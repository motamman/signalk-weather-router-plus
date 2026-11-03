/**
 * Polar diagram: boat speed as a function of true wind angle and true
 * wind speed. Files store knots; memory is m/s.
 *
 * Formats:
 *  - `.csv`: header `twa/tws,4,6,8,...` (TWS knots), rows `twa,s1,s2,...`
 *  - `.pol`: same layout, tab-delimited, header `TWA\TWS<tab>...`
 *
 * Interpolation is bilinear with linear extrapolation beyond the table
 * edges (scipy RegularGridInterpolator, method="linear",
 * fill_value=None semantics), clamped at zero, with a per-wind-speed
 * no-go floor: below the tightest TWA that carries any speed at that
 * wind speed the boat is in irons and speed is 0. A cell with no sailing
 * solution (a null cell of a polar-format 2 polar set) gives 0 wherever it
 * carries weight in the interpolation: no speed is interpolated across it.
 */

import * as fs from 'node:fs';
import { foldTwa } from '../geo/angles';
import * as path from 'node:path';
import { KTS_TO_MS } from '../geo/geodesy';

/** A polar as plain arrays, to send to another thread or process: `unavailable` only when a cell has no sailing solution. */
export interface PolarArrays {
  twa: number[];
  tws: number[];
  speeds: number[];
  unavailable?: number[];
}

export class PolarDiagram {
  /** Ascending TWA in degrees. */
  readonly twa: Float64Array;
  /** TWS in m/s, in file order (may be descending). */
  readonly tws: Float64Array;
  /** speeds[i * nTws + k] in m/s for twa[i], tws[k]. */
  readonly speeds: Float64Array;
  /** 1 at speeds[i * nTws + k] where the cell has no sailing solution (its speed is held as 0); null when every cell has one. */
  readonly unavailable: Uint8Array | null;
  private readonly floorByTws: Float64Array;

  constructor(twaDeg: ArrayLike<number>, twsMs: ArrayLike<number>, speedsMs: ArrayLike<number>, unavailable?: ArrayLike<number> | null) {
    const nT = twaDeg.length;
    const nW = twsMs.length;
    if (nT < 2 || nW < 1) throw new Error('polar needs at least two TWA rows and one TWS column');
    if (speedsMs.length !== nT * nW) throw new Error('polar speeds table has the wrong size');
    if (unavailable && unavailable.length !== nT * nW) throw new Error('polar unavailable-cell table has the wrong size');
    for (let i = 1; i < nT; i++) {
      if (!(twaDeg[i] > twaDeg[i - 1])) throw new Error('polar TWA rows must be strictly ascending');
    }
    this.twa = Float64Array.from(twaDeg);
    this.tws = Float64Array.from(twsMs);
    this.speeds = Float64Array.from(speedsMs);
    const mask = unavailable ? Uint8Array.from(unavailable, v => (v ? 1 : 0)) : null;
    this.unavailable = mask && mask.some(v => v === 1) ? mask : null;
    if (this.unavailable) for (let j = 0; j < this.speeds.length; j++) if (this.unavailable[j]) this.speeds[j] = 0;

    // Per-column no-go floor: first TWA with any speed in that column.
    const rowHasSpeed = new Array<boolean>(nT).fill(false);
    for (let i = 0; i < nT; i++) {
      for (let k = 0; k < nW; k++) if (this.speeds[i * nW + k] > 0) rowHasSpeed[i] = true;
    }
    const worstIdx = rowHasSpeed.indexOf(true);
    let worst = worstIdx >= 0 ? this.twa[worstIdx] : 0;
    const floors = new Float64Array(nW);
    const colHas = new Array<boolean>(nW).fill(false);
    for (let k = 0; k < nW; k++) {
      let first = -1;
      for (let i = 0; i < nT; i++) {
        if (this.speeds[i * nW + k] > 0) {
          first = i;
          break;
        }
      }
      colHas[k] = first >= 0;
      floors[k] = first >= 0 ? this.twa[first] : worst;
    }
    if (nW) {
      worst = Math.max(...floors);
      for (let k = 0; k < nW; k++) if (!colHas[k]) floors[k] = worst;
    }
    this.floorByTws = floors;
  }

  /** Tightest sailable TWA at a wind speed (linear across columns, clamped). */
  noGoFloor(twsMs: number): number {
    const n = this.tws.length;
    if (n === 0) return 0;
    if (n === 1) return this.floorByTws[0];
    // np.interp needs ascending x; flip if the table is descending.
    const asc = this.tws[0] <= this.tws[n - 1];
    const x = (k: number): number => (asc ? this.tws[k] : this.tws[n - 1 - k]);
    const y = (k: number): number => (asc ? this.floorByTws[k] : this.floorByTws[n - 1 - k]);
    if (twsMs <= x(0)) return y(0);
    if (twsMs >= x(n - 1)) return y(n - 1);
    let k = 0;
    while (k + 1 < n && x(k + 1) < twsMs) k++;
    const t = (twsMs - x(k)) / (x(k + 1) - x(k));
    return y(k) + t * (y(k + 1) - y(k));
  }

  /**
   * Boat speed (m/s) for a true wind angle (degrees, mirrored into
   * [0, 180]) and true wind speed (m/s, clamped at 0).
   */
  boatSpeed(twaDeg: number, twsMs: number): number {
    const twa = foldTwa(twaDeg);
    const tws = Math.max(0, twsMs);
    if (twa < this.noGoFloor(tws)) return 0;
    if (this.unavailable && this.unavailableAt(twa, tws)) return 0;
    return Math.max(0, this.interp(twa, tws));
  }

  /**
   * Whether the speed at this true wind angle (degrees, mirrored into [0, 180]) and true wind speed (m/s) would be
   * read from a cell with no sailing solution: one of the cells around the point that carries weight in the
   * interpolation. Always false for a table without such cells.
   */
  unavailableAt(twaDeg: number, twsMs: number): boolean {
    const u = this.unavailable;
    if (!u) return false;
    const twa = foldTwa(twaDeg);
    const tws = Math.max(0, twsMs);
    const nW = this.tws.length;
    const i = this.twaRow(twa);
    const ta = (twa - this.twa[i]) / (this.twa[i + 1] - this.twa[i]);
    const k = nW === 1 ? 0 : this.twsColumn(tws);
    const tw = nW === 1 ? 0 : (tws - this.tws[k]) / (this.tws[k + 1] - this.tws[k]);
    // A cell carries weight unless the point lies exactly on the other side's row or column.
    const lo = ta !== 1;
    const hi = ta !== 0;
    const left = tw !== 1;
    const right = nW > 1 && tw !== 0;
    const at = (r: number, c: number): boolean => u[r * nW + c] === 1;
    return (lo && left && at(i, k)) || (lo && right && at(i, k + 1)) || (hi && left && at(i + 1, k)) || (hi && right && at(i + 1, k + 1));
  }

  /** The TWA row below `twa` (ascending axis; the first or last pair outside it, for extrapolation). */
  private twaRow(twa: number): number {
    const nT = this.twa.length;
    let i = 0;
    while (i + 1 < nT - 1 && this.twa[i + 1] <= twa) i++;
    return i;
  }

  /** The TWS column below `tws` (the axis either direction; at least two columns). */
  private twsColumn(tws: number): number {
    const nW = this.tws.length;
    const asc = this.tws[0] <= this.tws[nW - 1];
    let k = 0;
    if (asc) {
      while (k + 1 < nW - 1 && this.tws[k + 1] <= tws) k++;
    } else {
      while (k + 1 < nW - 1 && this.tws[k + 1] >= tws) k++;
    }
    return k;
  }

  /** Bilinear interpolation with linear extrapolation on both axes. */
  private interp(twa: number, tws: number): number {
    const nW = this.tws.length;
    // TWA axis (ascending).
    const i = this.twaRow(twa);
    const ta = (twa - this.twa[i]) / (this.twa[i + 1] - this.twa[i]);
    // TWS axis (either direction).
    if (nW === 1) {
      const a = this.speeds[i * nW];
      const b = this.speeds[(i + 1) * nW];
      return a + ta * (b - a);
    }
    const k = this.twsColumn(tws);
    const tw = (tws - this.tws[k]) / (this.tws[k + 1] - this.tws[k]);
    const s00 = this.speeds[i * nW + k];
    const s01 = this.speeds[i * nW + k + 1];
    const s10 = this.speeds[(i + 1) * nW + k];
    const s11 = this.speeds[(i + 1) * nW + k + 1];
    const s0 = s00 + tw * (s01 - s00);
    const s1 = s10 + tw * (s11 - s10);
    return s0 + ta * (s1 - s0);
  }

  /**
   * This polar with every boat speed multiplied by `factor` (the vessel's
   * polar performance, a ratio). Zero cells stay zero, so the no-go floor
   * is unchanged.
   */
  scaled(factor: number): PolarDiagram {
    if (factor === 1) return this;
    return new PolarDiagram(
      this.twa,
      this.tws,
      this.speeds.map(s => s * factor),
      this.unavailable
    );
  }

  /**
   * This polar with every boat speed closer to the wind than `minTwaDeg`
   * set to zero, so the no-go floor is at least that angle. Many library
   * polars carry small speeds at 5°–25° off the wind, where no boat sails;
   * left in, a route goes dead upwind at a crawl instead of tacking.
   * Returns `this` when nothing changes.
   */
  withNoGoFloor(minTwaDeg: number): PolarDiagram {
    if (!(minTwaDeg > 0)) return this;
    const nW = this.tws.length;
    const speeds = Float64Array.from(this.speeds);
    let changed = false;
    for (let i = 0; i < this.twa.length; i++) {
      if (this.twa[i] >= minTwaDeg) continue;
      for (let k = 0; k < nW; k++) {
        if (speeds[i * nW + k] > 0) {
          speeds[i * nW + k] = 0;
          changed = true;
        }
      }
    }
    return changed ? new PolarDiagram(this.twa, this.tws, speeds, this.unavailable) : this;
  }

  /** This polar as plain arrays (PolarDiagram.fromArrays builds it again). */
  toArrays(): PolarArrays {
    return {
      twa: Array.from(this.twa),
      tws: Array.from(this.tws),
      speeds: Array.from(this.speeds),
      ...(this.unavailable ? { unavailable: Array.from(this.unavailable) } : {}),
    };
  }

  static fromArrays(p: PolarArrays): PolarDiagram {
    return new PolarDiagram(p.twa, p.tws, p.speeds, p.unavailable);
  }

  static load(filePath: string): PolarDiagram {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pol') return PolarDiagram.fromDelimited(filePath, '\t');
    if (ext === '.csv') return PolarDiagram.fromDelimited(filePath, ',');
    throw new Error(`unknown polar format ${ext} for ${filePath} (expected .csv or .pol)`);
  }

  static fromDelimited(filePath: string, delimiter: string): PolarDiagram {
    const text = fs.readFileSync(filePath, 'utf8');
    return PolarDiagram.parse(text, delimiter, filePath);
  }

  static parse(text: string, delimiter: string, label = 'polar'): PolarDiagram {
    const lines = text.split(/\r?\n/);
    let headerIdx = 0;
    while (headerIdx < lines.length && lines[headerIdx].trim() === '') headerIdx++;
    if (headerIdx >= lines.length) throw new Error(`${label} is empty`);
    const header = splitRow(lines[headerIdx], delimiter);
    if (header.length < 2) throw new Error(`${label} has no TWS columns in header: ${lines[headerIdx]}`);
    const twsKts = header.slice(1).map(s => parseNum(s, `${label} header`));
    const nW = twsKts.length;
    const twa: number[] = [];
    const speeds: number[] = [];
    for (let r = headerIdx + 1; r < lines.length; r++) {
      const line = lines[r];
      if (line.trim() === '') continue;
      let row = splitRow(line, delimiter);
      // Tab rows split on runs of tabs (files align columns with extra tabs), so an
      // empty cell (two tabs with nothing between) shows as a missing column. Retry
      // with single tabs; empty cells are then filled from the rows around them.
      if (row.length - 1 !== nW && delimiter === '\t') {
        const exact = line.split('\t').map(x => x.trim());
        while (exact.length > nW + 1 && exact[exact.length - 1] === '') exact.pop();
        if (exact.length - 1 === nW && exact[0] !== '') row = exact;
      }
      if (row.length - 1 !== nW) {
        throw new Error(`${label}, row ${r + 1}: expected ${nW} boat-speed columns, got ${row.length - 1}`);
      }
      twa.push(parseNum(row[0], `${label} row ${r + 1}`));
      for (let k = 1; k <= nW; k++) speeds.push(row[k] === '' ? NaN : parseNum(row[k], `${label} row ${r + 1}`) * KTS_TO_MS);
    }
    if (twa.length === 0) throw new Error(`${label} has no data rows`);
    fillEmptyCells(twa, nW, speeds, label);
    return new PolarDiagram(
      twa,
      twsKts.map(k => k * KTS_TO_MS),
      speeds
    );
  }
}

/**
 * Fill empty cells (NaN) in place: linear in TWA between the nearest filled
 * rows of the same TWS column, or the nearest filled row at the table's end.
 * A column with no value at all is an error.
 */
function fillEmptyCells(twa: number[], nW: number, speeds: number[], label: string): void {
  const nA = twa.length;
  for (let k = 0; k < nW; k++) {
    const at = (i: number): number => speeds[i * nW + k];
    for (let i = 0; i < nA; i++) {
      if (!Number.isNaN(at(i))) continue;
      let lo = i - 1;
      while (lo >= 0 && Number.isNaN(at(lo))) lo--;
      let hi = i + 1;
      while (hi < nA && Number.isNaN(at(hi))) hi++;
      if (lo < 0 && hi >= nA) throw new Error(`${label}: TWS column ${k + 1} has no values`);
      let v: number;
      if (lo < 0) v = at(hi);
      else if (hi >= nA) v = at(lo);
      else v = at(lo) + ((at(hi) - at(lo)) * (twa[i] - twa[lo])) / (twa[hi] - twa[lo] || 1);
      speeds[i * nW + k] = v;
    }
  }
}

function splitRow(line: string, delimiter: string): string[] {
  const parts = delimiter === '\t' ? line.split(/\t+/) : line.split(delimiter);
  return parts.map(s => s.trim()).filter((s, idx, arr) => !(idx === arr.length - 1 && s === ''));
}

function parseNum(s: string, where: string): number {
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`${where}: "${s}" is not a number`);
  return v;
}
