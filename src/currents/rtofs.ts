/**
 * NOAA Global RTOFS depth-averaged (barotropic) currents from the
 * regional GRIB2 products on NOMADS:
 *
 *   https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod/rtofs.YYYYMMDD/
 *       rtofs_glo.t00z.f024_<region>_std.grb2   hours 1..24, hourly
 *       rtofs_glo.t00z.f048_<region>_std.grb2   hours 25..48
 *       rtofs_glo.t00z.f072_<region>_std.grb2   hours 49..72
 *       rtofs_glo.t00z.f144_<region>_std.grb2   hours 75..144, 3-hourly
 *
 * Each file is a regular lat/lon grid (west_atl: 0.08°, 100°W to 54°W,
 * 10°N to 44.8°N, ~38 MB) with simple packing and a bit map over land.
 * Fields used: `ubaro` (discipline 10, category 1, number 194) and
 * `vbaro` (10, 1, 195), m/s, depth-averaged velocities.
 *
 * Which products are loaded: the one that contains the vessel (the finest
 * where two overlap), plus any the user adds. Each product's extent is
 * read from the grid definition in the first few kilobytes of its f024
 * file (a range request), kept in extents.json in the cache directory,
 * and updated whenever a decoded file's grid differs.
 *
 * Sampling: linear in time between bracketing steps with a ±1 h grace
 * beyond the ends, and (0, 0) for "no data". Spatially, bilinear on the
 * regular grid.
 */

import * as fs from 'node:fs';
import { fetchWithRetry, isOffline, sleep } from '../data/http';
import { lonOffset, wrapLon } from '../geo/angles';
import { HOUR_MS, HOUR_S } from '../geo/units';
import * as path from 'node:path';
import type { BBox } from '../geo/geodesy';
import { iterateGrib2, parseGrib2Grid, type Grib2Grid } from '../grib/grib2';
import { cropField, type FieldGrid, sampleField, sharedFloat32 } from '../data/forecast';
import { type CurrentSourceLike, type SourceBBox } from './types';
import { sampleFieldPairFilled } from './coastfill';

export const RTOFS_REGIONS = [
  'west_atl',
  'west_conus',
  'alaska',
  'arctic',
  'bering',
  'guam',
  'gulf_alaska',
  'honolulu',
  'hudson_baffin',
  'samoa',
  'trop_paci_lowres',
] as const;
export type RtofsRegion = (typeof RTOFS_REGIONS)[number];

export const RTOFS_BASE = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod';

/**
 * A product's extent as its grid says: the latitudes, the first column's
 * longitude (−180..180) and the last column's as that plus the grid's
 * width (so above 180 for a product across the antimeridian), and the
 * grid spacing.
 */
export interface RtofsExtent extends SourceBBox {
  dLon: number;
  dLat: number;
}

/**
 * The extent of a product's grid, with the decoder's arithmetic (the first
 * row and column plus the count of steps, as cropField and extentOfField
 * place them), not the last point the header codes: west_atl codes 44.8°N
 * for a last row that 435 rows of 0.08° put at 44.72°N.
 */
export function rtofsExtentOfGrid(g: Grib2Grid): RtofsExtent {
  const west = wrapLon(g.lo1);
  const span = (g.nj - 1) * g.dj;
  const south = g.jScansPositively ? g.la1 : g.la1 - span;
  return { south, north: south + span, west, east: west + (g.ni - 1) * g.di, dLon: g.di, dLat: g.dj };
}

/** The extent of a decoded (whole-product or cropped) field: west −180..180, east = west + its width. */
export function extentOfField(g: FieldGrid): SourceBBox {
  return { south: g.lat0, west: g.lon0, north: g.lat0 + (g.nLat - 1) * g.dLat, east: g.lon0 + (g.nLon - 1) * g.dLon };
}

/** Is (lon, lat) inside the extent? Longitudes are compared as offsets east of its west edge, across the antimeridian. */
export function extentContains(b: SourceBBox, lon: number, lat: number): boolean {
  return lat >= b.south && lat <= b.north && lonOffset(lon, b.west) <= b.east - b.west;
}

/** Does the extent meet the box (longitudes compared across the antimeridian)? */
export function extentMeets(b: SourceBBox, box: SourceBBox): boolean {
  if (box.north < b.south || box.south > b.north) return false;
  const bw = b.east - b.west;
  const aw = lonOffset(box.east, box.west);
  return lonOffset(box.west, b.west) <= bw || lonOffset(b.west, box.west) <= aw;
}

/** The products whose extent is known, finest grid first (the order of RTOFS_REGIONS between equals). */
export function finestFirst(products: readonly string[], extents: Readonly<Record<string, RtofsExtent>>): string[] {
  const cell = (p: string): number => (extents[p] ? extents[p].dLon * extents[p].dLat : Infinity);
  const rank = (p: string): number => (RTOFS_REGIONS as readonly string[]).indexOf(p);
  return [...products].sort((a, b) => cell(a) - cell(b) || rank(a) - rank(b));
}

/**
 * The product to load for the vessel: the finest whose extent contains its
 * position. `product` null with the reason when there is no position, or
 * no product (of those whose extent is known) contains it.
 */
export function chooseRtofsProduct(
  extents: Readonly<Record<string, RtofsExtent>>,
  pos: { lat: number; lon: number } | null
): { product: string | null; reason: string | null } {
  if (!pos) return { product: null, reason: 'no vessel position' };
  const inside = RTOFS_REGIONS.filter(r => extents[r] && extentContains(extents[r], pos.lon, pos.lat));
  if (inside.length) return { product: finestFirst(inside, extents)[0], reason: null };
  const unknown = RTOFS_REGIONS.filter(r => !extents[r]);
  const at = `${pos.lat.toFixed(2)}, ${pos.lon.toFixed(2)}`;
  return {
    product: null,
    reason: unknown.length
      ? `no RTOFS product known to cover the vessel at ${at} (the extent of ${unknown.join(', ')} is not known yet)`
      : `no RTOFS product covers the vessel at ${at}`,
  };
}

/** The extents kept in the cache directory (extents.json), by product. */
export function readRtofsExtents(cacheDir: string): Record<string, RtofsExtent> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, 'extents.json'), 'utf8')) as Record<string, RtofsExtent>;
    const out: Record<string, RtofsExtent> = {};
    for (const r of RTOFS_REGIONS) {
      const e = raw[r];
      if (e && [e.south, e.north, e.west, e.east, e.dLon, e.dLat].every(Number.isFinite)) out[r] = e;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the extents (atomic: the data worker writes, the other workers and the mesh process only read). */
export function writeRtofsExtents(cacheDir: string, extents: Record<string, RtofsExtent>): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, 'extents.json');
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(extents, null, 2));
  fs.renameSync(tmp, file);
}

const sameExtent = (a: RtofsExtent, b: RtofsExtent): boolean =>
  (['south', 'north', 'west', 'east', 'dLon', 'dLat'] as const).every(k => Math.abs(a[k] - b[k]) < 1e-6);

/**
 * Every product's extent: those kept in extents.json, and (with the
 * network) the missing ones read from the first bytes of the newest
 * published f024 file. Returns the extents and the products still unknown.
 * Throws OfflineError when there is no connection.
 */
export async function loadRtofsExtents(
  cacheDir: string,
  opts: {
    network: boolean;
    now?: Date;
    maxDaysBack?: number;
    log?: (m: string) => void;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  }
): Promise<{ extents: Record<string, RtofsExtent>; unknown: string[] }> {
  const extents = readRtofsExtents(cacheDir);
  let changed = false;
  try {
    if (opts.network) {
      const now = opts.now ?? new Date();
      for (const region of RTOFS_REGIONS) {
        if (extents[region]) continue;
        const client = new RtofsClient({ cacheDir, region, log: opts.log, fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl });
        try {
          for (let d = 0; d <= (opts.maxDaysBack ?? 7); d++) {
            const e = await client.fetchExtent(rtofsRunFor(new Date(now.getTime() - d * 86_400_000)));
            if (!e) continue;
            extents[region] = e;
            changed = true;
            opts.log?.(
              `rtofs: ${region} covers ${e.south}..${e.north}°N, ${e.west}..${wrapLon(e.east)}°E (grid ${e.dLon.toFixed(3)}° × ${e.dLat.toFixed(3)}°)`
            );
            break;
          }
        } catch (err) {
          // No connection fails the whole discovery; one product's failure leaves it unknown and goes on to the next.
          if (isOffline(err)) throw err;
          opts.log?.(`rtofs: could not read the extent of ${region}: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    if (changed) writeRtofsExtents(cacheDir, extents);
  }
  return { extents, unknown: RTOFS_REGIONS.filter(r => !extents[r]) };
}

/** Record the extent a decoded file showed, when it differs from the one kept (the product's grid changed). True when it did. */
export function noteRtofsExtent(cacheDir: string, region: string, e: RtofsExtent): boolean {
  const extents = readRtofsExtents(cacheDir);
  if (extents[region] && sameExtent(extents[region], e)) return false;
  extents[region] = e;
  writeRtofsExtents(cacheDir, extents);
  return true;
}

/** Daily files and the forecast hours they carry. */
export const RTOFS_FILES: { name: string; hours: number[] }[] = [
  { name: 'f024', hours: Array.from({ length: 24 }, (_, i) => i + 1) },
  { name: 'f048', hours: Array.from({ length: 24 }, (_, i) => i + 25) },
  { name: 'f072', hours: Array.from({ length: 24 }, (_, i) => i + 49) },
  { name: 'f144', hours: Array.from({ length: 24 }, (_, i) => 75 + 3 * i) },
];

export interface RtofsRun {
  /** Run date at 00Z. */
  time: Date;
  yyyymmdd: string;
}

export function rtofsRunFor(t: Date): RtofsRun {
  const day = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, '0');
  const d = String(day.getUTCDate()).padStart(2, '0');
  return { time: day, yyyymmdd: `${y}${m}${d}` };
}

export interface RtofsClientOptions {
  cacheDir: string;
  region: RtofsRegion | string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Read the cache only, never the network: a file not in it fails at once (another process reading what the data
   * worker downloaded, currents/fromcache.ts). Without it, a missing file is downloaded.
   */
  cacheOnly?: boolean;
}

export class RtofsClient {
  readonly cacheDir: string;
  readonly region: string;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly cacheOnly: boolean;

  constructor(opts: RtofsClientOptions) {
    this.cacheDir = opts.cacheDir;
    this.region = opts.region;
    this.baseUrl = (opts.baseUrl ?? RTOFS_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.retries = opts.retries ?? 6;
    this.log = opts.log ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.cacheOnly = opts.cacheOnly ?? false;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  fileUrl(run: RtofsRun, file: string): string {
    return `${this.baseUrl}/rtofs.${run.yyyymmdd}/rtofs_glo.t00z.${file}_${this.region}_std.grb2`;
  }

  cachePath(run: RtofsRun, file: string): string {
    return path.join(this.cacheDir, run.yyyymmdd, `${file}_${this.region}.grb2`);
  }

  /**
   * Fetch with timeout and retries. The body is read inside the attempt
   * (data/http.ts: after the headers, the timeout spent), so a body-read
   * failure is retried like a failed connection.
   */
  private async request(url: string, init: RequestInit = {}): Promise<{ status: number; body: Uint8Array }> {
    const r = await fetchWithRetry(url, init, {
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      fetchImpl: this.fetchImpl,
      sleepImpl: this.sleepImpl,
      log: this.log,
      tag: 'rtofs',
      readBody: init.method !== 'HEAD',
    });
    return { status: r.status, body: r.body ?? new Uint8Array(0) };
  }

  /**
   * The product's extent from the grid definition at the start of the run's
   * f024 file: its first HEAD_BYTES only (a range request; a server that
   * sends the whole file is read no further). Null when the file is not
   * published.
   */
  async fetchExtent(run: RtofsRun): Promise<RtofsExtent | null> {
    if (this.cacheOnly) throw new Error(`${this.region}: a cache-only client cannot read the extent of run ${run.yyyymmdd}`);
    const url = this.fileUrl(run, 'f024');
    const r = await fetchWithRetry(
      url,
      { headers: { Range: `bytes=0-${RtofsClient.HEAD_BYTES - 1}` } },
      {
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        fetchImpl: this.fetchImpl,
        sleepImpl: this.sleepImpl,
        log: this.log,
        tag: 'rtofs',
      }
    );
    if (r.status === 404 || r.status === 403) {
      await r.response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (r.status !== 206 && r.status !== 200) {
      await r.response.body?.cancel().catch(() => undefined);
      throw new Error(`unexpected HTTP ${r.status} reading the start of ${url}`);
    }
    const head = new Uint8Array(RtofsClient.HEAD_BYTES);
    let n = 0;
    const reader = r.response.body?.getReader();
    if (reader) {
      // fetchWithRetry's timeout ends with the headers (no readBody here: only the first bytes are wanted), so a
      // stream that stalls after them is cancelled here: the read then ends, and the short head fails to parse. A
      // stalled read would otherwise hold the data worker's refresh, and every refresh after it (PR #68 review).
      const stall = setTimeout(() => void reader.cancel().catch(() => undefined), this.timeoutMs);
      try {
        while (n < head.length) {
          const { done, value } = await reader.read();
          if (done) break;
          const take = Math.min(value.length, head.length - n);
          head.set(value.subarray(0, take), n);
          n += take;
        }
      } finally {
        clearTimeout(stall);
        await reader.cancel().catch(() => undefined);
      }
    }
    return rtofsExtentOfGrid(parseGrib2Grid(head.subarray(0, n)));
  }

  /** Bytes read from the start of a file for its grid definition (sections 0–3 are about 120 bytes). */
  static readonly HEAD_BYTES = 4096;

  async filePublished(run: RtofsRun, file: string): Promise<boolean> {
    if (this.cacheOnly)
      throw new Error(`${this.region}: a cache-only client cannot check whether run ${run.yyyymmdd} ${file} is published`);
    const res = await this.request(this.fileUrl(run, file), { method: 'HEAD' });
    if (res.status === 200) return true;
    if (res.status === 404 || res.status === 403) return false;
    throw new Error(`unexpected HTTP ${res.status} probing ${this.fileUrl(run, file)}`);
  }

  /** Files needed to cover `horizonHours`. */
  static filesFor(horizonHours: number): { name: string; hours: number[] }[] {
    const out: { name: string; hours: number[] }[] = [];
    for (const f of RTOFS_FILES) {
      if (f.hours[0] > horizonHours) break;
      out.push({ name: f.name, hours: f.hours.filter(h => h <= horizonHours) });
    }
    return out;
  }

  hasCached(run: RtofsRun, file: string): boolean {
    const p = this.cachePath(run, file);
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const head = Buffer.alloc(4);
        return fs.readSync(fd, head, 0, 4, 0) === 4 && head.toString('latin1') === 'GRIB';
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  runFullyCached(run: RtofsRun, horizonS: number): boolean {
    return RtofsClient.filesFor(horizonS / HOUR_S).every(f => this.hasCached(run, f.name));
  }

  /** Runs present in the cache, newest first. */
  cachedRuns(): RtofsRun[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch {
      return [];
    }
    return entries
      .filter(e => /^\d{8}$/.test(e))
      .sort()
      .reverse()
      .map(e => rtofsRunFor(new Date(Date.UTC(+e.slice(0, 4), +e.slice(4, 6) - 1, +e.slice(6, 8)))));
  }

  /**
   * Newest run (today, walking back up to `maxDaysBack` days) whose files
   * for the horizon are all published.
   */
  async findLatestRun(horizonS: number, opts: { now?: Date; maxDaysBack?: number } = {}): Promise<RtofsRun> {
    const now = opts.now ?? new Date();
    const files = RtofsClient.filesFor(horizonS / HOUR_S);
    const last = files[files.length - 1].name;
    for (let d = 0; d <= (opts.maxDaysBack ?? 7); d++) {
      const run = rtofsRunFor(new Date(now.getTime() - d * 86_400_000));
      if (await this.filePublished(run, last)) return run;
    }
    throw new Error(`no RTOFS run with ${last} published in the last ${opts.maxDaysBack ?? 7} days`);
  }

  /** Download one daily file to the cache (atomic), returning its bytes. */
  async fetchFile(run: RtofsRun, file: string): Promise<Uint8Array> {
    const cached = this.cachePath(run, file);
    if (this.hasCached(run, file)) return new Uint8Array(fs.readFileSync(cached));
    if (this.cacheOnly) throw new Error(`${this.region} run ${run.yyyymmdd} ${file} is not in the cache`);
    const url = this.fileUrl(run, file);
    const t = Date.now();
    const res = await this.request(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const buf = res.body;
    if (!(buf[0] === 0x47 && buf[1] === 0x52 && buf[2] === 0x49 && buf[3] === 0x42)) throw new Error(`${url}: body is not GRIB`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    // The data and route workers are threads of one process (same pid): add a random part.
    const tmp = `${cached}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, cached);
    this.log(`rtofs: fetched ${file} (${(buf.length / 1e6).toFixed(1)} MB) in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return buf;
  }

  pruneCache(keep: RtofsRun[]): void {
    const keepSet = new Set(keep.map(r => r.yyyymmdd));
    for (const r of this.cachedRuns()) {
      if (!keepSet.has(r.yyyymmdd)) fs.rmSync(path.join(this.cacheDir, r.yyyymmdd), { recursive: true, force: true });
    }
  }
}

export interface RtofsStep {
  validMs: number;
  u: FieldGrid;
  v: FieldGrid;
}

/**
 * The steps with their values moved into SharedArrayBuffers, so the run can
 * be relayed to the other workers without a copy (as SMOC): the data worker
 * loads RTOFS once and every worker samples the same memory. Before, each
 * worker loaded its own copy (brain, 2026-10-06: 46 MB × 4 workers).
 */
export function shareRtofsSteps(steps: RtofsStep[]): RtofsStep[] {
  const share = (g: FieldGrid): FieldGrid => {
    if (g.values.buffer instanceof SharedArrayBuffer) return g;
    const v = sharedFloat32(g.values.length);
    v.set(g.values);
    return { ...g, values: v };
  };
  return steps.map(s => ({ validMs: s.validMs, u: share(s.u), v: share(s.v) }));
}

export interface SerializedRtofs {
  product: string;
  runMs: number;
  bbox: SourceBBox;
  steps: RtofsStep[];
}

/**
 * The products the data worker loaded (finest first), with the extra
 * products setting they were loaded under: relayed to the route and tiles
 * workers as one message.
 */
export interface SerializedRtofsSet {
  extra: string[];
  runs: SerializedRtofs[];
}

/**
 * The relayed set when it was loaded under the current settings, else
 * null: a set loaded before a currents settings change can still arrive
 * after it and must not be used.
 */
export function rtofsSetForConfig(s: SerializedRtofsSet | null, enabled: boolean, extra: readonly string[]): SerializedRtofsSet | null {
  return s && enabled && s.extra.length === extra.length && s.extra.every((p, i) => p === extra[i]) ? s : null;
}

const UBARO = { discipline: 10, category: 1, number: 194 };
const VBARO = { discipline: 10, category: 1, number: 195 };

/**
 * Decode ubaro/vbaro for the requested hours from the daily files and
 * crop to `bbox` (null = keep the whole product grid). Missing
 * (bit-mapped) cells become NaN.
 */
export async function loadRtofsSteps(
  client: RtofsClient,
  run: RtofsRun,
  bbox: BBox | null,
  horizonS: number,
  stepS: number,
  opts: { log?: (m: string) => void; shouldCancel?: () => boolean } = {}
): Promise<RtofsStep[]> {
  const horizonHours = horizonS / HOUR_S;
  const stepHours = stepS / HOUR_S;
  const wanted = new Set<number>();
  for (let h = stepHours; h <= horizonHours; h += stepHours) wanted.add(h);
  const steps: RtofsStep[] = [];
  for (const f of RtofsClient.filesFor(horizonHours)) {
    if (!f.hours.some(h => wanted.has(h))) continue;
    if (opts.shouldCancel?.()) throw new Error('rtofs load cancelled');
    const buf = await client.fetchFile(run, f.name);
    const byHour = new Map<number, { u?: FieldGrid; v?: FieldGrid; validMs: number }>();
    for (const msg of iterateGrib2(buf)) {
      const p = msg.product;
      const isU = p.discipline === UBARO.discipline && p.parameterCategory === UBARO.category && p.parameterNumber === UBARO.number;
      const isV = p.discipline === VBARO.discipline && p.parameterCategory === VBARO.category && p.parameterNumber === VBARO.number;
      if (!isU && !isV) continue;
      const h = p.forecastHours;
      if (!wanted.has(h)) continue;
      const g = msg.grid;
      const grid = bbox
        ? cropField(g, msg.decode(), bbox, 1)
        : cropField(
            g,
            msg.decode(),
            { west: g.lo1, east: g.lo1 + (g.ni - 1) * g.di, south: Math.min(g.la1, g.la2), north: Math.max(g.la1, g.la2) },
            0
          );
      const entry = byHour.get(h) ?? { validMs: msg.referenceTime.getTime() + h * HOUR_MS };
      if (isU) entry.u = grid;
      else entry.v = grid;
      byHour.set(h, entry);
    }
    for (const [h, e] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
      if (!e.u || !e.v) throw new Error(`rtofs ${f.name}: hour ${h} lacks ubaro or vbaro`);
      steps.push({ validMs: e.validMs, u: e.u, v: e.v });
    }
    await new Promise(r => setImmediate(r));
  }
  steps.sort((a, b) => a.validMs - b.validMs);
  opts.log?.(
    `rtofs: ${steps.length} steps decoded for run ${run.yyyymmdd} (${steps.length ? new Date(steps[0].validMs).toISOString() : '-'} .. ${steps.length ? new Date(steps[steps.length - 1].validMs).toISOString() : '-'})`
  );
  return steps;
}

export class RtofsCurrentSource implements CurrentSourceLike {
  /** The regional product (one of RTOFS_REGIONS); the source is named RTOFS-<product>. */
  readonly product: string;
  readonly name: string;
  readonly priority = 2;
  readonly resolutionM = 9000;
  /** The product's extent: east above 180 for a product across the antimeridian (extentContains). */
  readonly bbox: SourceBBox;
  readonly runMs: number;
  readonly steps: RtofsStep[];
  private static readonly GRACE_MS = HOUR_MS;

  constructor(product: string, runMs: number, bbox: SourceBBox, steps: RtofsStep[]) {
    if (steps.length === 0) throw new Error('RtofsCurrentSource needs at least one step');
    this.product = product;
    this.name = `RTOFS-${product}`;
    this.runMs = runMs;
    this.bbox = bbox;
    this.steps = [...steps].sort((a, b) => a.validMs - b.validMs);
  }

  static fromSerialized(s: SerializedRtofs): RtofsCurrentSource {
    return new RtofsCurrentSource(s.product, s.runMs, s.bbox, s.steps);
  }

  serialize(): SerializedRtofs {
    return { product: this.product, runMs: this.runMs, bbox: this.bbox, steps: this.steps };
  }

  contains(lon: number, lat: number): boolean {
    return extentContains(this.bbox, lon, lat);
  }

  get validRange(): [Date, Date] {
    return [new Date(this.steps[0].validMs), new Date(this.steps[this.steps.length - 1].validMs)];
  }

  private timeWeights(tMs: number): [number, number, number] | null {
    const ts = this.steps;
    if (tMs < ts[0].validMs - RtofsCurrentSource.GRACE_MS) return null;
    if (tMs > ts[ts.length - 1].validMs + RtofsCurrentSource.GRACE_MS) return null;
    if (tMs <= ts[0].validMs) return [0, 0, 0];
    if (tMs >= ts[ts.length - 1].validMs) return [ts.length - 1, ts.length - 1, 0];
    let i = 0;
    while (i + 1 < ts.length && ts[i + 1].validMs <= tMs) i++;
    i = Math.max(0, Math.min(i, ts.length - 2));
    const w = (tMs - ts[i].validMs) / (ts[i + 1].validMs - ts[i].validMs);
    return [i, i + 1, w];
  }

  at(lon: number, lat: number, time: Date): [number, number] {
    if (!this.contains(lon, lat)) return [0, 0];
    const tw = this.timeWeights(time.getTime());
    if (!tw) return [0, 0];
    const [i0, i1, w] = tw;
    let u = sampleField(this.steps[i0].u, lon, lat);
    let v = sampleField(this.steps[i0].v, lon, lat);
    if (w !== 0 && i0 !== i1) {
      u = u * (1 - w) + sampleField(this.steps[i1].u, lon, lat) * w;
      v = v * (1 - w) + sampleField(this.steps[i1].v, lon, lat) * w;
    }
    if (!Number.isFinite(u) || !Number.isFinite(v)) return [0, 0];
    return [u, v];
  }

  /** Overlay value: bilinear on the coastally extended field (coastfill.ts); routing uses `at`. */
  atDisplay(lon: number, lat: number, time: Date): [number, number] {
    if (!this.contains(lon, lat)) return [0, 0];
    const tw = this.timeWeights(time.getTime());
    if (!tw) return [0, 0];
    const [i0, i1, w] = tw;
    let [u, v] = sampleFieldPairFilled(this.steps[i0].u, this.steps[i0].v, lon, lat);
    if (w !== 0 && i0 !== i1) {
      const [u1, v1] = sampleFieldPairFilled(this.steps[i1].u, this.steps[i1].v, lon, lat);
      u = u * (1 - w) + u1 * w;
      v = v * (1 - w) + v1 * w;
    }
    if (!Number.isFinite(u) || !Number.isFinite(v)) return [0, 0];
    return [u, v];
  }

  atMany(lons: Float64Array, lats: Float64Array, time: Date): { u: Float64Array; v: Float64Array } {
    const n = lons.length;
    const u = new Float64Array(n);
    const v = new Float64Array(n);
    const tw = this.timeWeights(time.getTime());
    if (!tw) return { u, v };
    const [i0, i1, w] = tw;
    for (let k = 0; k < n; k++) {
      if (!this.contains(lons[k], lats[k])) continue;
      let uu = sampleField(this.steps[i0].u, lons[k], lats[k]);
      let vv = sampleField(this.steps[i0].v, lons[k], lats[k]);
      if (w !== 0 && i0 !== i1) {
        uu = uu * (1 - w) + sampleField(this.steps[i1].u, lons[k], lats[k]) * w;
        vv = vv * (1 - w) + sampleField(this.steps[i1].v, lons[k], lats[k]) * w;
      }
      if (Number.isFinite(uu) && Number.isFinite(vv)) {
        u[k] = uu;
        v[k] = vv;
      }
    }
    return { u, v };
  }

  /** As atMany, each point at its own time. */
  atManyAt(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): { u: Float64Array; v: Float64Array } {
    const n = lons.length;
    const u = new Float64Array(n);
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      if (!this.contains(lons[k], lats[k])) continue;
      const tw = this.timeWeights(timesMs[k]);
      if (!tw) continue;
      const [i0, i1, w] = tw;
      let uu = sampleField(this.steps[i0].u, lons[k], lats[k]);
      let vv = sampleField(this.steps[i0].v, lons[k], lats[k]);
      if (w !== 0 && i0 !== i1) {
        uu = uu * (1 - w) + sampleField(this.steps[i1].u, lons[k], lats[k]) * w;
        vv = vv * (1 - w) + sampleField(this.steps[i1].v, lons[k], lats[k]) * w;
      }
      if (Number.isFinite(uu) && Number.isFinite(vv)) {
        u[k] = uu;
        v[k] = vv;
      }
    }
    return { u, v };
  }

  bytes(): number {
    let b = 0;
    for (const s of this.steps) b += s.u.values.byteLength + s.v.values.byteLength;
    return b;
  }
}
