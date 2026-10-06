/**
 * Map tiles built ahead of time (main thread scheduler + `tiles` worker
 * threads).
 *
 * Areas: the view the map shows (inferred from the tile requests the page
 * sends: the deepest zoom asked for in the last seconds and the middle of
 * those tiles) and the boat (navigation.position, kept across restarts).
 * Each area is a pyramid of web-map tiles: the full radius down to zoom 8,
 * half the radius at each deeper zoom, to the deepest zoom set. Every
 * hour of the window is built at every level.
 *
 * Order: the view's area, then the boat's; within each, nearest hour
 * first, then shallower zoom, then tiles nearest the centre. Tiles already
 * saved are skipped. A new forecast cycle / currents run / tide run (tile
 * generation), a new hour, a boat move of more than a kilometre, a new
 * view or a settings change starts the walk again from the top.
 *
 * Priority: the builders are separate processes, so the map's own queries
 * (data worker) and routes (route worker) never queue behind them; no new
 * tile is started while a route runs or the data worker has map queries
 * waiting.
 *
 * Builders are child processes (not worker threads), started when the walk
 * has a tile to build and stopped when it is complete. A thread's memory,
 * freed, stays with Signal K's process until it restarts; a child process
 * gives all of it back when it exits (brain, 2026-10-06: the two tile
 * threads held 95–110 MB of buffers each and kept them after the walk; a
 * map session added 350 MB that stayed). Shared memory does not cross
 * processes, so the current, tide and harmonic data relayed to a builder
 * are copies (unshared()), freed with the process.
 */

import * as fs from 'node:fs';
import { DEG, M_PER_DEG, HOUR_MS } from '../geo/units';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { MainToWorker, VesselPosition, WorkerToMain } from './protocol';
import { PRESSURE_TILE_ZOOM } from './tilejoin';
import {
  encodeTile,
  PYRAMID_MIN_ZOOM,
  pyramidRadius,
  pyramidTiles,
  tileBBox,
  tileGroup,
  tileQuery,
  type TileId,
  type TileLayer,
  type TileStore,
} from './tiles';

/** Layers the page draws, built ahead of time; `msl` only at the zoom the isobars read. */
export const PREBUILD_LAYERS: readonly TileLayer[] = [
  'wind',
  'waves',
  'sea_state',
  'current',
  'precip',
  'temperature',
  'sst',
  'tide',
  'barbs',
  'arrows',
  'msl',
];

const QUERY_TIMEOUT_MS = 120_000;
/** A view is the deepest zoom the page asked for within this long. */
const VIEW_WINDOW_MS = 5_000;
/** Consecutive errors after which a layer is left out until the walk restarts. */
const LAYER_ERROR_LIMIT = 3;

export interface PrebuildSettings {
  enabled: boolean;
  radiusM: number;
  windowS: number | null;
  maxZoom: number;
  workers: number;
  followView: boolean;
}

export interface PrebuildDeps {
  store: TileStore;
  dataDir: string;
  /** Worker script and its exec args (index.ts startWorker). */
  workerPath: string;
  execArgv: string[];
  /** init for a new tiles worker. */
  initMessage: () => MainToWorker;
  /** What a new tiles worker must adopt: forecast, SMOC, harmonics, tide run, a refresh. */
  replayMessages: () => MainToWorker[];
  vesselPosition: () => VesselPosition | null;
  /** Hours available: forecast (colour and barb layers), tide run, per layer; null = not loaded. */
  lastHourMs: (layer: TileLayer) => number | null;
  /** Layers the loaded data can answer (e.g. no waves without wave fields). */
  layerAvailable: (layer: TileLayer) => boolean;
  /** A route is running or the data worker has map queries waiting. */
  busy: () => boolean;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

interface Area {
  kind: 'view' | 'boat';
  lat: number;
  lon: number;
  /** view: the deepest zoom the page asked for. */
  z?: number;
}

interface TilesWorker {
  proc: ChildProcess;
  ready: boolean;
  /** Stopped on purpose (walk complete, plugin stopped): its exit is not an error and it is not replaced. */
  retiring: boolean;
  /** Query in flight. */
  pending: {
    id: number;
    resolve: (v: { result: unknown; complete: boolean }) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null;
}

export interface PrebuildStatus {
  enabled: boolean;
  workers: number;
  workers_ready: number;
  paused: boolean;
  areas: { kind: string; lat: number; lon: number; radius_m: number }[];
  window: { from: string; to: string } | null;
  max_zoom: number;
  walk_started_at: string | null;
  /** Tiles looked at in this walk / built / already saved / not kept (incomplete data) / failed. */
  seen: number;
  built: number;
  skipped: number;
  not_kept: number;
  errors: number;
  last_error: string | null;
  /** Where the walk is: area, hour, zoom. */
  at: { area: string; hour: string; z: number } | null;
  /** The walk reached its end: everything in the window is saved. */
  complete: boolean;
  built_total: number;
  build_ms_avg: number | null;
}

/**
 * A copy of a message with every SharedArrayBuffer-backed typed array
 * replaced by a plain copy: shared memory cannot be sent to another
 * process. The same source array gives the same copy (an area's `u` and
 * `data.utotal` stay one array).
 */
export function unshared<T>(v: T, memo = new Map<unknown, unknown>()): T {
  if (v === null || typeof v !== 'object') return v;
  if (memo.has(v)) return memo.get(v) as T;
  if (ArrayBuffer.isView(v)) {
    const out = v.buffer instanceof SharedArrayBuffer ? (v as unknown as { slice: () => unknown }).slice() : v;
    memo.set(v, out);
    return out as T;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    memo.set(v, out);
    for (const x of v) out.push(unshared(x, memo));
    return out as T;
  }
  if (v instanceof Map) {
    const out = new Map();
    memo.set(v, out);
    for (const [k, x] of v) out.set(k, unshared(x, memo));
    return out as T;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) return v; // Date and the like: sent as they are
  const out: Record<string, unknown> = {};
  memo.set(v, out);
  for (const [k, x] of Object.entries(v)) out[k] = unshared(x, memo);
  return out as T;
}

function hourIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13) + 'Z';
}

export class TilePrebuilder {
  private settings: PrebuildSettings;
  private readonly deps: PrebuildDeps;
  private workers: TilesWorker[] = [];
  private stopped = true;
  private queryId = 0;
  private walk: Generator<{ t: TileId; area: Area }> | null = null;
  private walkKey = '';
  private walkStartedAt: number | null = null;
  private at: PrebuildStatus['at'] = null;
  private counts = { seen: 0, built: 0, skipped: 0, notKept: 0, errors: 0 };
  private builtTotal = 0;
  private buildMsTotal = 0;
  private lastError: string | null = null;
  private layerErrors = new Map<TileLayer, number>();
  private droppedLayers = new Set<TileLayer>();
  private complete = false;
  private paused = false;
  private timer: NodeJS.Timeout | null = null;
  /** The walk's next tile, taken before a builder was free to build it. */
  private peeked: { t: TileId; area: Area } | null = null;
  private boat: VesselPosition | null = null;
  private readonly recent: { z: number; x: number; y: number; at: number }[] = [];
  private areas: Area[] = [];
  private lastView: Area | null = null;
  private window: { fromMs: number; toMs: number } | null = null;
  /** The last messages to replay to a (re)started worker, by type. */
  private broadcastLog = new Map<string, MainToWorker>();

  constructor(settings: PrebuildSettings, deps: PrebuildDeps) {
    this.settings = settings;
    this.deps = deps;
    this.boat = this.readBoat();
  }

  start(): void {
    this.stopped = false;
    if (!this.settings.enabled) return;
    // Builders are started when the walk has a tile for them (pump).
    this.schedule(1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.peeked = null;
    for (const w of [...this.workers]) this.retire(w, 'stopped');
    this.workers = [];
  }

  /** Send a message to a builder process (shared memory copied). */
  private post(h: TilesWorker, msg: MainToWorker): void {
    if (!h.proc.connected) return;
    try {
      h.proc.send(unshared(msg));
    } catch (err) {
      this.deps.error(`tiles builder: could not send ${msg.type}: ${(err as Error).message}`);
    }
  }

  /** Stop a builder on purpose: shut down, killed after 2 s; a query in flight is rejected. */
  private retire(h: TilesWorker, why: string): void {
    h.retiring = true;
    if (h.pending) {
      clearTimeout(h.pending.timer);
      const p = h.pending;
      h.pending = null;
      p.reject(new Error(why));
    }
    this.post(h, { type: 'shutdown' } as MainToWorker);
    const proc = h.proc;
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 2000);
    const i = this.workers.indexOf(h);
    if (i >= 0) this.workers.splice(i, 1);
  }

  /** Forward a message to every builder (forecast, SMOC, harmonics, RTOFS, tide run, config, refresh). */
  broadcast(msg: MainToWorker): void {
    if (msg.type !== 'config' && msg.type !== 'refresh') this.broadcastLog.set(msg.type, msg);
    for (const w of this.workers) if (w.ready) this.post(w, msg);
  }

  /** The page asked for this tile (view inference). */
  noteRequest(z: number, x: number, y: number): void {
    if (!this.settings.followView) return;
    const now = Date.now();
    this.recent.push({ z, x, y, at: now });
    while (this.recent.length && (this.recent.length > 400 || now - this.recent[0].at > VIEW_WINDOW_MS)) this.recent.shift();
  }

  private readBoat(): VesselPosition | null {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(this.deps.dataDir, 'last-position.json'), 'utf8')) as VesselPosition;
      return Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
    } catch {
      return null;
    }
  }

  private saveBoat(p: VesselPosition): void {
    fs.promises.writeFile(path.join(this.deps.dataDir, 'last-position.json'), JSON.stringify(p)).catch(() => undefined);
  }

  private spawn(): void {
    const proc = fork(this.deps.workerPath, [], {
      execArgv: this.deps.execArgv,
      env: { ...process.env, WRP_WORKER_ROLE: 'tiles' },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const h: TilesWorker = { proc, ready: false, retiring: false, pending: null };
    this.workers.push(h);
    proc.on('message', (m: WorkerToMain) => this.onMessage(h, m));
    proc.on('error', err => this.deps.error(`tiles builder error: ${err.message}`));
    proc.on('exit', (code, signal) => {
      const i = this.workers.indexOf(h);
      if (i >= 0) this.workers.splice(i, 1);
      if (h.pending) {
        clearTimeout(h.pending.timer);
        const p = h.pending;
        h.pending = null;
        p.reject(new Error(`tiles builder exited (${code ?? signal})`));
      }
      if (h.retiring || this.stopped) return;
      // Died on its own: the walk starts another builder when it next has a tile.
      this.deps.error(`tiles builder exited (${code ?? signal}); a new one is started in 5 s`);
      this.schedule(5000);
    });
    this.post(h, this.deps.initMessage());
  }

  private onMessage(h: TilesWorker, m: WorkerToMain): void {
    switch (m.type) {
      case 'ready': {
        h.ready = true;
        for (const msg of this.deps.replayMessages()) this.post(h, msg);
        for (const msg of this.broadcastLog.values()) this.post(h, msg);
        this.schedule(0);
        return;
      }
      case 'log':
        if (m.level === 'error') this.deps.error(m.message);
        return;
      case 'query-result':
        if (h.pending && h.pending.id === m.id) {
          const p = h.pending;
          h.pending = null;
          clearTimeout(p.timer);
          p.resolve({ result: m.result, complete: m.complete });
        }
        return;
      case 'query-error':
        if (h.pending && h.pending.id === m.id) {
          const p = h.pending;
          h.pending = null;
          clearTimeout(p.timer);
          p.reject(new Error(m.message));
        }
        return;
      default:
        return; // status messages of the tiles worker are not used
    }
  }

  private workerQuery(h: TilesWorker, t: TileId): Promise<{ result: unknown; complete: boolean }> {
    const { kind, args } = tileQuery(t);
    const id = ++this.queryId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The worker may still be running it, and a running query cannot be
        // cancelled: restart the worker (its exit handler rejects this query
        // and starts a new one), so the worker count stays the cap.
        if (h.pending?.id !== id) return;
        this.deps.error(`tiles builder: tile query timed out after ${QUERY_TIMEOUT_MS / 1000} s; restarting the builder`);
        h.proc.kill('SIGKILL');
      }, QUERY_TIMEOUT_MS);
      h.pending = { id, resolve, reject, timer };
      this.post(h, { type: 'query', id, kind, args } as MainToWorker);
    });
  }

  private schedule(ms: number): void {
    if (this.stopped || !this.settings.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, ms);
  }

  /** The view: middle of the deepest-zoom tiles asked for in the last seconds. */
  private viewArea(): Area | null {
    if (!this.settings.followView) return null;
    const now = Date.now();
    const recent = this.recent.filter(r => now - r.at <= VIEW_WINDOW_MS);
    if (!recent.length) return this.lastView; // keep the last view
    const z = Math.max(...recent.map(r => r.z));
    const at = recent.filter(r => r.z === z);
    // Mean of tile centres on the unit circle for longitude (date line).
    let sx = 0;
    let sy = 0;
    let lat = 0;
    for (const r of at) {
      const b = tileBBox(r.z, r.x, r.y);
      const lon = ((b.west + b.east) / 2) * DEG;
      sx += Math.cos(lon);
      sy += Math.sin(lon);
      lat += (b.north + b.south) / 2;
    }
    // Round the centre to a quarter of the radius at its zoom so small pans do not restart the walk.
    const step = pyramidRadius(this.settings.radiusM, z) / 4 / M_PER_DEG;
    const cLat = lat / at.length;
    const cLon = (Math.atan2(sy, sx) * 180) / Math.PI;
    this.lastView = { kind: 'view', lat: Math.round(cLat / step) * step, lon: Math.round(cLon / step) * step, z };
    return this.lastView;
  }

  /** What the walk depends on; a change starts it again. */
  private currentKey(): string {
    const now = Date.now();
    const pos = this.deps.vesselPosition();
    // A move of more than a kilometre moves the boat's area (and is remembered across restarts).
    const movedM = (a: VesselPosition, b: VesselPosition): number =>
      Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) * M_PER_DEG;
    if (pos && (!this.boat || movedM(pos, this.boat) > 1000)) {
      this.boat = pos;
      this.saveBoat(pos);
    }
    const areas: Area[] = [];
    const view = this.viewArea();
    if (view) areas.push(view);
    if (this.boat) areas.push({ kind: 'boat', lat: this.boat.lat, lon: this.boat.lon });
    this.areas = areas;
    const gens = (['wx', 'cur', 'tide', 'land'] as const).map(g => this.deps.store.generation(g)).join(',');
    const hour = Math.floor(now / HOUR_MS);
    return JSON.stringify({ gens, hour, areas: areas.map(a => [a.kind, a.lat.toFixed(4), a.lon.toFixed(4)]), s: this.settings });
  }

  private *tiles(areas: Area[], layers: TileLayer[], fromMs: number, windowEndMs: number): Generator<{ t: TileId; area: Area }> {
    const zs: number[] = [];
    for (let z = PYRAMID_MIN_ZOOM; z <= this.settings.maxZoom; z++) zs.push(z);
    for (const area of areas) {
      const byZ = zs.map(z => ({ z, tiles: pyramidTiles(area.lat, area.lon, this.settings.radiusM, z) }));
      for (const { z, tiles } of byZ) for (const { x, y } of tiles) yield { t: { layer: 'land', z, x, y, hourMs: 0 }, area };
      const ends = new Map(layers.map(l => [l, Math.min(windowEndMs, this.deps.lastHourMs(l) ?? -Infinity)]));
      const lastMs = Math.max(...ends.values());
      const tileLayers = layers.filter(l => l !== 'msl');
      // Isobars read the pressure grid at one zoom (tilejoin.ts joinPressure), whatever the map zoom.
      const pressure = layers.includes('msl') ? pyramidTiles(area.lat, area.lon, this.settings.radiusM, PRESSURE_TILE_ZOOM) : [];
      for (let h = fromMs; h <= lastMs; h += HOUR_MS) {
        if (h <= (ends.get('msl') ?? -Infinity))
          for (const { x, y } of pressure) yield { t: { layer: 'msl', z: PRESSURE_TILE_ZOOM, x, y, hourMs: h }, area };
        for (const { z, tiles } of byZ)
          for (const { x, y } of tiles)
            for (const layer of tileLayers) if (h <= (ends.get(layer) as number)) yield { t: { layer, z, x, y, hourMs: h }, area };
      }
    }
  }

  private restartWalk(key: string): void {
    const now = Date.now();
    const fromMs = Math.floor(now / HOUR_MS) * HOUR_MS;
    const layers = PREBUILD_LAYERS.filter(l => this.deps.layerAvailable(l));
    const lasts = layers.map(l => this.deps.lastHourMs(l)).filter((v): v is number => v !== null);
    const windowEnd = this.settings.windowS === null ? Infinity : fromMs + this.settings.windowS * 1000;
    const toMs = Math.min(windowEnd, lasts.length ? Math.max(...lasts) : fromMs);
    this.window = lasts.length ? { fromMs, toMs } : null;
    this.walk = lasts.length ? this.tiles(this.areas, layers, fromMs, windowEnd) : null;
    this.walkKey = key;
    this.peeked = null;
    this.walkStartedAt = now;
    this.counts = { seen: 0, built: 0, skipped: 0, notKept: 0, errors: 0 };
    this.layerErrors.clear();
    this.droppedLayers.clear();
    this.complete = false;
    if (this.areas.length)
      this.deps.log(
        `tile prebuild: walk ${this.areas.map(a => `${a.kind} ${a.lat.toFixed(3)},${a.lon.toFixed(3)}`).join(' then ')}, radius ${this.settings.radiusM} m, zoom ${PYRAMID_MIN_ZOOM}–${this.settings.maxZoom}, ${layers.length} layers${this.window ? `, ${hourIso(this.window.fromMs)} to ${hourIso(this.window.toMs)}` : ''}`
      );
  }

  /** Next tile not saved yet, or null at the end of the walk. */
  private async next(): Promise<{ t: TileId; area: Area } | null> {
    if (!this.walk) return null;
    for (;;) {
      const n = this.walk.next();
      if (n.done) return null;
      const { t } = n.value;
      if (this.droppedLayers.has(t.layer)) continue;
      this.counts.seen++;
      if (await this.deps.store.has(t)) {
        this.counts.skipped++;
        continue;
      }
      if (!this.deps.store.generation(tileGroup(t.layer))) continue; // its data is not loaded
      return n.value;
    }
  }

  private pumping = false;

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      const key = this.currentKey();
      if (key !== this.walkKey) this.restartWalk(key);
      this.paused = this.deps.busy();
      if (this.paused) {
        this.schedule(500);
        return;
      }
      for (;;) {
        const item = this.peeked ?? (await this.next());
        this.peeked = null;
        if (!item) {
          if (!this.complete && this.walk) {
            this.complete = true;
            this.deps.log(
              `tile prebuild: walk complete (${this.counts.built} built, ${this.counts.skipped} already saved, ${this.counts.notKept} not kept, ${this.counts.errors} failed)`
            );
          }
          break;
        }
        const h = this.workers.find(w => w.ready && !w.pending);
        if (!h) {
          // No free builder: keep the tile, start a builder if fewer than the setting are running.
          this.peeked = item;
          if (this.workers.length < this.settings.workers) this.spawn();
          break;
        }
        void this.build(h, item);
      }
      // Walk complete (or nothing to walk): idle builders exit and give their memory back.
      if (this.complete || !this.walk) for (const h of this.workers.filter(w => !w.pending)) this.retire(h, 'walk complete');
    } finally {
      this.pumping = false;
    }
    // Idle: look again for a new hour, cycle, view or position.
    this.schedule(this.complete || !this.walk ? 15_000 : 1000);
  }

  private async build(h: TilesWorker, item: { t: TileId; area: Area }): Promise<void> {
    const { t, area } = item;
    this.at = { area: area.kind, hour: hourIso(t.hourMs), z: t.z };
    const generation = this.deps.store.generation(tileGroup(t.layer));
    const t0 = Date.now();
    try {
      const { result, complete } = await this.workerQuery(h, t);
      if (complete) {
        await this.deps.store.write(t, await encodeTile(t, result), generation);
        this.counts.built++;
        this.builtTotal++;
        this.buildMsTotal += Date.now() - t0;
      } else {
        this.counts.notKept++;
        this.deps.store.noteNotKept();
      }
      this.layerErrors.delete(t.layer);
    } catch (err) {
      this.counts.errors++;
      this.lastError = `${t.layer} ${t.z}/${t.x}/${t.y} ${t.layer === 'land' ? '' : hourIso(t.hourMs)}: ${(err as Error).message}`;
      const n = (this.layerErrors.get(t.layer) ?? 0) + 1;
      this.layerErrors.set(t.layer, n);
      if (n >= LAYER_ERROR_LIMIT && !this.droppedLayers.has(t.layer)) {
        this.droppedLayers.add(t.layer);
        this.deps.error(`tile prebuild: ${t.layer} left out until the next walk after ${n} failures (${this.lastError})`);
      }
    }
    this.schedule(0);
  }

  status(): PrebuildStatus {
    return {
      enabled: this.settings.enabled,
      workers: this.workers.length,
      workers_ready: this.workers.filter(w => w.ready).length,
      paused: this.paused,
      areas: this.areas.map(a => ({ kind: a.kind, lat: a.lat, lon: a.lon, radius_m: this.settings.radiusM })),
      window: this.window ? { from: new Date(this.window.fromMs).toISOString(), to: new Date(this.window.toMs).toISOString() } : null,
      max_zoom: this.settings.maxZoom,
      walk_started_at: this.walkStartedAt ? new Date(this.walkStartedAt).toISOString() : null,
      seen: this.counts.seen,
      built: this.counts.built,
      skipped: this.counts.skipped,
      not_kept: this.counts.notKept,
      errors: this.counts.errors,
      last_error: this.lastError,
      at: this.at,
      complete: this.complete,
      built_total: this.builtTotal,
      build_ms_avg: this.builtTotal ? Math.round(this.buildMsTotal / this.builtTotal) : null,
    };
  }
}
