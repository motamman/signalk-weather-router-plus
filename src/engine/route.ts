/**
 * Route and Waypoint types (SI: m, m/s, s, degrees) and the per-waypoint
 * metadata recomputation. The GeoJSON and Signal K wire formats live in
 * plugin/routeformat.ts.
 */

import { haversineBearing, haversineDistanceM } from '../geo/geodesy';
import { twaFromHeading } from '../geo/angles';

export type Mode = 'sailing' | 'motoring';

export interface RouteDrawbridge {
  lon: number;
  lat: number;
  clearM: number | null;
  legIndex: number;
}

export interface Waypoint {
  lon: number;
  lat: number;
  time: Date;
  /** Speed over ground into this waypoint, m/s (0 at the start). */
  sogMs: number;
  /** Course over ground into this waypoint, degrees true. */
  cogDeg: number;
  mode: Mode;
  /** Charted depth under the waypoint, metres, from the chart mesh (mesh legs only). */
  depthM?: number;
  twaDeg?: number;
  windMs?: number;
  /** Wind direction FROM, degrees true. */
  windDirDeg?: number;
  swhM?: number;
  mwpS?: number;
  /** Wave direction FROM, degrees true. */
  mwdDeg?: number;
  currentUMs?: number;
  currentVMs?: number;
  currentMs?: number;
  /** Current set (flows TO), degrees true. */
  currentDirDeg?: number;
  /** Lowest wind speed sampled along the leg departing here, m/s. */
  windMinMs?: number;
  /** Highest wind speed sampled along the leg departing here, m/s. */
  windMaxMs?: number;
  /** Lowest significant wave height along the leg departing here, m. */
  swhMinM?: number;
  /** Highest significant wave height along the leg departing here, m. */
  swhMaxM?: number;
  leg?: string;
  role?: 'via';
  /** A tack or gybe point the router placed when it split a beat into its two legs (experimental router). */
  tack?: true;
  /**
   * Sailing and motoring seconds of the leg arriving here, set when the
   * shortcut smoother merged several legs into one (mixed modes); totals
   * use it in place of the binary `mode`.
   */
  arrivingSplit?: [number, number];
}

export interface RouteWarning {
  leg_index: number;
  violation: 'leg_crosses_land' | 'wind_over_limit' | 'waves_over_limit';
  from: [number, number];
  to: [number, number];
  repaired: boolean;
}

export interface FrontPoint {
  lon: number;
  lat: number;
  timeMs: number;
  /** Which goal (waypoint) the point is heading for; 0 before the first via. */
  viaCount: number;
}

export interface StageFront {
  /** Leg index for multi-leg routes (0 for a single leg). */
  leg: number;
  stage: number;
  totalStages: number;
  /** Sorted across the track within each viaCount. */
  points: FrontPoint[];
  /** The best candidate's path back to the start, [lon, lat] from the start. */
  best: [number, number][];
}

/** A route point that was on land and was moved to the nearest water before routing. */
export interface StopSnap {
  /** Index among the route's stops: 0 = start, last = destination, others = the user's waypoints in order. */
  index: number;
  original: [number, number];
  anchor: [number, number];
  distanceM: number;
}

export interface Route {
  waypoints: Waypoint[];
  totalTimeS: number;
  totalDistanceM: number;
  motoringTimeS: number;
  sailingTimeS: number;
  warnings?: RouteWarning[];
  validated: boolean;
  /** Set by the caller when the route runs past the forecast's last step. */
  forecastHorizonExceededS?: number;
  /** The forecast's last valid step (ms since epoch), set by the caller; waypoints after it ran on held conditions. */
  forecastValidToMs?: number;
  /** Set by the caller when a wind or wave limit was in force on legs past the forecast's last step. */
  limitsBeyondForecast?: boolean;
  /** Stops that were on land and were moved to the nearest water (set by the caller). */
  snaps?: StopSnap[];
  /** The stops the route was asked for (start, waypoints, destination; after any snap) with each waypoint's arrival radius in approximate mode (set by the caller). */
  stops?: { lon: number; lat: number; radiusM?: number }[];
  /** Waypoint precision the route was computed with (set by the caller). */
  precision?: 'precise' | 'approximate';
  /** Forecast cycle used, ISO string, when any. */
  forecastCycle?: string;
  /** Names of the current sources that were stacked, when any. */
  currentSources?: string[];
  /** Coarse A* skeleton that guided the heading sweep, when one was found. */
  skeleton?: { lon: number; lat: number }[];
  /**
   * The front of every search stage (the candidates kept after pruning, each
   * with its own arrival time; not equal-time isochrones) and the best path
   * back to the start at that stage. For display only.
   */
  fronts?: StageFront[];
  /** Waypoints the shortcut smoother dropped (RDP thinning is not counted). */
  smootherDrops?: number;
  /** Automatic vias the router placed at narrow passages (not waypoints). */
  autoVias?: { lon: number; lat: number; radiusM: number; widthM: number; name: string }[];
  /** Opening bridges the route passes under (mesh legs): position, charted open clearance (null = none charted), the waypoint the crossing leg arrives at. */
  drawbridges?: RouteDrawbridge[];
  /** The corridor search failed and the leg ran on the per-route coarse skeleton instead (decision E: counted in the status). */
  corridorFallback?: true;
  /** The leg (or at least one leg) was routed on the chart mesh (engine/mesh) instead of the coastline search. */
  meshLeg?: true;
}

/** Recompute cog / twa / sog on every waypoint from the final geometry. */
export function recomputePerWaypointMetadata(route: Route): void {
  const wps = route.waypoints;
  for (let k = 1; k < wps.length; k++) {
    const prev = wps[k - 1];
    const cur = wps[k];
    cur.cogDeg = haversineBearing(prev.lon, prev.lat, cur.lon, cur.lat);
    if (cur.windDirDeg !== undefined) {
      cur.twaDeg = twaFromHeading(cur.cogDeg, cur.windDirDeg);
    }
    const dt = (cur.time.getTime() - prev.time.getTime()) / 1000;
    if (dt > 0) cur.sogMs = haversineDistanceM(prev.lon, prev.lat, cur.lon, cur.lat) / dt;
  }
}
