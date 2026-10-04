/**
 * Data behind the overlay and conditions endpoints. Everything is SI
 * and the browser renders it (heatmaps from JSON grids, arrows, barbs,
 * isobars) from the forecast store, the current stack and the tide
 * store.
 */

import type { ForecastStore } from '../data/forecast';
import { norm360 } from '../geo/angles';
import { latOfMercY, mercY } from '../geo/mercator';
import { wrapLon } from '../geo/angles';
import { HOUR_MS } from '../geo/units';
import type { CurrentStack } from '../currents/stack';
import type { OverlayLand } from '../geo/landcache';
import { bboxWidth, type BBox } from '../geo/geodesy';
import {
  beaufort,
  douglas,
  douglasLabel,
  feelsLike,
  heatIndexK,
  precipType,
  relativeHumidity,
  rnd,
  seaStateBand,
  seaStateIndex,
  windChillK,
  roughnessIndex,
} from './conditions';
import { buildIsobarFeatures, type IsobarFeature } from './isobars';
import { tideRowAt, tideSummary, SL_NAME, type TidePointSeries, type TideRowFields, type TideSummary } from '../tides/sealevel';

export type { FieldLayer } from './layers';
import type { FieldLayer } from './layers';

export interface FieldGridResponse {
  layer: FieldLayer;
  time: string;
  bbox: [number, number, number, number];
  res: number;
  lons: number[];
  lats: number[];
  /** Named value grids, row-major from the south, null = no data. */
  fields: Record<string, (number | null)[][]>;
  /** 1 = land, per cell. */
  land: number[][];
  units: Record<string, string>;
}

/** Lattice covering the bbox at `res`, snapped to the global grid so neighbouring requests share cells. */
function lattice(bbox: BBox, res: number, maxCells: number): { lons: number[]; lats: number[]; res: number } {
  let r = res;
  const width = bboxWidth(bbox);
  const height = bbox.north - bbox.south;
  while ((Math.ceil(width / r) + 1) * (Math.ceil(height / r) + 1) > maxCells) r *= 2;
  const lons: number[] = [];
  const lats: number[] = [];
  const lonStart = Math.ceil(bbox.west / r) * r;
  for (let x = lonStart; x <= bbox.west + width + 1e-9; x += r) lons.push(Math.round(wrapLon(x) * 1e6) / 1e6);
  const latStart = Math.ceil(bbox.south / r) * r;
  for (let y = latStart; y <= bbox.north + 1e-9; y += r) lats.push(Math.round(y * 1e6) / 1e6);
  return { lons, lats, res: r };
}

function nz(v: number): number | null {
  return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;
}

/**
 * Significant-digit rounding for values far below 1e-4 in SI (the
 * precipitation rate in m/s: 1 mm/h ≈ 2.8e-7 m/s), which nz() would
 * round to 0.
 */
function nzSig(v: number): number | null {
  return Number.isFinite(v) ? Number(v.toPrecision(5)) : null;
}

export interface OverlaySources {
  forecast: ForecastStore | null;
  currents: CurrentStack | null;
  /** On-demand land: a raster per request bbox, exact point tests. */
  land: OverlayLand | null;
  /** Tide-height map field (Copernicus Marine ocean_tide), display value with the coastal fill; NaN = no data. */
  tides?: { tideAtDisplay(lon: number, lat: number, time: Date): number } | null;
}

export function fieldGrid(src: OverlaySources, layer: FieldLayer, bbox: BBox, time: Date, res: number): FieldGridResponse {
  const { lons, lats, res: r } = lattice(bbox, res, 40_000);
  const lm = src.land ? src.land.forBBox(bbox, r) : null;
  const land = lats.map(lat => lons.map(lon => (lm && lm.isLand(lon, lat) ? 1 : 0)));
  const fields: Record<string, (number | null)[][]> = {};
  const units: Record<string, string> = {};
  const f = src.forecast;
  const need = (): ForecastStore => {
    if (!f) throw new Error('no forecast loaded');
    return f;
  };
  const rowsOf = (fn: (lon: number, lat: number) => number): (number | null)[][] => lats.map(lat => lons.map(lon => nz(fn(lon, lat))));
  switch (layer) {
    case 'wind': {
      const s = need();
      const speed: (number | null)[][] = [];
      const dir: (number | null)[][] = [];
      for (const lat of lats) {
        const rs: (number | null)[] = [];
        const rd: (number | null)[] = [];
        for (const lon of lons) {
          const [ws, wd] = s.at(lon, lat, time);
          rs.push(nz(ws));
          rd.push(nz(wd));
        }
        speed.push(rs);
        dir.push(rd);
      }
      fields.speed_ms = speed;
      fields.dir_from = dir;
      units.speed_ms = 'm/s';
      units.dir_from = 'deg';
      break;
    }
    case 'waves': {
      const s = need();
      if (!s.hasWaves) throw new Error('no wave data in the forecast');
      const swh: (number | null)[][] = [];
      const mwp: (number | null)[][] = [];
      const mwd: (number | null)[][] = [];
      for (const lat of lats) {
        const a: (number | null)[] = [];
        const b: (number | null)[] = [];
        const c: (number | null)[] = [];
        for (const lon of lons) {
          const w = s.wavesAt(lon, lat, time);
          a.push(w ? nz(w.swh) : null);
          b.push(w ? nz(w.mwp) : null);
          c.push(w ? nz(w.mwd) : null);
        }
        swh.push(a);
        mwp.push(b);
        mwd.push(c);
      }
      fields.swh = swh;
      fields.mwp = mwp;
      fields.mwd = mwd;
      units.swh = 'm';
      units.mwp = 's';
      units.mwd = 'deg';
      break;
    }
    case 'msl': {
      const s = need();
      if (!s.has('msl')) throw new Error('msl not loaded');
      fields.msl = rowsOf((lon, lat) => s.mslAt(lon, lat, time));
      units.msl = 'Pa';
      break;
    }
    case 'temperature': {
      const s = need();
      if (!s.has('2t')) throw new Error('2t not loaded (enable extra fields)');
      fields.t2m = rowsOf((lon, lat) => s.paramAt('2t', lon, lat, time));
      units.t2m = 'K';
      break;
    }
    case 'sst': {
      const s = need();
      if (!s.has('skt')) throw new Error('skt not loaded (enable extra fields)');
      fields.skt = rowsOf((lon, lat) => s.paramAt('skt', lon, lat, time));
      units.skt = 'K';
      break;
    }
    case 'precip': {
      const s = need();
      if (!s.has('tprate')) throw new Error('tprate not loaded (enable extra fields)');
      // Already a depth rate in m/s: the store converts tprate at ingestion.
      fields.rate = lats.map(lat => lons.map(lon => nzSig(s.paramAt('tprate', lon, lat, time))));
      units.rate = 'm/s';
      if (s.has('ptype')) {
        fields.ptype = rowsOf((lon, lat) => s.paramAt('ptype', lon, lat, time));
        units.ptype = 'code';
      }
      break;
    }
    case 'sea_state': {
      const s = need();
      const idx: (number | null)[][] = [];
      const sig: (number | null)[][] = [];
      for (const lat of lats) {
        const a: (number | null)[] = [];
        const b: (number | null)[] = [];
        for (const lon of lons) {
          const [ws, wd] = s.at(lon, lat, time);
          const w = s.hasWaves ? s.wavesAt(lon, lat, time) : null;
          let C = 0;
          let cTo = 0;
          if (src.currents) {
            const [u, v] = src.currents.at(lon, lat, time);
            C = Math.hypot(u, v);
            cTo = norm360((Math.atan2(u, v) * 180) / Math.PI);
          }
          const { idx: v, signal } = roughnessIndex(ws, C, wd, cTo, w ? w.swh : 0, w ? w.mwp : 5, w ? w.mwd : 0);
          a.push(nz(v));
          b.push(nz(signal));
        }
        idx.push(a);
        sig.push(b);
      }
      fields.index = idx;
      fields.signal = sig;
      units.index = '';
      units.signal = '';
      break;
    }
    case 'current': {
      if (!src.currents || src.currents.isEmpty) throw new Error('no current sources loaded');
      const st = src.currents;
      const speed: (number | null)[][] = [];
      const dir: (number | null)[][] = [];
      for (const lat of lats) {
        const a: (number | null)[] = [];
        const b: (number | null)[] = [];
        for (const lon of lons) {
          // Display value: gridded model currents extended to the coast (coastfill.ts).
          const [u, v] = st.atDisplay(lon, lat, time);
          if (u === 0 && v === 0) {
            a.push(null);
            b.push(null);
          } else {
            a.push(nz(Math.hypot(u, v)));
            b.push(nz(norm360((Math.atan2(u, v) * 180) / Math.PI)));
          }
        }
        speed.push(a);
        dir.push(b);
      }
      fields.speed_ms = speed;
      fields.dir_to = dir;
      units.speed_ms = 'm/s';
      units.dir_to = 'deg';
      break;
    }
    case 'tide': {
      const t = src.tides;
      if (!t) throw new Error('no tide data loaded (enable Tides in Settings)');
      // Tide height above mean sea level, m: display value extended to the coast (coastfill.ts).
      fields.tide_m = rowsOf((lon, lat) => t.tideAtDisplay(lon, lat, time));
      units.tide_m = 'm';
      break;
    }
  }
  // A cropped or windowed store clamps to its edge outside its box; those
  // values are not forecast, so every forecast-derived layer reports no
  // data there (the data worker reads the view plus a margin, so a map
  // view is covered everywhere). The global store covers everywhere. Currents and tides carry their own coverage.
  if (layer !== 'current' && layer !== 'tide' && f) {
    for (let r = 0; r < lats.length; r++) {
      for (let c = 0; c < lons.length; c++) {
        if (f.covers(lons[c], lats[r])) continue;
        for (const grid of Object.values(fields)) grid[r][c] = null;
      }
    }
  }
  return { layer, time: time.toISOString(), bbox: [bbox.west, bbox.south, bbox.east, bbox.north], res: r, lons, lats, fields, land, units };
}

export interface CurrentPoint {
  lon: number;
  lat: number;
  u_ms: number;
  v_ms: number;
  speed_ms: number;
  /** Direction the current flows TO, degrees true. */
  dir_deg: number;
}

/**
 * Current arrows on a lattice; land and near-slack points dropped.
 * Display values (coastal extension of gridded model currents).
 */
export function currentPoints(src: OverlaySources, bbox: BBox, time: Date, res: number): CurrentPoint[] {
  if (!src.currents || src.currents.isEmpty) return [];
  const { lons, lats, res: r } = lattice(bbox, res, 20_000);
  const lm = src.land ? src.land.forBBox(bbox, r) : null;
  const out: CurrentPoint[] = [];
  for (const lat of lats) {
    for (const lon of lons) {
      if (lm && lm.isLand(lon, lat)) continue;
      // Display value: gridded model currents extended to the coast (coastfill.ts).
      const [u, v] = src.currents.atDisplay(lon, lat, time);
      const sp = Math.hypot(u, v);
      if (sp < 0.005) continue;
      out.push({
        lon: Math.round(lon * 1e6) / 1e6,
        lat: Math.round(lat * 1e6) / 1e6,
        u_ms: Math.round(u * 1e4) / 1e4,
        v_ms: Math.round(v * 1e4) / 1e4,
        speed_ms: Math.round(sp * 1e4) / 1e4,
        dir_deg: Math.round(norm360((Math.atan2(u, v) * 180) / Math.PI) * 10) / 10,
      });
    }
  }
  return out;
}

export interface WindPoint {
  lon: number;
  lat: number;
  speed_ms: number;
  /** FROM, degrees true. */
  dir_deg: number;
}

export function windPoints(src: OverlaySources, bbox: BBox, time: Date, res: number): WindPoint[] {
  if (!src.forecast) throw new Error('no forecast loaded');
  const { lons, lats } = lattice(bbox, res, 20_000);
  const out: WindPoint[] = [];
  for (const lat of lats) {
    for (const lon of lons) {
      if (!src.forecast.covers(lon, lat)) continue;
      const [ws, wd] = src.forecast.at(lon, lat, time);
      if (!Number.isFinite(ws)) continue;
      out.push({
        lon: Math.round(lon * 1e6) / 1e6,
        lat: Math.round(lat * 1e6) / 1e6,
        speed_ms: Math.round(ws * 1000) / 1000,
        dir_deg: Math.round(wd * 10) / 10,
      });
    }
  }
  return out;
}

export interface ConditionsRow {
  time: string;
  wind_ms: number | null;
  wind_dir_deg: number | null;
  /** 10 m wind gust, m/s (extra fields; absent at step 0, whose range is empty). */
  gust_ms: number | null;
  swh_m: number | null;
  mwp_s: number | null;
  mwd_deg: number | null;
  current_ms: number | null;
  current_dir_deg: number | null;
  msl_pa: number | null;
  t2m_k: number | null;
  skt_k: number | null;
  /** Precipitation depth rate, m/s (ECMWF tprate converted at ingestion). */
  precip_rate_ms: number | null;
  precip_type: number | null;
  precip_type_label: string | null;
  /** Total precipitation depth in m over `interval_h`, the interval containing the sample time (energy fields). */
  precip_m: number | null;
  /** Snowfall water-equivalent depth in m over the same interval (energy fields). */
  snowfall_m: number | null;
  /** Average surface solar radiation, W/m², over the same interval (energy fields; ECMWF ssrd). */
  ssrd_wm2: number | null;
  /** Average downward surface thermal radiation, W/m², over the same interval (energy fields; ECMWF strd). */
  strd_wm2: number | null;
  /** Average net surface thermal radiation, W/m², over the same interval (energy fields; ECMWF str). */
  str_wm2: number | null;
  /** Hours the interval fields of this row cover (3 below 144 h, 6 past; null when none are loaded). */
  interval_h: number | null;
  /** Total cloud cover, ratio 0..1 (extra fields). */
  cloud_cover: number | null;
  /** Most-unstable convective available potential energy, J/kg (energy fields). */
  mucape_jkg: number | null;
  dewpoint_k: number | null;
  /** Relative humidity as a ratio 0..1 (Signal K unit). */
  rh: number | null;
  feels_like_k: number | null;
  feels_like_basis: string | null;
  wind_chill_k: number | null;
  heat_index_k: number | null;
  beaufort: number | null;
  douglas: number | null;
  douglas_label: string | null;
  sea_state_index: number | null;
  sea_state: string | null;
  sea_state_partial: boolean;
}

/**
 * One sample row at a position and time. Everything is SI or
 * dimensionless: `precip_rate_ms` in m/s, `rh` a ratio 0..1. The interval
 * fields (`precip_m`, `snowfall_m`, the fluxes) are the values of the
 * interval containing the sample time, `interval_h` hours long.
 */
export function sampleConditions(src: OverlaySources, lon: number, lat: number, time: Date): ConditionsRow {
  const f = src.forecast;
  const finiteOr = (v: number | undefined | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  let wind: number | null = null;
  let windDir: number | null = null;
  let swh: number | null = null;
  let mwp: number | null = null;
  let mwd: number | null = null;
  let msl: number | null = null;
  let t2m: number | null = null;
  let skt: number | null = null;
  let tprate: number | null = null;
  let d2m: number | null = null;
  let ptypeCode: number | null = null;
  let gust: number | null = null;
  let cloud: number | null = null;
  let mucape: number | null = null;
  let precipM: number | null = null;
  let snowM: number | null = null;
  let ssrd: number | null = null;
  let strd: number | null = null;
  let str: number | null = null;
  let intervalH: number | null = null;
  if (f && f.covers(lon, lat)) {
    const [ws, wd] = f.at(lon, lat, time);
    wind = finiteOr(ws);
    windDir = wind === null ? null : finiteOr(wd);
    if (f.hasWaves) {
      const w = f.wavesAt(lon, lat, time);
      if (w) {
        swh = finiteOr(w.swh);
        mwp = finiteOr(w.mwp);
        mwd = finiteOr(w.mwd);
      }
    }
    msl = finiteOr(f.mslAt(lon, lat, time));
    if (f.has('2t')) t2m = finiteOr(f.paramAt('2t', lon, lat, time));
    if (f.has('skt')) skt = finiteOr(f.paramAt('skt', lon, lat, time));
    if (f.has('tprate')) tprate = finiteOr(f.paramAt('tprate', lon, lat, time));
    if (f.has('2d')) d2m = finiteOr(f.paramAt('2d', lon, lat, time));
    if (f.has('ptype')) ptypeCode = finiteOr(f.paramAt('ptype', lon, lat, time));
    if (f.hasAny('10fg')) gust = finiteOr(f.paramAt('10fg', lon, lat, time));
    if (f.has('tcc')) cloud = finiteOr(f.paramAt('tcc', lon, lat, time));
    if (f.hasAny('mucape')) mucape = finiteOr(f.paramAt('mucape', lon, lat, time));
    // The accumulated fields: the interval containing the sample time, not
    // interpolated (see ForecastStore.intervalAt); they share the interval.
    for (const p of ['tp', 'sf', 'ssrd', 'strd', 'str'] as const) {
      if (!f.hasAny(p)) continue;
      const iv = f.intervalAt(p, lon, lat, time);
      if (!iv || !Number.isFinite(iv.value)) continue;
      if (p === 'tp') precipM = iv.value;
      else if (p === 'sf') snowM = iv.value;
      else if (p === 'ssrd') ssrd = iv.value;
      else if (p === 'strd') strd = iv.value;
      else str = iv.value;
      intervalH = iv.intervalHours;
    }
  }
  let current: number | null = null;
  let currentDir: number | null = null;
  if (src.currents && !src.currents.isEmpty) {
    const [u, v] = src.currents.at(lon, lat, time);
    // Exactly (0, 0) is the stack's "no source has data here" (stack.ts), not slack water: report no value.
    if (!(u === 0 && v === 0)) {
      const sp = Math.hypot(u, v);
      current = sp;
      currentDir = sp > 1e-6 ? norm360((Math.atan2(u, v) * 180) / Math.PI) : null;
    }
  }
  const rh = relativeHumidity(t2m, d2m);
  const fl = feelsLike(wind === null ? t2m : t2m, wind, rh);
  const pt = precipType(ptypeCode);
  const bft = beaufort(wind);
  const dg = douglas(swh);
  const ss = seaStateIndex(wind, windDir, current, currentDir, swh, mwp, mwd);
  return {
    time: time.toISOString(),
    wind_ms: rnd(wind, 2),
    wind_dir_deg: rnd(windDir, 0),
    gust_ms: rnd(gust, 2),
    swh_m: rnd(swh, 2),
    mwp_s: rnd(mwp, 1),
    mwd_deg: rnd(mwd, 0),
    current_ms: rnd(current, 3),
    current_dir_deg: rnd(currentDir, 0),
    msl_pa: rnd(msl, 0),
    t2m_k: rnd(t2m, 2),
    skt_k: rnd(skt, 2),
    precip_rate_ms: rnd(tprate, 10),
    precip_type: pt.code,
    precip_type_label: pt.label,
    precip_m: rnd(precipM, 5),
    snowfall_m: rnd(snowM, 5),
    ssrd_wm2: rnd(ssrd, 1),
    strd_wm2: rnd(strd, 1),
    str_wm2: rnd(str, 1),
    interval_h: intervalH,
    cloud_cover: rnd(cloud, 3),
    mucape_jkg: rnd(mucape, 0),
    dewpoint_k: rnd(d2m, 2),
    rh: rnd(rh, 2),
    feels_like_k: rnd(fl.k, 2),
    feels_like_basis: fl.basis,
    wind_chill_k: rnd(windChillK(t2m, wind), 2),
    heat_index_k: rnd(heatIndexK(t2m, rh), 2),
    beaufort: bft,
    douglas: dg,
    douglas_label: douglasLabel(dg),
    sea_state_index: ss.index,
    sea_state: seaStateBand(ss.index),
    sea_state_partial: ss.partial,
  };
}

/** A conditions series row: the sample fields plus the tide fields (null when tides are off or have no data here). */
export type ConditionsSeriesRow = ConditionsRow & TideRowFields;

export interface ConditionsSeries {
  lon: number;
  lat: number;
  is_land: boolean;
  from: string;
  hours: number;
  step_h: number;
  forecast_time_range: [string, string] | null;
  truncated: boolean;
  series: ConditionsSeriesRow[];
  /** High / low waters and range over the rows' span (null when tides are off or have no data here). */
  tides: TideSummary | null;
  /** Why `tides` is null when tides are enabled (download failure, outside the grid, no model water nearby). */
  tides_error: string | null;
  sources: { forecast_cycle: string | null; currents: string[]; tides: string | null };
}

/** The tide point series for a conditions query (fetched asynchronously before conditionsSeries). */
export interface ConditionsTide {
  series: TidePointSeries | null;
  error: string | null;
}

const CONDITIONS_MAX_ROWS = 1000;

export function conditionsSeries(
  src: OverlaySources,
  lon: number,
  lat: number,
  from: Date,
  hours: number,
  stepH: number,
  tide: ConditionsTide | null = null
): ConditionsSeries {
  if (!Number.isFinite(stepH) || stepH <= 0) throw new Error('step_h must be > 0');
  const f = src.forecast;
  let start = from.getTime();
  let end = start + hours * HOUR_MS;
  let truncated = false;
  let range: [string, string] | null = null;
  if (f) {
    const [a, b] = f.validRange;
    range = [a.toISOString(), b.toISOString()];
    if (start < a.getTime()) {
      start = a.getTime();
      truncated = true;
    }
    if (end > b.getTime()) {
      end = b.getTime();
      truncated = true;
    }
  }
  const series: ConditionsSeriesRow[] = [];
  const ts = tide?.series ?? null;
  let t = start;
  for (; t <= end + 1 && series.length < CONDITIONS_MAX_ROWS; t += stepH * HOUR_MS)
    series.push({ ...sampleConditions(src, lon, lat, new Date(t)), ...tideRowAt(ts, t) });
  if (t <= end + 1) truncated = true; // stopped by the row limit
  let tides: TideSummary | null = null;
  let tidesError = tide?.error ?? null;
  if (ts && series.length) {
    tides = tideSummary(ts, Date.parse(series[0].time), Date.parse(series[series.length - 1].time));
    if (!series.some(r => r.tide_m !== null)) {
      tides = null;
      tidesError = tidesError ?? 'no model sea level within 2 grid cells (about {distance:18000}) of this point';
    }
  }
  return {
    lon,
    lat,
    is_land: !!src.land && src.land.isLandAt(lon, lat),
    from: new Date(start).toISOString(),
    hours,
    step_h: stepH,
    forecast_time_range: range,
    truncated,
    series,
    tides,
    tides_error: tidesError,
    sources: {
      forecast_cycle: f ? f.meta.cycleTime.toISOString() : null,
      currents: src.currents ? src.currents.sources.map(s => s.name) : [],
      tides: ts ? `${SL_NAME}, run ${ts.run}` : null,
    },
  };
}

/**
 * Land mask for drawing: one byte per pixel (1 = land) over `bbox` at
 * `w`×`h` pixels, row 0 at the north edge, pixel centres at
 * `west + (x + 0.5) * dx`, `north - (y + 0.5) * dy`, the same mapping the
 * page uses to draw a heatmap canvas over the same box. The raster
 * resolution follows the pixel size (finest 0.002°), so the coastline is
 * as sharp as the screen, independent of the data grid.
 */
export function landMaskImage(src: OverlaySources, bbox: BBox, w: number, h: number, mercator = false): Uint8Array {
  if (!src.land) throw new Error('no coastline configured');
  const width = bboxWidth(bbox);
  const height = bbox.north - bbox.south;
  const dx = width / w;
  const dy = height / h;
  // forBBox picks a raster resolution of spacing/4; ask for 4× the pixel so the raster matches the pixel.
  const lm = src.land.forBBox(bbox, Math.min(dx, dy) * 4);
  const out = new Uint8Array(w * h);
  // Web Mercator y of the edges, for tile rows.
  const yN = mercY(bbox.north);
  const yS = mercY(bbox.south);
  for (let y = 0; y < h; y++) {
    const lat = mercator ? latOfMercY(yN - ((y + 0.5) / h) * (yN - yS)) : bbox.north - (y + 0.5) * dy;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const lon = wrapLon(bbox.west + (x + 0.5) * dx);
      if (lm.isLand(lon, lat)) out[row + x] = 1;
    }
  }
  return out;
}

/** Isobar GeoJSON for a bbox at a time (interval in hPa). */
export function pressureFeatures(
  src: OverlaySources,
  bbox: BBox,
  time: Date,
  intervalHpa: number
): { type: 'FeatureCollection'; features: IsobarFeature[] } {
  const f = src.forecast;
  if (!f) throw new Error('no forecast loaded');
  if (!f.has('msl')) throw new Error('msl not loaded');
  const GRID = 0.25;
  const pad = GRID;
  const west = Math.floor((bbox.west - pad) / GRID) * GRID;
  const east = west + Math.ceil((bboxWidth(bbox) + 2 * pad) / GRID) * GRID;
  const south = Math.max(-90, Math.floor((bbox.south - pad) / GRID) * GRID);
  const north = Math.min(90, Math.ceil((bbox.north + pad) / GRID) * GRID);
  let nx = Math.round((east - west) / GRID) + 1;
  let ny = Math.round((north - south) / GRID) + 1;
  nx = Math.max(8, Math.min(600, nx));
  ny = Math.max(8, Math.min(600, ny));
  const lons = new Float64Array(nx);
  const lats = new Float64Array(ny);
  for (let i = 0; i < nx; i++) lons[i] = west + i * GRID;
  for (let j = 0; j < ny; j++) lats[j] = south + j * GRID;
  const field = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      field[j * nx + i] = f.mslAt(wrapLon(lons[i]), lats[j], time) * 0.01;
    }
  }
  return { type: 'FeatureCollection', features: buildIsobarFeatures(field, lons, lats, intervalHpa) };
}
