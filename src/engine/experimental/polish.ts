/**
 * Cross-track polish (docs/drafts/routing-thought-experiment.md, Idea 3,
 * done gradient-free): the search and the tack layout give a polyline
 * whose waypoints sit on the search's grid; this moves each interior
 * waypoint sideways where that lowers the route's true arrival time.
 *
 * Why not the draft's adjoint: that needs a differentiable forward
 * model, and the leg simulator is not one (sub-steps, mode switches,
 * polar table lookups, forecast interpolation kinks); a finite-difference
 * gradient over hundreds of headings would cost hundreds of full-route
 * simulations per step. Trying a few offsets per waypoint and keeping the
 * best costs about one re-timing of the route per offset.
 *
 * Per pass, for each interior waypoint that is not a user via: offsets of
 * POLISH_OFFSETS_M to either side, perpendicular to the straight line
 * between its neighbours, capped at a third of the shorter adjacent leg;
 * a move is kept when the whole route re-timed from there arrives at
 * least POLISH_MIN_GAIN_S earlier and both adjacent legs are clear of
 * land and sailable. Passes repeat until one moves nothing, at most
 * POLISH_MAX_PASSES.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import type { LandTest } from '../../geo/landmask';
import type { Waypoint } from '../route';

export const POLISH_OFFSETS_M = [2000, 1000, 500, 250];
export const POLISH_MAX_PASSES = 5;
/** A move has to gain at least this to be kept (seconds). */
export const POLISH_MIN_GAIN_S = 1;

export interface PolishResult {
  passes: number;
  moved: number;
  /** Arrival time gained, seconds. */
  gainedS: number;
}

/**
 * `timeLeg(a, b)` sets b's time (and mode) from a's, returning false when
 * the leg cannot be sailed. The waypoints are moved and re-timed in place.
 */
export function crossTrackPolish(wps: Waypoint[], land: LandTest, timeLeg: (a: Waypoint, b: Waypoint) => boolean): PolishResult {
  const n = wps.length;
  const res: PolishResult = { passes: 0, moved: 0, gainedS: 0 };
  if (n < 3) return res;
  const arrivalFrom = (list: Waypoint[], k: number): number => {
    for (let i = k; i < list.length; i++) if (!timeLeg(list[i - 1], list[i])) return Infinity;
    return list[list.length - 1].time.getTime();
  };
  for (let pass = 0; pass < POLISH_MAX_PASSES; pass++) {
    res.passes++;
    let movedThisPass = 0;
    for (let k = 1; k < n - 1; k++) {
      const p = wps[k];
      if (p.role === 'via') continue;
      const a = wps[k - 1];
      const c = wps[k + 1];
      const cap = Math.min(haversineDistanceM(a.lon, a.lat, p.lon, p.lat), haversineDistanceM(p.lon, p.lat, c.lon, c.lat)) / 3;
      const brg = haversineBearing(a.lon, a.lat, c.lon, c.lat);
      const current = wps[n - 1].time.getTime();
      let best: { list: Waypoint[]; arrival: number } | null = null;
      for (const off of POLISH_OFFSETS_M) {
        if (off > cap) continue;
        for (const side of [90, -90]) {
          const [lon, lat] = projectAlongBearing(p.lon, p.lat, brg + side, off);
          if (land.legCrossesLandExact(a.lon, a.lat, lon, lat) || land.legCrossesLandExact(lon, lat, c.lon, c.lat)) continue;
          // Trial copy from this waypoint on (times and modes change downstream).
          const trial = wps.map((w, i) => (i >= k ? { ...w } : w));
          trial[k].lon = lon;
          trial[k].lat = lat;
          const arrival = arrivalFrom(trial, k);
          if (arrival < (best ? best.arrival : current - POLISH_MIN_GAIN_S * 1000)) best = { list: trial, arrival };
        }
      }
      if (best) {
        res.gainedS += (current - best.arrival) / 1000;
        for (let i = k; i < n; i++) wps[i] = best.list[i];
        movedThisPass++;
      }
    }
    res.moved += movedThisPass;
    if (!movedThisPass) break;
  }
  return res;
}
