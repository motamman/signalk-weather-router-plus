/**
 * Copernicus Marine hourly sea level — product
 * GLOBAL_ANALYSISFORECAST_PHY_001_024, dataset
 * cmems_mod_glo_phy_anfc_merged-sl_PT1H-i_202411 (source attribute
 * "MERCATOR GLO12, FES2014"): 1/12° grid from 80°S to 90°N, hourly from
 * 2022-09-01 to about 10 days ahead, updated daily. Read anonymously
 * from the ARCO Zarr stores with the shared machinery in data/arco.ts
 * (the same run detection, disk cache and layouts as CMEMS SMOC).
 *
 * Variables used (metres):
 *   ocean_tide       FES2014 ocean tide, standard name
 *                    tidal_sea_surface_height_above_mean_sea_level:
 *                    the tide relative to the sea floor, i.e. what a
 *                    tide gauge records;
 *   total_sea_level  sea_surface_height_above_geoid = ocean_tide +
 *                    invert_barometer + sea_surface_height (GLO12
 *                    dynamic sea level, which includes the mean dynamic
 *                    topography) + global_mean_steric_variation +
 *                    global_mean_mass_volume_variation (PUM
 *                    CMEMS-GLO-PUM-001-024 issue 2.4 §c, and the
 *                    variable's long_name; verified on the data to
 *                    within the product's 1 mm quantisation).
 * `tide_loading` (the sea-floor displacement under the tidal load) is
 * NOT added: a gauge moves with the loaded crust, so the sea-surface
 * height a mariner sees relative to the bottom / the land is the ocean
 * tide alone; geocentric tide (ocean + load) is only relevant to
 * satellite altimetry. total_sea_level does not include it either.
 *
 * Derived quantities (SI metres, relative to local mean sea level):
 *   tide         = ocean_tide
 *   offset       = mean(total_sea_level − ocean_tide) over the mean window
 *   surge        = total_sea_level − ocean_tide − offset  (non-tidal residual)
 *   water level  = total_sea_level − offset = tide + surge
 * The mean window is every hourly sample of the geoChunked time chunks
 * that cover the last MEAN_WINDOW_DAYS days of the run (60 to ~210 days:
 * a geo chunk holds 3648 h, and it is downloaded whole anyway), so the
 * offset is the same for every query of a run at a place. It removes
 * the geoid-to-mean-sea-level separation (mean dynamic topography) and
 * the seasonal-mean anomaly; the surge is therefore the departure from
 * the recent (seasonal) mean non-tidal level: weather-driven set-up,
 * inverse barometer and shorter dynamic signals.
 *
 * Point series (conditions popup, Weather API): the geoChunked store,
 * one small chunk per variable holding thousands of hours for 16 × 16
 * cells; bilinear in space from the 4 surrounding cells, a missing
 * corner (model land) taking the coastal fill (IDW² of valid cells
 * within 2 cells, coastfill.ts) and flagging the result extrapolated.
 * Decoded regions are cached in memory (LRU), chunks on disk per run.
 *
 * Map field (tide-height layer): `ocean_tide` only, hourly: a resident
 * area around the vessel (± half-width, the window now → horizon with
 * its start aligned to 6 h so it is rebuilt four times a day, not every
 * hour) and on-demand areas for other views (one or two steps bracketing
 * the map time; the 1/3° level for zoomed-out views), under a memory
 * budget, sampled bilinearly with the coastal fill for display.
 */

import type { BBox } from '../geo/geodesy';
import { lonOffset } from '../geo/angles';
import { MINUTE_MS, HOUR_MS, HOUR_S } from '../geo/units';
import {
  alignedSteps,
  ArcoAreaSet,
  ArcoClient,
  arcoUrls,
  chooseLayout,
  loadArcoArea,
  loadRegion,
  mod,
  regionForBBox,
  residentAreaStale,
  residentBBox,
  runLastMs,
  timeAt,
  timeIndex,
  type ArcoArea,
  type ArcoClientOptions,
  type ArcoLayout,
  type ArcoRun,
  type DownloadNote,
  type DownloadStats,
  type GeoBox,
  type Region,
} from '../data/arco';
import { bilinearFilledScalar, FILL_RADIUS_CELLS, type ScalarGrid } from '../currents/coastfill';
import {
  derivedLevels,
  findExtrema,
  mslOffset,
  sampleSeries,
  slopeAt,
  tendencyOf,
  tidalRanges,
  type RegularSeries,
  type Tendency,
} from './tidecalc';

export const SL_PRODUCT = 'GLOBAL_ANALYSISFORECAST_PHY_001_024';
export const SL_DATASET = 'cmems_mod_glo_phy_anfc_merged-sl_PT1H-i_202411';
export const SL_URLS = arcoUrls(SL_PRODUCT, SL_DATASET);
export const SL_VARS = ['ocean_tide', 'total_sea_level'] as const;
export const TIDE_FIELD_VARS = ['ocean_tide'] as const;
export const SL_NAME = 'CMEMS GLO12 hourly sea level (FES2014 tide)';
export const SL_DOI = 'https://doi.org/10.48670/moi-00016';
export const TIDE_DATUM = 'mean sea level';
/** The mean-sea-level offset is taken over the geo time chunks covering this many days before the run's last step. */
export const MEAN_WINDOW_DAYS = 60;
/** Default on-demand memory budget for tide map areas. */
export const TIDE_DEFAULT_BUDGET_BYTES = 128 * 1024 * 1024;
/** Decoded point regions kept in memory. */
export const POINT_CACHE_ENTRIES = 8;
/** Cells of margin around a map box: 1 for bilinear + the coastal fill radius. */
export const TIDE_MARGIN_CELLS = FILL_RADIUS_CELLS + 1;
/** The resident window starts on a multiple of this (it is rebuilt when the start moves). */
export const RESIDENT_ALIGN_HOURS = 6;

export type SeaLevelClientOptions = Omit<ArcoClientOptions, 'urls' | 'vars' | 'tag'> & { urls?: Partial<typeof SL_URLS> };

/** ARCO client for the sea-level dataset (ocean_tide, total_sea_level). */
export class SeaLevelClient extends ArcoClient {
  constructor(opts: SeaLevelClientOptions) {
    super({ ...opts, urls: { ...SL_URLS, ...(opts.urls ?? {}) }, vars: SL_VARS, tag: 'tides' });
  }
}

// ─────────────── point series ───────────────

export interface TidePointSeries {
  lat: number;
  lon: number;
  run: string;
  /** First sample instant, ms; hourly. */
  t0Ms: number;
  stepMs: number;
  /** Tide height, m above mean sea level (NaN = no data). */
  tide: Float64Array;
  /** Total water level, m above local mean sea level. */
  waterLevel: Float64Array;
  /** Non-tidal residual, m. */
  surge: Float64Array;
  /** Per sample: a bilinear corner came from the coastal fill. */
  extrapolated: Uint8Array;
  /** mean(total_sea_level − ocean_tide) over the mean window, m (NaN when no data). */
  offsetM: number;
  offsetSamples: number;
  meanWindow: { fromMs: number; toMs: number };
  stats: DownloadStats;
  /** Served from the in-memory region cache. */
  cached: boolean;
}

interface PointRegion {
  key: string;
  region: Region;
  tIdx: number[];
  data: Record<string, Float32Array>;
  stats: DownloadStats;
}

/**
 * The 6 × 6 cell block around (lat, lon) — the 4 bilinear corners plus
 * the coastal fill radius — and the point's local cell coordinates in
 * it; null south of the grid.
 */
export function pointBlock(run: ArcoRun, lat: number, lon: number): { region: Region; xl: number; yl: number } | null {
  const g = run.levels.time.grid;
  const y = (lat - g.lat0) / g.dLat;
  if (!(y >= 0 && y <= g.nLat - 1)) return null;
  const x = lonOffset(lon, g.lon0) / g.dLon;
  const R = FILL_RADIUS_CELLS;
  const fy = Math.min(Math.floor(y), g.nLat - 2);
  const row0 = Math.max(0, fy - R);
  const row1 = Math.min(g.nLat - 1, fy + 1 + R);
  const fx = Math.floor(x);
  const col0 = mod(fx - R, g.nLon);
  return { region: { row0, nRows: row1 - row0 + 1, col0, nCols: 2 + 2 * R }, xl: x - fx + R, yl: y - row0 };
}

/**
 * Store time indices to load for a point query: every index of the geo
 * time chunks covering [fromIdx, toIdx] and the mean window. Returns the
 * indices (ascending) and the mean-window chunk span.
 */
export function pointTimePlan(
  run: ArcoRun,
  chunkT: number,
  fromIdx: number,
  toIdx: number
): { tIdx: number[]; meanLo: number; meanHi: number } {
  const lastIdx = run.timeCount - 1;
  const meanFromIdx = Math.max(0, lastIdx - MEAN_WINDOW_DAYS * 24);
  const meanTc0 = Math.floor(meanFromIdx / chunkT);
  const meanTc1 = Math.floor(lastIdx / chunkT);
  const tcs = new Set<number>();
  for (let tc = meanTc0; tc <= meanTc1; tc++) tcs.add(tc);
  if (toIdx >= fromIdx) for (let tc = Math.floor(fromIdx / chunkT); tc <= Math.floor(toIdx / chunkT); tc++) tcs.add(tc);
  const tIdx: number[] = [];
  for (const tc of [...tcs].sort((a, b) => a - b)) {
    for (let i = tc * chunkT; i < Math.min(run.timeCount, (tc + 1) * chunkT); i++) tIdx.push(i);
  }
  return { tIdx, meanLo: meanTc0 * chunkT, meanHi: Math.min(lastIdx, (meanTc1 + 1) * chunkT - 1) };
}

/** Compute the point series from a loaded block (pure; exported for tests). */
export function seriesFromBlock(
  run: ArcoRun,
  lat: number,
  lon: number,
  block: { region: Region; xl: number; yl: number },
  tIdx: number[],
  data: Record<string, Float32Array>,
  meanLo: number,
  meanHi: number,
  fromIdx: number,
  toIdx: number
): Omit<TidePointSeries, 'stats' | 'cached'> {
  const { region, xl, yl } = block;
  const nCells = region.nRows * region.nCols;
  const tideAll = new Float64Array(tIdx.length);
  const totAll = new Float64Array(tIdx.length);
  const filledAll = new Uint8Array(tIdx.length);
  const gt: ScalarGrid = { nRows: region.nRows, nCols: region.nCols, wrap: false, v: data.ocean_tide, offset: 0 };
  const gs: ScalarGrid = { nRows: region.nRows, nCols: region.nCols, wrap: false, v: data.total_sea_level, offset: 0 };
  for (let s = 0; s < tIdx.length; s++) {
    gt.offset = gs.offset = s * nCells;
    const a = bilinearFilledScalar(gt, xl, yl);
    const b = bilinearFilledScalar(gs, xl, yl);
    tideAll[s] = a.value;
    totAll[s] = b.value;
    filledAll[s] = a.filled || b.filled ? 1 : 0;
  }
  // Mean window: the samples of the chunks covering the last MEAN_WINDOW_DAYS days.
  const pos = new Map<number, number>();
  tIdx.forEach((ti, s) => pos.set(ti, s));
  const mt: number[] = [];
  const ms: number[] = [];
  for (let ti = meanLo; ti <= meanHi; ti++) {
    const s = pos.get(ti);
    if (s === undefined) continue;
    mt.push(tideAll[s]);
    ms.push(totAll[s]);
  }
  const { offset, samples } = mslOffset(ms, mt);
  const n = Math.max(0, toIdx - fromIdx + 1);
  const tide = new Float64Array(n).fill(NaN);
  const waterLevel = new Float64Array(n).fill(NaN);
  const surge = new Float64Array(n).fill(NaN);
  const extrapolated = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const s = pos.get(fromIdx + k);
    if (s === undefined) continue;
    const t = tideAll[s];
    const tot = totAll[s];
    extrapolated[k] = filledAll[s];
    if (!Number.isFinite(t)) continue;
    tide[k] = t;
    if (Number.isFinite(tot) && Number.isFinite(offset)) {
      const d = derivedLevels(t, tot, offset);
      surge[k] = d.surge;
      waterLevel[k] = d.waterLevel;
    }
  }
  return {
    lat,
    lon,
    run: run.key,
    t0Ms: timeAt(run, fromIdx),
    stepMs: run.timeStepMs,
    tide,
    waterLevel,
    surge,
    extrapolated,
    offsetM: offset,
    offsetSamples: samples,
    meanWindow: { fromMs: timeAt(run, meanLo), toMs: timeAt(run, meanHi) },
  };
}

// ─────────────── the tide source ───────────────

export interface TideSettings {
  halfWidthDeg: number;
  /** Seconds ahead of now the resident window covers. */
  horizonS: number;
  budgetBytes: number;
}

export interface TideStatus {
  name: string;
  doi: string;
  datum: string;
  run: string;
  run_last_time: string;
  stac_updated: string | null;
  settled: boolean;
  half_width_deg: number;
  horizon_hours: number;
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
    list: { bbox: GeoBox; res: 'full' | 'ds4'; steps: number; bytes: number; reason: string }[];
  };
  point_cache: { entries: number; bytes: number; queries: number; hits: number };
  memory_bytes: number;
  last_download: DownloadNote | null;
  last_point_query: {
    at: string;
    lat: number;
    lon: number;
    bytes: number;
    chunks: number;
    downloaded: number;
    from_disk: number;
    seconds: number;
    cached: boolean;
  } | null;
  downloaded_bytes_total: number;
  disk_cache_bytes: number | null;
  layouts: ArcoLayout[];
  mean_window_days: number;
}

export class TideSource {
  readonly run: ArcoRun;
  readonly settings: TideSettings;
  private readonly client: ArcoClient | null;
  private readonly log: (m: string) => void;
  private readonly set: ArcoAreaSet<ArcoArea>;
  private points: PointRegion[] = [];
  private pendingPoints = new Map<string, Promise<PointRegion>>();
  private queries = 0;
  private hits = 0;
  private lastPoint: TideStatus['last_point_query'] = null;

  constructor(run: ArcoRun, settings: TideSettings, client: ArcoClient | null, log: (m: string) => void = () => undefined) {
    this.run = run;
    this.settings = settings;
    this.client = client;
    this.log = log;
    this.set = new ArcoAreaSet<ArcoArea>(run, client, {
      vars: TIDE_FIELD_VARS,
      budgetBytes: settings.budgetBytes,
      tag: 'tides',
      log,
      wrap: a => a,
    });
  }

  get revision(): number {
    return this.set.revision;
  }

  /** On-demand areas dropped so far (worker.ts: an answer sampled after one was dropped is not kept). */
  get evictions(): number {
    return this.set.evictions;
  }

  get resident(): ArcoArea | null {
    return this.set.resident;
  }

  get residentCentre(): { lat: number; lon: number } | null {
    return this.set.residentCentre;
  }

  setResident(area: ArcoArea | null, centre: { lat: number; lon: number } | null): void {
    this.set.setResident(area, centre);
  }

  noteDownload(reason: string, s: DownloadStats): void {
    this.set.noteDownload(reason, s);
  }

  /**
   * Resident window: hourly from the last multiple of
   * RESIDENT_ALIGN_HOURS at or before now to horizon + that alignment
   * later (so now → now + horizon is always inside).
   */
  windowSteps(nowMs: number): number[] {
    const a = RESIDENT_ALIGN_HOURS * HOUR_MS;
    const start = Math.floor(nowMs / a) * a;
    return alignedSteps(this.run, start, start + this.settings.horizonS * 1000 + RESIDENT_ALIGN_HOURS * HOUR_MS, 1);
  }

  /** Hourly steps bracketing one instant (map queries). */
  bracketSteps(tMs: number): number[] {
    return alignedSteps(this.run, tMs, tMs, 1);
  }

  residentStale(pos: { lat: number; lon: number } | null, steps: number[]): boolean {
    return residentAreaStale(this.set.resident, this.set.residentCentre, this.settings.halfWidthDeg, pos, steps);
  }

  expire(nowMs: number): void {
    this.set.expire(nowMs);
  }

  /** Map area on demand (see ArcoAreaSet.ensure). */
  ensure(
    bbox: BBox,
    steps: number[],
    opts: { reason: string; deadlineMs?: number; coarseOk?: boolean; onIncomplete?: () => void }
  ): Promise<boolean> {
    return this.set.ensure(bbox, steps, TIDE_MARGIN_CELLS, opts);
  }

  /**
   * Tide height for display, m above mean sea level: bilinear on the
   * coastally extended ocean_tide field, linear in time between the
   * hourly steps; NaN where no loaded area answers.
   */
  tideAtDisplay(lon: number, lat: number, time: Date): number {
    const f = this.set.find(lon, lat, time.getTime());
    if (!f) return NaN;
    const { a, x, y, tw } = f;
    const g: ScalarGrid = { nRows: a.nRows, nCols: a.nCols, wrap: this.set.wraps(a), v: a.data.ocean_tide, offset: 0 };
    const one = (s: number): number => {
      g.offset = s * a.nRows * a.nCols;
      return bilinearFilledScalar(g, x, y).value;
    };
    const [i0, i1, w] = tw;
    let v = one(i0);
    if (w !== 0 && i0 !== i1) v = v * (1 - w) + one(i1) * w;
    return v;
  }

  private pointBytes(): number {
    let b = 0;
    for (const p of this.points) for (const arr of Object.values(p.data)) b += arr.byteLength;
    return b;
  }

  memoryBytes(): number {
    return this.set.memoryBytes() + this.pointBytes();
  }

  /** Drop least recently used on-demand areas down to `maxBytes` (0: all); returns the bytes released. */
  trimOnDemand(maxBytes: number): number {
    return this.set.trimOnDemand(maxBytes);
  }

  /**
   * Hourly tide, water level and surge at (lat, lon) from `fromMs` to
   * `toMs` (inclusive, rounded outwards to whole hours, clipped to the
   * store's time axis). null when the point is outside the grid or the
   * query lies wholly outside the time axis. Throws when the
   * geoChunked store is unavailable or the download fails.
   */
  async pointSeries(
    lat: number,
    lon: number,
    fromMs: number,
    toMs: number,
    opts: { reason?: string } = {}
  ): Promise<TidePointSeries | null> {
    const block = pointBlock(this.run, lat, lon);
    if (!block) return null;
    const geo = this.run.levels.geo;
    if (!geo) throw new Error('tides: the geoChunked store is unavailable; point series cannot be read');
    const fromIdx = Math.max(0, Math.floor((fromMs - this.run.timeFirstMs) / this.run.timeStepMs));
    const toIdx = Math.min(this.run.timeCount - 1, Math.ceil((toMs - this.run.timeFirstMs) / this.run.timeStepMs));
    if (toIdx < fromIdx) return null;
    const chunkT = Object.values(geo.meta)[0].chunks[geo.dims.time];
    const plan = pointTimePlan(this.run, chunkT, fromIdx, toIdx);
    const r = block.region;
    const key = `${this.run.key}|${r.row0},${r.nRows},${r.col0}|${plan.tIdx[0]}-${plan.tIdx[plan.tIdx.length - 1]}`;
    this.queries++;
    let pr = this.points.find(p => p.key === key) ?? null;
    let cached = !!pr;
    if (pr) {
      this.hits++;
      this.points = [pr, ...this.points.filter(p => p !== pr)];
    } else {
      let pending = this.pendingPoints.get(key);
      if (!pending) {
        if (!this.client) throw new Error('tides: no client');
        const client = this.client;
        pending = loadRegion(client, this.run, 'full', r, plan.tIdx, SL_VARS, {
          reason: opts.reason ?? 'point series',
          layout: 'geo',
          unshared: true,
        })
          .then(({ data, stats }) => {
            const p: PointRegion = { key, region: r, tIdx: plan.tIdx, data, stats };
            this.points = [p, ...this.points.filter(q => q.key !== key)].slice(0, POINT_CACHE_ENTRIES);
            this.log(
              `tides: ${opts.reason ?? 'point series'} at ${lat.toFixed(3)},${lon.toFixed(3)}: ${stats.chunks} chunks (${stats.downloaded} downloaded ${(stats.bytes / 1e6).toFixed(2)} MB, ${stats.fromDisk} from disk, ${stats.absent} absent), ${plan.tIdx.length} h × ${r.nRows}×${r.nCols} cells, decode ${stats.decodeMs} ms, ${stats.seconds.toFixed(1)} s`
            );
            return p;
          })
          .finally(() => this.pendingPoints.delete(key));
        this.pendingPoints.set(key, pending);
      } else cached = true;
      pr = await pending;
    }
    const out = seriesFromBlock(this.run, lat, lon, block, pr.tIdx, pr.data, plan.meanLo, plan.meanHi, fromIdx, toIdx);
    const stats = cached ? { chunks: 0, downloaded: 0, fromDisk: 0, absent: 0, bytes: 0, decodeMs: 0, seconds: 0 } : pr.stats;
    this.lastPoint = {
      at: new Date().toISOString(),
      lat,
      lon,
      bytes: stats.bytes,
      chunks: stats.chunks,
      downloaded: stats.downloaded,
      from_disk: stats.fromDisk,
      seconds: stats.seconds,
      cached,
    };
    return { ...out, stats, cached };
  }

  status(): TideStatus {
    const parts = this.set.statusParts();
    return {
      name: SL_NAME,
      doi: SL_DOI,
      datum: TIDE_DATUM,
      run: this.run.key,
      run_last_time: new Date(runLastMs(this.run)).toISOString(),
      stac_updated: this.run.stacUpdated,
      settled: this.run.settled,
      half_width_deg: this.settings.halfWidthDeg,
      horizon_hours: this.settings.horizonS / HOUR_S,
      resident: parts.resident,
      on_demand: parts.on_demand,
      point_cache: { entries: this.points.length, bytes: this.pointBytes(), queries: this.queries, hits: this.hits },
      memory_bytes: this.memoryBytes(),
      last_download: this.set.lastDownload,
      last_point_query: this.lastPoint,
      downloaded_bytes_total: this.client?.totals.downloadedBytes ?? 0,
      disk_cache_bytes: this.client ? this.client.cachedBytes(this.run) : null,
      layouts: (['time', 'geo', 'ds4'] as ArcoLayout[]).filter(l => this.run.levels[l]),
      mean_window_days: MEAN_WINDOW_DAYS,
    };
  }
}

/** Load the resident tide map area for `pos` over `steps` (ocean_tide, full resolution). */
export async function loadTideResident(
  client: ArcoClient,
  run: ArcoRun,
  settings: TideSettings,
  pos: { lat: number; lon: number },
  steps: number[],
  opts: { log?: (m: string) => void } = {}
): Promise<{ area: ArcoArea; stats: DownloadStats } | null> {
  const region = regionForBBox(run.levels.time.grid, residentBBox(pos.lat, pos.lon, settings.halfWidthDeg), TIDE_MARGIN_CELLS);
  if (!region || steps.length === 0) return null;
  const tIdx = steps.map(t => timeIndex(run, t));
  return loadArcoArea(client, run, 'full', region, steps, TIDE_FIELD_VARS, {
    reason: `resident tide area around ${pos.lat.toFixed(2)},${pos.lon.toFixed(2)} ±${settings.halfWidthDeg}°`,
    log: opts.log,
    layout: chooseLayout(run, region, tIdx),
  });
}

// ─────────────── conditions / Weather API views ───────────────

export interface TideRowFields {
  /** Tide height above mean sea level, m. */
  tide_m: number | null;
  /** Total water level (tide + surge) above local mean sea level, m. */
  water_level_m: number | null;
  /** Non-tidal residual, m. */
  surge_m: number | null;
  /** A bilinear corner came from the coastal fill (the point is near or on the model coastline). */
  tide_extrapolated: boolean;
  /** Tendency of the tide height (±2 cm/h = steady). */
  tide_tendency: Tendency | null;
}

export interface TideExtremumOut {
  time: string;
  /** Tide height at the extremum, m above mean sea level. */
  height_m: number;
  /** Total water level at that time, m above local mean sea level (null when unavailable). */
  water_level_m: number | null;
}

export interface TideSummary {
  highs: TideExtremumOut[];
  lows: TideExtremumOut[];
  /** Mean height difference between consecutive high and low waters in the window, m (null with fewer than two extrema). */
  range_m: number | null;
  /** Largest such difference, m. */
  max_range_m: number | null;
  /** Extrema are those of the tide height. */
  of: 'tide_m';
  source: string;
  run: string;
  datum: string;
  /** mean(total_sea_level − ocean_tide) removed from the total level, m (the local mean sea level above the geoid). */
  msl_offset_m: number | null;
  mean_window: { from: string; to: string; samples: number };
  /** Any value in the window came from the coastal fill. */
  extrapolated: boolean;
  doi: string;
}

const r4 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

export function asRegular(s: TidePointSeries, which: 'tide' | 'waterLevel' | 'surge'): RegularSeries {
  return { t0Ms: s.t0Ms, stepMs: s.stepMs, values: s[which] };
}

/** Tide fields for one conditions row at `tMs` (linear between the hourly samples). */
export function tideRowAt(s: TidePointSeries | null, tMs: number): TideRowFields {
  if (!s) return { tide_m: null, water_level_m: null, surge_m: null, tide_extrapolated: false, tide_tendency: null };
  const tide = asRegular(s, 'tide');
  const q = (tMs - s.t0Ms) / s.stepMs;
  const k0 = Math.floor(q);
  const k1 = Math.ceil(q);
  const ext =
    (k0 >= 0 && k0 < s.extrapolated.length && s.extrapolated[k0] === 1) ||
    (k1 >= 0 && k1 < s.extrapolated.length && s.extrapolated[k1] === 1);
  const t = sampleSeries(tide, tMs);
  return {
    tide_m: r4(t),
    water_level_m: r4(sampleSeries(asRegular(s, 'waterLevel'), tMs)),
    surge_m: r4(sampleSeries(asRegular(s, 'surge'), tMs)),
    tide_extrapolated: t !== null && ext,
    tide_tendency: t === null ? null : tendencyOf(slopeAt(tide, tMs)),
  };
}

/** High / low waters and range over [fromMs, toMs] of the series. */
export function tideSummary(s: TidePointSeries, fromMs: number, toMs: number): TideSummary {
  const k0 = Math.max(0, Math.ceil((fromMs - s.t0Ms) / s.stepMs));
  const k1 = Math.min(s.tide.length - 1, Math.floor((toMs - s.t0Ms) / s.stepMs));
  const sub: RegularSeries = {
    t0Ms: s.t0Ms + k0 * s.stepMs,
    stepMs: s.stepMs,
    values: k1 >= k0 ? s.tide.subarray(k0, k1 + 1) : new Float64Array(0),
  };
  const ext = findExtrema(sub);
  const wl = asRegular(s, 'waterLevel');
  const out = (e: { timeMs: number; height: number }): TideExtremumOut => ({
    time: new Date(Math.round(e.timeMs / MINUTE_MS) * MINUTE_MS).toISOString(),
    height_m: r4(e.height) as number,
    water_level_m: r4(sampleSeries(wl, e.timeMs)),
  });
  const ranges = tidalRanges(ext);
  let extrap = false;
  for (let k = Math.max(0, k0); k <= k1; k++) if (s.extrapolated[k] === 1 && Number.isFinite(s.tide[k])) extrap = true;
  return {
    highs: ext.filter(e => e.kind === 'high').map(out),
    lows: ext.filter(e => e.kind === 'low').map(out),
    range_m: ranges.length ? r4(ranges.reduce((a, b) => a + b, 0) / ranges.length) : null,
    max_range_m: ranges.length ? r4(Math.max(...ranges)) : null,
    of: 'tide_m',
    source: `${SL_NAME}, ${SL_DATASET}`,
    run: s.run,
    datum: TIDE_DATUM,
    msl_offset_m: r4(s.offsetM),
    mean_window: {
      from: new Date(s.meanWindow.fromMs).toISOString(),
      to: new Date(s.meanWindow.toMs).toISOString(),
      samples: s.offsetSamples,
    },
    extrapolated: extrap,
    doi: SL_DOI,
  };
}
