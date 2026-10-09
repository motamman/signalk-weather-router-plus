/**
 * Copernicus Marine SMOC — global hourly surface merged ocean current
 * (model circulation + tidal currents + Stokes drift), product
 * GLOBAL_ANALYSISFORECAST_PHY_001_024, dataset
 * cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_202211, variables
 * `utotal` / `vtotal` (m/s, east / north), 1/12° grid from 80°S to 90°N,
 * hourly from 2020-11-01 to about 10 days ahead, updated once a day.
 *
 * Read anonymously from the Copernicus Marine ARCO Zarr v2 stores
 * (Blosc/LZ4, decoded in-process by data/zarr.ts + data/blosc.ts):
 *   timeChunked.zarr   chunks 1 h × 512 × 2048 cells (≈ 42.7° × 170.7°)
 *   geoChunked.zarr    chunks 4272 h × 16 × 8 cells (point time series)
 *   downsampled4.zarr  1/3° grid, one chunk per hour for the globe
 * An area load picks the layout with the lower estimated download cost
 * (layoutCost: a point or a small box over many hours → geoChunked; a
 * wide area or few hours → timeChunked), and falls back to the 1/3° grid when a full-resolution
 * area would exceed the per-area memory cap.
 *
 * Data resident in memory, per worker (the engine's `at()` is
 * synchronous, so data must be resident before it is sampled):
 *  - the resident area: vessel position ± `halfWidthDeg`, full
 *    resolution, every step of the currents window (now → horizon at
 *    `stepS`), in SharedArrayBuffers (the data worker loads it; the
 *    route worker adopts the same memory);
 *  - on-demand areas (LRU, `budgetBytes` per worker): loaded before a
 *    route (route worker) or an overlay / conditions query (data worker)
 *    whose box the resident area does not cover. Overlay areas hold only
 *    the one or two steps bracketing the requested time.
 * Compressed chunks are cached on disk per run (cacheDir/<run>/<layout>/
 * <var>/<chunk key>); a new run replaces the previous one.
 *
 * Generic ARCO machinery (run probe, regions, chunk cache, layout choice,
 * area loading, resident + on-demand area set) lives in data/arco.ts;
 * this module adds the SMOC variables, settings and sampling.
 *
 * A "run" is identified by the last time step of the store's time axis
 * (yyyymmddHH); it advances by 24 h with each daily update. The STAC
 * record's `admp_updated_data` / `admp_updating_start_date` tell whether
 * that update has finished writing chunks (the metadata is rewritten
 * first, the chunks over the following hours).
 *
 * Sampling: bilinear on the 1/12° grid (longitude wraps across the
 * antimeridian), linear in time between the bracketing steps with a ±1 h
 * grace beyond the ends (as RTOFS), (0, 0) = no data (land, outside the
 * loaded areas, outside the time range).
 */

import type { BBox } from '../geo/geodesy';
import { HOUR_S } from '../geo/units';
import {
  alignedSteps,
  ArcoAreaSet,
  ArcoClient,
  arcoUrls,
  bilinearCorners,
  loadArcoArea,
  residentAreaStale,
  residentBBox,
  regionForBBox,
  runLastMs,
  type ArcoArea,
  type ArcoClientOptions,
  type ArcoGrid,
  type ArcoLayout,
  type ArcoLevel,
  type ArcoResolution,
  type ArcoRun,
  type DownloadNote,
  type DownloadStats,
  type LoadAreaOptions,
  type Region,
  type StacInfo,
} from '../data/arco';
import { bilinearFilled, FILL_RADIUS_CELLS, type PairGrid } from './coastfill';
import type { CurrentSourceLike, SourceBBox } from './types';

export {
  alignedSteps,
  chooseLayout,
  gridFromCoords,
  isSettled,
  layoutCost,
  LAYOUT_BYTES_PER_ELEMENT,
  parseStac,
  planChunks,
  regionContains,
  regionForBBox,
  REQUEST_COST_BYTES,
  residentBBox,
  runLastMs,
  timeIndex,
} from '../data/arco';
export type { DownloadStats, LoadAreaOptions, Region } from '../data/arco';

export const SMOC_PRODUCT = 'GLOBAL_ANALYSISFORECAST_PHY_001_024';
export const SMOC_DATASET = 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_202211';
export const SMOC_URLS = arcoUrls(SMOC_PRODUCT, SMOC_DATASET);
export const SMOC_VARS = ['utotal', 'vtotal'] as const;
export type SmocVar = (typeof SMOC_VARS)[number];
export const SMOC_NAME = 'CMEMS-SMOC';
export const SMOC_PRIORITY = 3;
/** Cells of margin around a requested box: 1 for bilinear + the coastal fill radius. */
export const AREA_MARGIN_CELLS = FILL_RADIUS_CELLS + 1;
/** Default on-demand memory budget per worker. */
export const SMOC_DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;

export type SmocLayout = ArcoLayout;
export type SmocResolution = ArcoResolution;
export type SmocGrid = ArcoGrid;
export type SmocLevel = ArcoLevel;
export type SmocRun = ArcoRun;
export type SmocStacInfo = StacInfo;

/** An ARCO area of the two SMOC variables, with typed shortcuts (the same arrays as `data`). */
export interface SmocArea extends ArcoArea {
  /** [step][row][col], NaN = no data. SharedArrayBuffer-backed. */
  u: Float32Array;
  v: Float32Array;
}

export function areaBytes(a: Pick<SmocArea, 'u' | 'v'>): number {
  return a.u.byteLength + a.v.byteLength;
}

function asSmocArea(a: ArcoArea): SmocArea {
  const u = a.data.utotal;
  const v = a.data.vtotal;
  if (!u || !v) throw new Error('smoc: area without utotal / vtotal');
  return Object.assign(a, { u, v });
}

// ─────────────── client ───────────────

export type SmocClientOptions = Omit<ArcoClientOptions, 'urls' | 'vars' | 'tag'> & { urls?: Partial<typeof SMOC_URLS> };

/** ARCO client for the SMOC dataset (utotal / vtotal). */
export class SmocClient extends ArcoClient {
  constructor(opts: SmocClientOptions) {
    super({ ...opts, urls: { ...SMOC_URLS, ...(opts.urls ?? {}) }, vars: SMOC_VARS, tag: 'smoc' });
  }
}

/**
 * Fetch (disk cache or network), decode and crop the chunks covering
 * `region` at the given step times into a new area.
 */
export async function loadArea(
  client: ArcoClient,
  run: SmocRun,
  res: SmocResolution,
  region: Region,
  stepMs: number[],
  opts: LoadAreaOptions
): Promise<{ area: SmocArea; stats: DownloadStats }> {
  const { area, stats } = await loadArcoArea(client, run, res, region, stepMs, SMOC_VARS, opts);
  return { area: asSmocArea(area), stats };
}

// ─────────────── the current source ───────────────

export interface SmocSettings {
  /** Seconds between the steps held (the data is hourly; a whole number of hours). */
  stepS: number;
  /** Seconds ahead of now the resident window covers. */
  horizonS: number;
  halfWidthDeg: number;
  budgetBytes: number;
}

export interface SerializedSmoc {
  run: SmocRun;
  resident: SmocArea | null;
  settings: SmocSettings;
  /** Vessel position the resident area was centred on. */
  centre: { lat: number; lon: number } | null;
}

export interface SmocStatus {
  run: string;
  run_last_time: string;
  stac_updated: string | null;
  settled: boolean;
  step_hours: number;
  horizon_hours: number;
  half_width_deg: number;
  resident: {
    bbox: SourceBBox;
    centre: { lat: number; lon: number } | null;
    steps: number;
    valid_from: string | null;
    valid_to: string | null;
    bytes: number;
    layout: SmocLayout;
  } | null;
  on_demand: {
    areas: number;
    bytes: number;
    budget_bytes: number;
    list: { bbox: SourceBBox; res: SmocResolution; steps: number; bytes: number; reason: string }[];
  };
  memory_bytes: number;
  shared_resident: boolean;
  last_download: DownloadNote | null;
  downloaded_bytes_total: number;
  disk_cache_bytes: number | null;
  layouts: SmocLayout[];
}

export class SmocCurrentSource implements CurrentSourceLike {
  readonly name = SMOC_NAME;
  readonly priority = SMOC_PRIORITY;
  readonly resolutionM = 9000;
  readonly run: SmocRun;
  readonly settings: SmocSettings;
  private client: ArcoClient | null;
  private readonly set: ArcoAreaSet<SmocArea>;

  constructor(run: SmocRun, settings: SmocSettings, client: ArcoClient | null, log: (m: string) => void = () => undefined) {
    this.run = run;
    this.settings = settings;
    this.client = client;
    this.set = new ArcoAreaSet<SmocArea>(run, client, {
      vars: SMOC_VARS,
      budgetBytes: settings.budgetBytes,
      tag: 'smoc',
      log,
      wrap: asSmocArea,
    });
  }

  static fromSerialized(s: SerializedSmoc, client: ArcoClient | null, log?: (m: string) => void): SmocCurrentSource {
    const src = new SmocCurrentSource(s.run, s.settings, client, log);
    src.setResident(s.resident, s.centre);
    return src;
  }

  serialize(): SerializedSmoc {
    return { run: this.run, resident: this.set.resident, settings: this.settings, centre: this.set.residentCentre };
  }

  get revision(): number {
    return this.set.revision;
  }

  /** On-demand areas dropped so far (worker.ts: an answer sampled after one was dropped is not kept). */
  get evictions(): number {
    return this.set.evictions;
  }

  get resident(): SmocArea | null {
    return this.set.resident;
  }

  get residentCentre(): { lat: number; lon: number } | null {
    return this.set.residentCentre;
  }

  get onDemandAreas(): readonly SmocArea[] {
    return this.set.onDemandAreas;
  }

  get lastDownload(): DownloadNote | null {
    return this.set.lastDownload;
  }

  /** Product extent (on-demand areas can come from anywhere in it). */
  get bbox(): SourceBBox {
    const g = this.run.levels.time.grid;
    return { south: g.lat0, north: g.lat0 + (g.nLat - 1) * g.dLat, west: -180, east: 180 };
  }

  setResident(area: SmocArea | null, centre: { lat: number; lon: number } | null): void {
    // A structured clone (worker relay) keeps u/v and data pointing at the same arrays.
    this.set.setResident(area, centre);
  }

  contains(lon: number, lat: number): boolean {
    return this.set.contains(lon, lat);
  }

  private static raw(a: SmocArea, wrap: boolean, s: number, x: number, y: number): [number, number] {
    const k = bilinearCorners(a.nRows, a.nCols, wrap, x, y);
    const base = s * a.nRows * a.nCols;
    const { tx, ty } = k;
    const i00 = base + k.i00;
    const i01 = base + k.i01;
    const i10 = base + k.i10;
    const i11 = base + k.i11;
    const ua = a.u[i00] + tx * (a.u[i01] - a.u[i00]);
    const ub = a.u[i10] + tx * (a.u[i11] - a.u[i10]);
    const va = a.v[i00] + tx * (a.v[i01] - a.v[i00]);
    const vb = a.v[i10] + tx * (a.v[i11] - a.v[i10]);
    return [ua + ty * (ub - ua), va + ty * (vb - va)];
  }

  private sample(lon: number, lat: number, time: Date, display: boolean): [number, number] {
    const f = this.set.find(lon, lat, time.getTime());
    if (!f) return [0, 0];
    const { a, x, y, tw } = f;
    const wrap = this.set.wraps(a);
    const one = (s: number): [number, number] => {
      if (!display) return SmocCurrentSource.raw(a, wrap, s, x, y);
      const g: PairGrid = { nRows: a.nRows, nCols: a.nCols, wrap, u: a.u, v: a.v, offset: s * a.nRows * a.nCols };
      return bilinearFilled(g, x, y);
    };
    const [i0, i1, w] = tw;
    let [u, v] = one(i0);
    if (w !== 0 && i0 !== i1) {
      const [u1, v1] = one(i1);
      u = u * (1 - w) + u1 * w;
      v = v * (1 - w) + v1 * w;
    }
    if (!Number.isFinite(u) || !Number.isFinite(v)) return [0, 0];
    return [u, v];
  }

  /** Raw model value (routing, conditions): bilinear, NaN corner = no data (0, 0). */
  at(lon: number, lat: number, time: Date): [number, number] {
    return this.sample(lon, lat, time, false);
  }

  /** Overlay value: bilinear on the coastally extended field (coastfill.ts). */
  atDisplay(lon: number, lat: number, time: Date): [number, number] {
    return this.sample(lon, lat, time, true);
  }

  atMany(lons: Float64Array, lats: Float64Array, time: Date): { u: Float64Array; v: Float64Array } {
    const n = lons.length;
    const u = new Float64Array(n);
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const [a, b] = this.at(lons[k], lats[k], time);
      u[k] = a;
      v[k] = b;
    }
    return { u, v };
  }

  atManyAt(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): { u: Float64Array; v: Float64Array } {
    const n = lons.length;
    const u = new Float64Array(n);
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const [a, b] = this.at(lons[k], lats[k], new Date(timesMs[k]));
      u[k] = a;
      v[k] = b;
    }
    return { u, v };
  }

  /** Window steps (now → horizon at the configured step). */
  windowSteps(nowMs: number): number[] {
    return alignedSteps(this.run, nowMs, nowMs + this.settings.horizonS * 1000, this.settings.stepS / HOUR_S);
  }

  /** Steps bracketing one instant (overlay queries). */
  bracketSteps(tMs: number): number[] {
    return alignedSteps(this.run, tMs, tMs, this.settings.stepS / HOUR_S);
  }

  /** Steps covering [fromMs, toMs]. */
  stepsBetween(fromMs: number, toMs: number): number[] {
    return alignedSteps(this.run, fromMs, toMs, this.settings.stepS / HOUR_S);
  }

  memoryBytes(): number {
    return this.set.memoryBytes();
  }

  onDemandBytes(): number {
    return this.set.onDemandBytes();
  }

  /** Drop least recently used on-demand areas down to `maxBytes` (0: all); returns the bytes released. */
  trimOnDemand(maxBytes: number): number {
    return this.set.trimOnDemand(maxBytes);
  }

  /**
   * Make `bbox` × `steps` resident (on demand); see ArcoAreaSet.ensure.
   * A coarse overlay view (lattice ≥ 1/4°) may take the 1/3° level.
   */
  ensure(
    bbox: BBox,
    steps: number[],
    opts: { reason: string; deadlineMs?: number; shouldCancel?: () => boolean; coarseOk?: boolean; onIncomplete?: () => void } = {
      reason: 'on demand',
    }
  ): Promise<boolean> {
    return this.set.ensure(bbox, steps, AREA_MARGIN_CELLS, opts);
  }

  noteDownload(reason: string, s: DownloadStats): void {
    this.set.noteDownload(reason, s);
  }

  /** Drop on-demand areas whose steps all lie before `nowMs − grace` (they can no longer answer). */
  expire(nowMs: number): void {
    this.set.expire(nowMs);
  }

  status(): SmocStatus {
    const r = this.set.resident;
    return {
      run: this.run.key,
      run_last_time: new Date(runLastMs(this.run)).toISOString(),
      stac_updated: this.run.stacUpdated,
      settled: this.run.settled,
      step_hours: this.settings.stepS / HOUR_S,
      horizon_hours: this.settings.horizonS / HOUR_S,
      half_width_deg: this.settings.halfWidthDeg,
      ...this.set.statusParts(),
      shared_resident: !!r && r.u.buffer instanceof SharedArrayBuffer,
      last_download: this.set.lastDownload,
      downloaded_bytes_total: this.client?.totals.downloadedBytes ?? 0,
      disk_cache_bytes: this.client ? this.client.cachedBytes(this.run) : null,
      layouts: (['time', 'geo', 'ds4'] as SmocLayout[]).filter(l => this.run.levels[l]),
    };
  }
}

/**
 * Should the resident area be rebuilt? When there is none (and a
 * position is known), when its steps differ from the window's, or when
 * the vessel has moved more than a third of the half-width from the
 * centre it was built around.
 */
export function residentStale(src: SmocCurrentSource, pos: { lat: number; lon: number } | null, steps: number[]): boolean {
  return residentAreaStale(src.resident, src.residentCentre, src.settings.halfWidthDeg, pos, steps);
}

/** Load the resident area for `pos` over `steps`. */
export async function loadResident(
  client: ArcoClient,
  run: SmocRun,
  settings: SmocSettings,
  pos: { lat: number; lon: number },
  steps: number[],
  opts: { log?: (m: string) => void; shouldCancel?: () => boolean } = {}
): Promise<{ area: SmocArea; stats: DownloadStats } | null> {
  const region = regionForBBox(run.levels.time.grid, residentBBox(pos.lat, pos.lon, settings.halfWidthDeg), AREA_MARGIN_CELLS);
  if (!region || steps.length === 0) return null;
  return loadArea(client, run, 'full', region, steps, {
    reason: `resident area around ${pos.lat.toFixed(2)},${pos.lon.toFixed(2)} ±${settings.halfWidthDeg}°`,
    log: opts.log,
    shouldCancel: opts.shouldCancel,
  });
}
