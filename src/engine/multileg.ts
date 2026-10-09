/**
 * Waypoints as legs: port of the reference's compute_multi_leg_route
 * (routePlanning routing/engine/hybrid.py, from line 850).
 *
 * stops = [start, waypoint 1, …, end]. Each consecutive pair is routed as
 * its own route (its own corridor, search and retries), departing at the
 * previous leg's arrival so wind, current and tide advance across legs.
 * The legs are stitched: the duplicate junction point is dropped,
 * distances and sail/motor times are summed, and the junction point of
 * each waypoint gets role "via".
 *
 * Precision (routes.py lines 95–135):
 *  - precise (default): every leg ends exactly on its waypoint (the
 *    propagator's straight final leg to the exact point);
 *  - approximate: an intermediate leg is done as soon as the route enters
 *    the waypoint's circle (arrival radius, ocean_propagator.py lines
 *    1037–1075, snap_to_exact=False); the next leg starts from that point.
 *    The final destination is always exact.
 *
 * Consecutive approximate legs are collapsed into one run (hybrid.py
 * lines 1336–1446): one search from the run's start to its end that must
 * pass through each intermediate waypoint's circle (propagator vias), so
 * the track carries through a waypoint instead of ending and restarting
 * there. Every plugin leg is an ocean-propagator leg, so every approximate
 * boundary collapses.
 *
 * Differences from the reference:
 *  - a leg after a precise waypoint starts where the previous one ended
 *    (the reference restarts from the canonical waypoint and trims the
 *    stitch), so the stitched track is continuous;
 *  - when a collapsed run finds no branch through every circle, its legs
 *    are routed one by one (approximate ends as above) instead of failing
 *    the route.
 */

import { haversineDistanceM } from '../geo/geodesy';
import { ViasNotCrossedError } from './propagator';
import type { ProgressFn } from './progress';
import { recomputePerWaypointMetadata, type Route, type RouteWarning } from './route';

export type Precision = 'precise' | 'approximate';

/** Reference defaults (routes.py): precision "precise", arrival_radius_m 200, range 0–5000. */
export const DEFAULT_PRECISION: Precision = 'precise';
export const DEFAULT_ARRIVAL_RADIUS_M = 200;
export const MAX_ARRIVAL_RADIUS_M = 5000;

export interface Stop {
  lon: number;
  lat: number;
  /** Per-waypoint arrival radius, metres; overrides the request's arrival radius (approximate mode). */
  radiusM?: number;
}

export interface LegPlan {
  /** 0-based index of the (first) leg. */
  index: number;
  /** 0-based index of the last leg this plan covers (> index for a collapsed run). */
  lastIndex: number;
  /** Number of legs. */
  count: number;
  /** Waypoint circles the run must pass through, in order (empty for a single leg). */
  vias: { lon: number; lat: number; radiusM: number }[];
  /** The leg's target (the next stop). */
  end: [number, number];
  /** true: the leg ends exactly on `end`; false: on entering the circle of radius arrivalRadiusM. */
  snapToExact: boolean;
  /** Circle radius for an approximate leg (undefined when exact). */
  arrivalRadiusM?: number;
}

/**
 * Validate precision / radii the way the reference does: approximate needs
 * a radius > 0 (routes.py `_approximate_requires_positive_radius`).
 * Returns an error message or null.
 */
export function validateLegOptions(
  precision: unknown,
  arrivalRadiusM: unknown,
  waypoints: { radius_m?: unknown }[] | undefined
): string | null {
  if (precision !== undefined && precision !== 'precise' && precision !== 'approximate')
    return 'precision must be "precise" or "approximate"';
  const radiusOk = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_ARRIVAL_RADIUS_M;
  if (arrivalRadiusM !== undefined && !radiusOk(arrivalRadiusM)) return `arrival_radius_m must be 0..${MAX_ARRIVAL_RADIUS_M}`;
  for (let i = 0; i < (waypoints ?? []).length; i++) {
    const r = waypoints![i].radius_m;
    if (r !== undefined && !radiusOk(r)) return `waypoints[${i}].radius_m must be 0..${MAX_ARRIVAL_RADIUS_M}`;
  }
  if (precision === 'approximate') {
    const def = (arrivalRadiusM as number | undefined) ?? DEFAULT_ARRIVAL_RADIUS_M;
    if (!(def > 0)) return 'arrival_radius_m must be > 0 when precision is "approximate" (use "precise" for exact waypoints)';
    for (let i = 0; i < (waypoints ?? []).length; i++) {
      const r = waypoints![i].radius_m;
      if (r !== undefined && !((r as number) > 0)) return `waypoints[${i}].radius_m must be > 0 when precision is "approximate"`;
    }
  }
  return null;
}

/**
 * One plan per leg. Precise: every leg exact. Approximate: every
 * intermediate leg ends on its waypoint's circle (the waypoint's own
 * radius, else `arrivalRadiusM`); the last leg is always exact.
 */
export function planLegs(stops: Stop[], precision: Precision = DEFAULT_PRECISION, arrivalRadiusM = DEFAULT_ARRIVAL_RADIUS_M): LegPlan[] {
  if (stops.length < 2) throw new Error(`at least start and end are needed (got ${stops.length} stops)`);
  const count = stops.length - 1;
  const out: LegPlan[] = [];
  for (let i = 0; i < count; i++) {
    const to = stops[i + 1];
    const last = i === count - 1;
    const r = to.radiusM ?? arrivalRadiusM;
    const approx = precision === 'approximate' && !last && r > 0;
    out.push({
      index: i,
      lastIndex: i,
      count,
      vias: [],
      end: [to.lon, to.lat],
      snapToExact: !approx,
      arrivalRadiusM: approx ? r : undefined,
    });
  }
  return out;
}

/**
 * Collapse maximal runs of legs joined by approximate waypoints into one
 * plan each (hybrid.py ~1336): the run ends where its last leg ends, and
 * each inner waypoint becomes a via with its circle radius.
 */
export function collapseRuns(plans: LegPlan[]): LegPlan[] {
  const out: LegPlan[] = [];
  let i = 0;
  while (i < plans.length) {
    let j = i;
    while (j + 1 < plans.length && !plans[j].snapToExact) j++;
    if (j === i) {
      out.push(plans[i]);
    } else {
      const last = plans[j];
      out.push({
        ...last,
        index: plans[i].index,
        lastIndex: last.index,
        vias: plans.slice(i, j).map(p => ({ lon: p.end[0], lat: p.end[1], radiusM: p.arrivalRadiusM! })),
      });
    }
    i = j + 1;
  }
  return out;
}

/** "leg 2/4" or "legs 1–3/4". */
export function legLabel(plan: LegPlan): string {
  return plan.lastIndex > plan.index ? `legs ${plan.index + 1}–${plan.lastIndex + 1}/${plan.count}` : `leg ${plan.index + 1}/${plan.count}`;
}

/** Same point to within ~0.1 m. */
function samePoint(a: { lon: number; lat: number }, b: { lon: number; lat: number }): boolean {
  return Math.abs(a.lon - b.lon) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6;
}

/**
 * Stitch leg routes into one route (hybrid.py lines ~1731–1790): the
 * first point of each following leg duplicates the previous leg's last
 * point and is dropped; distances and sail/motor times are summed; the
 * junction point of each waypoint gets role "via"; warnings keep their
 * position (leg_index re-based on the stitched polyline); automatic vias
 * and skeletons are concatenated.
 */
export function stitchLegs(legs: Route[]): Route {
  if (legs.length === 0) throw new Error('no legs to stitch');
  if (legs.length === 1) return legs[0];
  // Roles a leg already set (the waypoints of a collapsed run) are kept.
  const waypoints = legs[0].waypoints.map(w => ({ ...w }));
  let totalDistanceM = legs[0].totalDistanceM;
  let motoringTimeS = legs[0].motoringTimeS;
  let sailingTimeS = legs[0].sailingTimeS;
  const warnings: RouteWarning[] = (legs[0].warnings ?? []).map(w => ({ ...w }));
  const autoVias = [...(legs[0].autoVias ?? [])];
  const drawbridges = (legs[0].drawbridges ?? []).map(b => ({ ...b }));
  const skeleton = legs[0].skeleton ? [...legs[0].skeleton] : undefined;
  const fronts = legs.flatMap((leg, li) => (leg.fronts ?? []).map(f => ({ ...f, leg: li })));
  let validated = legs[0].validated;
  let horizon = legs[0].forecastHorizonExceededS ?? 0;
  let validTo = legs[0].forecastValidToMs;
  let limitsBeyond = legs[0].limitsBeyondForecast ?? false;
  let drops = legs[0].smootherDrops ?? 0;
  let fallback = legs[0].corridorFallback ?? false;
  let mesh = legs[0].meshLeg ?? false;
  for (let li = 1; li < legs.length; li++) {
    const leg = legs[li];
    // The previous leg's end is this waypoint's junction.
    waypoints[waypoints.length - 1].role = 'via';
    let wps = leg.waypoints;
    let offset = waypoints.length - 1;
    if (wps.length && samePoint(waypoints[waypoints.length - 1], wps[0])) {
      wps = wps.slice(1);
    } else {
      // Not continuous (a caller that started the leg elsewhere): the jump stays as a segment.
      offset = waypoints.length;
      if (wps.length) {
        const a = waypoints[waypoints.length - 1];
        totalDistanceM += haversineDistanceM(a.lon, a.lat, wps[0].lon, wps[0].lat);
      }
    }
    for (const w of wps) waypoints.push({ ...w });
    for (const w of leg.warnings ?? []) warnings.push({ ...w, leg_index: w.leg_index + offset });
    totalDistanceM += leg.totalDistanceM;
    motoringTimeS += leg.motoringTimeS;
    sailingTimeS += leg.sailingTimeS;
    autoVias.push(...(leg.autoVias ?? []));
    for (const b of leg.drawbridges ?? []) drawbridges.push({ ...b, legIndex: b.legIndex + offset });
    if (skeleton && leg.skeleton)
      skeleton.push(...(samePoint(skeleton[skeleton.length - 1], leg.skeleton[0]) ? leg.skeleton.slice(1) : leg.skeleton));
    validated = validated && leg.validated;
    horizon = Math.max(horizon, leg.forecastHorizonExceededS ?? 0);
    if (leg.forecastValidToMs !== undefined)
      validTo = validTo === undefined ? leg.forecastValidToMs : Math.min(validTo, leg.forecastValidToMs);
    limitsBeyond = limitsBeyond || (leg.limitsBeyondForecast ?? false);
    fallback = fallback || (leg.corridorFallback ?? false);
    mesh = mesh || (leg.meshLeg ?? false);
    drops += leg.smootherDrops ?? 0;
  }
  const route: Route = {
    waypoints,
    totalTimeS: (waypoints[waypoints.length - 1].time.getTime() - waypoints[0].time.getTime()) / 1000,
    totalDistanceM,
    motoringTimeS,
    sailingTimeS,
    validated,
  };
  if (warnings.length) route.warnings = warnings;
  if (autoVias.length) route.autoVias = autoVias;
  if (drawbridges.length) route.drawbridges = drawbridges;
  if (skeleton) route.skeleton = skeleton;
  if (fronts.length) route.fronts = fronts;
  if (horizon > 0) route.forecastHorizonExceededS = horizon;
  if (validTo !== undefined) route.forecastValidToMs = validTo;
  if (limitsBeyond) route.limitsBeyondForecast = true;
  if (drops) route.smootherDrops = drops;
  if (fallback) route.corridorFallback = true;
  if (mesh) route.meshLeg = true;
  recomputePerWaypointMetadata(route);
  return route;
}

export interface MultiLegArgs {
  stops: Stop[];
  departureTime: Date;
  precision?: Precision;
  arrivalRadiusM?: number;
  /**
   * Route one leg from `start` (the route start, or where the previous leg
   * ended) departing at `departure`.
   */
  runLeg: (leg: LegPlan, start: [number, number], departure: Date) => Promise<Route> | Route;
  /** Progress lines ("leg 2/4: …"); stage and total are 0 (the legs report their own). */
  onProgress?: ProgressFn;
}

/**
 * Route stops[0] → … → stops[n-1] leg by leg and stitch. Each leg starts
 * where the previous one ended (the waypoint in precise mode, the circle
 * entry in approximate mode) at its arrival time. Approximate runs are
 * one search through the waypoint circles; if no branch passes through
 * every circle, that run's legs are routed one by one.
 */
export async function routeMultiLeg(args: MultiLegArgs): Promise<Route> {
  const single = planLegs(args.stops, args.precision ?? DEFAULT_PRECISION, args.arrivalRadiusM ?? DEFAULT_ARRIVAL_RADIUS_M);
  const plans = collapseRuns(single);
  const progress = (m: string): void => args.onProgress?.(0, 0, m);
  const multi = single.length > 1;
  const legs: Route[] = [];
  let start: [number, number] = [args.stops[0].lon, args.stops[0].lat];
  let departure = args.departureTime;
  const run = async (plan: LegPlan): Promise<void> => {
    if (multi) {
      const through = plan.vias.length
        ? `, through ${plan.vias.length} waypoint circle(s) (${plan.vias.map(v => `{length:${v.radiusM.toFixed(0)}}`).join(', ')}) in one search`
        : '';
      progress(
        `${legLabel(plan)}: (${start[1].toFixed(4)}, ${start[0].toFixed(4)}) → (${plan.end[1].toFixed(4)}, ${plan.end[0].toFixed(4)}), departing ${departure.toISOString()}${through}${plan.snapToExact ? ', ends exactly on the point' : `, ends on entering the {length:${plan.arrivalRadiusM!.toFixed(0)}} circle`}`
      );
    }
    const r = await args.runLeg(plan, start, departure);
    if (!r.waypoints.length) throw new Error(`${legLabel(plan)} returned no waypoints`);
    const last = r.waypoints[r.waypoints.length - 1];
    if (multi) {
      const miss = haversineDistanceM(last.lon, last.lat, plan.end[0], plan.end[1]);
      progress(
        `${legLabel(plan)} done: {distance:${r.totalDistanceM.toFixed(0)}}, {time:${r.totalTimeS.toFixed(0)}}, ends {length:${miss.toFixed(0)}} from the ${plan.lastIndex + 1 < plan.count ? 'waypoint' : 'destination'}`
      );
    }
    legs.push(r);
    start = [last.lon, last.lat];
    departure = last.time;
  };
  for (const plan of plans) {
    if (!plan.vias.length) {
      await run(plan);
      continue;
    }
    try {
      await run(plan);
    } catch (err) {
      if (!(err instanceof ViasNotCrossedError)) throw err;
      progress(`WARNING: ${legLabel(plan)}: ${err.message}; routing these legs one by one instead`);
      for (const p of single.slice(plan.index, plan.lastIndex + 1)) await run(p);
    }
  }
  return stitchLegs(legs);
}
