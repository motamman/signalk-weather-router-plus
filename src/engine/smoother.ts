/**
 * Route simplification after the propagator: RDP thinning, then the
 * shortcut smoother. Port of routePlanning's `_rdp_simplify`
 * (routing/engine/hybrid.py) and `shortcut_smoother`
 * (routing/engine/smoother.py), run in the same order, per leg.
 *
 * Land checks are the plugin's own: the leg's land raster
 * (`legsCrossLandBulk`, every cell the leg crosses, as the propagator) and, for
 * the smoother, the exact polygons (`legCrossesLandExact`, as the final
 * validation). The plugin has no bathymetry or chart data, so the
 * parent's depth and S-57 passage checks have no counterpart.
 *
 * Deviation from the parent: after smoothing, waypoints whose time moved
 * get their wind, waves and current sampled again at the new time.
 */

import { haversineDistanceM } from '../geo/geodesy';
import { M_PER_DEG } from '../geo/units';
import type { LandTest } from '../geo/landmask';
import type { CurrentSource, WindSource } from './environment';
import { simulateLegTime, type SimOptions } from './legsim';
import type { Route, Waypoint } from './route';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';

/** Mode-preservation thresholds (smoother.py). */
const SAIL_PRESERVE_FLOOR_S = 60.0;
const SAIL_PRESERVE_ORIG_FRAC = 0.5;
const SAIL_PRESERVE_CANDIDATE_FRAC = 0.5;

function legClear(land: LandTest, a: Waypoint, b: Waypoint): boolean {
  return !land.legsCrossLandBulk([a.lon], [a.lat], [b.lon], [b.lat])[0];
}

/**
 * Ramer–Douglas–Peucker with a land check: a point is dropped when it
 * lies within `toleranceM` of the straight line between the kept points
 * either side and that line is clear of land. Endpoints and user
 * waypoints (`role: 'via'`) are always kept. Returns the number dropped.
 */
export function rdpSimplify(route: Route, land: LandTest, toleranceM: number): number {
  const wps = route.waypoints;
  if (wps.length <= 2 || !(toleranceM > 0)) return 0;
  const tolDeg = toleranceM / M_PER_DEG;
  const perp = (p: Waypoint, a: Waypoint, b: Waypoint): number => {
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;
    if (dx === 0 && dy === 0) return Math.hypot(p.lon - a.lon, p.lat - a.lat);
    const t = Math.max(0, Math.min(1, ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.lon - (a.lon + t * dx), p.lat - (a.lat + t * dy));
  };
  const keep = new Set<number>([0, wps.length - 1]);
  wps.forEach((w, i) => {
    if (w.role === 'via') keep.add(i);
  });
  const anchors = [...keep].sort((x, y) => x - y);
  const stack: [number, number][] = [];
  for (let k = 0; k + 1 < anchors.length; k++) stack.push([anchors[k], anchors[k + 1]]);
  while (stack.length) {
    const [s, e] = stack.pop()!;
    if (e - s <= 1) continue;
    let maxD = 0;
    let maxI = s;
    for (let i = s + 1; i < e; i++) {
      const d = perp(wps[i], wps[s], wps[e]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD < tolDeg && legClear(land, wps[s], wps[e])) continue;
    if (maxI === s) maxI = (s + e) >> 1;
    keep.add(maxI);
    stack.push([s, maxI], [maxI, e]);
  }
  const before = wps.length;
  route.waypoints = [...keep].sort((x, y) => x - y).map(i => wps[i]);
  return before - route.waypoints.length;
}

function chainSailingSeconds(wps: Waypoint[], lo: number, hi: number): number {
  let sail = 0;
  for (let k = lo; k < hi; k++) {
    const dt = (wps[k + 1].time.getTime() - wps[k].time.getTime()) / 1000;
    if (dt <= 0) continue;
    const split = wps[k + 1].arrivingSplit;
    if (split) sail += Math.max(0, Math.min(split[0], dt));
    else if (wps[k + 1].mode === 'sailing') sail += dt;
  }
  return sail;
}

export interface SmootherArgs {
  land: LandTest;
  vessel: VesselParams;
  polar: PolarDiagram | null;
  wind: WindSource;
  current: CurrentSource;
  sim: SimOptions;
  /** A shortcut may take at most this much longer than the legs it replaces, as a ratio (0.05 = 5 %). */
  tolerance: number;
}

/**
 * Greedy backward pass (smoother.py): anchored at the last waypoint, try
 * to replace the waypoints between an earlier one and the anchor with one
 * straight leg; accept when the leg is clear of land, its simulated time
 * is within `tolerance` of the legs it replaces, and (sail_max) a
 * sailing-dominant stretch stays sailing-dominant. User waypoints are
 * never removed. Returns the number of waypoints dropped.
 */
export function shortcutSmoother(route: Route, a: SmootherArgs): number {
  const wps = route.waypoints;
  if (wps.length < 3) return 0;
  const tol = 1 + a.tolerance;
  let drops = 0;
  let anchor = wps.length - 1;
  // With a comfort weight the shortcut is judged on time plus comfort cost,
  // as the search chose the legs, so it never cuts back through the rough
  // water the search went round. legPenalty[k]: the comfort cost of the leg
  // into waypoint k.
  const comfort = (a.sim.comfortWeight ?? 0) > 0;
  const legPenalty = new Float64Array(wps.length);
  if (comfort) {
    for (let k = 1; k < wps.length; k++) {
      const p = wps[k - 1];
      const r = simulateLegTime(p.lon, p.lat, p.time, wps[k].lon, wps[k].lat, a.vessel, a.polar, a.wind, a.current, a.sim);
      legPenalty[k] = Number.isFinite(r.penaltySeconds) ? r.penaltySeconds : 0;
    }
  }
  const penaltyBetween = (i: number, j: number): number => {
    let t = 0;
    for (let k = i + 1; k <= j; k++) t += legPenalty[k];
    return t;
  };
  while (anchor > 0) {
    let examined = anchor - 2;
    let failedAt: number | null = null;
    while (examined >= 0) {
      if (wps.slice(examined + 1, anchor).some(w => w.role === 'via')) {
        failedAt = examined;
        break;
      }
      const A = wps[examined];
      const C = wps[anchor];
      if (!legClear(a.land, A, C) || a.land.legCrossesLandExact(A.lon, A.lat, C.lon, C.lat)) {
        failedAt = examined;
        break;
      }
      const sim = simulateLegTime(A.lon, A.lat, A.time, C.lon, C.lat, a.vessel, a.polar, a.wind, a.current, a.sim);
      const origS = (C.time.getTime() - A.time.getTime()) / 1000;
      // The time tolerance holds on elapsed time; with a comfort weight the
      // shortcut must also not cost more in time plus comfort.
      const tooSlow = sim.seconds > tol * origS;
      const tooRough = comfort && sim.seconds + sim.penaltySeconds > tol * (origS + penaltyBetween(examined, anchor));
      if (!Number.isFinite(sim.seconds) || tooSlow || tooRough) {
        failedAt = examined;
        break;
      }
      if (a.sim.modePolicy === 'sail_max' && origS > SAIL_PRESERVE_FLOOR_S) {
        const origFrac = chainSailingSeconds(wps, examined, anchor) / origS;
        const simFrac = sim.seconds > 0 ? sim.sailingSeconds / sim.seconds : 0;
        if (origFrac >= SAIL_PRESERVE_ORIG_FRAC && simFrac < SAIL_PRESERVE_CANDIDATE_FRAC) {
          failedAt = examined;
          break;
        }
      }
      // Accept: re-time C and shift everything after it by the same amount.
      const shiftMs = A.time.getTime() + sim.seconds * 1000 - C.time.getTime();
      for (let k = anchor; k < wps.length; k++) wps[k].time = new Date(wps[k].time.getTime() + shiftMs);
      C.mode = sim.dominantMode === 'sailing' ? 'sailing' : 'motoring';
      C.arrivingSplit = [sim.sailingSeconds, sim.motoringSeconds];
      drops += anchor - examined - 1;
      if (comfort) {
        // The new leg A→C carries the shortcut's comfort cost; the legs it replaced go.
        const kept = Array.from(legPenalty);
        kept.splice(examined + 1, anchor - examined, sim.penaltySeconds);
        legPenalty.fill(0);
        legPenalty.set(kept.slice(0, legPenalty.length));
      }
      wps.splice(examined + 1, anchor - examined - 1);
      anchor = examined + 1;
      examined -= 1;
    }
    if (failedAt === null) break;
    anchor = failedAt;
  }
  if (drops > 0) recomputeTotals(route);
  return drops;
}

/** Distance, time and per-mode totals from the waypoint list (validate._recompute_totals). */
export function recomputeTotals(route: Route): void {
  const wps = route.waypoints;
  let dist = 0;
  let motor = 0;
  let sail = 0;
  for (let k = 0; k + 1 < wps.length; k++) {
    const a = wps[k];
    const b = wps[k + 1];
    dist += haversineDistanceM(a.lon, a.lat, b.lon, b.lat);
    const dt = Math.max(0, (b.time.getTime() - a.time.getTime()) / 1000);
    if (b.arrivingSplit) {
      let s = Math.max(0, b.arrivingSplit[0]);
      let m = Math.max(0, b.arrivingSplit[1]);
      if (s + m > dt && s + m > 0) {
        const f = dt / (s + m);
        s *= f;
        m *= f;
      }
      sail += s;
      motor += m;
    } else if (b.mode === 'sailing') sail += dt;
    else motor += dt;
  }
  route.totalDistanceM = dist;
  route.totalTimeS = wps.length ? (wps[wps.length - 1].time.getTime() - wps[0].time.getTime()) / 1000 : 0;
  route.sailingTimeS = sail;
  route.motoringTimeS = motor;
}

/** Exact-polygon land check of every leg (the propagator's final validation), after simplification. */
export function revalidateLand(route: Route, land: LandTest): void {
  const wps = route.waypoints;
  const warns: NonNullable<Route['warnings']> = [];
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    if (land.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat)) {
      warns.push({ leg_index: i, violation: 'leg_crosses_land', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
    }
  }
  route.warnings = warns.length ? warns : undefined;
}
