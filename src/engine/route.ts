/**
 * Route and Waypoint types (SI: m, m/s, s, degrees) and the per-waypoint
 * metadata recomputation. The GeoJSON and Signal K wire formats live in
 * plugin/routeformat.ts.
 */

import { haversineBearing, haversineDistanceM } from '../geo/geodesy';
import { twaFromHeading } from '../geo/angles';
import type { LegArrival } from './legsim';

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
  /**
   * The sail plan the leg arriving here is sailed on: the fastest of a polar set's plans along it (engine/sailplans.ts),
   * a route point placed where that changes. On a leg partly motored, the plan of its sailed part. Absent on a leg with
   * no sailing and for a polar without sail plans.
   */
  sailPlan?: string;
  role?: 'via';
  /** A tack or gybe point the router placed when it split a beat into its two legs (experimental router). */
  tack?: true;
  /**
   * The leg arriving here is a beat no tack fitted in, motored straight (experimental router, layTacks): turned into
   * a `beat_motored` warning once the route is final (copies made by the polish keep it), then removed.
   */
  motoredBeat?: true;
  /**
   * Sailing and motoring seconds of the leg arriving here, set when the
   * shortcut smoother merged several legs into one (mixed modes); totals
   * use it in place of the binary `mode`.
   */
  arrivingSplit?: [number, number];
}

export interface RouteWarning {
  leg_index: number;
  /**
   * `detour_motored`: a chart-mesh repair detour (worker/route.ts repairViolations) that had to motor because sailing
   * could not move the boat there. `search_failed`: the search on an open stretch of a chart-mesh leg failed and the
   * stretch follows the mesh route instead (mesh/legrun.ts), which can be slower, with many short tacks; from and to
   * are the stretch's ends. `beat_motored`: a beat no tack fitted in, motored straight (experimental/propagator.ts).
   * `waves_outside_correction`: time sailed where the sea was outside the polar's wave-correction table, so at the
   * polar's speed uncorrected (smoother.ts waveCorrectionWarnings). `waves_no_period`: time sailed where the forecast
   * had waves but no Tm02 (mp2) to read that table with, so uncorrected too.
   */
  violation:
    | 'leg_crosses_land'
    | 'wind_over_limit'
    | 'waves_over_limit'
    | 'detour_motored'
    | 'search_failed'
    | 'beat_motored'
    | 'waves_outside_correction'
    | 'waves_no_period';
  from: [number, number];
  to: [number, number];
  repaired: boolean;
  /**
   * detour_motored and beat_motored: the motoring time, seconds; waves_outside_correction: the time sailed uncorrected,
   * seconds. search_failed: why the search failed.
   */
  detail?: string;
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
  /** Detours the chart-mesh repair spliced in (worker/route.ts repairViolations). */
  repairsApplied?: number;
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
  /** Per leg of the route (a leg ends at each waypoint), what planned it: the chart mesh, the coastline search, or both (a handover leg). */
  legSources?: LegSource[];
  /** The final depth check against the chart mesh (set by the caller): per leg what the route crosses. */
  depthCheck?: DepthCheck;
}

export type LegSource = 'mesh' | 'coastline' | 'mixed';

/** What one leg of a finished route crosses on the chart mesh (engine/mesh/check.ts); metres along the route. */
export interface LegDepth {
  leg: number;
  /** On mesh triangles. */
  onMeshM: number;
  /** On mesh triangles with no charted depth (-999): passed, as the blocking rules pass them. */
  unknownDepthM: number;
  /** Where no mesh triangle is (outside every mesh, or land the mesh leaves out: not told apart yet). */
  outsideMeshM: number;
  /** The shallowest charted depth crossed, metres, and where; null when none was charted along the leg. */
  shallowestM: number | null;
  shallowestAt: [number, number] | null;
}

export interface DepthCheck {
  legs: LegDepth[];
}

/** How the boat arrives at `cur` from `prev`: the course between them and `cur`'s mode (legsim.ts LegArrival, for the tack charge of the move after). */
export function arrivalInto(prev: { lon: number; lat: number }, cur: { lon: number; lat: number; mode: Mode }): LegArrival {
  return { cogDeg: haversineBearing(prev.lon, prev.lat, cur.lon, cur.lat), mode: cur.mode };
}

/** The arrival at a route's last waypoint (null for a route of one point): what the next leg's first move is charged against. */
export function routeArrival(route: Pick<Route, 'waypoints'>): LegArrival | null {
  const w = route.waypoints;
  return w.length >= 2 ? arrivalInto(w[w.length - 2], w[w.length - 1]) : null;
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
