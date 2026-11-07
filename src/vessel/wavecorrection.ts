/**
 * A polar set's wave correction (polar-format 2 `waveCorrection`): a boat-speed factor by significant wave height,
 * wave period and the angle the waves come from relative to the bow (0 = head seas, 180° = following seas, both
 * sides alike). Sailing speed = polar speed × factor (polar-format: × the performance factor too, which the polar
 * already carries).
 *
 * The factor is interpolated as polar-format suggests: linearly in angle, then in period within each of the two
 * height layers around the height, then in height. A sea outside the table (a height, period or angle beyond the
 * layers' axes) has no factor: polar-format forbids extrapolating or treating it as 1, so the caller sails it
 * uncorrected and says so (the owner's choice, 2026-11-03: a warning on the leg, the route not failed).
 *
 * The period is the forecast's mean zero-crossing period Tm02 (ECMWF mp2): mean, the owner's choice of 2026-11-03,
 * agreed in SignalK/sailsconfiguration#13; Tm02 because ECMWF's mwp is the energy mean period Tm−1,0, longer than
 * Tm01 or Tm02, and open data has no Tm01 (2026-11-04). Polar-format does not say which period a table is made for. A
 * forecast without mp2 leaves the sea uncorrected (legsim.ts), never read with mwp.
 */

/** One height layer: factors[period row × angles + angle column]. */
export interface WaveCorrectionLayer {
  /** Significant wave height, m. */
  heightM: number;
  /** Wave periods, s, strictly increasing. */
  periodsS: number[];
  /** Wave angles from the bow, degrees 0..180, strictly increasing. */
  anglesDeg: number[];
  /** Speed factors (dimensionless, ≥ 0), [period][angle] row-major. */
  factors: number[];
}

export interface WaveCorrection {
  /** By strictly increasing height. */
  layers: WaveCorrectionLayer[];
  /** The layers' heights, m (layers[i].heightM), for the lookup. */
  heightsM: number[];
}

/** Where `x` falls on a strictly increasing axis: the cell below and the share towards the next, or null outside it. */
function bracket(axis: readonly number[], x: number): [number, number] | null {
  const n = axis.length;
  if (!(x >= axis[0] && x <= axis[n - 1])) return null;
  if (n === 1) return [0, 0];
  let i = 0;
  while (i + 1 < n - 1 && axis[i + 1] <= x) i++;
  return [i, (x - axis[i]) / (axis[i + 1] - axis[i])];
}

/** One layer's factor at a period and angle: linear in angle, then in period; null outside its axes. */
function layerFactor(l: WaveCorrectionLayer, periodS: number, angleDeg: number): number | null {
  const p = bracket(l.periodsS, periodS);
  const a = bracket(l.anglesDeg, angleDeg);
  if (!p || !a) return null;
  const nA = l.anglesDeg.length;
  const at = (r: number, c: number): number => l.factors[r * nA + c];
  const row = (r: number): number => (a[1] === 0 ? at(r, a[0]) : at(r, a[0]) + a[1] * (at(r, a[0] + 1) - at(r, a[0])));
  return p[1] === 0 ? row(p[0]) : row(p[0]) + p[1] * (row(p[0] + 1) - row(p[0]));
}

/**
 * The speed factor for a sea of `swhM` metres at `periodS` seconds, the waves `angleDeg` off the bow (0..180), or null
 * when the sea is outside the table (or a value is missing).
 */
export function waveFactor(wc: WaveCorrection, swhM: number, periodS: number, angleDeg: number): number | null {
  if (!Number.isFinite(swhM) || !Number.isFinite(periodS) || !Number.isFinite(angleDeg)) return null;
  const h = bracket(wc.heightsM, swhM);
  if (!h) return null;
  const lo = layerFactor(wc.layers[h[0]], periodS, angleDeg);
  if (lo === null) return null;
  if (h[1] === 0) return lo;
  const hi = layerFactor(wc.layers[h[0] + 1], periodS, angleDeg);
  if (hi === null) return null;
  return lo + h[1] * (hi - lo);
}
