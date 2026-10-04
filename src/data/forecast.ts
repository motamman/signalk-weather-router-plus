/**
 * Forecast store: gridded wind (10u/10v), pressure (msl), waves
 * (swh/mwp/mwd) and the optional extra fields, with bilinear spatial and
 * linear temporal interpolation.
 *
 * The decoded global forecast is not kept in memory: it lives on disk
 * (decoded.ts, one raw Float32 file per field and step, exactly the
 * decoded values). A request reads the part it needs into a short-lived
 * store: a *window* of the global grid (FieldGrid.win) holding only some
 * rows and columns, for some steps and parameters. A windowed field
 * samples with the global grid's own index arithmetic, so every value
 * inside the window is bit-for-bit the value the whole global store
 * gives (the tests check this). Longitude wraps across the 0/360 seam and
 * the antimeridian.
 *
 * A store of whole global fields (globalField) is what the decoder builds
 * one step at a time before writing it out; `cropField` still builds bbox
 * crops (plain arrays) for the RTOFS currents and for the route worker's
 * fallback when no decoded run exists yet.
 *
 * Wind direction is meteorological (FROM). Wave fields carry NaN over
 * land in the source; a limited nearest-neighbour fill (up to
 * `waveFillCells` cells) is applied so coastal waypoints still get a
 * value, matching the reference implementation's `_wave_nanfill_limited`.
 */

import type { DecodeScratch, Grib2Grid, Grib2Message } from '../grib/grib2';
import { norm360, wrapLon, lonOffset } from '../geo/angles';
import { HOUR_MS, HOUR_S } from '../geo/units';
import type { BBox } from '../geo/geodesy';
import { bboxWidth } from '../geo/geodesy';
import { bilinearCorners, gridXY, lerp2 } from './sampling';
import type { WaveConditions, WindSource } from '../engine/environment';

export interface FieldGrid {
  /** Latitude of row 0 (southernmost), degrees. */
  lat0: number;
  /** Longitude of column 0, degrees (in -180..180 after wrap). */
  lon0: number;
  dLat: number;
  dLon: number;
  nLat: number;
  nLon: number;
  /** Row-major from the south, NaN = missing. */
  values: Float32Array;
  /**
   * True when the columns span the full circle (nLon · dLon = 360):
   * sampling then wraps in longitude instead of clamping at the edges.
   */
  wrapLon?: boolean;
  /**
   * Set when this field holds only a window of the grid described above:
   * lat0/lon0/dLat/dLon/nLat/nLon/wrapLon describe the whole grid, and
   * `values` holds rows r0..r0+nr-1 and columns c0..c0+nc-1 (columns wrap
   * modulo nLon), row-major from the south, nr × nc values. Sampling
   * inside the window gives exactly what the whole grid gives; outside it
   * clamps to the window's edge (those values are not forecast; `covers`
   * says where the window is valid).
   */
  win?: FieldWindow;
}

export interface FieldWindow {
  r0: number;
  c0: number;
  nr: number;
  nc: number;
}

/** Float32Array backed by a SharedArrayBuffer (shared, not copied, across worker threads). */
export function sharedFloat32(n: number): Float32Array {
  return new Float32Array(new SharedArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
}

/**
 * One SharedArrayBuffer carved into Float32 views: the streaming decoder
 * holds one forecast step (every field of it) in one, reused for every
 * step (reset()).
 *
 * Why one block: glibc gives each worker thread its own malloc arena and
 * raises its mmap threshold (up to 32 MB) after large blocks are freed,
 * so a store built from ~275 separate 4.15 MB buffers ends up served from
 * the arena, and when the store is replaced that memory stays in the
 * arena instead of going back to the OS: measured on a Pi 5, one previous
 * store (0.6–1.1 GB) stayed resident after every refresh. A single block
 * of hundreds of MB is always mmap'd and returned to the OS the moment
 * the last thread drops it. Pages never touched (a field missing from a
 * cycle) are never resident. The same holds for the one-step block the
 * streaming decoder reuses (about 46 MB with the extra fields): it is
 * allocated once per update and returned to the OS when the update ends.
 */
export class FloatSlab {
  readonly buffer: SharedArrayBuffer;
  private offset = 0;
  constructor(readonly capacity: number) {
    this.buffer = new SharedArrayBuffer(capacity * Float32Array.BYTES_PER_ELEMENT);
  }
  /** A view of `n` floats, or null when the slab has no room (the caller allocates its own). */
  take(n: number): Float32Array | null {
    if (this.offset + n > this.capacity) return null;
    const v = new Float32Array(this.buffer, this.offset * Float32Array.BYTES_PER_ELEMENT, n);
    this.offset += n;
    return v;
  }
  get used(): number {
    return this.offset;
  }
  /** Reuse the block from the start (the streaming decoder refills it for every step). */
  reset(): void {
    this.offset = 0;
  }
}

/** Same backing kind as `like` (shared or plain). */
function allocLike(like: Float32Array, n: number): Float32Array {
  return like.buffer instanceof SharedArrayBuffer ? sharedFloat32(n) : new Float32Array(n);
}

/** Is this grid's column span the full circle? */
function spansCircle(nLon: number, dLon: number): boolean {
  return Math.abs(nLon * dLon - 360) < 1e-6;
}

/**
 * Keep a whole decoded field (no crop), rows re-ordered south → north
 * like every other FieldGrid, into a SharedArrayBuffer. Each cell is the
 * decoded value rounded to Float32 (then multiplied by `scale` and
 * rounded again, the same two roundings `cropField` + `scaleField`
 * perform), so samples are identical to those from a crop.
 */
export function globalField(grid: Grib2Grid, values: Float64Array, scale = 1, slab?: FloatSlab): FieldGrid {
  if (!grid.iScansPositively) throw new Error('globalField: grids scanning west are not supported');
  const { ni, nj, di, dj } = grid;
  if (values.length !== ni * nj) throw new Error(`globalField: ${values.length} values for a ${ni}x${nj} grid`);
  const out = slab?.take(ni * nj) ?? sharedFloat32(ni * nj);
  const southUp = grid.jScansPositively;
  for (let r = 0; r < nj; r++) {
    const src = (southUp ? r : nj - 1 - r) * ni;
    const dst = r * ni;
    if (scale === 1) {
      for (let c = 0; c < ni; c++) out[dst + c] = values[src + c];
    } else {
      for (let c = 0; c < ni; c++) out[dst + c] = Math.fround(values[src + c]) * scale;
    }
  }
  const lat0 = southUp ? grid.la1 : grid.la1 - (nj - 1) * dj;
  let lon0 = grid.lo1;
  lon0 = wrapLon(lon0);
  return { lat0, lon0, dLat: dj, dLon: di, nLat: nj, nLon: ni, values: out, wrapLon: spansCircle(ni, di) };
}

export interface ForecastStep {
  /** Valid time (ms since epoch). */
  validMs: number;
  stepHours: number;
  fields: Map<string, FieldGrid>;
  /**
   * Hours of the interval each interval field of this step covers
   * (ACCUMULATED_PARAMS, end time = validMs), set only for the fields
   * present. Steps 3–144 h cover 3 h, steps past 144 h cover 6 h; step 0
   * has no interval fields (ECMWF's accumulations start with an empty
   * range, and the step-0 gust is coded 0 m/s everywhere).
   */
  intervals?: Map<string, number>;
}

/**
 * ECMWF fields accumulated since the forecast started. The streaming
 * decode turns each into its per-interval value (step N minus step N−1):
 * a depth in m for `tp` and `sf` (snowfall water equivalent), an average
 * W/m² over the interval for `ssrd`, `strd` and `str` (the GRIB holds
 * J/m², divided by the interval's seconds). The step-0 fields, whose
 * range is empty, are dropped.
 */
export const ACCUMULATED_PARAMS = ['tp', 'ssrd', 'sf', 'strd', 'str'] as const;

/** The accumulated fields published in J/m², stored as average W/m² over the interval. */
export const RADIATIVE_ACCUM: ReadonlySet<string> = new Set(['ssrd', 'strd', 'str']);

/** The previous step's raw accumulated field, kept by the streaming decoder for the step difference. */
export interface AccumPrev {
  values: Float32Array;
  stepHours: number;
}

/**
 * Turn the accumulated-since-start fields of one decoded step into their
 * per-interval values, in place, and record the interval length on the
 * step. `prev` carries the previous step's raw accumulated values across
 * steps (the streaming decoder holds one Map for the run). A field whose
 * previous value is missing (the first step the parameter appears, and
 * step 0) has an empty or unknown range: it is dropped from the step, and
 * its raw values become the new previous. A parameter absent from a
 * cycle's index leaves `prev` untouched, so the next appearance diffs
 * over the real span.
 */
export function applyAccumulated(step: ForecastStep, prev: Map<string, AccumPrev>): void {
  for (const p of ACCUMULATED_PARAMS) {
    const f = step.fields.get(p);
    if (!f) continue;
    const was = prev.get(p);
    // The previous RAW accumulation first: the in-place difference below must
    // not pollute it (step N's diff is raw N − raw N−1, not raw N − diff N−1).
    const raw = new Float32Array(f.values);
    if (was) {
      const intervalH = step.stepHours - was.stepHours;
      const div = RADIATIVE_ACCUM.has(p) ? intervalH * HOUR_S : 1;
      const v = f.values;
      if (div === 1) for (let i = 0; i < v.length; i++) v[i] -= was.values[i];
      else for (let i = 0; i < v.length; i++) v[i] = (v[i] - was.values[i]) / div;
      if (!step.intervals) step.intervals = new Map();
      step.intervals.set(p, intervalH);
    }
    prev.set(p, { values: raw, stepHours: step.stepHours });
    if (!was) step.fields.delete(p);
  }
}

/** The whole globe, as a BBox (meta.bbox of a global store). */
export const GLOBAL_BBOX: BBox = { west: -180, south: -90, east: 180, north: 90 };

export interface ForecastMeta {
  cycleTime: Date;
  /** Crop box, or GLOBAL_BBOX for a global store. */
  bbox: BBox;
  steps: number[];
  params: string[];
  loadedAt: Date;
}

/**
 * Crop a decoded global field to `bbox` (plus one cell of margin on
 * each side so bilinear interpolation at the edges has neighbours).
 * Handles the 0..360 longitude convention of ECMWF grids and boxes
 * crossing the antimeridian.
 */
export function cropField(grid: Grib2Grid, values: Float64Array, bbox: BBox, marginCells = 1): FieldGrid {
  if (!grid.iScansPositively) throw new Error('cropField: grids scanning west are not supported');
  const { ni, nj, di, dj } = grid;
  // Latitude rows in the message run from la1 towards la2.
  const latTop = grid.la1;
  const rowsSouthUp = grid.jScansPositively;
  const latAt = (row: number): number => (rowsSouthUp ? latTop + row * dj : latTop - row * dj);
  // Row indices covering [south, north].
  const rowIdxForLat = (lat: number): number => (rowsSouthUp ? (lat - latTop) / dj : (latTop - lat) / dj);
  let rA = Math.floor(Math.min(rowIdxForLat(bbox.south), rowIdxForLat(bbox.north))) - marginCells;
  let rB = Math.ceil(Math.max(rowIdxForLat(bbox.south), rowIdxForLat(bbox.north))) + marginCells;
  rA = Math.max(0, rA);
  rB = Math.min(nj - 1, rB);
  if (rA > rB) throw new Error('cropField: bbox has no latitude overlap with the grid');
  const nLat = rB - rA + 1;

  // Longitude columns: the grid covers lo1 .. lo1 + (ni-1)*di, possibly
  // the whole circle. Work in offsets east of lo1.
  const lo1 = grid.lo1;
  const globalWrap = Math.abs(ni * di - 360) < 1e-6;
  const offWest = lonOffset(bbox.west, lo1);
  const width = bboxWidth(bbox);
  let cA = Math.floor(offWest / di) - marginCells;
  let cB = Math.ceil((offWest + width) / di) + marginCells;
  if (!globalWrap) {
    cA = Math.max(0, cA);
    cB = Math.min(ni - 1, cB);
    if (cA > cB) throw new Error('cropField: bbox has no longitude overlap with the grid');
  }
  const nLon = cB - cA + 1;
  if (nLon > ni) throw new Error('cropField: bbox wider than the grid');

  const out = new Float32Array(nLat * nLon);
  // Output rows run south → north.
  for (let r = 0; r < nLat; r++) {
    const srcRow = rowsSouthUp ? rA + r : rB - r;
    for (let c = 0; c < nLon; c++) {
      let srcCol = cA + c;
      if (globalWrap) srcCol = ((srcCol % ni) + ni) % ni;
      out[r * nLon + c] = values[srcRow * ni + srcCol];
    }
  }
  const lat0 = rowsSouthUp ? latAt(rA) : latAt(rB);
  let lon0 = lo1 + cA * di;
  lon0 = wrapLon(lon0);
  return { lat0, lon0, dLat: dj, dLon: di, nLat, nLon, values: out };
}

/**
 * Limited nearest-neighbour fill of NaN cells, as in the reference
 * implementation's `_wave_nanfill_limited`: every NaN cell takes the
 * value of the nearest valid cell (Euclidean, in cells) scaled by
 * clip(1 - d / maxCells, 0, 1). Cells farther than `maxCells` from any
 * valid cell therefore become 0, not NaN. A grid with no valid cell at
 * all is returned unchanged. On a grid that spans the full circle
 * (`wrapLon`) the search wraps in longitude.
 *
 * Global wave grids have ~300 k land cells per field, so the search is
 * pruned: a separable box count first finds the NaN cells with no valid
 * cell within Chebyshev distance ceil(maxCells) (their Euclidean
 * distance is then > maxCells too, so the fade makes them 0), and only
 * the rest run the ring search. The ring search visits ring cells in the
 * same row-major order as before, so ties resolve identically.
 *
 * `inPlace` writes the result into `f.values` (the search reads a plain
 * temporary copy), so filling a global shared field does not leave a
 * second 4 MB SharedArrayBuffer behind as garbage.
 */
/** Reusable temporaries for nanFillLimited (the streaming decoder fills ~75 global wave fields per update). */
export interface NanFillScratch {
  copy?: Float32Array;
  count?: Int32Array;
}

export function nanFillLimited(f: FieldGrid, maxCells: number, opts: { inPlace?: boolean; scratch?: NanFillScratch } = {}): FieldGrid {
  const { nLat, nLon } = f;
  const wrap = !!f.wrapLon;
  let anyValid = false;
  for (let i = 0; i < f.values.length && !anyValid; i++) if (!Number.isNaN(f.values[i])) anyValid = true;
  if (!anyValid) return f;
  let values: Float32Array;
  let out: Float32Array;
  if (opts.inPlace) {
    const sc = opts.scratch;
    if (sc) {
      if (!sc.copy || sc.copy.length !== f.values.length) sc.copy = new Float32Array(f.values.length);
      sc.copy.set(f.values);
      values = sc.copy;
    } else values = new Float32Array(f.values);
    out = f.values;
  } else {
    values = f.values;
    out = allocLike(values, values.length);
    out.set(values);
  }
  const R = Math.max(0, Math.ceil(maxCells));
  // near[idx] = number of valid cells within the (2R+1)² box around idx.
  let rowCount: Int32Array;
  if (opts.scratch) {
    if (!opts.scratch.count || opts.scratch.count.length !== values.length) opts.scratch.count = new Int32Array(values.length);
    rowCount = opts.scratch.count;
  } else rowCount = new Int32Array(values.length);
  for (let r = 0; r < nLat; r++) {
    const base = r * nLon;
    for (let c = 0; c < nLon; c++) {
      let n = 0;
      for (let d = -R; d <= R; d++) {
        let cc = c + d;
        if (wrap) cc = ((cc % nLon) + nLon) % nLon;
        else if (cc < 0 || cc >= nLon) continue;
        if (!Number.isNaN(values[base + cc])) n++;
      }
      rowCount[base + c] = n;
    }
  }
  // Ring search out to maxCells + 1 (Euclidean nearest can sit one
  // Chebyshev ring beyond the first hit); beyond that the fade is 0.
  const maxRing = R + 1;
  for (let r = 0; r < nLat; r++) {
    for (let c = 0; c < nLon; c++) {
      const idx = r * nLon + c;
      if (!Number.isNaN(values[idx])) continue;
      let near = 0;
      for (let rr = Math.max(0, r - R); rr <= Math.min(nLat - 1, r + R) && near === 0; rr++) near += rowCount[rr * nLon + c];
      if (near === 0) {
        out[idx] = 0;
        continue;
      }
      let best = 0;
      let bestD = Infinity;
      for (let d = 1; d <= maxRing && d < bestD; d++) {
        for (let rr = r - d; rr <= r + d; rr++) {
          if (rr < 0 || rr >= nLat) continue;
          const edgeRow = rr === r - d || rr === r + d;
          const step = edgeRow ? 1 : 2 * d;
          for (let cc0 = c - d; cc0 <= c + d; cc0 += step) {
            let cc = cc0;
            if (wrap) {
              if (2 * d + 1 > nLon) {
                // Ring wider than the grid: skip columns already visited in this row.
                if (cc0 - (c - d) >= nLon) continue;
              }
              cc = ((cc % nLon) + nLon) % nLon;
            } else if (cc < 0 || cc >= nLon) continue;
            const v = values[rr * nLon + cc];
            if (!Number.isNaN(v)) {
              const dist = Math.hypot(rr - r, cc0 - c);
              if (dist < bestD) {
                bestD = dist;
                best = v;
              }
            }
          }
        }
      }
      out[idx] = bestD < Infinity ? best * Math.max(0, Math.min(1, 1 - bestD / maxCells)) : 0;
    }
  }
  return { ...f, values: out };
}

/**
 * Bilinear sample. On a full-circle grid (`wrapLon`) longitude wraps, so
 * the cell between the last column (359.75°) and the first (0°) blends
 * those two columns and there is no seam at 0° or at the antimeridian.
 * Otherwise positions outside the cropped grid clamp to the nearest edge
 * cell (extrapolating would invent values). Latitude always clamps.
 */
export function sampleField(f: FieldGrid, lon: number, lat: number): number {
  if (f.win) return sampleWindow(f, f.win, lon, lat);
  const [x, y] = gridXY(f, lon, lat);
  const k = bilinearCorners(f.nLat, f.nLon, !!f.wrapLon, x, y);
  return lerp2(f.values[k.i00], f.values[k.i01], f.values[k.i10], f.values[k.i11], k.tx, k.ty);
}

/** Local row of global row `r` in a window (clamped to the window). */
function winRow(w: FieldWindow, r: number): number {
  const lr = r - w.r0;
  return lr < 0 ? 0 : lr >= w.nr ? w.nr - 1 : lr;
}

/** Local column of global column `c` (0..nLon-1) in a window (clamped to its nearer edge outside it). */
function winCol(w: FieldWindow, nLon: number, wrap: boolean, c: number): number {
  let lc = c - w.c0;
  if (wrap && lc < 0) lc += nLon;
  if (lc >= 0 && lc < w.nc) return lc;
  if (!wrap) return lc < 0 ? 0 : w.nc - 1;
  // Outside a window of a wrapping grid: the nearer edge, going either way round.
  return lc - (w.nc - 1) <= nLon - lc ? w.nc - 1 : 0;
}

/**
 * Bilinear sample of a windowed field: the global grid's index and
 * weight arithmetic (sampleWrapped / sampleField, operation for
 * operation), then each cell read from the window. Inside the window the
 * result is therefore identical to sampling the whole grid.
 */
function sampleWindow(f: FieldGrid, w: FieldWindow, lon: number, lat: number): number {
  const [x, y] = gridXY(f, lon, lat);
  const k = bilinearCorners(f.nLat, f.nLon, !!f.wrapLon, x, y);
  const wrap = !!f.wrapLon;
  const nc = w.nc;
  const lr = winRow(w, k.r) * nc;
  const lr1 = winRow(w, k.r1) * nc;
  const lc = winCol(w, f.nLon, wrap, k.c);
  const lc1 = winCol(w, f.nLon, wrap, k.c1);
  return lerp2(f.values[lr + lc], f.values[lr + lc1], f.values[lr1 + lc], f.values[lr1 + lc1], k.tx, k.ty);
}

/**
 * Is (lon, lat) inside the part of the grid a windowed field holds, so
 * that its bilinear neighbours are all in the window?
 */
export function windowCovers(f: FieldGrid, w: FieldWindow, lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  const y = (lat - f.lat0) / f.dLat;
  if (!(y >= w.r0 && y <= w.r0 + w.nr - 1)) return false;
  // A window of every column covers every longitude only on a grid that
  // wraps the globe (ECMWF); a regional grid ends at its edges.
  if (f.wrapLon && w.nc >= f.nLon) return true;
  let x = lonOffset(lon, f.lon0) / f.dLon - w.c0;
  if (f.wrapLon && x < 0) x += f.nLon;
  return x >= 0 && x <= w.nc - 1;
}

/** Nearest-cell sample (categorical fields). */
export function sampleFieldNearest(f: FieldGrid, lon: number, lat: number): number {
  const [fx, fy] = gridXY(f, lon, lat);
  let x: number;
  if (f.wrapLon) {
    x = Math.round(fx);
    if (x >= f.nLon) x -= f.nLon;
  } else x = Math.max(0, Math.min(f.nLon - 1, Math.round(fx)));
  const y = Math.max(0, Math.min(f.nLat - 1, Math.round(fy)));
  if (f.win) return f.values[winRow(f.win, y) * f.win.nc + winCol(f.win, f.nLon, !!f.wrapLon, x)];
  return f.values[y * f.nLon + x];
}

export class ForecastStore implements WindSource {
  readonly steps: ForecastStep[];
  readonly meta: ForecastMeta;
  readonly hasWaves: boolean;
  /** Every field of every step spans the full circle and pole to pole: covers() is true everywhere. */
  readonly global: boolean;

  /**
   * `requireWind` (default true): every step must hold 10u/10v. A window
   * read for one map layer (e.g. msl only) passes false; its at() then
   * returns NaN.
   */
  constructor(steps: ForecastStep[], meta: ForecastMeta, opts: { requireWind?: boolean } = {}) {
    if (steps.length === 0) throw new Error('ForecastStore needs at least one step');
    this.steps = [...steps].sort((a, b) => a.validMs - b.validMs);
    this.meta = meta;
    this.hasWaves = this.steps.every(s => s.fields.has('swh') && s.fields.has('mwp') && s.fields.has('mwd'));
    if (opts.requireWind !== false) {
      for (const s of this.steps) {
        if (!s.fields.has('10u') || !s.fields.has('10v')) throw new Error(`step +${s.stepHours}h lacks 10u/10v`);
      }
    }
    const isGlobal = (f: FieldGrid): boolean =>
      !f.win && !!f.wrapLon && f.lat0 <= -90 + 1e-6 && f.lat0 + (f.nLat - 1) * f.dLat >= 90 - 1e-6;
    this.global = this.steps.every(s => [...s.fields.values()].every(isGlobal));
  }

  /** Is this parameter present in every step? */
  has(param: string): boolean {
    return this.steps.every(s => s.fields.has(param));
  }

  /**
   * Is this parameter present in at least one step? Interval fields start
   * at step 3 (step 0's range is empty), so an interval field is never in
   * *every* step: ask hasAny, not has, before sampling one.
   */
  hasAny(param: string): boolean {
    return this.steps.some(s => s.fields.has(param));
  }

  /** Any field of the first step (the geometry reference for covers()). */
  private refField(): FieldGrid | undefined {
    const s = this.steps[0];
    return s.fields.get('10u') ?? s.fields.values().next().value;
  }

  /** Bracketing step indices and blend factor for a time. */
  timeBlend(time: Date): [number, number, number] {
    return this.timeBlendMs(time.getTime());
  }

  timeBlendMs(t: number): [number, number, number] {
    const n = this.steps.length;
    if (n === 1 || t <= this.steps[0].validMs) return [0, 0, 0];
    if (t >= this.steps[n - 1].validMs) return [n - 1, n - 1, 0];
    let i = 1;
    while (i < n && this.steps[i].validMs <= t) i++;
    const t0 = this.steps[i - 1].validMs;
    const t1 = this.steps[i].validMs;
    const alpha = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return [i - 1, i, alpha];
  }

  /** Parameters that are categorical: nearest in space and time, never blended. */
  static readonly NEAREST_PARAMS = new Set(['ptype']);

  private blended(param: string, lon: number, lat: number, time: Date): number {
    const [i0, i1, a] = this.timeBlend(time);
    if (ForecastStore.NEAREST_PARAMS.has(param)) {
      const i = a < 0.5 ? i0 : i1;
      const f = this.steps[i].fields.get(param);
      return f ? sampleFieldNearest(f, lon, lat) : NaN;
    }
    const f0 = this.steps[i0].fields.get(param);
    if (!f0) return NaN;
    const v0 = sampleField(f0, lon, lat);
    if (a === 0 || i0 === i1) return v0;
    const f1 = this.steps[i1].fields.get(param);
    if (!f1) return v0;
    return v0 * (1 - a) + sampleField(f1, lon, lat) * a;
  }

  /** Wind [speed m/s, direction FROM degrees]. */
  at(lon: number, lat: number, time: Date): [number, number] {
    const u = this.blended('10u', lon, lat, time);
    const v = this.blended('10v', lon, lat, time);
    return [Math.hypot(u, v), norm360(270 - (Math.atan2(v, u) * 180) / Math.PI)];
  }

  atMany(lons: Float64Array, lats: Float64Array, time: Date): { speed: Float64Array; dir: Float64Array } {
    const n = lons.length;
    const speed = new Float64Array(n);
    const dir = new Float64Array(n);
    const [i0, i1, a] = this.timeBlend(time);
    const u0 = this.steps[i0].fields.get('10u')!;
    const v0 = this.steps[i0].fields.get('10v')!;
    const u1 = this.steps[i1].fields.get('10u')!;
    const v1 = this.steps[i1].fields.get('10v')!;
    for (let k = 0; k < n; k++) {
      let u = sampleField(u0, lons[k], lats[k]);
      let v = sampleField(v0, lons[k], lats[k]);
      if (a !== 0 && i0 !== i1) {
        u = u * (1 - a) + sampleField(u1, lons[k], lats[k]) * a;
        v = v * (1 - a) + sampleField(v1, lons[k], lats[k]) * a;
      }
      speed[k] = Math.hypot(u, v);
      dir[k] = norm360(270 - (Math.atan2(v, u) * 180) / Math.PI);
    }
    return { speed, dir };
  }

  /** As atMany, each point at its own time. */
  atManyAt(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): { speed: Float64Array; dir: Float64Array } {
    const n = lons.length;
    const speed = new Float64Array(n);
    const dir = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const [i0, i1, a] = this.timeBlendMs(timesMs[k]);
      let u = sampleField(this.steps[i0].fields.get('10u')!, lons[k], lats[k]);
      let v = sampleField(this.steps[i0].fields.get('10v')!, lons[k], lats[k]);
      if (a !== 0 && i0 !== i1) {
        u = u * (1 - a) + sampleField(this.steps[i1].fields.get('10u')!, lons[k], lats[k]) * a;
        v = v * (1 - a) + sampleField(this.steps[i1].fields.get('10v')!, lons[k], lats[k]) * a;
      }
      speed[k] = Math.hypot(u, v);
      dir[k] = norm360(270 - (Math.atan2(v, u) * 180) / Math.PI);
    }
    return { speed, dir };
  }

  wavesAt(lon: number, lat: number, time: Date): WaveConditions | null {
    if (!this.hasWaves) return null;
    const [i0, i1, a] = this.timeBlend(time);
    const g = (p: string, i: number): number => sampleField(this.steps[i].fields.get(p)!, lon, lat);
    let swh = g('swh', i0);
    let mwp = g('mwp', i0);
    let mwd: number;
    const d0 = (g('mwd', i0) * Math.PI) / 180;
    if (a === 0 || i0 === i1) {
      mwd = norm360((d0 * 180) / Math.PI);
    } else {
      swh = swh * (1 - a) + g('swh', i1) * a;
      mwp = mwp * (1 - a) + g('mwp', i1) * a;
      const d1 = (g('mwd', i1) * Math.PI) / 180;
      const sx = Math.sin(d0) * (1 - a) + Math.sin(d1) * a;
      const cx = Math.cos(d0) * (1 - a) + Math.cos(d1) * a;
      mwd = norm360((Math.atan2(sx, cx) * 180) / Math.PI);
    }
    if (!Number.isFinite(swh)) return null;
    return { swh, mwp, mwd };
  }

  wavesAtMany(lons: Float64Array, lats: Float64Array, time: Date): Float64Array {
    const n = lons.length;
    const out = new Float64Array(n);
    if (!this.hasWaves) return out.fill(NaN);
    const [i0, i1, a] = this.timeBlend(time);
    const s0 = this.steps[i0].fields.get('swh')!;
    const s1 = this.steps[i1].fields.get('swh')!;
    for (let k = 0; k < n; k++) {
      let swh = sampleField(s0, lons[k], lats[k]);
      if (a !== 0 && i0 !== i1) swh = swh * (1 - a) + sampleField(s1, lons[k], lats[k]) * a;
      out[k] = swh;
    }
    return out;
  }

  /** As wavesAtMany, each point at its own time. */
  wavesAtManyAt(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): Float64Array {
    const n = lons.length;
    const out = new Float64Array(n);
    if (!this.hasWaves) return out.fill(NaN);
    for (let k = 0; k < n; k++) {
      const [i0, i1, a] = this.timeBlendMs(timesMs[k]);
      let swh = sampleField(this.steps[i0].fields.get('swh')!, lons[k], lats[k]);
      if (a !== 0 && i0 !== i1) swh = swh * (1 - a) + sampleField(this.steps[i1].fields.get('swh')!, lons[k], lats[k]) * a;
      out[k] = swh;
    }
    return out;
  }

  /** Mean sea-level pressure in Pa, or NaN when not loaded. */
  mslAt(lon: number, lat: number, time: Date): number {
    return this.blended('msl', lon, lat, time);
  }

  /** Generic sampler for any loaded parameter (SI as in the store's unit). */
  paramAt(param: string, lon: number, lat: number, time: Date): number {
    return this.blended(param, lon, lat, time);
  }

  /**
   * The value of an interval field (ACCUMULATED_PARAMS: an accumulation
   * turned into its per-interval amount or average) at a time: the value
   * of the step whose interval contains the time (the step ending at the
   * time, or — strictly inside an interval — the step ending after it).
   * Interval values are not interpolated: mixing the depths of two
   * adjacent 3 h intervals is no interval's depth. Null when the
   * parameter is not loaded or the time falls in no interval of the run
   * (before the first, whose fields start at step 3).
   */
  intervalAt(param: string, lon: number, lat: number, time: Date): { value: number; intervalHours: number } | null {
    const [i0, i1, a] = this.timeBlend(time);
    const step = this.steps[a === 0 ? i0 : i1];
    const intervalHours = step.intervals?.get(param);
    const f = step.fields.get(param);
    if (intervalHours === undefined || !f) return null;
    return { value: sampleField(f, lon, lat), intervalHours };
  }

  get validRange(): [Date, Date] {
    return [new Date(this.steps[0].validMs), new Date(this.steps[this.steps.length - 1].validMs)];
  }

  /** Does the store cover this position (always, for a global store; else within the cropped grid)? */
  covers(lon: number, lat: number): boolean {
    if (this.global) return Number.isFinite(lon) && Number.isFinite(lat) && lat >= -90 && lat <= 90;
    const f = this.refField();
    if (!f) return false;
    if (f.win) return windowCovers(f, f.win, lon, lat);
    const off = lonOffset(lon, f.lon0);
    const x = off > 180 ? off - 360 : off;
    const y = lat - f.lat0;
    return x >= 0 && x <= (f.nLon - 1) * f.dLon && y >= 0 && y <= (f.nLat - 1) * f.dLat;
  }

  /** Approximate resident bytes of all fields. */
  bytes(): number {
    let b = 0;
    for (const s of this.steps) for (const f of s.fields.values()) b += f.values.byteLength;
    return b;
  }

  /** True when every field lives in a SharedArrayBuffer (posting the store shares it, no copy). */
  get shared(): boolean {
    return this.steps.every(s => [...s.fields.values()].every(f => f.values.buffer instanceof SharedArrayBuffer));
  }

  /**
   * Structured-clone friendly form for crossing a worker boundary. The
   * field arrays are passed as they are: SharedArrayBuffer-backed arrays
   * (the global store) arrive in the other thread as views of the same
   * memory; plain arrays (crops) are copied by the clone.
   */
  serialize(): SerializedForecast {
    return {
      steps: this.steps.map(s => ({
        validMs: s.validMs,
        stepHours: s.stepHours,
        fields: [...s.fields.entries()],
        intervals: s.intervals ? [...s.intervals.entries()] : undefined,
      })),
      meta: {
        cycleTimeMs: this.meta.cycleTime.getTime(),
        bbox: this.meta.bbox,
        steps: this.meta.steps,
        params: this.meta.params,
        loadedAtMs: this.meta.loadedAt.getTime(),
      },
    };
  }

  /** Wrap a serialized store; shared field memory stays shared (nothing is copied). */
  static deserialize(s: SerializedForecast): ForecastStore {
    return new ForecastStore(
      s.steps.map(st => ({
        validMs: st.validMs,
        stepHours: st.stepHours,
        fields: new Map(st.fields),
        intervals: st.intervals ? new Map(st.intervals) : undefined,
      })),
      {
        cycleTime: new Date(s.meta.cycleTimeMs),
        bbox: s.meta.bbox,
        steps: s.meta.steps,
        params: s.meta.params,
        loadedAt: new Date(s.meta.loadedAtMs),
      }
    );
  }

  /** Does this store's crop contain the whole box? */
  coversBBox(b: BBox): boolean {
    if (this.global) return true;
    const f = this.refField();
    if (!f) return false;
    if (f.win) {
      const w = f.win;
      const east = b.west + bboxWidth(b);
      return (
        windowCovers(f, w, b.west, b.south) && windowCovers(f, w, east, b.north) && (w.nc >= f.nLon || bboxWidth(b) <= (w.nc - 1) * f.dLon)
      );
    }
    const spanLon = (f.nLon - 1) * f.dLon;
    const spanLat = (f.nLat - 1) * f.dLat;
    const west = lonOffset(b.west, f.lon0);
    const wStart = west > 180 ? west - 360 : west;
    return wStart >= 0 && wStart + bboxWidth(b) <= spanLon && b.south >= f.lat0 && b.north <= f.lat0 + spanLat;
  }
}

export interface SerializedForecast {
  steps: { validMs: number; stepHours: number; fields: [string, FieldGrid][]; intervals?: [string, number][] }[];
  meta: { cycleTimeMs: number; bbox: BBox; steps: number[]; params: string[]; loadedAtMs: number };
}

/**
 * Unit conversions applied once, when a field enters the store, so every
 * consumer (routing, overlays, conditions, the Signal K Weather API) sees
 * Signal K SI units. ECMWF publishes `tprate` as a mass flux in
 * kg m⁻² s⁻¹; with water at 1000 kg/m³ that is a depth rate of 1e-3 m/s.
 * Everything else ECMWF sends (m/s, K, Pa, m, s, degrees, codes) is
 * already in the unit the store promises.
 */
const INGEST_SCALE: Record<string, number> = { tprate: 1e-3 };

function scaleField(f: FieldGrid, k: number): FieldGrid {
  const values = allocLike(f.values, f.values.length);
  for (let i = 0; i < values.length; i++) values[i] = f.values[i] * k;
  return { ...f, values };
}

/**
 * Build a step from decoded messages. `messages` must all share the
 * same valid time; params are named by the caller. `bbox` null keeps
 * each field whole (global, SharedArrayBuffer-backed, in `slab` when
 * given); a bbox crops.
 */
export function buildStep(
  named: { param: string; message: Grib2Message }[],
  bbox: BBox | null,
  waveFillCells = 3,
  scratch?: DecodeScratch,
  slab?: FloatSlab,
  fillScratch?: NanFillScratch
): ForecastStep {
  if (named.length === 0) throw new Error('buildStep: no messages');
  const first = named[0].message;
  const validMs = first.referenceTime.getTime() + first.product.forecastHours * HOUR_MS;
  const fields = new Map<string, FieldGrid>();
  for (const { param, message } of named) {
    const v = message.referenceTime.getTime() + message.product.forecastHours * HOUR_MS;
    if (v !== validMs) throw new Error(`buildStep: ${param} valid time differs from the first message`);
    // An interval message with an empty range carries no statistic: ECMWF
    // codes the step-0 gust (a maximum over 0–0 h) as 0 m/s everywhere.
    // Later steps carry the real maximum over the past interval.
    if (param === '10fg' && message.product.intervalHours === 0) continue;
    const isWave = param === 'swh' || param === 'mwp' || param === 'mwd';
    let f: FieldGrid;
    if (bbox) {
      f = cropField(message.grid, message.decode(scratch), bbox);
      if (isWave) f = nanFillLimited(f, waveFillCells);
      if (INGEST_SCALE[param] !== undefined) f = scaleField(f, INGEST_SCALE[param]);
    } else {
      // Scale is folded into the copy (no wave field is scaled, so the
      // order relative to the NaN fill does not matter).
      f = globalField(message.grid, message.decode(scratch), INGEST_SCALE[param] ?? 1, slab);
      if (isWave) f = nanFillLimited(f, waveFillCells, { inPlace: true, scratch: fillScratch });
    }
    fields.set(param, f);
  }
  return { validMs, stepHours: first.product.forecastHours, fields };
}
