/**
 * Map overlay tiles: fixed web-map tiles (z/x/y) at whole hours, saved
 * on disk and answered by the main thread without the data worker.
 *
 * A tile's box is the web-map tile and its sample spacing is fixed by
 * the zoom, so the same tile at the same hour is always the same query
 * and its answer can be kept. Answers are gzip JSON (land: gzip bytes)
 * under one directory per data generation:
 *
 *   <root>/<group>-<generation hash>/<layer>/<z>/<x>_<y>_<hour>.gz
 *
 * `group` says which data a layer depends on (forecast, currents, tide
 * height, coastline); a new forecast cycle, currents run or tide run
 * changes that group's generation and the old directory is removed. The
 * whole store is kept under a byte cap, least recently used first.
 * All file access is asynchronous: this runs on Signal K's main thread.
 */

import * as crypto from 'node:crypto';
import { clampMercLat, tileAt, tileBBox } from '../geo/mercator';
import { DEG, M_PER_DEG, HOUR_MS } from '../geo/units';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import type { BBox } from '../geo/geodesy';
import type { QueryArgs, QueryKind } from './protocol';
import { rmtree, runChildTask, type RmtreeResult } from './childtask';

export { FIELD_LAYERS as TILE_FIELD_LAYERS } from './layers';
import { FIELD_LAYERS } from './layers';
/** Every tile layer: colour layers, wind barbs, current arrows, coastline mask. */
export const TILE_LAYERS = [...FIELD_LAYERS, 'barbs', 'arrows', 'seas', 'land'] as const;
export type TileLayer = (typeof TILE_LAYERS)[number];

/** Which data a layer's answer depends on. */
/** `pt`: point answers (conditions, Weather API, forecast samples), which depend on forecast, currents and tides. */
export type TileGroup = 'wx' | 'cur' | 'tide' | 'land' | 'pt';
export const TILE_GROUPS: readonly TileGroup[] = ['wx', 'cur', 'tide', 'land', 'pt'];

/** Where a saved answer lives: its group and its path under the group's generation directory. */
export interface StoreKey {
  group: TileGroup;
  rel: string;
}

function storeKey(k: TileId | StoreKey): StoreKey {
  if ('rel' in k) return k;
  const name = k.layer === 'land' ? `${k.x}_${k.y}.gz` : `${k.x}_${k.y}_${Math.round(k.hourMs / HOUR_MS)}.gz`;
  return { group: tileGroup(k.layer), rel: path.join(k.layer, String(k.z), name) };
}

export function tileGroup(layer: TileLayer): TileGroup {
  switch (layer) {
    case 'current':
    case 'sea_state':
    case 'arrows':
    case 'seas':
      return 'cur';
    case 'tide':
      return 'tide';
    case 'land':
      return 'land';
    default:
      return 'wx';
  }
}

export const TILE_MIN_ZOOM = 0;
export const TILE_MAX_ZOOM = 18;
/** Coastline mask tiles: pixels per side. */
export const LAND_TILE_PX = 256;
/** Colour-layer grid: samples across a tile's width. */
export const FIELD_SAMPLES_PER_TILE = 64;
/** Wind barbs across a tile's width. */
export const BARBS_PER_TILE = 7;
/** Current arrows across a tile's width. */
export const ARROWS_PER_TILE = 5;
/** Sea-state glyphs per tile edge (the double-ended wave arrows). */
export const SEAS_PER_TILE = 5;

export interface TileId {
  layer: TileLayer;
  z: number;
  x: number;
  y: number;
  /** Whole hour, ms (unused for land). */
  hourMs: number;
}

/** Nearest whole hour. */
export function roundHour(ms: number): number {
  return Math.round(ms / HOUR_MS) * HOUR_MS;
}

export { tileAt, tileBBox } from '../geo/mercator';

/** Shallowest zoom built ahead of time. */
export const PYRAMID_MIN_ZOOM = 6;
/** Deepest zoom at which the pyramid keeps its full radius; halved at each deeper zoom. */
export const PYRAMID_FULL_RADIUS_ZOOM = 8;

/** Pyramid radius at zoom z: the full radius to zoom 8, halved at each deeper zoom. */
export function pyramidRadius(radiusM: number, z: number): number {
  return z <= PYRAMID_FULL_RADIUS_ZOOM ? radiusM : radiusM / 2 ** (z - PYRAMID_FULL_RADIUS_ZOOM);
}

/** Tiles at zoom z covering the box `r` metres around a point (x wraps at the date line). */
export function pyramidTiles(lat: number, lon: number, radiusM: number, z: number): { x: number; y: number }[] {
  const r = pyramidRadius(radiusM, z);
  const dLat = r / M_PER_DEG;
  const dLon = r / (M_PER_DEG * Math.max(0.01, Math.cos(lat * DEG)));
  const n = 2 ** z;
  const nw = tileAt(lon - dLon, clampMercLat(lat + dLat), z);
  const se = tileAt(lon + dLon, clampMercLat(lat - dLat), z);
  let span = se.x - nw.x;
  if (span < 0) span += n; // across the date line
  if (2 * dLon >= 360) span = n - 1;
  const out: { x: number; y: number }[] = [];
  for (let y = nw.y; y <= se.y; y++) for (let i = 0; i <= span; i++) out.push({ x: (nw.x + i) % n, y });
  // Nearest the centre first.
  const c = tileAt(lon, lat, z);
  const d = (t: { x: number; y: number }): number => {
    const dx = Math.min(Math.abs(t.x - c.x), n - Math.abs(t.x - c.x));
    return dx * dx + (t.y - c.y) ** 2;
  };
  return out.sort((a, b) => d(a) - d(b));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Check z/x/y; throws with a message for the API. */
export function checkTile(z: number, x: number, y: number): void {
  if (!Number.isInteger(z) || z < TILE_MIN_ZOOM || z > TILE_MAX_ZOOM)
    throw new Error(`z must be an integer in [${TILE_MIN_ZOOM}, ${TILE_MAX_ZOOM}]`);
  const n = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= n || !Number.isInteger(y) || y < 0 || y >= n)
    throw new Error(`x and y must be integers in [0, ${n - 1}] at zoom ${z}`);
}

/**
 * The data-worker query for a tile. Colour-layer boxes reach one sample
 * spacing past the tile so a tile's edge pixels interpolate between
 * samples (no seams); points are trimmed back to the tile afterwards
 * (trimPoints) so neighbours do not both draw an edge point.
 */
export function tileQuery(t: TileId): { kind: QueryKind; args: QueryArgs[QueryKind] } {
  const bbox = tileBBox(t.z, t.x, t.y);
  // From the zoom alone (not east − west, which rounds differently per tile), so every tile at a zoom samples one global lattice.
  const width = 360 / 2 ** t.z;
  switch (t.layer) {
    case 'land':
      return { kind: 'land_mask', args: { bbox, w: LAND_TILE_PX, h: LAND_TILE_PX, mercator: true } };
    case 'barbs':
      return { kind: 'wind_points', args: { bbox, timeMs: t.hourMs, res: clamp(width / BARBS_PER_TILE, 0.02, 5) } };
    case 'arrows':
      return { kind: 'currents', args: { bbox, timeMs: t.hourMs, res: clamp(width / ARROWS_PER_TILE, 0.005, 5) } };
    case 'seas':
      return { kind: 'sea_points', args: { bbox, timeMs: t.hourMs, res: clamp(width / SEAS_PER_TILE, 0.02, 5) } };
    default: {
      const res = clamp(width / FIELD_SAMPLES_PER_TILE, 0.002, 2);
      const padded: BBox = {
        west: bbox.west - res,
        east: bbox.east + res,
        south: Math.max(-90, bbox.south - res),
        north: Math.min(90, bbox.north + res),
      };
      return { kind: 'field', args: { layer: t.layer, bbox: padded, timeMs: t.hourMs, res } };
    }
  }
}

/** Points inside the tile, west/south edges in, east/north edges out. */
export function trimPoints<P extends { lon: number; lat: number }>(points: P[], z: number, x: number, y: number): P[] {
  const b = tileBBox(z, x, y);
  const eps = 1e-9;
  return points.filter(p => {
    let lon = p.lon;
    if (lon < b.west - eps) lon += 360;
    return lon >= b.west - eps && lon < b.east - eps && p.lat >= b.south - eps && p.lat < b.north - eps;
  });
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export interface TileStoreOptions {
  root: string;
  /** Byte cap for the whole store. */
  capBytes: number;
  log?: (msg: string) => void;
}

export interface TileStoreStats {
  dir: string;
  cap_bytes: number;
  files: number;
  bytes: number;
  hits: number;
  misses: number;
  /** Saved files found empty or not gzip, removed on read. */
  corrupt: number;
  writes: number;
  /** Answers not kept: an on-demand current or tide load was late or failed. */
  not_kept: number;
  generations: Record<TileGroup, string | null>;
}

/** Where the store's running totals are kept between starts. */
const TOTALS_FILE = '.totals.json';
/** Saved totals older than this are used but checked by a background count. */
const TOTALS_MAX_AGE_MS = 24 * HOUR_MS;
/** How long changed totals wait before they are saved (one write per burst of tiles). */
const TOTALS_SAVE_DELAY_MS = 5000;

/**
 * Tile answers on disk (see the file comment).
 *
 * Totals (files, bytes) are kept running and saved to TOTALS_FILE, so a
 * start does not walk the store: brain (2026-10-06) held 950 k tiles and
 * the walk built one entry per file on Signal K's main thread, 300 MB of
 * heap after every plugin start and every retired generation, taken back
 * only by a later major GC. When the totals are unknown they are counted
 * without a list; the sorted list is built only when the store is over
 * its cap, the one time it is needed (prune).
 */
export class TileStore {
  readonly root: string;
  private capBytes: number;
  private readonly log: (msg: string) => void;
  private gens: Record<TileGroup, string | null> = { wx: null, cur: null, tide: null, land: null, pt: null };
  private totals: { files: number; bytes: number } | null = null;
  /** Saved totals were old: count once in the background to check them. */
  private staleTotals = false;
  private totalsDirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private counting: Promise<void> | null = null;
  /**
   * Writes while a count-only walk runs. The walk may or may not have
   * passed them, so they are added to its result; removals during the walk
   * are not subtracted (the walk may already have skipped them). Either way
   * the totals err on the high side, never low (the cap is enforced early,
   * never late), until the next daily count sets them exactly.
   */
  private countDelta: { files: number; bytes: number } | null = null;
  private pruning: Promise<void> | null = null;
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private notKept = 0;

  constructor(opts: TileStoreOptions) {
    this.root = opts.root;
    this.capBytes = opts.capBytes;
    this.log = opts.log ?? (() => undefined);
    this.loadTotals();
  }

  private loadTotals(): void {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(this.root, TOTALS_FILE), 'utf8')) as {
        files?: unknown;
        bytes?: unknown;
        savedAt?: unknown;
      };
      if (!Number.isInteger(t.files) || (t.files as number) < 0 || !Number.isFinite(t.bytes) || (t.bytes as number) < 0) return;
      this.totals = { files: t.files as number, bytes: t.bytes as number };
      const age = Date.now() - Date.parse(String(t.savedAt ?? ''));
      this.staleTotals = !(age >= 0 && age < TOTALS_MAX_AGE_MS);
    } catch {
      // none saved yet (first start, or an older version): counted on first use
    }
  }

  private scheduleSave(): void {
    this.totalsDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveTotals();
    }, TOTALS_SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Saves run one after another (a timer save and a stop flush may overlap). */
  private saving: Promise<void> = Promise.resolve();

  private saveTotals(): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.totals || !this.totalsDirty) return;
      this.totalsDirty = false;
      const f = path.join(this.root, TOTALS_FILE);
      const tmp = `${f}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      try {
        await fs.promises.mkdir(this.root, { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify({ ...this.totals, savedAt: new Date().toISOString() }));
        await fs.promises.rename(tmp, f);
      } catch (err) {
        this.totalsDirty = true; // tried again at the next save
        this.log(`overlay tiles: could not save the totals: ${(err as Error).message}`);
      }
    });
    return this.saving;
  }

  /** Save changed totals now (plugin stop). */
  async flushTotals(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveTotals();
  }

  /** A count-only walk is running or starts now when the totals are unknown or old. */
  private ensureTotals(): void {
    if (this.counting || this.pruning) return;
    if (!this.totals || this.staleTotals) void this.recount();
  }

  setCap(bytes: number): void {
    this.capBytes = bytes;
    void this.prune();
  }

  /**
   * Set each group's generation (a string naming the data behind it:
   * forecast cycle, currents runs, tide run, coastline). Null: that
   * group's data is not loaded, nothing of it is cached. Directories of
   * other generations are removed in the background.
   */
  setGenerations(g: Record<TileGroup, string | null>): void {
    const next = { ...this.gens };
    let changed = false;
    for (const k of TILE_GROUPS) {
      const v = g[k] === null ? null : `${k}-${hash(g[k] as string)}`;
      if (v !== next[k]) {
        next[k] = v;
        changed = true;
      }
    }
    if (!changed) return;
    this.gens = next;
    void this.removeStale();
  }

  generation(group: TileGroup): string | null {
    return this.gens[group];
  }

  /** File for an entry under the current generation, or null when its data is not loaded. */
  file(t: TileId | StoreKey): string | null {
    const k = storeKey(t);
    const g = this.gens[k.group];
    if (!g) return null;
    return path.join(this.root, g, k.rel);
  }

  /**
   * The saved answer (gzip bytes), or null. A file that is not a gzip
   * body (empty, or shorter than a gzip header and trailer, or without
   * the gzip magic) is a miss and is removed: an unclean shutdown leaves
   * files written in the seconds before it empty (ext4 delayed
   * allocation; brain, 2026-10-02: 363 empty tiles after a crash, served
   * as 200 with nothing in them, "Unexpected end of JSON input" on the
   * map).
   */
  async read(t: TileId | StoreKey): Promise<Buffer | null> {
    const f = this.file(t);
    if (!f) return null;
    try {
      const buf = await fs.promises.readFile(f);
      if (!isGzipBody(buf)) {
        this.corrupt++;
        this.misses++;
        fs.promises.rm(f, { force: true }).catch(() => undefined);
        if (this.totals) {
          this.totals.files = Math.max(0, this.totals.files - 1);
          this.totals.bytes = Math.max(0, this.totals.bytes - buf.length);
          this.scheduleSave();
        }
        return null;
      }
      this.hits++;
      const now = new Date();
      fs.promises.utimes(f, now, now).catch(() => undefined); // recency for pruning
      return buf;
    } catch {
      this.misses++;
      return null;
    }
  }

  /** Saved files found empty or not gzip (removed; see read). */
  corrupt = 0;

  /** Whether a tile is saved (no read). */
  async has(t: TileId | StoreKey): Promise<boolean> {
    const f = this.file(t);
    if (!f) return false;
    try {
      await fs.promises.access(f);
      return true;
    } catch {
      return false;
    }
  }

  /** Save an answer (gzip bytes). The generation is the one current when the query started. */
  async write(t: TileId | StoreKey, gz: Buffer, generation: string | null): Promise<void> {
    if (!generation || generation !== this.gens[storeKey(t).group]) return; // data changed meanwhile
    const f = this.file(t);
    if (!f) return;
    try {
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      await fs.promises.writeFile(tmp, gz);
      // A tile written again (after a corrupt read, or built by the prebuilder
      // and a page miss at once) replaces its file: the totals take the difference.
      let replaced = -1;
      if (this.totals || this.countDelta) {
        try {
          replaced = (await fs.promises.stat(f)).size;
        } catch {
          // new tile
        }
      }
      await fs.promises.rename(tmp, f);
      this.writes++;
      if (this.totals) {
        if (replaced < 0) this.totals.files++;
        this.totals.bytes = Math.max(0, this.totals.bytes + gz.length - Math.max(0, replaced));
        this.scheduleSave();
        if (this.totals.bytes > this.capBytes) void this.prune();
      }
      if (this.countDelta) {
        // A replacement adds only its growth; a shrink is not subtracted (see countDelta).
        if (replaced < 0) this.countDelta.files++;
        this.countDelta.bytes += Math.max(0, gz.length - Math.max(0, replaced));
      }
      this.ensureTotals(); // unknown or old totals: counted in the background (and the cap enforced after)
    } catch (err) {
      this.log(`overlay tiles: could not save ${f}: ${(err as Error).message}`);
    }
  }

  noteNotKept(): void {
    this.notKept++;
  }

  /** Walk a directory tree, visiting every saved tile (nothing is kept). */
  private async walk(dir: string, visit: (f: string, size: number, mtimeMs: number) => void): Promise<void> {
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(p, visit);
      else if (e.name.endsWith('.gz')) {
        try {
          const st = await fs.promises.stat(p);
          visit(p, st.size, st.mtimeMs);
        } catch {
          // gone since readdir
        }
      }
    }
  }

  /** Files and bytes below `dir`, counted while walking (no list). */
  private async count(dir: string): Promise<{ files: number; bytes: number }> {
    const c = { files: 0, bytes: 0 };
    await this.walk(dir, (_f, size) => {
      c.files++;
      c.bytes += size;
    });
    return c;
  }

  /** Every saved tile with size and last use: only for a prune over the cap. */
  private async list(): Promise<{ f: string; size: number; t: number }[]> {
    const out: { f: string; size: number; t: number }[] = [];
    await this.walk(this.root, (f, size, t) => out.push({ f, size, t }));
    return out;
  }

  /** Learn the totals with a count-only walk (one at a time), then enforce the cap. */
  private recount(): Promise<void> {
    if (this.counting) return this.counting;
    this.counting = (async () => {
      this.countDelta = { files: 0, bytes: 0 };
      const c = await this.count(this.root);
      const d = this.countDelta;
      this.countDelta = null;
      this.totals = { files: Math.max(0, c.files + d.files), bytes: Math.max(0, c.bytes + d.bytes) };
      this.staleTotals = false;
      this.scheduleSave();
      if (this.totals.bytes > this.capBytes) await this.prune();
    })().finally(() => {
      this.counting = null;
      this.countDelta = null;
    });
    return this.counting;
  }

  /** Remove directories of generations no longer current (their files are subtracted from the totals). */
  private async removeStale(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.root);
    } catch {
      return;
    }
    const keep = new Set(Object.values(this.gens).filter((g): g is string => !!g));
    let removed = 0;
    for (const n of names) {
      if (keep.has(n)) continue;
      // Only a group's own directories: a group whose data is not loaded yet keeps nothing.
      if (!TILE_GROUPS.some(g => n.startsWith(`${g}-`))) continue;
      const g = n.slice(0, n.indexOf('-')) as TileGroup;
      if (this.gens[g] === null) continue; // not known yet (startup): keep until it is
      const dir = path.join(this.root, n);
      // Counted and deleted in a child process: a superseded generation is
      // hundreds of thousands of files, and walking and deleting them here,
      // on Signal K's main thread, left 537 MB of malloc memory that was
      // never handed back (brain, 2026-10-06). The child's memory goes back
      // to the system when it exits. Subtracted only when the directory is
      // really gone: a failed removal leaves its files in the store.
      let gone: RmtreeResult | null;
      try {
        gone = await runChildTask({ task: 'rmtree', dir });
      } catch (err) {
        this.log(`overlay tiles: child process could not remove ${dir} (${(err as Error).message}); removing it here`);
        gone = await rmtree(dir).catch((e: Error) => {
          this.log(`overlay tiles: could not remove ${dir}: ${e.message}`);
          return null;
        });
      }
      if (!gone) continue;
      if (this.totals) {
        this.totals.files = Math.max(0, this.totals.files - gone.files);
        this.totals.bytes = Math.max(0, this.totals.bytes - gone.bytes);
        this.scheduleSave();
      }
      removed++;
    }
    if (removed) this.log(`overlay tiles: removed ${removed} superseded generation(s)`);
  }

  /** Remove least recently used tiles until under 90 % of the cap (the file list is built only then). */
  prune(): Promise<void> {
    if (this.pruning) return this.pruning;
    this.pruning = (async () => {
      const known = this.totals ?? (await this.count(this.root));
      if (known.bytes <= this.capBytes) {
        this.totals = known;
        this.staleTotals = false;
        this.scheduleSave();
        return;
      }
      const files = await this.list();
      let total = files.reduce((a, x) => a + x.size, 0);
      let count = files.length;
      if (total > this.capBytes) {
        const target = this.capBytes * 0.9;
        files.sort((a, b) => a.t - b.t);
        for (const x of files) {
          if (total <= target) break;
          await fs.promises.rm(x.f, { force: true }).catch(() => undefined);
          total -= x.size;
          count--;
        }
        this.log(`overlay tiles: pruned to ${(total / 1e9).toFixed(2)} GB (cap ${(this.capBytes / 1e9).toFixed(2)} GB)`);
      }
      this.totals = { files: count, bytes: total };
      this.staleTotals = false;
      this.scheduleSave();
    })().finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  /** Status; unknown (or old) totals start a background count. */
  stats(): TileStoreStats {
    this.ensureTotals();
    return {
      dir: this.root,
      cap_bytes: this.capBytes,
      files: this.totals?.files ?? 0,
      bytes: this.totals?.bytes ?? 0,
      hits: this.hits,
      misses: this.misses,
      corrupt: this.corrupt,
      writes: this.writes,
      not_kept: this.notKept,
      generations: { ...this.gens },
    };
  }
}

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** A plausible gzip body: at least a header and a trailer (18 bytes) and the gzip magic. */
export function isGzipBody(buf: Buffer): boolean {
  return buf.length >= 18 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** JSON that keeps Float64Array (Weather API tide series); NaN in them becomes null and back. */
function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Float64Array ? { __f64: Array.from(x, n => (Number.isFinite(n) ? n : null)) } : x));
}
function fromJson(s: string): unknown {
  return JSON.parse(s, (_k, x) =>
    x && typeof x === 'object' && Array.isArray((x as { __f64?: unknown }).__f64)
      ? Float64Array.from((x as { __f64: (number | null)[] }).__f64, n => (n === null ? NaN : n))
      : x
  );
}

/** A data-worker query that can be cancelled while queued; `complete` false: do not keep the answer. */
export type TileQueryFn = (
  kind: QueryKind,
  args: QueryArgs[QueryKind],
  signal?: AbortSignal
) => Promise<{ result: unknown; complete: boolean }>;

/** Encode a query answer as the tile's gzip body. */
export async function encodeTile(t: TileId, result: unknown): Promise<Buffer> {
  if (t.layer === 'land') {
    const u = result as Uint8Array;
    return gzip(Buffer.from(u.buffer, u.byteOffset, u.byteLength));
  }
  const body =
    t.layer === 'barbs' || t.layer === 'arrows' || t.layer === 'seas'
      ? trimPoints(result as { lon: number; lat: number }[], t.z, t.x, t.y)
      : result;
  return gzip(Buffer.from(JSON.stringify(body)));
}

function tileKey(t: TileId): string {
  return `${t.layer}/${t.z}/${t.x}/${t.y}/${t.layer === 'land' ? 0 : t.hourMs}`;
}

/**
 * Tiles from the store, else computed by the data worker and saved.
 * Identical requests in flight share one query; the query is cancelled
 * (if it has not started) when every requester has gone.
 */
export class TileService {
  private readonly inflight = new Map<string, { p: Promise<Buffer>; waiters: number; ctrl: AbortController }>();

  constructor(
    readonly store: TileStore,
    private readonly query: TileQueryFn
  ) {}

  async get(t: TileId, signal?: AbortSignal): Promise<{ gz: Buffer; cached: boolean }> {
    const saved = await this.store.read(t);
    if (saved) return { gz: saved, cached: true };
    if (signal?.aborted) throw new Error('cancelled'); // gone during the disk read: start nothing
    const key = tileKey(t);
    let f = this.inflight.get(key);
    if (!f) {
      const ctrl = new AbortController();
      const generation = this.store.generation(tileGroup(t.layer));
      const { kind, args } = tileQuery(t);
      const p = this.query(kind, args, ctrl.signal)
        .then(async ({ result, complete }) => {
          const gz = await encodeTile(t, result);
          if (complete) await this.store.write(t, gz, generation);
          else this.store.noteNotKept();
          return gz;
        })
        .finally(() => {
          if (this.inflight.get(key) === f) this.inflight.delete(key);
        });
      f = { p, waiters: 0, ctrl };
      this.inflight.set(key, f);
    }
    const entry = f;
    entry.waiters++;
    const onAbort = (): void => {
      if (--entry.waiters > 0) return;
      entry.ctrl.abort();
      // A later request for the same tile starts afresh rather than joining a cancelled query.
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return { gz: await entry.p, cached: false };
    } finally {
      if (!signal?.aborted) entry.waiters--;
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** A tile's answer decoded: JSON, or bytes for `land`. */
  async decoded(t: TileId, signal?: AbortSignal): Promise<unknown> {
    const { gz } = await this.get(t, signal);
    const raw = await gunzip(gz);
    return t.layer === 'land' ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : JSON.parse(raw.toString());
  }

  /**
   * A point answer (conditions, Weather API point forecast or tide
   * series, forecast samples) from the store, else from the data worker
   * and saved when complete. Keyed by the exact query.
   */
  async point(kind: QueryKind, args: QueryArgs[QueryKind], signal?: AbortSignal): Promise<unknown> {
    const json = JSON.stringify(args);
    const k: StoreKey = { group: 'pt', rel: path.join(kind, `${hash(json)}.gz`) };
    const saved = await this.store.read(k);
    if (saved) return fromJson((await gunzip(saved)).toString());
    if (signal?.aborted) throw new Error('cancelled');
    const key = `pt/${kind}/${json}`;
    let f = this.inflight.get(key);
    if (!f) {
      const ctrl = new AbortController();
      const generation = this.store.generation('pt');
      const p = this.query(kind, args, ctrl.signal)
        .then(async ({ result, complete }) => {
          const gz = await gzip(Buffer.from(toJson(result)));
          if (complete) await this.store.write(k, gz, generation);
          else this.store.noteNotKept();
          return gz;
        })
        .finally(() => {
          if (this.inflight.get(key) === f) this.inflight.delete(key);
        });
      f = { p, waiters: 0, ctrl };
      this.inflight.set(key, f);
    }
    const entry = f;
    entry.waiters++;
    const onAbort = (): void => {
      if (--entry.waiters > 0) return;
      entry.ctrl.abort();
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return fromJson((await gunzip(await entry.p)).toString());
    } finally {
      if (!signal?.aborted) entry.waiters--;
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Tile queries waiting or running. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Requesters waiting on a tile's in-flight query (0 when none is in flight; tests). */
  waiters(t: TileId): number {
    return this.inflight.get(tileKey(t))?.waiters ?? 0;
  }
}
