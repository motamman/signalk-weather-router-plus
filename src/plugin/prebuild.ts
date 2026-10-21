/**
 * Map tiles built ahead of time (main thread scheduler + `tiles` worker
 * threads).
 *
 * Areas: the view a map shows (ViewTracker: inferred from the tile requests
 * of any map, this plugin's page or a chartplotter drawing the PNG tiles)
 * and the boat (navigation.position, kept across restarts).
 * The boat's area is a pyramid of web-map tiles: the full radius down to
 * zoom 8, half the radius at each deeper zoom, to the deepest zoom set.
 * The view is the tiles the map showed, at its zoom (and the isobar tiles
 * over them). Each layer is built at its data's steps in the window
 * (hasStep: the forecast's 3-hourly steps, the currents' steps, tide
 * height hourly); the map draws the hours between on demand.
 *
 * Order: the view's area, then the boat's; within each, nearest hour
 * first, then shallower zoom, then tiles nearest the centre. Tiles already
 * saved are skipped. A new forecast cycle / currents run / tide run (tile
 * generation), a new hour, a boat move of more than a kilometre, a new
 * view or a settings change starts the walk again from the top.
 *
 * Each builder finishes its tiles: answers the query, encodes the tile and
 * writes it to a temporary file beside it; the main thread only moves the
 * file into place and counts it (TileStore.adopt). Until 2026-10-13 the
 * answer crossed to the main thread, which encoded and wrote every tile:
 * Signal K's main thread at 47–100 % while the prebuild ran, 6 % a minute
 * after it was turned off (brain, top).
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
import type { DataStamp, MainToWorker, VesselPosition, WorkerToMain } from './protocol';
import { PRESSURE_TILE_ZOOM } from './tilejoin';
import {
  PYRAMID_MIN_ZOOM,
  pyramidRadius,
  pyramidTiles,
  tileAt,
  tileBBox,
  tileGroup,
  stampMatches,
  type TileGroup,
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
/** A builder that has not reported ready within this long is stopped (its start-up failed). */
const READY_TIMEOUT_MS = 60_000;
/** After a builder failed to start, no new one is started for this long (a lasting error does not respawn in a loop). */
const START_RETRY_MS = 5 * 60_000;
/** A burst of tile requests ends when no new tile has come for this long: one view drawn. */
const VIEW_GAP_MS = 5_000;
/** Consecutive errors after which a layer is left out until the walk restarts. */
const LAYER_ERROR_LIMIT = 3;

/** The step times of the data the map layers are drawn from, for `atStep`. */
export interface StepSources {
  /** The forecast's steps (valid times, ms); null: no forecast loaded. */
  forecast: number[] | null;
  /** RTOFS steps (valid times, ms), or none. */
  rtofs: number[];
  /** SMOC's step (ms; its steps are the multiples of it from 00Z, data/arco.ts alignedSteps), or null when off. */
  smocStepMs: number | null;
  /** Tidal-harmonic current sources loaded: they give a value for every hour. */
  harmonic: boolean;
}

/**
 * Whether a layer's data has a step at this whole hour (`atStep`). The forecast's layers (group `wx`): at its steps.
 * The current layers (`cur`: current, arrows, sea state): at an RTOFS step or a SMOC step, or every hour with tidal
 * harmonics (brain's settings, 2026-10-14: SMOC and RTOFS both at 3 h, so hourly current tiles were interpolations).
 * Tide height and the coastline: every hour (the sea level is hourly).
 */
export function hasStep(group: TileGroup, hourMs: number, s: StepSources): boolean {
  if (group === 'wx') return !!s.forecast?.includes(hourMs);
  if (group === 'cur') return s.harmonic || s.rtofs.includes(hourMs) || (s.smocStepMs !== null && hourMs % s.smocStepMs === 0);
  return true;
}

/** The tiles at zoom `zTo` covering the given tiles of zoom `z` (each tile's own extent: no wrap across the date line). */
export function coveringTiles(z: number, tiles: { x: number; y: number }[], zTo: number): { x: number; y: number }[] {
  const out = new Map<string, { x: number; y: number }>();
  for (const t of tiles) {
    const b = tileBBox(z, t.x, t.y);
    const nw = tileAt(b.west, b.north, zTo);
    // The east and south edges belong to the next tile: step back a hair inside.
    const se = tileAt(b.east - 1e-9, b.south + 1e-9, zTo);
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.set(`${x}/${y}`, { x, y });
  }
  return [...out.values()];
}

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
  /** The data the plugin holds now, to check a built tile's stamp against before adopting it. */
  dataStamp: () => DataStamp;
  vesselPosition: () => VesselPosition | null;
  /** Hours available: forecast (colour and barb layers), tide run, per layer; null = not loaded. */
  lastHourMs: (layer: TileLayer) => number | null;
  /**
   * Whether a layer's data has a step at this whole hour. Hours between a source's steps are not built ahead: the map
   * draws them on demand, interpolated as always (the forecast's steps are 3 h apart, the tiles hourly: two of every
   * three wind and wave tiles were interpolations built ahead, and every new cycle built them again; brain, 2026-10-14).
   */
  atStep: (layer: TileLayer, hourMs: number) => boolean;
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
  /** view: the deepest zoom the map asked for. */
  z?: number;
  /**
   * view: the tiles the map showed at that zoom. Only those are built ahead (every layer, every step of the window),
   * not the pyramid: a pyramid round every place a map paused on cost tens of thousands of tiles each (brain,
   * 2026-10-14: one pan by ZedDisplay off Block Island, about 30 minutes of two cores).
   */
  tiles?: { x: number; y: number }[];
}

/**
 * The view a map shows, from the tiles it asks for. A burst is the tiles of one view drawn: it ends when no new tile
 * (one it does not hold yet, or one deeper) has come for VIEW_GAP_MS. Requests again for tiles it holds (a map asking
 * for the same view at other hours, or refreshing it) do not keep it open (PR #39 review: ended by any request, a
 * map asking at least every 5 s never let the view be taken). The view is taken from a burst only when it has ended, from all its
 * distinct tiles at its deepest zoom (a tile asked for several layers counts once): their middle, rounded to a
 * quarter of the build's radius at that zoom so small pans do not restart the walk. A view shallower than the
 * shallowest zoom built (PYRAMID_MIN_ZOOM) has nothing of the build on screen and leaves the last view as it is;
 * so does no request at all (the map closed: the last view is kept).
 *
 * Until 2026-10-13 the view was the deepest zoom asked for in the last 5 s, read every second: with the requests
 * of a whole-Atlantic view at zoom 4 trickling in over half a minute (the server answering in 12–21 s), the last
 * 5 s held only the view's north-east corner tile, 4/9/4, and the prebuild built northwest Russia down to zoom 15 for
 * every hour (brain, journal and /api/status).
 */
export class ViewTracker {
  /** `newAt`: when the burst last gained a tile. */
  private burst: { z: number; tiles: Map<string, { x: number; y: number }>; newAt: number } | null = null;
  private last: Area | null = null;

  /** `radiusM`: the build's radius now (the rounding step follows it). */
  constructor(private readonly radiusM: () => number) {}

  /** A map asked for tile z/x/y at `atMs`. */
  note(z: number, x: number, y: number, atMs: number): void {
    if (this.burst && atMs - this.burst.newAt > VIEW_GAP_MS) this.close();
    if (!this.burst) this.burst = { z, tiles: new Map(), newAt: atMs };
    const b = this.burst;
    if (z > b.z) {
      b.z = z;
      b.tiles.clear();
    }
    const k = `${x}/${y}`;
    if (z === b.z && !b.tiles.has(k)) {
      b.tiles.set(k, { x, y });
      b.newAt = atMs;
    }
  }

  /** The view at `nowMs`: from the last burst that has ended, or null when there has been none. */
  view(nowMs: number): Area | null {
    if (this.burst && nowMs - this.burst.newAt > VIEW_GAP_MS) this.close();
    return this.last;
  }

  private close(): void {
    const b = this.burst;
    this.burst = null;
    if (!b || b.z < PYRAMID_MIN_ZOOM || !b.tiles.size) return;
    // Mean of the tile centres, on the unit circle for longitude (date line).
    let sx = 0;
    let sy = 0;
    let lat = 0;
    for (const { x, y } of b.tiles.values()) {
      const box = tileBBox(b.z, x, y);
      const lon = ((box.west + box.east) / 2) * DEG;
      sx += Math.cos(lon);
      sy += Math.sin(lon);
      lat += (box.north + box.south) / 2;
    }
    const step = pyramidRadius(this.radiusM(), b.z) / 4 / M_PER_DEG;
    const cLat = lat / b.tiles.size;
    const cLon = (Math.atan2(sy, sx) * 180) / Math.PI;
    this.last = {
      kind: 'view',
      lat: Math.round(cLat / step) * step,
      lon: Math.round(cLon / step) * step,
      z: b.z,
      tiles: [...b.tiles.values()],
    };
  }
}

interface TilesWorker {
  proc: ChildProcess;
  ready: boolean;
  /** Stopped on purpose (walk complete, plugin stopped): its exit is not an error and it is not replaced. */
  retiring: boolean;
  /** Tile build in flight. */
  pending: {
    id: number;
    resolve: (v: { bytes: number; complete: boolean; stamp: DataStamp }) => void;
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
    let out: unknown = v;
    if (v.buffer instanceof SharedArrayBuffer) {
      if (v instanceof DataView) {
        // No slice(): copy its bytes into a plain buffer.
        const bytes = new Uint8Array(v.byteLength);
        bytes.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        out = new DataView(bytes.buffer);
      } else if (Buffer.isBuffer(v)) {
        out = Buffer.from(v); // Buffer.slice() is a view on the same memory; Buffer.from copies
      } else {
        out = (v as unknown as { slice: () => unknown }).slice(); // a typed array's slice() copies into a plain buffer
      }
    }
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
  /** No new builder before this time (a builder failed to start). */
  private noStartUntil = 0;
  private boat: VesselPosition | null = null;
  private readonly views = new ViewTracker(() => this.settings.radiusM);
  private areas: Area[] = [];
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

  /** A map asked for this tile (view inference). */
  noteRequest(z: number, x: number, y: number): void {
    if (!this.settings.followView) return;
    this.views.note(z, x, y, Date.now());
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
    // Start-up failed (e.g. its init threw): it would hold its slot for good and no replacement would start.
    const readyTimer = setTimeout(() => {
      if (h.ready || h.retiring) return;
      this.deps.error(
        `tiles builder did not start within ${READY_TIMEOUT_MS / 1000} s; stopped, next attempt in ${START_RETRY_MS / 60_000} min`
      );
      this.noStartUntil = Date.now() + START_RETRY_MS;
      this.retire(h, 'did not start');
      this.schedule(START_RETRY_MS);
    }, READY_TIMEOUT_MS);
    proc.on('exit', () => clearTimeout(readyTimer));
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
      case 'tile-built':
        if (h.pending && h.pending.id === m.id) {
          const p = h.pending;
          h.pending = null;
          clearTimeout(p.timer);
          p.resolve({ bytes: m.bytes, complete: m.complete, stamp: m.stamp });
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

  /** Build a tile in a builder, written to `tmp` (complete: false, nothing written). */
  private workerBuild(h: TilesWorker, t: TileId, tmp: string): Promise<{ bytes: number; complete: boolean; stamp: DataStamp }> {
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
      this.post(h, { type: 'build-tile', id, tile: t, tmp });
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

  /** The view a map shows (ViewTracker), when the walk follows it. */
  private viewArea(): Area | null {
    return this.settings.followView ? this.views.view(Date.now()) : null;
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
    // A view is its tiles: a pan showing other tiles starts the walk again (cheap now: the view's tiles only).
    const where = (a: Area): unknown =>
      a.tiles ? [a.kind, a.z, a.tiles.map(t => `${t.x}/${t.y}`).join(',')] : [a.kind, a.lat.toFixed(4), a.lon.toFixed(4)];
    return JSON.stringify({ gens, hour, areas: areas.map(where), s: this.settings });
  }

  private *tiles(areas: Area[], layers: TileLayer[], fromMs: number, windowEndMs: number): Generator<{ t: TileId; area: Area }> {
    const zs: number[] = [];
    for (let z = PYRAMID_MIN_ZOOM; z <= this.settings.maxZoom; z++) zs.push(z);
    for (const area of areas) {
      // The view: the tiles the map showed, at its zoom; the boat: the pyramid round it.
      const shown = area.tiles && area.z !== undefined ? { z: area.z, tiles: area.tiles } : null;
      const byZ = shown ? [shown] : zs.map(z => ({ z, tiles: pyramidTiles(area.lat, area.lon, this.settings.radiusM, z) }));
      for (const { z, tiles } of byZ) for (const { x, y } of tiles) yield { t: { layer: 'land', z, x, y, hourMs: 0 }, area };
      const ends = new Map(layers.map(l => [l, Math.min(windowEndMs, this.deps.lastHourMs(l) ?? -Infinity)]));
      const lastMs = Math.max(...ends.values());
      const tileLayers = layers.filter(l => l !== 'msl');
      // Isobars read the pressure grid at one zoom (tilejoin.ts joinPressure), whatever the map zoom.
      const pressure = !layers.includes('msl')
        ? []
        : shown
          ? coveringTiles(shown.z, shown.tiles, PRESSURE_TILE_ZOOM)
          : pyramidTiles(area.lat, area.lon, this.settings.radiusM, PRESSURE_TILE_ZOOM);
      for (let h = fromMs; h <= lastMs; h += HOUR_MS) {
        if (h <= (ends.get('msl') ?? -Infinity) && this.deps.atStep('msl', h))
          for (const { x, y } of pressure) yield { t: { layer: 'msl', z: PRESSURE_TILE_ZOOM, x, y, hourMs: h }, area };
        const atH = tileLayers.filter(l => h <= (ends.get(l) as number) && this.deps.atStep(l, h));
        if (!atH.length) continue;
        for (const { z, tiles } of byZ)
          for (const { x, y } of tiles) for (const layer of atH) yield { t: { layer, z, x, y, hourMs: h }, area };
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
          if (this.workers.length < this.settings.workers && Date.now() >= this.noStartUntil) this.spawn();
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
    const tmp = this.deps.store.tmpFile(t);
    const t0 = Date.now();
    try {
      if (!tmp) throw new Error('its data is not loaded');
      const { bytes, complete, stamp } = await this.workerBuild(h, t, tmp);
      const group = tileGroup(t.layer);
      if (complete && !stampMatches(group, this.deps.dataStamp(), stamp)) {
        // The tile was computed from data the plugin has replaced meanwhile
        // (a settings change, or a tide run the builders learned late): not
        // adopted, not counted as built. No forecast-swap window exists: a
        // builder has the new run before it builds (worker.ts handles its
        // messages one at a time, behind the 'forecast' message itself).
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
        this.counts.notKept++;
        this.deps.store.noteNotKept();
      } else if (complete) {
        await this.deps.store.adopt(t, tmp, bytes, generation);
        this.counts.built++;
        this.builtTotal++;
        this.buildMsTotal += Date.now() - t0;
      } else {
        this.counts.notKept++;
        this.deps.store.noteNotKept();
      }
      this.layerErrors.delete(t.layer);
    } catch (err) {
      // A builder stopped or failed while writing may have left part of the file.
      if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
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
