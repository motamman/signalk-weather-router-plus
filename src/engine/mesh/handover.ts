/**
 * A leg with one end inside the chart mesh and the other outside: where
 * the mesh hands over to the coastline search, the corridor cut there,
 * and the two parts joined into one leg.
 *
 * The handover point is found on the corridor (the water-grid skeleton,
 * with the across-track water width at each point): walking from the
 * covered end through the points inside the mesh, at most
 * HANDOVER_SCAN_M along the corridor, the LAST narrow point (width under
 * OPEN_WATER_WIDTH_M, the parent planner's rule: both shores within a
 * kilometre) is found; the handover is the first point after it that is
 * open and stays open over the next point, or the last scanned covered
 * point when none is. No narrow point in the scanned stretch means the
 * leg starts (or ends) in open water and there is no mesh part.
 *
 * Why the last narrow point and not the first open one: most harbours
 * are a wide basin with a narrow mouth. Newport (2026-10-08, the
 * plugin's corridor on brain with GSHHG): 2.8 km of water at the start
 * point, 0.95–1.03 km between 1.7 and 3.1 km out past Goat Island, open
 * (8 km) from 4.9 km out. "First open point" put the handover at the
 * start and left the whole bay to the coastline search.
 *
 * Why the HANDOVER_SCAN_M cap: the mesh part is searched by a child that
 * reads every mesh tile within 0.5° of the part's two ends (wider when
 * that box holds no route, route.ts), about 1 GB
 * for the 6.5 M triangles of a 50 km leg (brain, 2026-10-08, Cape Cod
 * Canal); a mesh part twice as long would not fit a Raspberry Pi beside
 * Signal K. The cap is this plugin's, not the parent planner's.
 */

import { haversineDistanceM } from '../../geo/geodesy';
import type { Corridor } from '../corridor';
import { recomputePerWaypointMetadata, type Route, type RouteDrawbridge, type RouteWarning, type Waypoint } from '../route';
import { recomputeTotals } from '../smoother';
import type { MeshLegRunner } from './leg';

/** Across-track water this wide (2 × the parent's 1000 m per side) is open water. */
export const OPEN_WATER_WIDTH_M = 2000;
/** How far along the corridor from the covered end narrow water is looked for (see the header). */
export const HANDOVER_SCAN_M = 50_000;

export interface Handover {
  /** Index into the corridor skeleton. */
  index: number;
  point: [number, number];
  /** Skeleton length from the covered end to the handover, metres. */
  distanceM: number;
}

export function findHandover(
  corridor: Pick<Corridor, 'skeleton' | 'widthM'>,
  covered: 'start' | 'end',
  mesh: MeshLegRunner
): Handover | null {
  const sk = corridor.skeleton;
  const n = sk.length;
  if (n < 2) return null;
  const order = covered === 'start' ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
  const open = (i: number): boolean => corridor.widthM[i] >= OPEN_WATER_WIDTH_M;
  // The covered points within reach, in walking order, with the distance to each.
  const scanned: number[] = [];
  const dist: number[] = [];
  let d = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (k > 0) d += haversineDistanceM(sk[order[k - 1]].lon, sk[order[k - 1]].lat, sk[i].lon, sk[i].lat);
    if (d > HANDOVER_SCAN_M || !mesh.covers([[sk[i].lon, sk[i].lat]])) break;
    scanned.push(i);
    dist.push(d);
  }
  let lastNarrow = -1;
  for (let k = 0; k < scanned.length; k++) if (!open(scanned[k])) lastNarrow = k;
  if (lastNarrow < 0) return null;
  let hk = scanned.length - 1;
  for (let k = lastNarrow + 1; k < scanned.length; k++) {
    const next = k + 1 < scanned.length ? scanned[k + 1] : k + 1 < n ? order[k + 1] : -1;
    if (open(scanned[k]) && (next < 0 || open(next))) {
      hk = k;
      break;
    }
  }
  if (hk === 0) return null;
  const h = scanned[hk];
  return { index: h, point: [sk[h].lon, sk[h].lat], distanceM: dist[hk] };
}

/** The corridor from the handover on (`after`) or up to it (`before`), with the automatic vias on that part. */
export function sliceCorridor(c: Corridor, index: number, part: 'after' | 'before'): Corridor {
  const lo = part === 'after' ? index : 0;
  const hi = part === 'after' ? c.skeleton.length - 1 : index;
  const skeleton = c.skeleton.slice(lo, hi + 1);
  const widthM = c.widthM.slice(lo, hi + 1);
  let lengthM = 0;
  for (let i = 1; i < skeleton.length; i++)
    lengthM += haversineDistanceM(skeleton[i - 1].lon, skeleton[i - 1].lat, skeleton[i].lon, skeleton[i].lat);
  const nearest = (lon: number, lat: number): number => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < c.skeleton.length; i++) {
      const d = haversineDistanceM(lon, lat, c.skeleton[i].lon, c.skeleton[i].lat);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const autoVias = c.autoVias.filter(v => {
    const i = nearest(v.lon, v.lat);
    return i >= lo && i <= hi;
  });
  return { ...c, skeleton, widthM, lengthM, autoVias };
}

/** Two parts of one leg, the second starting where and when the first ended: one Route. */
export function stitchLegParts(a: Route, b: Route): Route {
  const waypoints: Waypoint[] = a.waypoints.map(w => ({ ...w }));
  const warnings: RouteWarning[] = (a.warnings ?? []).map(w => ({ ...w }));
  let wps = b.waypoints;
  let offset = waypoints.length - 1;
  const last = waypoints[waypoints.length - 1];
  if (wps.length && Math.abs(last.lon - wps[0].lon) < 1e-6 && Math.abs(last.lat - wps[0].lat) < 1e-6) wps = wps.slice(1);
  else offset = waypoints.length;
  for (const w of wps) waypoints.push({ ...w });
  for (const w of b.warnings ?? []) warnings.push({ ...w, leg_index: w.leg_index + offset });
  const drawbridges: RouteDrawbridge[] = (a.drawbridges ?? []).map(d => ({ ...d }));
  for (const d of b.drawbridges ?? []) drawbridges.push({ ...d, legIndex: d.legIndex + offset });
  const route: Route = {
    waypoints,
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: a.validated && b.validated,
    meshLeg: true,
  };
  if (warnings.length) route.warnings = warnings;
  if (drawbridges.length) route.drawbridges = drawbridges;
  const fronts = [...(a.fronts ?? []), ...(b.fronts ?? [])];
  if (fronts.length) route.fronts = fronts;
  const skeleton = [...(a.skeleton ?? []), ...(b.skeleton ?? [])];
  if (skeleton.length) route.skeleton = skeleton;
  const autoVias = [...(a.autoVias ?? []), ...(b.autoVias ?? [])];
  if (autoVias.length) route.autoVias = autoVias;
  const drops = (a.smootherDrops ?? 0) + (b.smootherDrops ?? 0);
  if (drops) route.smootherDrops = drops;
  const validTo = [a.forecastValidToMs, b.forecastValidToMs].filter((x): x is number => x !== undefined);
  if (validTo.length) route.forecastValidToMs = Math.min(...validTo);
  const horizon = Math.max(a.forecastHorizonExceededS ?? 0, b.forecastHorizonExceededS ?? 0);
  if (horizon > 0) route.forecastHorizonExceededS = horizon;
  if (a.limitsBeyondForecast || b.limitsBeyondForecast) route.limitsBeyondForecast = true;
  if (a.corridorFallback || b.corridorFallback) route.corridorFallback = true;
  const sources = a.currentSources ?? b.currentSources;
  if (sources) route.currentSources = sources;
  recomputePerWaypointMetadata(route);
  recomputeTotals(route);
  return route;
}
