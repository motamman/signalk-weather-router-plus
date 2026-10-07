/**
 * Copernicus Marine ARCO Zarr datasets: the parts shared by every
 * gridded (time, latitude, longitude) product the plugin reads from the
 * anonymous ARCO stores (CMEMS SMOC currents in currents/smoc.ts, the
 * hourly sea level in tides/sealevel.ts). Each dataset publishes the
 * same data in three layouts:
 *   timeChunked.zarr   chunks 1 h × 512 × 2048 cells (wide areas, few hours)
 *   geoChunked.zarr    chunks thousands of hours × 16 × 8..16 cells (point series)
 *   downsampled4.zarr  1/3° grid, one chunk per hour for the globe
 *
 * This module holds what does not depend on the variables:
 *  - the run (the store's time axis, identified by its last step, and
 *    whether the daily update has finished writing: STAC
 *    `admp_updated_data` / `admp_updating_start_date` against the
 *    `.zmetadata` Last-Modified);
 *  - grid-index regions for a bounding box (longitude wraps);
 *  - the client: probe, per-run disk cache of compressed chunks
 *    (cacheDir/<run>/<layout>/<var>/<chunk key>), parallel downloads;
 *  - the layout cost model and area loading (decode + crop the chunks
 *    covering a region at given steps into SharedArrayBuffers, one
 *    Float32Array per variable, [step][row][col], NaN = no data);
 *  - the area set: a resident area plus an LRU of on-demand areas under
 *    a memory budget, with de-duplicated loads and bilinear-ready lookup.
 */

import * as fs from 'node:fs';
import { norm360, lonOffset } from '../geo/angles';
import { HOUR_MS } from '../geo/units';
import * as path from 'node:path';
import { bboxWidth, type BBox } from '../geo/geodesy';
import { sharedFloat32 } from './forecast';
import {
  type ChunkScratch,
  chunkKey,
  decodeChunk,
  httpGet,
  parseCfTimeUnits,
  ZarrHttpStore,
  type ConsolidatedStore,
  type ZarrArrayMeta,
  type ZarrHttpOptions,
} from './zarr';

/** Linear-in-time sampling answers up to this long beyond the first / last step. */
export const GRACE_MS = HOUR_MS;

export type ArcoLayout = 'time' | 'geo' | 'ds4';
export type ArcoResolution = 'full' | 'ds4';

export interface ArcoGrid {
  /** Latitude of row 0 (southernmost), degrees. */
  lat0: number;
  dLat: number;
  nLat: number;
  /** Longitude of column 0, degrees. */
  lon0: number;
  dLon: number;
  nLon: number;
  /** Columns span the full circle. */
  wrap: boolean;
}

export interface ArcoLevel {
  layout: ArcoLayout;
  url: string;
  grid: ArcoGrid;
  /** Variable name → array metadata (all the dataset's variables share shape and chunking). */
  meta: Record<string, ZarrArrayMeta>;
  /** Position of time / latitude / longitude in the array dimensions (others have length 1). */
  dims: { time: number; lat: number; lon: number; rank: number };
}

export interface ArcoRun {
  /** yyyymmddHH of the last time step. */
  key: string;
  timeFirstMs: number;
  timeStepMs: number;
  timeCount: number;
  levels: { time: ArcoLevel; geo: ArcoLevel | null; ds4: ArcoLevel | null };
  /** STAC properties.admp_updated_data (null when STAC was unreachable). */
  stacUpdated: string | null;
  /** STAC reports an update in progress. */
  stacUpdating: boolean;
  /** timeChunked `.zmetadata` Last-Modified / ETag. */
  metadataModified: string | null;
  metadataEtag: string | null;
  /** The update that produced this run has finished writing (see the file comment). */
  settled: boolean;
  probedAt: string;
}

export function runLastMs(run: ArcoRun): number {
  return run.timeFirstMs + (run.timeCount - 1) * run.timeStepMs;
}

function ymdh(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '');
}

/** Store time index of `ms`, or -1 when that instant is not on the time axis. */
export function timeIndex(run: ArcoRun, ms: number): number {
  const q = (ms - run.timeFirstMs) / run.timeStepMs;
  const i = Math.round(q);
  if (Math.abs(q - i) > 1e-9 || i < 0 || i >= run.timeCount) return -1;
  return i;
}

/** Instant of store time index `i`. */
export function timeAt(run: ArcoRun, i: number): number {
  return run.timeFirstMs + i * run.timeStepMs;
}

/**
 * Step times from `fromMs` to `toMs` at `stepHours`, aligned to whole
 * multiples of the step in UTC: the first step is at or before `fromMs`,
 * the last at or after `toMs`. Only instants on the store's time axis.
 */
export function alignedSteps(run: ArcoRun, fromMs: number, toMs: number, stepHours: number): number[] {
  const stepMs = stepHours * HOUR_MS;
  const start = Math.floor(fromMs / stepMs) * stepMs;
  const end = Math.ceil(toMs / stepMs) * stepMs;
  const out: number[] = [];
  for (let t = start; t <= end; t += stepMs) if (timeIndex(run, t) >= 0) out.push(t);
  return out;
}

// ─────────────── regions (grid index boxes) ───────────────

export interface Region {
  row0: number;
  nRows: number;
  /** First column (0 .. nLon-1); the region may wrap past the last column. */
  col0: number;
  nCols: number;
}

export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Grid-index box covering `bbox` plus `margin` cells, or null when it misses the grid (e.g. south of 80°S). */
export function regionForBBox(grid: ArcoGrid, bbox: BBox, margin: number): Region | null {
  let r0 = Math.floor((bbox.south - grid.lat0) / grid.dLat) - margin;
  let r1 = Math.ceil((bbox.north - grid.lat0) / grid.dLat) + margin;
  r0 = Math.max(0, r0);
  r1 = Math.min(grid.nLat - 1, r1);
  if (r0 > r1) return null;
  const width = bboxWidth(bbox);
  const x0 = lonOffset(bbox.west, grid.lon0) / grid.dLon;
  let c0 = Math.floor(x0) - margin;
  let c1 = Math.ceil(x0 + width / grid.dLon) + margin;
  let nCols = c1 - c0 + 1;
  if (grid.wrap) {
    if (nCols >= grid.nLon) {
      c0 = 0;
      nCols = grid.nLon;
    } else c0 = mod(c0, grid.nLon);
  } else {
    c0 = Math.max(0, c0);
    c1 = Math.min(grid.nLon - 1, c1);
    if (c0 > c1) return null;
    nCols = c1 - c0 + 1;
  }
  return { row0: r0, nRows: r1 - r0 + 1, col0: c0, nCols };
}

/** Does `outer` contain every cell of `inner` (columns modulo nLon)? */
export function regionContains(outer: Region, inner: Region, nLon: number): boolean {
  if (inner.row0 < outer.row0 || inner.row0 + inner.nRows > outer.row0 + outer.nRows) return false;
  if (outer.nCols >= nLon) return true;
  if (inner.nCols > outer.nCols) return false;
  const off = mod(inner.col0 - outer.col0, nLon);
  return off + inner.nCols <= outer.nCols;
}

export interface GeoBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Geographic extent of a region's cell centres (east may exceed 180 across the antimeridian). */
export function regionBBox(grid: ArcoGrid, r: Region): GeoBox {
  const west = grid.lon0 + r.col0 * grid.dLon;
  return {
    south: grid.lat0 + r.row0 * grid.dLat,
    north: grid.lat0 + (r.row0 + r.nRows - 1) * grid.dLat,
    west,
    east: west + (r.nCols - 1) * grid.dLon,
  };
}

export function fmtBox(b: GeoBox): string {
  return `${b.south.toFixed(2)}..${b.north.toFixed(2)}N ${b.west.toFixed(2)}..${b.east.toFixed(2)}E`;
}

export function gridForRes(run: ArcoRun, res: ArcoResolution, tag = 'arco'): ArcoGrid {
  if (res === 'ds4') {
    if (!run.levels.ds4) throw new Error(`${tag}: no downsampled level`);
    return run.levels.ds4.grid;
  }
  return run.levels.time.grid;
}

// ─────────────── areas ───────────────

export interface ArcoArea extends Region {
  id: string;
  res: ArcoResolution;
  /** Layout the chunks came from. */
  layout: ArcoLayout;
  runKey: string;
  stepMs: number[];
  /** Variable → [step][row][col], NaN = no data. SharedArrayBuffer-backed. */
  data: Record<string, Float32Array>;
  /** Geographic extent of the cells (east may exceed 180 across the antimeridian). */
  bbox: GeoBox;
  reason: string;
}

/** Bytes held by an area (each distinct buffer once). */
export function arcoAreaBytes(a: Pick<ArcoArea, 'data'>): number {
  const seen = new Set<ArrayBufferLike>();
  let b = 0;
  for (const arr of Object.values(a.data)) {
    if (seen.has(arr.buffer)) continue;
    seen.add(arr.buffer);
    b += arr.byteLength;
  }
  return b;
}

export function areaId(res: ArcoResolution, r: Region, steps: number[]): string {
  return `${res}|${r.row0},${r.nRows},${r.col0},${r.nCols}|${steps.length ? `${steps[0]}+${steps.length}x${steps.length > 1 ? steps[1] - steps[0] : 0}` : '-'}`;
}

// ─────────────── client (network + disk cache) ───────────────

export interface ArcoUrls {
  time: string;
  geo: string;
  ds4: string;
  stac: string;
}

/** ARCO store URLs of a Copernicus Marine dataset. */
export function arcoUrls(product: string, dataset: string, timeBucket = 'mdl-arco-time-015', geoBucket = 'mdl-arco-geo-015'): ArcoUrls {
  const base = 'https://s3.waw3-1.cloudferro.com';
  return {
    time: `${base}/${timeBucket}/arco/${product}/${dataset}/timeChunked.zarr`,
    geo: `${base}/${geoBucket}/arco/${product}/${dataset}/geoChunked.zarr`,
    ds4: `${base}/${timeBucket}/arco/${product}/${dataset}/downsampled4.zarr`,
    stac: `https://stac.marine.copernicus.eu/metadata/${product}/${dataset}/dataset.stac.json`,
  };
}

export interface ArcoClientOptions {
  cacheDir: string;
  urls: ArcoUrls;
  /** Variables this client reads; each must exist with the same shape and chunking. */
  vars: readonly string[];
  /** Log / error prefix, e.g. 'smoc'. */
  tag: string;
  timeoutMs?: number;
  retries?: number;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Parallel chunk downloads. */
  concurrency?: number;
  /** false: never touch the network (disk cache only). */
  network?: boolean;
}

export interface DownloadStats {
  chunks: number;
  downloaded: number;
  fromDisk: number;
  absent: number;
  bytes: number;
  decodeMs: number;
  seconds: number;
}

export function emptyStats(): DownloadStats {
  return { chunks: 0, downloaded: 0, fromDisk: 0, absent: 0, bytes: 0, decodeMs: 0, seconds: 0 };
}

function checkDims(meta: ZarrArrayMeta, name: string, tag: string): ArcoLevel['dims'] {
  const dims = meta.attrs._ARRAY_DIMENSIONS as string[] | undefined;
  if (!Array.isArray(dims) || dims.length !== meta.shape.length) throw new Error(`${tag}: ${name} has no _ARRAY_DIMENSIONS`);
  const t = dims.indexOf('time');
  const la = dims.indexOf('latitude');
  const lo = dims.indexOf('longitude');
  if (t < 0 || la < 0 || lo < 0) throw new Error(`${tag}: ${name} dimensions ${dims.join(',')} lack time/latitude/longitude`);
  dims.forEach((d, i) => {
    if (i !== t && i !== la && i !== lo && meta.shape[i] !== 1)
      throw new Error(`${tag}: ${name} dimension ${d} has length ${meta.shape[i]} (want 1)`);
  });
  if (!(la < lo)) throw new Error(`${tag}: ${name}: latitude must come before longitude`);
  return { time: t, lat: la, lon: lo, rank: dims.length };
}

/** Regular grid from coordinate vectors (ascending latitude and longitude). */
export function gridFromCoords(lat: Float64Array, lon: Float64Array, tag = 'arco'): ArcoGrid {
  const reg = (a: Float64Array, what: string): { a0: number; d: number } => {
    if (a.length < 2) throw new Error(`${tag}: ${what} has ${a.length} values`);
    const d = (a[a.length - 1] - a[0]) / (a.length - 1);
    if (!(d > 0)) throw new Error(`${tag}: ${what} is not ascending`);
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - (a[0] + i * d)) > d * 1e-2) throw new Error(`${tag}: ${what} is not regular at index ${i}`);
    }
    return { a0: a[0], d };
  };
  const la = reg(lat, 'latitude');
  const lo = reg(lon, 'longitude');
  const wrap = Math.abs(lon.length * lo.d - 360) < lo.d * 1e-2;
  return { lat0: la.a0, dLat: la.d, nLat: lat.length, lon0: lo.a0, dLon: wrap ? 360 / lon.length : lo.d, nLon: lon.length, wrap };
}

/** STAC properties of interest. */
export interface StacInfo {
  updatedData: string | null;
  updatingStart: string | null;
}

export function parseStac(doc: unknown): StacInfo {
  const p = (doc as { properties?: Record<string, unknown> })?.properties ?? {};
  const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return { updatedData: s(p.admp_updated_data), updatingStart: s(p.admp_updating_start_date) };
}

/**
 * Has the update behind this metadata finished? No STAC → assume yes;
 * STAC reports an update in progress → no; the data were last updated
 * before the metadata was rewritten → no (chunks still being written).
 */
export function isSettled(stac: StacInfo | null, metadataModifiedMs: number | null): boolean {
  if (!stac) return true;
  if (stac.updatingStart) return false;
  if (stac.updatedData && metadataModifiedMs !== null) {
    const u = Date.parse(stac.updatedData);
    if (!Number.isNaN(u) && u < metadataModifiedMs) return false;
  }
  return true;
}

export class ArcoClient {
  readonly cacheDir: string;
  readonly urls: ArcoUrls;
  readonly network: boolean;
  readonly vars: readonly string[];
  readonly tag: string;
  protected readonly http: ZarrHttpOptions;
  private readonly stores: { time: ZarrHttpStore; geo: ZarrHttpStore; ds4: ZarrHttpStore };
  protected readonly log: (msg: string) => void;
  private readonly concurrency: number;
  /** Totals since construction. */
  readonly totals = { downloadedBytes: 0, downloadedChunks: 0, diskChunks: 0 };

  constructor(opts: ArcoClientOptions) {
    if (opts.vars.length === 0) throw new Error(`${opts.tag}: no variables`);
    this.cacheDir = opts.cacheDir;
    this.urls = opts.urls;
    this.vars = [...opts.vars];
    this.tag = opts.tag;
    this.network = opts.network ?? true;
    this.log = opts.log ?? (() => undefined);
    this.concurrency = opts.concurrency ?? 6;
    this.http = {
      timeoutMs: opts.timeoutMs ?? 120_000,
      retries: opts.retries ?? 6,
      log: this.log,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      tag: opts.tag,
    };
    this.stores = {
      time: new ZarrHttpStore(this.urls.time, this.http),
      geo: new ZarrHttpStore(this.urls.geo, this.http),
      ds4: new ZarrHttpStore(this.urls.ds4, this.http),
    };
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private async level(
    layout: ArcoLayout,
    cons: ConsolidatedStore
  ): Promise<{ level: ArcoLevel; time: Float64Array; timeMeta: ZarrArrayMeta }> {
    const store = this.stores[layout];
    const need = (n: string): ZarrArrayMeta => {
      const m = cons.arrays.get(n);
      if (!m) throw new Error(`${this.tag}: ${layout} store has no ${n}`);
      return m;
    };
    const v0 = this.vars[0];
    const m0 = need(v0);
    const dims = checkDims(m0, v0, this.tag);
    const meta: Record<string, ZarrArrayMeta> = { [v0]: m0 };
    for (const v of this.vars.slice(1)) {
      const m = need(v);
      const d = checkDims(m, v, this.tag);
      if (
        JSON.stringify(m.shape) !== JSON.stringify(m0.shape) ||
        JSON.stringify(m.chunks) !== JSON.stringify(m0.chunks) ||
        d.time !== dims.time ||
        d.lat !== dims.lat ||
        d.lon !== dims.lon
      ) {
        throw new Error(`${this.tag}: ${layout}: ${v0} and ${v} differ in shape or chunking`);
      }
      meta[v] = m;
    }
    const latM = need('latitude');
    const lonM = need('longitude');
    const timeM = need('time');
    const [lat, lon, time] = await Promise.all([
      store.read1d('latitude', latM),
      store.read1d('longitude', lonM),
      store.read1d('time', timeM),
    ]);
    const grid = gridFromCoords(lat, lon, this.tag);
    if (m0.shape[dims.lat] !== grid.nLat || m0.shape[dims.lon] !== grid.nLon || m0.shape[dims.time] !== time.length) {
      throw new Error(`${this.tag}: ${layout}: ${v0} shape ${m0.shape.join('×')} does not match the coordinates`);
    }
    return { level: { layout, url: store.baseUrl, grid, meta, dims }, time, timeMeta: timeM };
  }

  private async stac(): Promise<StacInfo | null> {
    try {
      const res = await httpGet(this.urls.stac, { ...this.http, retries: 2, timeoutMs: 30_000 });
      if (res.status !== 200) return null;
      return parseStac(JSON.parse(Buffer.from(res.body).toString('utf8')));
    } catch (err) {
      this.log(`${this.tag}: STAC record unavailable (${(err as Error).message}); cannot tell whether an update is in progress`);
      return null;
    }
  }

  /**
   * Current store state. When the timeChunked `.zmetadata` ETag equals
   * `prev`'s, the coordinates are not re-read (only STAC is re-checked).
   */
  async probe(prev: ArcoRun | null = null): Promise<ArcoRun> {
    if (!this.network) throw new Error(`${this.tag}: network disabled`);
    const cons = await this.stores.time.consolidated();
    const stac = await this.stac();
    const metaModified = cons.lastModifiedMs !== null ? new Date(cons.lastModifiedMs).toISOString() : null;
    const settled = isSettled(stac, cons.lastModifiedMs);
    if (prev && cons.etag && prev.metadataEtag === cons.etag) {
      return {
        ...prev,
        stacUpdated: stac?.updatedData ?? null,
        stacUpdating: !!stac?.updatingStart,
        settled,
        probedAt: new Date().toISOString(),
      };
    }
    const t = await this.level('time', cons);
    const tm = t.timeMeta;
    const { unitMs, epochMs } = parseCfTimeUnits(String(tm.attrs.units ?? ''), tm.attrs.calendar as string | undefined);
    const times = t.time;
    for (let i = 0; i < times.length; i++) if (!Number.isFinite(times[i])) throw new Error(`${this.tag}: time[${i}] is not finite`);
    const firstMs = epochMs + times[0] * unitMs;
    const stepMs = times.length > 1 ? (times[1] - times[0]) * unitMs : HOUR_MS;
    for (let i = 1; i < times.length; i++) {
      if (Math.abs((times[i] - times[i - 1]) * unitMs - stepMs) > 1) throw new Error(`${this.tag}: time axis is not regular at index ${i}`);
    }
    if (stepMs !== HOUR_MS) throw new Error(`${this.tag}: time step ${stepMs / 1000} s (want hourly)`);
    const sameAxis = async (layout: 'geo' | 'ds4'): Promise<ArcoLevel | null> => {
      try {
        const lv = await this.level(layout, await this.stores[layout].consolidated());
        const tt = lv.time;
        const ok = tt.length === times.length && tt[0] === times[0] && tt[tt.length - 1] === times[times.length - 1];
        if (!ok) {
          this.log(`${this.tag}: ${layout} store time axis differs from timeChunked (${tt.length} vs ${times.length} steps); not used`);
          return null;
        }
        if (layout === 'geo') {
          const g = lv.level.grid;
          const tg = t.level.grid;
          if (g.nLat !== tg.nLat || g.nLon !== tg.nLon || Math.abs(g.lat0 - tg.lat0) > 1e-6 || Math.abs(g.lon0 - tg.lon0) > 1e-6) {
            this.log(`${this.tag}: geoChunked grid differs from timeChunked; not used`);
            return null;
          }
        }
        return lv.level;
      } catch (err) {
        this.log(`${this.tag}: ${layout} store unavailable: ${(err as Error).message}`);
        return null;
      }
    };
    const [geo, ds4] = await Promise.all([sameAxis('geo'), sameAxis('ds4')]);
    return {
      key: ymdh(firstMs + (times.length - 1) * stepMs),
      timeFirstMs: firstMs,
      timeStepMs: stepMs,
      timeCount: times.length,
      levels: { time: t.level, geo, ds4 },
      stacUpdated: stac?.updatedData ?? null,
      stacUpdating: !!stac?.updatingStart,
      metadataModified: metaModified,
      metadataEtag: cons.etag,
      settled,
      probedAt: new Date().toISOString(),
    };
  }

  private runDir(key: string): string {
    return path.join(this.cacheDir, key);
  }

  /** Save the run description next to its chunks (offline restarts reuse it). */
  saveRun(run: ArcoRun): void {
    const dir = this.runDir(run.key);
    fs.mkdirSync(dir, { recursive: true });
    // Random part: the data and route workers are threads of one process (same pid).
    const tmp = path.join(dir, `run.json.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp, JSON.stringify(run));
    fs.renameSync(tmp, path.join(dir, 'run.json'));
  }

  /** Cached runs, newest first. */
  cachedRuns(): ArcoRun[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch {
      return [];
    }
    const out: ArcoRun[] = [];
    for (const e of entries
      .filter(x => /^\d{10}$/.test(x))
      .sort()
      .reverse()) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.runDir(e), 'run.json'), 'utf8')) as ArcoRun);
      } catch {
        // chunks without a run description: unusable
      }
    }
    return out;
  }

  /** Delete every cached run except `keep`. */
  pruneRuns(keep: string[]): string[] {
    const keepSet = new Set(keep);
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch {
      return removed;
    }
    for (const e of entries) {
      if (!/^\d{10}$/.test(e) || keepSet.has(e)) continue;
      fs.rmSync(this.runDir(e), { recursive: true, force: true });
      removed.push(e);
    }
    return removed;
  }

  /** Remove one run's cached chunks (a provisional run being replaced by its settled version). */
  dropRun(key: string): void {
    fs.rmSync(this.runDir(key), { recursive: true, force: true });
  }

  /** Bytes cached on disk for a run. */
  cachedBytes(key: string): number {
    let total = 0;
    const walk = (d: string): void => {
      let es: fs.Dirent[];
      try {
        es = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          // The other worker may rename or prune files while this walks.
          try {
            total += fs.statSync(p).size;
          } catch {
            // gone since readdir
          }
        }
      }
    };
    walk(this.runDir(key));
    return total;
  }

  /** Directory for derived per-run files (e.g. decoded point series), created on demand. */
  runFile(run: ArcoRun, ...parts: string[]): string {
    const p = path.join(this.runDir(run.key), ...parts);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  }

  chunkPath(run: ArcoRun, layout: ArcoLayout, v: string, key: string): string {
    return path.join(this.runDir(run.key), layout, v, key);
  }

  /**
   * Stored bytes of one chunk: disk cache first, else downloaded (and
   * cached, atomically). null = chunk absent in the store (all fill).
   * The disk cache is used only for a settled run: a run whose update
   * is still being written is always downloaded and never cached, so
   * its in-flight loads cannot repopulate the cache after dropRun().
   */
  async chunk(run: ArcoRun, layout: ArcoLayout, v: string, idx: number[], stats: DownloadStats): Promise<Uint8Array | null> {
    const level = run.levels[layout];
    if (!level) throw new Error(`${this.tag}: layout ${layout} unavailable`);
    const meta = level.meta[v];
    if (!meta) throw new Error(`${this.tag}: variable ${v} not in the ${layout} level`);
    const key = chunkKey(meta, idx);
    const p = this.chunkPath(run, layout, v, key);
    if (run.settled) {
      try {
        const b = new Uint8Array(fs.readFileSync(p));
        stats.fromDisk++;
        this.totals.diskChunks++;
        return b;
      } catch {
        // not cached
      }
      if (fs.existsSync(`${p}.none`)) {
        stats.absent++;
        return null;
      }
    }
    if (!this.network) throw new Error(`${this.tag}: chunk ${layout}/${v}/${key} is not cached and the network is disabled`);
    const store = this.stores[layout];
    const body = await store.chunkBytes(v, meta, idx);
    if (body === null) {
      stats.absent++;
      if (run.settled) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(`${p}.none`, '');
      }
      return null;
    }
    if (run.settled) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, p);
    }
    stats.downloaded++;
    stats.bytes += body.length;
    this.totals.downloadedBytes += body.length;
    this.totals.downloadedChunks++;
    return body;
  }

  /** Run `jobs` with at most `concurrency` in flight. */
  async pool<T>(items: T[], fn: (item: T) => Promise<void>, shouldCancel?: () => boolean): Promise<void> {
    let next = 0;
    let failed: unknown = null;
    const worker = async (): Promise<void> => {
      while (failed === null && next < items.length) {
        if (shouldCancel?.()) throw new Error(`${this.tag} load cancelled`);
        const it = items[next++];
        try {
          await fn(it);
        } catch (err) {
          failed = err;
          throw err;
        }
      }
    };
    const n = Math.min(this.concurrency, items.length);
    const results = await Promise.allSettled(Array.from({ length: n }, worker));
    const bad = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (bad) throw bad.reason;
  }
}

// ─────────────── area loading ───────────────

interface ColRun {
  cc: number;
  local0: number;
  g0: number;
  len: number;
}

function firstMeta(level: ArcoLevel): ZarrArrayMeta {
  const m = Object.values(level.meta)[0];
  if (!m) throw new Error('arco: level without variables');
  return m;
}

function colRuns(level: ArcoLevel, r: Region): ColRun[] {
  const cc = firstMeta(level).chunks[level.dims.lon];
  const nLon = level.grid.nLon;
  const out: ColRun[] = [];
  for (let c = 0; c < r.nCols; c++) {
    const g = (r.col0 + c) % nLon;
    const k = Math.floor(g / cc);
    const last = out[out.length - 1];
    if (last && last.cc === k && last.g0 + last.len === g) last.len++;
    else out.push({ cc: k, local0: c, g0: g, len: 1 });
  }
  return out;
}

export interface ChunkJob {
  tc: number;
  rc: number;
  run: ColRun;
  steps: number[];
}

/**
 * Chunks needed for a region × time indices on a layout: the jobs, the
 * chunk elements that hold data and the number of chunk requests, for
 * `nVars` variables.
 */
export function planChunks(
  level: ArcoLevel,
  r: Region,
  tIdx: number[],
  timeCount: number,
  nVars = 1
): { jobs: ChunkJob[]; elements: number; requests: number } {
  const ch = firstMeta(level).chunks;
  const ct = ch[level.dims.time];
  const cr = ch[level.dims.lat];
  const perChunk = ch.reduce((a, b) => a * b, 1);
  const byTc = new Map<number, number[]>();
  tIdx.forEach((ti, s) => {
    const tc = Math.floor(ti / ct);
    const l = byTc.get(tc) ?? [];
    l.push(s);
    byTc.set(tc, l);
  });
  const runs = colRuns(level, r);
  const rc0 = Math.floor(r.row0 / cr);
  const rc1 = Math.floor((r.row0 + r.nRows - 1) / cr);
  const jobs: ChunkJob[] = [];
  let elements = 0;
  let requests = 0;
  for (const [tc, steps] of byTc) {
    // Time chunks at the end of the axis hold only the existing steps
    // (the rest is fill and compresses to nothing): weight by that.
    const valid = Math.min(timeCount, (tc + 1) * ct) - tc * ct;
    for (let rc = rc0; rc <= rc1; rc++) {
      // Runs in the same chunk column split by the wrap are separate jobs sharing one chunk (fetched once).
      for (const run of runs) jobs.push({ tc, rc, run, steps });
      const uniqueCc = new Set(runs.map(x => x.cc)).size;
      elements += uniqueCc * (perChunk / ct) * valid;
      requests += uniqueCc;
    }
  }
  return { jobs, elements: elements * nVars, requests: requests * nVars };
}

/**
 * Download cost model for choosing a layout, in bytes: compressed bytes
 * per data element (measured on the SMOC store, 2026-09-28: timeChunked
 * ≈ 0.85 B, geoChunked ≈ 1.4 B, since geo chunks are small and compress
 * worse) plus a per-request overhead equivalent (latency; measured
 * ≈ 0.04 s per request at 6 in flight, dominant for many small chunks).
 */
export const LAYOUT_BYTES_PER_ELEMENT: Record<ArcoLayout, number> = { time: 0.85, geo: 1.4, ds4: 0.85 };
export const REQUEST_COST_BYTES = 64 * 1024;

export function layoutCost(level: ArcoLevel, r: Region, tIdx: number[], timeCount: number, nVars = 1): number {
  const p = planChunks(level, r, tIdx, timeCount, nVars);
  return p.elements * LAYOUT_BYTES_PER_ELEMENT[level.layout] + p.requests * REQUEST_COST_BYTES;
}

/** Pick the layout for a full-resolution load: the lower estimated download cost (layoutCost). */
export function chooseLayout(run: ArcoRun, r: Region, tIdx: number[]): ArcoLayout {
  if (!run.levels.geo) return 'time';
  const t = layoutCost(run.levels.time, r, tIdx, run.timeCount);
  const g = layoutCost(run.levels.geo, r, tIdx, run.timeCount);
  return g < t ? 'geo' : 'time';
}

export interface LoadAreaOptions {
  reason: string;
  log?: (m: string) => void;
  shouldCancel?: () => boolean;
  /** Force a layout (point series: geo; tests); default: chooseLayout. */
  layout?: ArcoLayout;
  /** Plain ArrayBuffers instead of SharedArrayBuffers (data never shared with another thread). */
  unshared?: boolean;
}

/**
 * Decode buffers shared by every loadRegion on this thread (each worker has
 * its own module instance). A chunk is decoded and copied into the area in
 * one synchronous stretch, so one scratch suffices; it stays at the largest
 * chunk size seen (timeChunked: 4 MB of bytes + 4 MB of values).
 */
const chunkScratch: ChunkScratch = { raw: null, out: null };

/**
 * Fetch (disk cache or network), decode and crop the chunks covering
 * `region` at the given store time indices into one Float32Array per
 * variable, [step][row][col].
 */
export async function loadRegion(
  client: ArcoClient,
  run: ArcoRun,
  res: ArcoResolution,
  region: Region,
  tIdx: number[],
  vars: readonly string[],
  opts: LoadAreaOptions
): Promise<{ layout: ArcoLayout; data: Record<string, Float32Array>; stats: DownloadStats }> {
  const t0 = Date.now();
  const layout: ArcoLayout = res === 'ds4' ? 'ds4' : (opts.layout ?? chooseLayout(run, region, tIdx));
  const level = run.levels[layout];
  if (!level) throw new Error(`${client.tag}: layout ${layout} unavailable`);
  const grid = level.grid;
  const nCells = region.nRows * region.nCols;
  const data: Record<string, Float32Array> = {};
  for (const v of vars) {
    if (!level.meta[v]) throw new Error(`${client.tag}: variable ${v} not in the ${layout} level`);
    data[v] = (opts.unshared ? new Float32Array(tIdx.length * nCells) : sharedFloat32(tIdx.length * nCells)).fill(NaN);
  }
  const ch = firstMeta(level).chunks;
  const ct = ch[level.dims.time];
  const cr = ch[level.dims.lat];
  const cc = ch[level.dims.lon];
  // Strides of the chunk array in C order.
  const strides = new Array<number>(ch.length);
  let st = 1;
  for (let d = ch.length - 1; d >= 0; d--) {
    strides[d] = st;
    st *= ch[d];
  }
  const { jobs } = planChunks(level, region, tIdx, run.timeCount, vars.length);
  // One fetch per distinct chunk; jobs sharing a chunk (wrap) scatter from the same decode.
  const byChunk = new Map<string, ChunkJob[]>();
  for (const j of jobs) {
    const k = `${j.tc}|${j.rc}|${j.run.cc}`;
    const l = byChunk.get(k) ?? [];
    l.push(j);
    byChunk.set(k, l);
  }
  const stats = emptyStats();
  const work: { v: string; jobs: ChunkJob[] }[] = [];
  for (const variable of vars) for (const js of byChunk.values()) work.push({ v: variable, jobs: js });
  stats.chunks = work.length;
  try {
    await client.pool(
      work,
      async ({ v: variable, jobs: js }) => {
        const j0 = js[0];
        const idx = new Array<number>(level.dims.rank).fill(0);
        idx[level.dims.time] = j0.tc;
        idx[level.dims.lat] = j0.rc;
        idx[level.dims.lon] = j0.run.cc;
        const stored = await client.chunk(run, layout, variable, idx, stats);
        if (stored === null) return; // all fill: the area stays NaN there
        const td = Date.now();
        // Decoded into the shared scratch and copied out below before the next await.
        const vals = decodeChunk(level.meta[variable], stored, chunkScratch);
        const dst = data[variable];
        const rowLo = Math.max(region.row0, j0.rc * cr);
        const rowHi = Math.min(region.row0 + region.nRows - 1, j0.rc * cr + cr - 1, grid.nLat - 1);
        for (const j of js) {
          for (const s of j.steps) {
            const tl = tIdx[s] - j.tc * ct;
            const base = s * nCells;
            for (let gr = rowLo; gr <= rowHi; gr++) {
              const rl = gr - j.rc * cr;
              const src0 =
                tl * strides[level.dims.time] + rl * strides[level.dims.lat] + (j.run.g0 - j.run.cc * cc) * strides[level.dims.lon];
              const dst0 = base + (gr - region.row0) * region.nCols + j.run.local0;
              for (let k = 0; k < j.run.len; k++) dst[dst0 + k] = vals[src0 + k];
            }
          }
        }
        stats.decodeMs += Date.now() - td;
        // Let other messages interleave between chunks.
        await new Promise(r => setImmediate(r));
      },
      opts.shouldCancel
    );
  } finally {
    // Shared across this load's chunks only: a worker does not keep 8 MB between loads, failed ones included.
    chunkScratch.raw = null;
    chunkScratch.out = null;
  }
  stats.seconds = (Date.now() - t0) / 1000;
  return { layout, data, stats };
}

/** loadRegion at step instants, as an area. */
export async function loadArcoArea(
  client: ArcoClient,
  run: ArcoRun,
  res: ArcoResolution,
  region: Region,
  stepMs: number[],
  vars: readonly string[],
  opts: LoadAreaOptions
): Promise<{ area: ArcoArea; stats: DownloadStats }> {
  const tIdx = stepMs.map(t => {
    const i = timeIndex(run, t);
    if (i < 0) throw new Error(`${client.tag}: ${new Date(t).toISOString()} is not on the store time axis`);
    return i;
  });
  const { layout, data, stats } = await loadRegion(client, run, res, region, tIdx, vars, opts);
  const grid = gridForRes(run, res, client.tag);
  const bbox = regionBBox(grid, region);
  const area: ArcoArea = {
    ...region,
    id: areaId(res, region, stepMs),
    res,
    layout,
    runKey: run.key,
    stepMs: [...stepMs],
    data,
    bbox,
    reason: opts.reason,
  };
  opts.log?.(
    `${client.tag}: ${opts.reason}: ${res === 'ds4' ? '1/3°' : '1/12°'} area ${fmtBox(bbox)} (${region.nRows}×${region.nCols} cells, ${stepMs.length} steps) from ${layout}: ` +
      `${stats.chunks} chunks (${stats.downloaded} downloaded ${(stats.bytes / 1e6).toFixed(2)} MB, ${stats.fromDisk} from disk, ${stats.absent} absent), ` +
      `decode ${stats.decodeMs} ms, ${(arcoAreaBytes(area) / 1e6).toFixed(1)} MB in memory, ${stats.seconds.toFixed(1)} s`
  );
  return { area, stats };
}

// ─────────────── sampling helpers ───────────────

/**
 * Bracketing steps and weight for `tMs`: [i0, i1, w] with value =
 * (1 − w)·s[i0] + w·s[i1]; the end values are held for GRACE_MS beyond
 * the first / last step; null outside.
 */
export function timeWeights(steps: number[], tMs: number): [number, number, number] | null {
  const n = steps.length;
  if (n === 0) return null;
  if (tMs < steps[0] - GRACE_MS || tMs > steps[n - 1] + GRACE_MS) return null;
  if (tMs <= steps[0]) return [0, 0, 0];
  if (tMs >= steps[n - 1]) return [n - 1, n - 1, 0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (steps[mid] <= tMs) lo = mid;
    else hi = mid;
  }
  return [lo, lo + 1, (tMs - steps[lo]) / (steps[lo + 1] - steps[lo])];
}

export { bilinearCorners } from './sampling';

// ─────────────── area set (resident + on-demand LRU) ───────────────

export interface DownloadNote {
  at: string;
  reason: string;
  bytes: number;
  chunks: number;
  downloaded: number;
  from_disk: number;
  seconds: number;
  decode_ms: number;
}

export interface AreaSetOptions<A extends ArcoArea> {
  /** Variables each area holds. */
  vars: readonly string[];
  /** On-demand memory budget (bytes); one area may take at most half. */
  budgetBytes: number;
  tag: string;
  log?: (m: string) => void;
  /** Wrap a freshly loaded area (e.g. add typed shortcuts). */
  wrap: (a: ArcoArea) => A;
}

/**
 * The data of one run held in memory: a resident area (set from outside,
 * e.g. around the vessel) and on-demand areas (LRU under a budget)
 * loaded by `ensure`. Lookup order: full resolution first (resident,
 * then most recent), then 1/3°.
 */
export class ArcoAreaSet<A extends ArcoArea> {
  readonly run: ArcoRun;
  private readonly client: ArcoClient | null;
  private readonly opts: AreaSetOptions<A>;
  private readonly log: (m: string) => void;
  private residentArea: A | null = null;
  private centre: { lat: number; lon: number } | null = null;
  /** On-demand areas, most recently used first. */
  private lru: A[] = [];
  private pending = new Map<string, Promise<A | null>>();
  private rev = 0;
  /** On-demand areas dropped so far (budget eviction, trim, expiry): a query compares it around its sampling. */
  private evicted = 0;
  lastDownload: DownloadNote | null = null;

  constructor(run: ArcoRun, client: ArcoClient | null, opts: AreaSetOptions<A>) {
    this.run = run;
    this.client = client;
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  get revision(): number {
    return this.rev;
  }

  get evictions(): number {
    return this.evicted;
  }

  get resident(): A | null {
    return this.residentArea;
  }

  get residentCentre(): { lat: number; lon: number } | null {
    return this.centre;
  }

  get onDemandAreas(): readonly A[] {
    return this.lru;
  }

  get budgetBytes(): number {
    return this.opts.budgetBytes;
  }

  grid(res: ArcoResolution): ArcoGrid {
    return gridForRes(this.run, res, this.opts.tag);
  }

  setResident(area: A | null, centre: { lat: number; lon: number } | null): void {
    if (area && area.runKey !== this.run.key)
      throw new Error(`${this.opts.tag}: resident area of run ${area.runKey} for source of run ${this.run.key}`);
    this.residentArea = area;
    this.centre = centre;
    this.rev++;
  }

  areas(): A[] {
    const full: A[] = [];
    const coarse: A[] = [];
    if (this.residentArea) full.push(this.residentArea);
    for (const a of this.lru) (a.res === 'full' ? full : coarse).push(a);
    return full.concat(coarse);
  }

  /** Does the area span the full circle of longitude? */
  wraps(a: A): boolean {
    return a.nCols >= this.grid(a.res).nLon;
  }

  /** Fractional local cell coordinates of (lon, lat) in `a`, or null outside it. */
  local(a: A, lon: number, lat: number): [number, number] | null {
    const g = this.grid(a.res);
    const y = (lat - g.lat0) / g.dLat - a.row0;
    if (!(y >= 0 && y <= a.nRows - 1)) return null;
    const xg = lonOffset(lon, g.lon0) / g.dLon;
    if (a.nCols >= g.nLon) return [xg, y];
    const x = mod(xg - a.col0, g.nLon);
    if (x > a.nCols - 1) return null;
    return [x, y];
  }

  find(lon: number, lat: number, tMs: number): { a: A; x: number; y: number; tw: [number, number, number] } | null {
    for (const a of this.areas()) {
      const p = this.local(a, lon, lat);
      if (!p) continue;
      const tw = timeWeights(a.stepMs, tMs);
      if (!tw) continue;
      return { a, x: p[0], y: p[1], tw };
    }
    return null;
  }

  contains(lon: number, lat: number): boolean {
    for (const a of this.areas()) if (this.local(a, lon, lat)) return true;
    return false;
  }

  private covered(res: ArcoResolution, region: Region, steps: number[]): A | null {
    const nLon = this.grid(res).nLon;
    for (const a of this.areas()) {
      if (a.res !== res) continue;
      if (!regionContains(a, region, nLon)) continue;
      const have = new Set(a.stepMs);
      if (steps.every(t => have.has(t))) return a;
    }
    return null;
  }

  memoryBytes(): number {
    let b = this.residentArea ? arcoAreaBytes(this.residentArea) : 0;
    for (const a of this.lru) b += arcoAreaBytes(a);
    return b;
  }

  onDemandBytes(): number {
    return this.lru.reduce((s, a) => s + arcoAreaBytes(a), 0);
  }

  /**
   * Make `bbox` × `steps` resident (on demand), with `marginCells` of
   * extra cells around the box. Resolves true once the data are in
   * memory (or already were), false when there is nothing to load (no
   * steps, outside the grid, no client). With `deadlineMs`, resolves
   * false when the load takes longer; it then completes in the
   * background and serves later queries. `coarseOk` (a zoomed-out
   * view) takes the 1/3° level when it fits. `onIncomplete` is called
   * when the answer will lack data it should have (deadline passed or the
   * load failed), so the caller does not keep that answer.
   */
  async ensure(
    bbox: BBox,
    steps: number[],
    marginCells: number,
    opts: { reason: string; deadlineMs?: number; shouldCancel?: () => boolean; coarseOk?: boolean; onIncomplete?: () => void }
  ): Promise<boolean> {
    if (steps.length === 0) return false;
    const full = regionForBBox(this.run.levels.time.grid, bbox, marginCells);
    if (!full) return false;
    if (this.covered('full', full, steps)) return true;
    const maxArea = this.opts.budgetBytes / 2;
    let res: ArcoResolution = 'full';
    let region = full;
    const bytesFor = (r: Region): number => r.nRows * r.nCols * steps.length * 4 * this.opts.vars.length;
    // A coarse overlay view takes the 1/3° level: one chunk per variable and hour for the whole globe.
    const coarse = opts.coarseOk && this.run.levels.ds4 ? regionForBBox(this.run.levels.ds4.grid, bbox, marginCells) : null;
    if (coarse && bytesFor(coarse) <= maxArea) {
      res = 'ds4';
      region = coarse;
      if (this.covered('ds4', coarse, steps)) return true;
    } else if (bytesFor(full) > maxArea) {
      const ds = this.run.levels.ds4 ? regionForBBox(this.run.levels.ds4.grid, bbox, marginCells) : null;
      if (!ds || bytesFor(ds) > maxArea) {
        throw new Error(
          `${this.opts.tag}: ${opts.reason}: area ${bboxWidth(bbox).toFixed(1)}° × ${(bbox.north - bbox.south).toFixed(1)}° over ${steps.length} steps needs ${(bytesFor(full) / 1e6).toFixed(0)} MB at 1/12°${ds ? ` (${(bytesFor(ds) / 1e6).toFixed(0)} MB at 1/3°)` : ''}, over the ${(maxArea / 1e6).toFixed(0)} MB per-area cap`
        );
      }
      res = 'ds4';
      region = ds;
      if (this.covered('ds4', ds, steps)) return true;
    }
    if (!this.client) return false;
    const id = areaId(res, region, steps);
    let p = this.pending.get(id);
    if (!p) {
      const client = this.client;
      p = loadArcoArea(client, this.run, res, region, steps, this.opts.vars, {
        reason: opts.reason,
        log: this.log,
        shouldCancel: opts.shouldCancel,
      })
        .then(({ area, stats }) => {
          this.noteDownload(opts.reason, stats);
          const a = this.opts.wrap(area);
          this.addOnDemand(a);
          return a;
        })
        .finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    if (opts.deadlineMs === undefined) {
      await p;
      return true;
    }
    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<null>(r => {
      timer = setTimeout(() => r(null), opts.deadlineMs);
    });
    p.catch(err => this.log(`${this.opts.tag}: ${opts.reason}: load failed: ${(err as Error).message}`));
    const got = await Promise.race([p.catch(() => null), deadline]);
    if (timer) clearTimeout(timer);
    if (got === null) opts.onIncomplete?.();
    if (got === null)
      this.log(
        `${this.opts.tag}: ${opts.reason}: still loading after ${(opts.deadlineMs / 1000).toFixed(0)} s; answering without it (the area is used once loaded)`
      );
    return got !== null;
  }

  noteDownload(reason: string, s: DownloadStats): void {
    this.lastDownload = {
      at: new Date().toISOString(),
      reason,
      bytes: s.bytes,
      chunks: s.chunks,
      downloaded: s.downloaded,
      from_disk: s.fromDisk,
      seconds: s.seconds,
      decode_ms: s.decodeMs,
    };
  }

  private addOnDemand(area: A): void {
    this.lru = [area, ...this.lru.filter(a => a.id !== area.id)];
    let total = this.onDemandBytes();
    while (total > this.opts.budgetBytes && this.lru.length > 1) {
      const gone = this.lru.pop()!;
      this.evicted++;
      total -= arcoAreaBytes(gone);
      this.log(
        `${this.opts.tag}: evicted on-demand area ${fmtBox(gone.bbox)} (${(arcoAreaBytes(gone) / 1e6).toFixed(1)} MB; budget ${(this.opts.budgetBytes / 1e6).toFixed(0)} MB)`
      );
    }
    this.rev++;
  }

  /**
   * Drop least recently used on-demand areas until they hold at most
   * `maxBytes` (0 drops them all). The data worker trims to a small set
   * after each query; the route worker drops its route areas when the
   * route ends. Returns the bytes released.
   */
  trimOnDemand(maxBytes: number): number {
    let total = this.onDemandBytes();
    let released = 0;
    while (total > maxBytes && this.lru.length > 0) {
      const gone = this.lru.pop()!;
      this.evicted++;
      const b = arcoAreaBytes(gone);
      total -= b;
      released += b;
    }
    if (released > 0) {
      this.rev++;
      this.log(`${this.opts.tag}: released ${(released / 1e6).toFixed(1)} MB of on-demand areas (kept ${(total / 1e6).toFixed(1)} MB)`);
    }
    return released;
  }

  /** Drop on-demand areas whose steps all lie before `nowMs − grace` (they can no longer answer). */
  expire(nowMs: number): void {
    const before = this.lru.length;
    this.lru = this.lru.filter(a => a.stepMs.length && a.stepMs[a.stepMs.length - 1] + GRACE_MS >= nowMs);
    if (this.lru.length !== before) {
      this.rev++;
      this.evicted += before - this.lru.length;
    }
  }

  /** Status pieces shared by the sources. */
  statusParts(): {
    resident: {
      bbox: GeoBox;
      centre: { lat: number; lon: number } | null;
      steps: number;
      valid_from: string | null;
      valid_to: string | null;
      bytes: number;
      layout: ArcoLayout;
    } | null;
    on_demand: {
      areas: number;
      bytes: number;
      budget_bytes: number;
      list: { bbox: GeoBox; res: ArcoResolution; steps: number; bytes: number; reason: string }[];
    };
    memory_bytes: number;
  } {
    const r = this.residentArea;
    return {
      resident: r
        ? {
            bbox: r.bbox,
            centre: this.centre,
            steps: r.stepMs.length,
            valid_from: r.stepMs.length ? new Date(r.stepMs[0]).toISOString() : null,
            valid_to: r.stepMs.length ? new Date(r.stepMs[r.stepMs.length - 1]).toISOString() : null,
            bytes: arcoAreaBytes(r),
            layout: r.layout,
          }
        : null,
      on_demand: {
        areas: this.lru.length,
        bytes: this.onDemandBytes(),
        budget_bytes: this.opts.budgetBytes,
        list: this.lru.map(a => ({ bbox: a.bbox, res: a.res, steps: a.stepMs.length, bytes: arcoAreaBytes(a), reason: a.reason })),
      },
      memory_bytes: this.memoryBytes(),
    };
  }
}

/** Resident region: position ± half-width (latitude clamped to the grid). */
export function residentBBox(lat: number, lon: number, halfWidthDeg: number): BBox {
  const south = Math.max(-90, lat - halfWidthDeg);
  const north = Math.min(90, lat + halfWidthDeg);
  const w = Math.min(180, halfWidthDeg);
  return { south, north, west: lon - w, east: lon + w };
}

/**
 * Should a resident area be rebuilt? When there is none (and a position
 * is known), when its steps differ from the window's, or when the vessel
 * has moved more than a third of the half-width from the centre it was
 * built around.
 */
export function residentAreaStale(
  area: ArcoArea | null,
  centre: { lat: number; lon: number } | null,
  halfWidthDeg: number,
  pos: { lat: number; lon: number } | null,
  steps: number[]
): boolean {
  if (!pos) return false;
  if (!area) return true;
  if (area.stepMs.length !== steps.length || area.stepMs.some((t, i) => t !== steps[i])) return true;
  if (!centre) return true;
  const dLon = Math.abs(norm360(pos.lon - centre.lon + 180) - 180);
  return Math.abs(pos.lat - centre.lat) > halfWidthDeg / 3 || dLon > halfWidthDeg / 3;
}
