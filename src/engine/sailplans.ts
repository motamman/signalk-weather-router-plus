/**
 * The sail plan of each stretch of a finished leg, for a polar set with sail plans (polar-format 2): every sailed
 * segment walked again in the simulator's sub-steps, the fastest of the set's plans named at each one
 * (vessel/sailplan.ts), and a route point put where that changes, so each segment is sailed on one plan. The point
 * lies on the segment's line where the sub-step of the new plan starts, at that share of the segment's time (as
 * search/enrich.ts enrichLegRanges samples a leg); the course, and every point and time already on the route, stay as
 * they were. The route's speed is the set's `best` table throughout; the plans only name the sails.
 *
 * Run at the end of each leg, while the leg's forecast is loaded (pipeline.ts openWaterLeg, mesh/legrun.ts).
 */

import { haversineBearing, haversineDistanceM } from '../geo/geodesy';
import { twaFromHeading } from '../geo/angles';
import type { PolarDiagram } from '../vessel/polar';
import { sailPlanAt, type SailPlanPolar } from '../vessel/sailplan';
import type { VesselParams } from '../vessel/vessel';
import type { CurrentSource, WindSource } from './environment';
import { simulateLegTime, type SimOptions } from './legsim';
import { enrichLegRanges, enrichWaypoints } from './propagator';
import type { Route, Waypoint } from './route';
import { recomputeTotals } from './smoother';

export interface SailPlanEnv {
  vessel: VesselParams;
  /** The polar the route is sailed on (a polar set's `best`). */
  polar: PolarDiagram | null;
  /** The set's sail plans, scaled and floored as `polar` is; none or empty: nothing is named. */
  sailPlans?: readonly SailPlanPolar[] | null;
  wind: WindSource;
  current: CurrentSource;
  sim: SimOptions;
}

interface Step {
  lon: number;
  lat: number;
  seconds: number;
  sailed: boolean;
  plan: string | null;
}

/**
 * Name the sail plan of each sailed segment of `route` (Waypoint.sailPlan, on the point the segment arrives at), with a
 * route point where the fastest plan changes along a segment. Returns the number of points added.
 */
export function markSailPlans(route: Route, env: SailPlanEnv): number {
  const plans = env.sailPlans;
  if (!plans || !plans.length || !env.polar) return 0;
  const wps = route.waypoints;
  let added = 0;
  // Back to front, so the segments still to be walked keep their indices.
  for (let k = wps.length - 1; k >= 1; k--) {
    const a = wps[k - 1];
    const b = wps[k];
    if (b.mode !== 'sailing' && !(b.arrivingSplit && b.arrivingSplit[0] > 0)) continue;
    const bearing = haversineBearing(a.lon, a.lat, b.lon, b.lat);
    const steps: Step[] = [];
    const r = simulateLegTime(
      a.lon,
      a.lat,
      a.time,
      b.lon,
      b.lat,
      env.vessel,
      env.polar,
      env.wind,
      env.current,
      env.sim,
      (_c, lon, lat, _t, ws, wd, sailed, seconds) =>
        steps.push({ lon, lat, seconds, sailed, plan: sailed ? sailPlanAt(plans, twaFromHeading(bearing, wd), ws) : null })
    );
    if (!Number.isFinite(r.seconds) || !(r.seconds > 0)) continue;
    // The parts of the segment: the step each starts at (the first at 0) and its plan; a motored step names none and
    // starts no part.
    const starts: number[] = [];
    const names: string[] = [];
    for (let j = 0; j < steps.length; j++) {
      const p = steps[j].plan;
      if (p === null || p === names[names.length - 1]) continue;
      starts.push(names.length ? j : 0);
      names.push(p);
    }
    if (!names.length) continue;
    b.sailPlan = names[names.length - 1];
    if (names.length === 1) continue;
    // The walk's seconds as shares of the segment's own time (its end time stays).
    const scale = (b.time.getTime() - a.time.getTime()) / 1000 / r.seconds;
    const elapsed = [0];
    for (const s of steps) elapsed.push(elapsed[elapsed.length - 1] + s.seconds);
    const split = (from: number, to: number): [number, number] => {
      let sail = 0;
      let motor = 0;
      for (let j = from; j < to; j++) {
        if (steps[j].sailed) sail += steps[j].seconds * scale;
        else motor += steps[j].seconds * scale;
      }
      return [sail, motor];
    };
    const inserted: Waypoint[] = [];
    for (let m = 1; m < names.length; m++) {
      const s = steps[starts[m]];
      const w: Waypoint = {
        lon: s.lon,
        lat: s.lat,
        time: new Date(a.time.getTime() + elapsed[starts[m]] * scale * 1000),
        sogMs: 0,
        cogDeg: bearing,
        mode: b.mode,
        sailPlan: names[m - 1],
      };
      if (b.leg !== undefined) w.leg = b.leg;
      if (b.arrivingSplit) w.arrivingSplit = split(starts[m - 1], starts[m]);
      inserted.push(w);
    }
    if (b.arrivingSplit) b.arrivingSplit = split(starts[starts.length - 1], steps.length);
    enrichWaypoints(inserted, env.wind, env.current);
    // Course, true wind angle and speed over ground of the parts (the segment's line, each part its own time).
    let prev = a;
    for (const w of [...inserted, b]) {
      w.cogDeg = bearing;
      if (w.windDirDeg !== undefined) w.twaDeg = twaFromHeading(bearing, w.windDirDeg);
      const dt = (w.time.getTime() - prev.time.getTime()) / 1000;
      if (dt > 0) w.sogMs = haversineDistanceM(prev.lon, prev.lat, w.lon, w.lat) / dt;
      prev = w;
    }
    wps.splice(k, 0, ...inserted);
    shiftSegments(route, k, inserted.length);
    added += inserted.length;
  }
  if (added) {
    recomputeTotals(route);
    enrichLegRanges(route, env.wind);
  }
  return added;
}

/**
 * After `n` route points were inserted before waypoint `k`: what indexes the route's segments or waypoints moves with
 * them. Warnings index segments (the one from k - 1 keeps its index: it now ends at the first point inserted); opening
 * bridges index the waypoint their crossing leg arrives at.
 */
export function shiftSegments(route: Route, k: number, n: number): void {
  if (!n) return;
  for (const w of route.warnings ?? []) if (w.leg_index >= k) w.leg_index += n;
  for (const br of route.drawbridges ?? []) if (br.legIndex >= k) br.legIndex += n;
}
