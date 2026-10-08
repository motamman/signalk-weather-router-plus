/**
 * A leg on the chart mesh, as the leg pipeline uses it: whether the mesh
 * takes the leg, the split of the mesh route into narrow and open-water
 * segments (the parent planner's hybrid rule; with a sail threshold of 0
 * the narrow passages are sailed too), the Route for a stretch walked
 * along the mesh polyline, and the stitching of the segments.
 *
 * The search itself runs wherever the host puts it (the plugin: a child
 * process, so the tile arrays go back to the operating system after the
 * leg); the pipeline only sees MeshLegRouter.
 */

import type { PolarDiagram } from '../../vessel/polar';
import type { VesselParams } from '../../vessel/vessel';
import type { CurrentSource, WindSource } from '../environment';
import { simulateLegTime, type SimOptions } from '../legsim';
import { enrichLegRanges, enrichWaypoints } from '../propagator';
import { haversineDistanceM } from '../../geo/geodesy';
import { recomputePerWaypointMetadata, type Route, type RouteWarning, type Waypoint } from '../route';
import { recomputeTotals } from '../smoother';
import type { MeshRouteResult, MeshRules } from './route';

export interface MeshLegRouter {
  /** Every point lies in the mesh (a tile exists and holds the point). */
  covers(points: [number, number][]): boolean;
  route(start: [number, number], end: [number, number], rules: MeshRules): Promise<MeshRouteResult>;
}

/**
 * The rules the mesh needs from the vessel, or null (with why) when the
 * mesh cannot be used for this leg: its blocking rules need the draught
 * and the air draft, and a leg through waypoint circles is not split.
 */
export function meshRulesFor(vessel: VesselParams, hasVias: boolean): { rules: MeshRules } | { rules: null; why: string } {
  if (vessel.draughtM === null || vessel.airDraftM === null)
    return {
      rules: null,
      why: `the vessel's ${vessel.draughtM === null ? 'draught (Signal K design.draft.maximum' : 'air draft (Signal K design.airHeight'}, or the request's vessel override) is not set`,
    };
  if (hasVias) return { rules: null, why: 'the leg passes through waypoint circles' };
  return { rules: { draughtM: vessel.draughtM, airDraftM: vessel.airDraftM, motorSpeedMs: vessel.motorSpeedMs } };
}

export interface MeshSegment {
  type: 'open' | 'constrained';
  /** Indices into the mesh path, inclusive. */
  start: number;
  end: number;
}

/** Both shores within this of the track: a constrained passage (the parent's constrained_width_m). */
export const CONSTRAINED_WIDTH_M = 1000;
/**
 * Track of the other kind before the classification flips. The parent
 * counts RUN_LENGTH = 3 samples taken every 10th cell of its dense
 * skeleton; the mesh route's points are the corners the string-pulled
 * path turns at, sparse and uneven, so the hysteresis is by distance.
 */
const HYSTERESIS_M = 1000;
/** How far a constrained segment reaches back / on through constrained points at its ends (the parent's pad_m). */
const PAD_M = 2000;
/** An open segment shorter than this is motored along the mesh route rather than sailed (the parent's rule). */
export const MIN_OPEN_SEGMENT_M = 100;

/**
 * Split a mesh route into constrained and open segments by the water on
 * each side of the track: the parent planner's classify_segments.
 * Constrained only where BOTH sides are within CONSTRAINED_WIDTH_M
 * (one-sided proximity is coastal sailing); a flip needs HYSTERESIS_M of
 * track of the other kind, and the segment boundary sits where that run
 * completes, so a constrained segment takes in the open run-out after it
 * (the parent's padding into open water, so the sailing search never
 * starts at a channel mouth) and reaches back over constrained lead-in
 * points up to PAD_M.
 */
export function classifySegments(path: [number, number][], widths: [number, number][], thresholdM = CONSTRAINED_WIDTH_M): MeshSegment[] {
  const n = path.length;
  if (n < 2) return [{ type: 'open', start: 0, end: n - 1 }];
  const constrained = widths.map(([l, r]) => l < thresholdM && r < thresholdM);
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversineDistanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  let current: MeshSegment['type'] = constrained[0] ? 'constrained' : 'open';
  const transitions = [0];
  const types: MeshSegment['type'][] = [current];
  let runStart = -1; // first point of the current run of the other kind
  for (let i = 1; i < n; i++) {
    const want = constrained[i];
    if ((current === 'open') !== want) {
      runStart = -1;
      continue;
    }
    if (runStart < 0) runStart = i;
    if (cum[i] - cum[runStart] < HYSTERESIS_M) continue;
    if (current === 'open') {
      current = 'constrained';
      let at = runStart;
      for (let p = runStart; p > transitions[transitions.length - 1] && cum[runStart] - cum[p] <= PAD_M; p--) {
        if (constrained[p]) at = p;
        else break;
      }
      transitions.push(Math.max(transitions[transitions.length - 1] + 1, at));
      types.push('constrained');
    } else {
      current = 'open';
      let at = i;
      for (let p = i; p < n && cum[p] - cum[i] <= PAD_M; p++) {
        if (constrained[p]) at = p + 1;
        else break;
      }
      transitions.push(Math.min(n - 1, at));
      types.push('open');
    }
    runStart = -1;
  }
  const out: MeshSegment[] = [];
  for (let s = 0; s < transitions.length; s++) {
    const start = transitions[s];
    const end = s + 1 < transitions.length ? transitions[s + 1] : n - 1;
    if (start >= end) continue;
    out.push({ type: types[s], start, end });
  }
  return out.length ? out : [{ type: constrained[0] ? 'constrained' : 'open', start: 0, end: n - 1 }];
}

/** Length of a polyline, metres. */
export function pathLengthM(path: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += haversineDistanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  return d;
}

/**
 * The Route for a mesh polyline walked straight: waypoints timed segment
 * by segment with the leg simulator under `sim` (motor for a narrow
 * passage; the request's own policy for an open stretch the pipeline
 * follows along the mesh), then wind / wave / current enrichment. Null
 * when a segment cannot be made (stuck, or the current cancels the
 * boat's speed): the caller falls back to the coastline search. A
 * sail_max stretch is not walked here but laid out with tacks
 * (experimental/propagator.ts sailPolyline).
 */
export function routeFromMeshPath(
  path: [number, number][],
  departure: Date,
  vessel: VesselParams,
  polar: PolarDiagram | null,
  wind: WindSource,
  current: CurrentSource,
  sim: SimOptions
): Route | null {
  const wps: Waypoint[] = [{ lon: path[0][0], lat: path[0][1], time: departure, sogMs: 0, cogDeg: 0, mode: 'motoring' }];
  let t = departure;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const c = path[i];
    const r = simulateLegTime(a[0], a[1], t, c[0], c[1], vessel, polar, wind, current, sim);
    if (!Number.isFinite(r.seconds)) return null;
    t = new Date(t.getTime() + r.seconds * 1000);
    wps.push({ lon: c[0], lat: c[1], time: t, sogMs: 0, cogDeg: 0, mode: r.dominantMode === 'sailing' ? 'sailing' : 'motoring' });
  }
  const route: Route = {
    waypoints: wps,
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
    meshLeg: true,
  };
  enrichWaypoints(wps, wind, current);
  recomputePerWaypointMetadata(route);
  recomputeTotals(route);
  enrichLegRanges(route, wind);
  return route;
}

/**
 * One leg from its segments in order (each starting where the previous
 * ended, at its arrival time): the junction point is kept once, warnings
 * are re-based, stage fronts kept for display, totals recomputed.
 */
export function stitchMeshSegments(parts: Route[], wind: WindSource): Route {
  const waypoints: Waypoint[] = parts[0].waypoints.map(w => ({ ...w }));
  const warnings: RouteWarning[] = (parts[0].warnings ?? []).map(w => ({ ...w }));
  const fronts = parts.flatMap(p => p.fronts ?? []);
  let validated = parts[0].validated;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    let wps = p.waypoints;
    let offset = waypoints.length - 1;
    const last = waypoints[waypoints.length - 1];
    if (wps.length && Math.abs(last.lon - wps[0].lon) < 1e-6 && Math.abs(last.lat - wps[0].lat) < 1e-6) wps = wps.slice(1);
    else offset = waypoints.length;
    for (const w of wps) waypoints.push({ ...w });
    for (const w of p.warnings ?? []) warnings.push({ ...w, leg_index: w.leg_index + offset });
    validated = validated && p.validated;
  }
  const route: Route = { waypoints, totalTimeS: 0, totalDistanceM: 0, motoringTimeS: 0, sailingTimeS: 0, validated, meshLeg: true };
  if (warnings.length) route.warnings = warnings;
  if (fronts.length) route.fronts = fronts;
  recomputePerWaypointMetadata(route);
  recomputeTotals(route);
  enrichLegRanges(route, wind);
  return route;
}
