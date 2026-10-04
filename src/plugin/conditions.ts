/**
 * Derived meteorological/sea-state quantities, ported from the routing
 * server's `routers/conditions.py` and `routers/roughness.py`.
 *
 * Units follow Signal K: SI throughout, dimensionless quantities as plain
 * ratios (relative humidity 0..1) or indices (Beaufort, Douglas, sea
 * state). Nothing here is in percent, mm/h or any other display unit.
 */

/** Beaufort force lower bounds (m/s) for forces 1..12; force 0 below 0.3. */
export const BEAUFORT_LOWER_MS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
export const BEAUFORT_NAMES = [
  'calm',
  'light air',
  'light breeze',
  'gentle breeze',
  'moderate breeze',
  'fresh breeze',
  'strong breeze',
  'near gale',
  'gale',
  'strong gale',
  'storm',
  'violent storm',
  'hurricane',
];
/** Douglas sea-state lower bounds (m) for states 1..9. */
export const DOUGLAS_LOWER_M = [0.0001, 0.1, 0.5, 1.25, 2.5, 4.0, 6.0, 9.0, 14.0];
export const DOUGLAS_LABEL = [
  'calm (glassy)',
  'calm (rippled)',
  'smooth',
  'slight',
  'moderate',
  'rough',
  'very rough',
  'high',
  'very high',
  'phenomenal',
];
export const SEA_STATE_CUTS = [35.0, 50.0, 75.0, 100.0, 150.0];
export const SEA_STATE_LABEL = ['smooth', 'good', 'slight', 'choppy', 'rough', 'extreme'];
/** WMO code table 4.201 as ECMWF publishes it. */
export const PTYPE_LABEL: Record<number, string> = {
  0: 'none',
  1: 'rain',
  3: 'freezing rain',
  5: 'snow',
  6: 'wet snow',
  7: 'rain and snow',
  8: 'ice pellets',
  12: 'freezing drizzle',
};

export function finite(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** numpy.searchsorted(..., side="right") equivalent on an ascending list. */
function searchRight(bounds: number[], v: number): number {
  let i = 0;
  while (i < bounds.length && bounds[i] <= v) i++;
  return i;
}

export function beaufort(windMs: number | null): number | null {
  const v = finite(windMs);
  if (v === null) return null;
  return searchRight(BEAUFORT_LOWER_MS, Math.max(v, 0));
}

export function douglas(swhM: number | null): number | null {
  const v = finite(swhM);
  if (v === null) return null;
  return searchRight(DOUGLAS_LOWER_M, Math.max(v, 0));
}

export function douglasLabel(state: number | null): string | null {
  return state === null ? null : DOUGLAS_LABEL[state];
}

export function seaStateBand(idx: number | null): string | null {
  const v = finite(idx);
  if (v === null) return null;
  return SEA_STATE_LABEL[searchRight(SEA_STATE_CUTS, v)];
}

const G = 9.80665;
const WIND_FADE_MS = 2.572222;
const SWH_FADE_M = 0.5;

/**
 * Combined wind-vs-current + swell-vs-current roughness index and the
 * "signal" (0..1) that drives heatmap alpha. Scalar port of
 * `_roughness_index`; all angles degrees, speeds m/s.
 */
export function roughnessIndex(
  W: number,
  C: number,
  windFromDeg: number,
  currentToDeg: number,
  swh: number,
  mwp: number,
  mwdFromDeg: number
): { idx: number; signal: number } {
  const windTo = (windFromDeg + 180) % 360;
  let theta = Math.abs(windTo - currentToDeg);
  if (theta > 180) theta = 360 - theta;
  const veff = Math.sqrt(W * W + C * C - 2 * W * C * Math.cos((theta * Math.PI) / 180));
  const wSafe = Math.max(W, 1e-3);
  const fadeW = Math.max(0, Math.min(1, W / WIND_FADE_MS));
  let idxWind = 50 * (veff / wSafe) ** 2 * fadeW;
  idxWind = Math.min(idxWind, 400);

  const waveTo = (mwdFromDeg + 180) % 360;
  let phi = Math.abs(waveTo - currentToDeg);
  if (phi > 180) phi = 360 - phi;
  const uAlong = C * Math.cos((phi * Math.PI) / 180);
  const uOpp = Math.max(-uAlong, 0);
  const cg = (G * Math.max(mwp, 2)) / (4 * Math.PI);
  const steepen = 1 / Math.max(0.3, 1 - (2 * uOpp) / cg);
  // Long-period swell rides easier than the steep short-period wind sea the
  // index was tuned on: damp the swell term by 5/max(mwp, 5) so standard
  // open-ocean swells (2.25 m at 12 s) no longer land in the extreme band
  // by themselves. Periods of 5 s or less (and the missing-data default of
  // 5 s) leave the original coastal behaviour untouched.
  const periodScale = 5 / Math.max(mwp, 5);
  const swhSafe = Number.isFinite(swh) && swh > 0 ? swh : 0;
  const idxSwell = 30 * swhSafe * swhSafe * periodScale * steepen;
  let idx = idxWind + idxSwell;
  if (!Number.isFinite(idx)) idx = 0;
  const signal = Math.max(Math.max(0, Math.min(1, W / WIND_FADE_MS)), Math.max(0, Math.min(1, swhSafe / SWH_FADE_M)));
  return { idx, signal };
}

/**
 * Sea-state index at one point via the roughness formula; `partial` is
 * true when wave data was missing and the wind-only term is used.
 */
export function seaStateIndex(
  windMs: number | null,
  windFromDeg: number | null,
  currentMs: number | null,
  currentToDeg: number | null,
  swhM: number | null,
  mwpS: number | null,
  mwdFromDeg: number | null
): { index: number | null; partial: boolean } {
  const W = finite(windMs);
  const wd = finite(windFromDeg);
  if (W === null || wd === null) return { index: null, partial: false };
  const C = finite(currentMs) ?? 0;
  const cd = finite(currentToDeg) ?? 0;
  let swh = finite(swhM);
  let mwp = finite(mwpS);
  let mwd = finite(mwdFromDeg);
  const partial = swh === null || mwp === null || mwd === null;
  if (partial) {
    swh = 0;
    mwp = 5;
    mwd = 0;
  }
  const { idx } = roughnessIndex(W, C, wd, cd, swh!, mwp!, mwd!);
  return { index: Math.round(idx * 10) / 10, partial };
}

export function precipType(code: number | null): { code: number | null; label: string | null } {
  const v = finite(code);
  if (v === null) return { code: null, label: null };
  const c = Math.round(v);
  return { code: c, label: PTYPE_LABEL[c] ?? 'other' };
}

/**
 * Relative humidity as a ratio (0..1, the Signal K unit for
 * `environment.*.relativeHumidity`) from air and dew-point temperature
 * (K), Magnus form.
 */
export function relativeHumidity(t2mK: number | null, d2mK: number | null): number | null {
  const t = finite(t2mK);
  const td = finite(d2mK);
  if (t === null || td === null) return null;
  const tc = t - 273.15;
  const tdc = td - 273.15;
  const rh = Math.exp((17.625 * tdc) / (243.04 + tdc)) / Math.exp((17.625 * tc) / (243.04 + tc));
  return Math.max(0, Math.min(1, rh));
}

/** NWS / Environment Canada wind chill (°C), wind in m/s at 10 m. */
export function windChillC(tC: number, windMs: number): number {
  const v = windMs * 3.6;
  return 13.12 + 0.6215 * tC - 11.37 * v ** 0.16 + 0.3965 * tC * v ** 0.16;
}

/** NWS heat index (Rothfusz regression with adjustments), °C; `rh` in percent as the regression is published. */
export function heatIndexC(tC: number, rh: number): number {
  const t = (tC * 9) / 5 + 32;
  let hi = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);
  if ((hi + t) / 2 >= 80) {
    hi =
      -42.379 +
      2.04901523 * t +
      10.14333127 * rh -
      0.22475541 * t * rh -
      6.83783e-3 * t * t -
      5.481717e-2 * rh * rh +
      1.22874e-3 * t * t * rh +
      8.5282e-4 * t * rh * rh -
      1.99e-6 * t * t * rh * rh;
    if (rh < 13 && t >= 80 && t <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
    else if (rh > 85 && t >= 80 && t <= 87) hi += ((rh - 85) / 10) * ((87 - t) / 5);
  }
  return ((hi - 32) * 5) / 9;
}

export function windChillK(t2mK: number | null, windMs: number | null): number | null {
  const t = finite(t2mK);
  const w = finite(windMs);
  if (t === null || w === null) return null;
  const tc = t - 273.15;
  if (tc <= 10 && w >= 1.34) return windChillC(tc, w) + 273.15;
  return null;
}

/** Heat index (K) from air temperature (K) and relative humidity as a ratio; null outside the NWS validity range. */
export function heatIndexK(t2mK: number | null, rh: number | null): number | null {
  const t = finite(t2mK);
  const r = finite(rh);
  if (t === null || r === null) return null;
  const tc = t - 273.15;
  if (tc >= 27 && r >= 0.4) return heatIndexC(tc, r * 100) + 273.15;
  return null;
}

/** Apparent temperature (K): wind chill when cold and windy, heat index when hot and humid, else air. `rh` is a ratio. */
export function feelsLike(
  t2mK: number | null,
  windMs: number | null,
  rh: number | null
): { k: number | null; basis: 'air' | 'wind_chill' | 'heat_index' | null } {
  const t = finite(t2mK);
  if (t === null) return { k: null, basis: null };
  const tc = t - 273.15;
  const w = finite(windMs);
  if (tc <= 10 && w !== null && w >= 1.34) return { k: windChillC(tc, w) + 273.15, basis: 'wind_chill' };
  const r = finite(rh);
  if (tc >= 27 && r !== null && r >= 0.4) return { k: heatIndexC(tc, r * 100) + 273.15, basis: 'heat_index' };
  return { k: t, basis: 'air' };
}

/** Round to `nd` decimals, or null for non-finite. */
export function rnd(x: number | null | undefined, nd: number): number | null {
  const v = finite(x);
  if (v === null) return null;
  const f = 10 ** nd;
  return Math.round(v * f) / f;
}
