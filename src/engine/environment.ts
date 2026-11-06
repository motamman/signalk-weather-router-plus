/** Environmental data interfaces the engine samples, plus calm defaults. */

export interface WaveConditions {
  /** Significant wave height, metres. */
  swh: number;
  /** Mean wave period, seconds (ECMWF mwp, the energy mean period Tm−1,0). */
  mwp: number;
  /** Mean zero-crossing period Tm02, seconds (ECMWF mp2), NaN where the forecast has none: the wave correction's period. */
  mp2: number;
  /** Mean wave direction FROM, degrees true. */
  mwd: number;
}

export interface WindSource {
  /** Returns [speed m/s, direction FROM degrees]. NaN speed = no data. */
  at(lon: number, lat: number, time: Date): [number, number];
  atMany(lons: Float64Array, lats: Float64Array, time: Date): { speed: Float64Array; dir: Float64Array };
  /** As atMany with one time per point (ms since epoch); the search times every candidate on its own clock. Optional: without it the search calls `at` per point. */
  atManyAt?(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): { speed: Float64Array; dir: Float64Array };
  readonly hasWaves: boolean;
  wavesAt(lon: number, lat: number, time: Date): WaveConditions | null;
  /** Significant wave height (m) per point, NaN where there is none; batched for the search. Optional. */
  wavesAtMany?(lons: Float64Array, lats: Float64Array, time: Date): Float64Array;
  /** As wavesAtMany with one time per point. Optional. */
  wavesAtManyAt?(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): Float64Array;
  /** Height (m), mean period and Tm02 (s) and mean direction FROM (degrees) per point at its own time, NaN where there is none; for the comfort cost and the wave correction. Optional: without it the search calls `wavesAt` per point. */
  wavesFullAtManyAt?(
    lons: Float64Array,
    lats: Float64Array,
    timesMs: Float64Array
  ): { swh: Float64Array; mwp: Float64Array; mp2: Float64Array; mwd: Float64Array };
}

export interface CurrentSource {
  /** Returns [u east m/s, v north m/s]. */
  at(lon: number, lat: number, time: Date): [number, number];
  atMany(lons: Float64Array, lats: Float64Array, time: Date): { u: Float64Array; v: Float64Array };
  /** As atMany with one time per point (ms since epoch). Optional: without it the search calls `at` per point. */
  atManyAt?(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): { u: Float64Array; v: Float64Array };
}

export class NoWind implements WindSource {
  readonly hasWaves = false;
  at(): [number, number] {
    return [0, 0];
  }
  atMany(lons: Float64Array): { speed: Float64Array; dir: Float64Array } {
    return { speed: new Float64Array(lons.length), dir: new Float64Array(lons.length) };
  }
  atManyAt(lons: Float64Array): { speed: Float64Array; dir: Float64Array } {
    return this.atMany(lons);
  }
  wavesAt(): null {
    return null;
  }
}

export class NoCurrent implements CurrentSource {
  at(): [number, number] {
    return [0, 0];
  }
  atMany(lons: Float64Array): { u: Float64Array; v: Float64Array } {
    return { u: new Float64Array(lons.length), v: new Float64Array(lons.length) };
  }
  atManyAt(lons: Float64Array): { u: Float64Array; v: Float64Array } {
    return this.atMany(lons);
  }
}

/** Constant wind everywhere (tests). */
export class ConstantWind implements WindSource {
  readonly hasWaves = false;
  constructor(
    private readonly speedMs: number,
    private readonly dirFromDeg: number
  ) {}
  at(): [number, number] {
    return [this.speedMs, this.dirFromDeg];
  }
  atMany(lons: Float64Array): { speed: Float64Array; dir: Float64Array } {
    return { speed: new Float64Array(lons.length).fill(this.speedMs), dir: new Float64Array(lons.length).fill(this.dirFromDeg) };
  }
  atManyAt(lons: Float64Array): { speed: Float64Array; dir: Float64Array } {
    return this.atMany(lons);
  }
  wavesAt(): null {
    return null;
  }
}
