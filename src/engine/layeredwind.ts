/**
 * Regional wind layered over the global forecast
 * (docs/plans/grib-downloader-enhancement.md, phase 4).
 *
 * The base (ECMWF) answers everywhere; each regional source (AROME,
 * ARPEGE, ICON-EU from signalk-grib-downloader) takes over inside its own
 * grid and forecast hours. A regional grid ends abruptly, so its weight
 * ramps from 0 at its border to 1 at EDGE_CELLS cells inside, and from 1
 * to 0 over its last HANDOFF_MS of forecast; the wind vectors (u, v) are
 * blended, never the directions. Several regional sources are applied
 * coarse to fine, the finest last. Waves always come from the base.
 */

import type { WaveConditions, WindSource } from './environment';
import { lonOffset, norm360 } from '../geo/angles';
import { DEG, RAD } from '../geo/units';

/** Cells inside a regional grid's border over which its weight ramps up. */
export const EDGE_CELLS = 5;
/** Hours before a regional forecast's last step over which its weight ramps down. */
export const HANDOFF_MS = 3 * 3600_000;

/** A regional wind field: a wind source plus the geometry of its whole grid and its forecast hours. */
export interface RegionalWind {
  name: string;
  wind: WindSource & { covers(lon: number, lat: number): boolean };
  /**
   * The whole grid (not the window read): row 0 south, column 0 west.
   * wrapLon: the grid goes all the way round (a global source such as GFS),
   * so its first and last columns are neighbours, not a border.
   */
  grid: { lat0: number; lon0: number; dLat: number; dLon: number; nLat: number; nLon: number; wrapLon?: boolean };
  firstMs: number;
  lastMs: number;
}

/** A base wind source that knows the range of time it covers (the ECMWF window). */
export interface BaseWind extends WindSource {
  validRange: [Date, Date];
}

export class LayeredWind implements WindSource {
  readonly hasWaves: boolean;
  /** Regional sources, coarse first, finest last. */
  readonly regional: RegionalWind[];
  /** Wind samples taken, and per regional source those it answered with a weight above one half. */
  private samples = 0;
  private answered = new Map<string, number>();

  constructor(
    readonly base: BaseWind,
    regional: RegionalWind[]
  ) {
    this.hasWaves = base.hasWaves;
    this.regional = [...regional].sort((a, b) => b.grid.dLon - a.grid.dLon);
    for (const r of this.regional) this.answered.set(r.name, 0);
  }

  get validRange(): [Date, Date] {
    return this.base.validRange;
  }

  /** The weight of a regional source at a point and time: 0 outside its grid or hours, ramping to 1 inside. */
  static weight(r: RegionalWind, lon: number, lat: number, tMs: number): number {
    if (!(tMs >= r.firstMs && tMs <= r.lastMs)) return 0;
    if (!r.wind.covers(lon, lat)) return 0;
    const g = r.grid;
    const y = (lat - g.lat0) / g.dLat;
    let edge = Math.min(y, g.nLat - 1 - y);
    // A grid that goes all the way round has no east or west border.
    if (!g.wrapLon) {
      let x = lonOffset(lon, g.lon0) / g.dLon;
      if (x > g.nLon - 1 + EDGE_CELLS * 4) x -= 360 / g.dLon; // west of the grid, wrapped
      edge = Math.min(edge, x, g.nLon - 1 - x);
    }
    if (!(edge > 0)) return 0;
    const wEdge = Math.min(1, edge / EDGE_CELLS);
    const wTime = Math.min(1, (r.lastMs - tMs) / HANDOFF_MS);
    return Math.max(0, wEdge * wTime);
  }

  /** Share of the wind samples since the last reset answered mainly by each regional source (0..1). */
  shares(): { name: string; share: number }[] {
    return this.regional.map(r => ({ name: r.name, share: this.samples ? (this.answered.get(r.name) ?? 0) / this.samples : 0 }));
  }

  /** Samples taken and those each regional source answered mainly (for totals over several legs). */
  tally(): { samples: number; answered: Record<string, number> } {
    return { samples: this.samples, answered: Object.fromEntries(this.answered) };
  }

  resetShares(): void {
    this.samples = 0;
    for (const k of this.answered.keys()) this.answered.set(k, 0);
  }

  at(lon: number, lat: number, time: Date): [number, number] {
    const r = this.atManyAt(Float64Array.of(lon), Float64Array.of(lat), Float64Array.of(time.getTime()));
    return [r.speed[0], r.dir[0]];
  }

  atMany(lons: Float64Array, lats: Float64Array, time: Date): { speed: Float64Array; dir: Float64Array } {
    return this.atManyAt(lons, lats, new Float64Array(lons.length).fill(time.getTime()));
  }

  atManyAt(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): { speed: Float64Array; dir: Float64Array } {
    const { speed, dir } = this.blend(lons, lats, timesMs);
    return { speed, dir };
  }

  /**
   * As atManyAt, with the source that answered each sample: the regional
   * source whose weight there is above one half (the finest when several
   * are), else null for the base. Counted in the shares like atManyAt.
   */
  atManyAtWithSource(
    lons: Float64Array,
    lats: Float64Array,
    timesMs: Float64Array
  ): { speed: Float64Array; dir: Float64Array; source: (string | null)[] } {
    const { speed, dir, bestIdx } = this.blend(lons, lats, timesMs);
    return { speed, dir, source: Array.from(bestIdx, ri => (ri >= 0 ? this.regional[ri].name : null)) };
  }

  private blend(
    lons: Float64Array,
    lats: Float64Array,
    timesMs: Float64Array
  ): { speed: Float64Array; dir: Float64Array; bestIdx: Int16Array } {
    const n = lons.length;
    const b = sampleAt(this.base, lons, lats, timesMs);
    const u = new Float64Array(n);
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      // Meteorological FROM direction: the vector points the other way.
      u[k] = -b.speed[k] * Math.sin(b.dir[k] * DEG);
      v[k] = -b.speed[k] * Math.cos(b.dir[k] * DEG);
    }
    const best = new Float64Array(n);
    const bestIdx = new Int16Array(n).fill(-1);
    for (let ri = 0; ri < this.regional.length; ri++) {
      const r = this.regional[ri];
      const idx: number[] = [];
      const w: number[] = [];
      for (let k = 0; k < n; k++) {
        const wk = LayeredWind.weight(r, lons[k], lats[k], timesMs[k]);
        if (wk > 0) {
          idx.push(k);
          w.push(wk);
        }
      }
      if (!idx.length) continue;
      const s = sampleAt(
        r.wind,
        Float64Array.from(idx, k => lons[k]),
        Float64Array.from(idx, k => lats[k]),
        Float64Array.from(idx, k => timesMs[k])
      );
      for (let q = 0; q < idx.length; q++) {
        const k = idx[q];
        const sp = s.speed[q];
        if (!Number.isFinite(sp)) continue; // no regional value here: keep what is there
        const ru = -sp * Math.sin(s.dir[q] * DEG);
        const rv = -sp * Math.cos(s.dir[q] * DEG);
        u[k] = u[k] * (1 - w[q]) + ru * w[q];
        v[k] = v[k] * (1 - w[q]) + rv * w[q];
        if (w[q] > 0.5 && w[q] >= best[k]) {
          best[k] = w[q];
          bestIdx[k] = ri;
        }
      }
    }
    const speed = new Float64Array(n);
    const dir = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      speed[k] = Math.hypot(u[k], v[k]);
      dir[k] = norm360(Math.atan2(-u[k], -v[k]) * RAD);
      if (!Number.isFinite(b.speed[k])) {
        speed[k] = NaN;
        dir[k] = NaN;
      }
      if (bestIdx[k] >= 0) {
        const name = this.regional[bestIdx[k]].name;
        this.answered.set(name, (this.answered.get(name) ?? 0) + 1);
      }
    }
    this.samples += n;
    return { speed, dir, bestIdx };
  }

  wavesAt(lon: number, lat: number, time: Date): WaveConditions | null {
    return this.base.wavesAt(lon, lat, time);
  }

  wavesAtMany(lons: Float64Array, lats: Float64Array, time: Date): Float64Array {
    if (this.base.wavesAtMany) return this.base.wavesAtMany(lons, lats, time);
    return Float64Array.from(lons, (lon, k) => this.base.wavesAt(lon, lats[k], time)?.swh ?? NaN);
  }

  /** The waves at each point and time, from the base forecast (regional runs hold wind only): all at once when it can. */
  wavesFullAtManyAt(
    lons: Float64Array,
    lats: Float64Array,
    timesMs: Float64Array
  ): { swh: Float64Array; mwp: Float64Array; mp2: Float64Array; mwd: Float64Array } {
    if (this.base.wavesFullAtManyAt) return this.base.wavesFullAtManyAt(lons, lats, timesMs);
    return wavesFullFallback(this.base, lons, lats, timesMs);
  }

  wavesAtManyAt(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): Float64Array {
    if (this.base.wavesAtManyAt) return this.base.wavesAtManyAt(lons, lats, timesMs);
    return Float64Array.from(lons, (lon, k) => this.base.wavesAt(lon, lats[k], new Date(timesMs[k]))?.swh ?? NaN);
  }
}

/** The waves at each point and time, one wavesAt each, for a source that cannot sample many at once: NaN where none. */
function wavesFullFallback(
  w: WindSource,
  lons: Float64Array,
  lats: Float64Array,
  timesMs: Float64Array
): { swh: Float64Array; mwp: Float64Array; mp2: Float64Array; mwd: Float64Array } {
  const n = lons.length;
  const swh = new Float64Array(n).fill(NaN);
  const mwp = new Float64Array(n).fill(NaN);
  const mp2 = new Float64Array(n).fill(NaN);
  const mwd = new Float64Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    const v = w.wavesAt(lons[k], lats[k], new Date(timesMs[k]));
    if (v) [swh[k], mwp[k], mp2[k], mwd[k]] = [v.swh, v.mwp, v.mp2, v.mwd];
  }
  return { swh, mwp, mp2, mwd };
}

function sampleAt(
  w: WindSource,
  lons: Float64Array,
  lats: Float64Array,
  timesMs: Float64Array
): { speed: Float64Array; dir: Float64Array } {
  if (w.atManyAt) return w.atManyAt(lons, lats, timesMs);
  const speed = new Float64Array(lons.length);
  const dir = new Float64Array(lons.length);
  for (let k = 0; k < lons.length; k++) [speed[k], dir[k]] = w.at(lons[k], lats[k], new Date(timesMs[k]));
  return { speed, dir };
}
