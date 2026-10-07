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
 * Each file (~38 MB) is a regular lat/lon grid (west_atl: 0.08°, 100°W
 * to 54°W, 10°N to 44.8°N) with simple packing and a bit map over land.
 * Fields used: `ubaro` (discipline 10, category 1, number 194) and
 * `vbaro` (10, 1, 195), m/s, the same depth-averaged velocities the
 * reference implementation reads from the NetCDF product.
 *
 * Sampling mirrors the reference RTOFS source: linear in time between
 * bracketing steps with a ±1 h grace beyond the ends, and (0, 0) for
 * "no data". Spatially, bilinear on the regular grid (the reference uses
 * 4-neighbour inverse distance on the curvilinear NetCDF grid; the GRIB2
 * product is already regular, so bilinear is the equivalent).
 */

import * as fs from 'node:fs';
import { fetchWithRetry, sleep } from '../data/http';
import { HOUR_MS, HOUR_S } from '../geo/units';
import * as path from 'node:path';
import type { BBox } from '../geo/geodesy';
import { iterateGrib2 } from '../grib/grib2';
import { cropField, type FieldGrid, sampleField, sharedFloat32 } from '../data/forecast';
import { bboxContains, type CurrentSourceLike, type SourceBBox } from './types';
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

  constructor(opts: RtofsClientOptions) {
    this.cacheDir = opts.cacheDir;
    this.region = opts.region;
    this.baseUrl = (opts.baseUrl ?? RTOFS_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.retries = opts.retries ?? 6;
    this.log = opts.log ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  fileUrl(run: RtofsRun, file: string): string {
    return `${this.baseUrl}/rtofs.${run.yyyymmdd}/rtofs_glo.t00z.${file}_${this.region}_std.grb2`;
  }

  cachePath(run: RtofsRun, file: string): string {
    return path.join(this.cacheDir, run.yyyymmdd, `${file}_${this.region}.grb2`);
  }

  /**
   * Fetch with timeout and retries. The body is read here, while the
   * abort timer is still armed, so a stalled download or a body-read
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

  async filePublished(run: RtofsRun, file: string): Promise<boolean> {
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

/**
 * The relayed run when it is the configured product's, else null: a run
 * loaded before a currents settings change (another region) can still
 * arrive after it and must not be used.
 */
export function rtofsForRegion(s: SerializedRtofs | null, enabled: boolean, region: string): SerializedRtofs | null {
  return s && enabled && s.name === `RTOFS-${region}` ? s : null;
}

export interface SerializedRtofs {
  name: string;
  runMs: number;
  bbox: SourceBBox;
  steps: RtofsStep[];
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
  readonly name: string;
  readonly priority = 2;
  readonly resolutionM = 9000;
  readonly bbox: SourceBBox;
  readonly runMs: number;
  readonly steps: RtofsStep[];
  private static readonly GRACE_MS = HOUR_MS;

  constructor(name: string, runMs: number, bbox: SourceBBox, steps: RtofsStep[]) {
    if (steps.length === 0) throw new Error('RtofsCurrentSource needs at least one step');
    this.name = name;
    this.runMs = runMs;
    this.bbox = bbox;
    this.steps = [...steps].sort((a, b) => a.validMs - b.validMs);
  }

  static fromSerialized(s: SerializedRtofs): RtofsCurrentSource {
    return new RtofsCurrentSource(s.name, s.runMs, s.bbox, s.steps);
  }

  serialize(): SerializedRtofs {
    return { name: this.name, runMs: this.runMs, bbox: this.bbox, steps: this.steps };
  }

  contains(lon: number, lat: number): boolean {
    return bboxContains(this.bbox, lon, lat);
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
