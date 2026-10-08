/**
 * The experimental open-water router (docs/drafts/routing-thought-experiment.md).
 *
 * Step 1 (now): the convexified polar (vessel/convexpolar.ts). The
 * isochrone search runs unchanged but on the hull polar, so a leg into
 * the wind is a straight line at the beat's exact VMG and the search
 * needs no beat handling. Afterwards every sailed leg whose course is a
 * time-share of two polar headings is laid out as tacks, forward in
 * time: each tack's heading is the hull's beat angle in the wind at that
 * tack's own start (a wind that veers over a long leg moves the tacks
 * with it), no tack longer than TACK_MAX_M, alternating sides, the last
 * tack landing on the leg's end; a tack that would cross land or that the
 * real polar cannot sail is tried on the other side, then shorter, down
 * to TACK_MIN_M. Every leg is timed with the real polar and each tack
 * costs TACK_PENALTY_S. Anything that still cannot be sailed fails the
 * route (a RouteError naming the leg): no leg ever gets an invented
 * duration (2026-10-08: a sub-leg in irons was given the search's
 * duration for a tack point, nothing, and showed as 43.9 nm in one
 * minute).
 *
 * Step 2 (now): the cross-track polish (polish.ts), moving interior
 * waypoints sideways where the route then arrives earlier.
 *
 * Next, behind this same toggle and measured against the isochrone
 * router first: the ordered-upwind solver, only if a fixture comparison
 * shows the isochrone's pruning loses enough to be worth it.
 */

import { norm360 } from '../../geo/angles';
import { DEG, haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import type { LandMask } from '../../geo/landmask';
import { ConvexPolar } from '../../vessel/convexpolar';
import type { PolarDiagram } from '../../vessel/polar';
import type { VesselParams } from '../../vessel/vessel';
import { NoCurrent, NoWind, type CurrentSource, type WindSource } from '../environment';
import { RouteError } from '../errors';
import { simulateLegTime, type SimOptions } from '../legsim';
import { enrichLegRanges, enrichWaypoints, OceanPropagator } from '../propagator';
import { recomputePerWaypointMetadata, type Route, type Waypoint } from '../route';
import type { ComputeRouteArgs, PropagatorOptions } from '../search/types';
import { recomputeTotals } from '../smoother';
import { crossTrackPolish } from './polish';

/** Seconds lost per tack or gybe. */
export const TACK_PENALTY_S = 30;
/** The longest tack laid out: the wind is re-read at each tack's start, so this bounds how stale it gets (this plugin's choice, 5 nm). */
export const TACK_MAX_M = 9260;
/** Tacks are shortened for land or an unsailable heading down to this; below it the leg fails. */
export const TACK_MIN_M = 500;
/** More tacks than this on one leg is a loop, not a beat. */
const MAX_TACKS_PER_LEG = 400;

/** What the tack layout and the timing need from the request. */
interface Env {
  vessel: VesselParams;
  polar: PolarDiagram;
  wind: WindSource;
  current: CurrentSource;
  sim: SimOptions;
}

export class ExperimentalPropagator {
  private readonly base: OceanPropagator;

  constructor(
    private readonly land: LandMask,
    opts: PropagatorOptions
  ) {
    this.base = new OceanPropagator(land, opts);
  }

  computeRoute(args: ComputeRouteArgs): Route {
    if (!args.polar || args.modePolicy === 'motor') return this.base.computeRoute(args);
    const cp = new ConvexPolar(args.polar);
    const route = this.base.computeRoute({ ...args, polar: cp.hull });
    const env = this.layTacks(route, cp, args);
    const before = route.waypoints[route.waypoints.length - 1].time.getTime();
    const pr = crossTrackPolish(route.waypoints, this.land, (a, b) => this.tryTimeLeg(a, b, env));
    this.finish(route, env);
    args.onProgress?.(
      0,
      0,
      `experimental: cross-track polish: ${pr.passes} pass(es), ${pr.moved} waypoint move(s), arrival {time:${((before - route.waypoints[route.waypoints.length - 1].time.getTime()) / 1000).toFixed(0)}} earlier`
    );
    return route;
  }

  /** Wind, waves and current at the waypoints, course and speed, totals, the leg ranges. */
  private finish(route: Route, env: Env): void {
    enrichWaypoints(route.waypoints, env.wind, env.current);
    recomputePerWaypointMetadata(route);
    recomputeTotals(route);
    enrichLegRanges(route, env.wind);
  }

  /** Replace each mixed sailing leg by its tacks, timing every leg with the real polar as the polyline is built. */
  private layTacks(route: Route, cp: ConvexPolar, args: ComputeRouteArgs): Env {
    const env: Env = {
      vessel: args.vessel,
      polar: args.polar!,
      wind: args.wind ?? new NoWind(),
      current: args.current ?? new NoCurrent(),
      // The search's own defaults for the optional arguments (search/context.ts).
      sim: {
        modePolicy: args.modePolicy ?? 'sail_max',
        sailThreshMs: args.sailThreshMs ?? 2.5,
        simStepM: args.simStepM ?? 200,
        maxWindMs: args.maxWindMs,
        maxSwhM: args.maxSwhM,
        comfortWeight: args.comfortWeight,
      },
    };
    const old = route.waypoints;
    const out: Waypoint[] = [{ ...old[0] }];
    let split = 0;
    let tacks = 0;
    for (let i = 1; i < old.length; i++) {
      const b: Waypoint = { ...old[i] };
      const from = out[out.length - 1];
      if (
        b.mode === 'sailing' &&
        this.mixAt(from.lon, from.lat, from.time, haversineBearing(from.lon, from.lat, b.lon, b.lat), cp, env.wind)
      ) {
        const pts = this.tacksFor(from, b, cp, env);
        for (const p of pts) out.push(p);
        split++;
        tacks += pts.length;
      }
      this.timeLeg(out[out.length - 1], b, env);
      out.push(b);
    }
    route.waypoints = out;
    this.finish(route, env);
    args.onProgress?.(
      0,
      0,
      `experimental: convex polar: ${split} leg(s) laid out as tacks (${tacks} tack point(s), {time:${TACK_PENALTY_S}} each, tacks at most {distance:${TACK_MAX_M}}); arrival ${out[out.length - 1].time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    );
    return env;
  }

  /** Time b's arrival from a (at a's time) with the real polar, setting its mode and mixed-mode split; a leg that cannot be sailed fails the route. */
  private timeLeg(a: Waypoint, b: Waypoint, env: Env): void {
    if (this.tryTimeLeg(a, b, env)) return;
    const r = simulateLegTime(a.lon, a.lat, a.time, b.lon, b.lat, env.vessel, env.polar, env.wind, env.current, env.sim);
    throw new RouteError(
      `experimental router: the leg from ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} to ${b.lat.toFixed(4)}, ${b.lon.toFixed(4)} cannot be sailed under the ${env.sim.modePolicy} policy (${r.reason ?? 'no speed'}); use the isochrone router, or a waypoint`
    );
  }

  /** As timeLeg, returning false instead of failing when the leg cannot be sailed. */
  private tryTimeLeg(a: Waypoint, b: Waypoint, env: Env): boolean {
    const r = simulateLegTime(a.lon, a.lat, a.time, b.lon, b.lat, env.vessel, env.polar, env.wind, env.current, env.sim);
    if (!Number.isFinite(r.seconds) || r.seconds <= 0) return false;
    b.mode = r.dominantMode === 'sailing' ? 'sailing' : 'motoring';
    if (r.sailingSeconds > 0 && r.motoringSeconds > 0) b.arrivingSplit = [r.sailingSeconds, r.motoringSeconds];
    else delete b.arrivingSplit;
    b.time = new Date(a.time.getTime() + r.seconds * 1000 + (b.tack ? TACK_PENALTY_S * 1000 : 0));
    return true;
  }

  /** The two true headings a course at (lon, lat, t) is a mix of, or null when the polar sails it directly. */
  private mixAt(lon: number, lat: number, t: Date, cog: number, cp: ConvexPolar, wind: WindSource): { h1: number; h2: number } | null {
    const [ws, wd] = wind.at(lon, lat, t);
    if (!Number.isFinite(ws) || ws <= 0 || !Number.isFinite(wd)) return null;
    const signed = ((cog - wd + 540) % 360) - 180;
    const mix = cp.mixFor(signed, ws);
    if (!mix) return null;
    return { h1: norm360(wd + mix.a1), h2: norm360(wd + mix.a2) };
  }

  /**
   * The tack points from a (at its time) to b: forward in time, each tack
   * on the heading the hull gives in the wind at its start, no longer
   * than TACK_MAX_M, alternating sides; the last tack lands on b. Each
   * point carries its arrival time.
   */
  private tacksFor(a: Waypoint, b: Waypoint, cp: ConvexPolar, env: Env): Waypoint[] {
    const pts: Waypoint[] = [];
    let at: Waypoint = a;
    let lastHeading = -1;
    const tackTo = (h: number, d: number): Waypoint | null => {
      const [tLon, tLat] = projectAlongBearing(at.lon, at.lat, h, d);
      if (this.land.legCrossesLandExact(at.lon, at.lat, tLon, tLat)) return null;
      const s = this.sailable(at, tLon, tLat, env);
      if (s === null) return null;
      return {
        lon: tLon,
        lat: tLat,
        time: new Date(at.time.getTime() + (s + TACK_PENALTY_S) * 1000),
        sogMs: 0,
        cogDeg: 0,
        mode: 'sailing',
        tack: true,
      };
    };
    for (let n = 0; n < MAX_TACKS_PER_LEG; n++) {
      const D = haversineDistanceM(at.lon, at.lat, b.lon, b.lat);
      const theta = haversineBearing(at.lon, at.lat, b.lon, b.lat);
      const mix = this.mixAt(at.lon, at.lat, at.time, theta, cp, env.wind);
      if (!mix) return pts; // the rest is sailed straight
      // The two headings' shares of the remaining distance (a 2 × 2 solve).
      const det = Math.sin((mix.h1 - mix.h2) * DEG);
      if (Math.abs(det) < 1e-9) return pts;
      const d1 = (D * Math.sin((theta - mix.h2) * DEG)) / det;
      const d2 = (D * Math.sin((mix.h1 - theta) * DEG)) / det;
      if (!(d1 > 0 && d2 > 0)) return pts;
      const share = (h: number): number => (h === mix.h1 ? d1 : d2);
      // Alternate sides; the first tack takes the larger share.
      const first = lastHeading === mix.h1 ? mix.h2 : lastHeading === mix.h2 ? mix.h1 : d1 >= d2 ? mix.h1 : mix.h2;
      const other = first === mix.h1 ? mix.h2 : mix.h1;
      // Both shares fit in one tack each: two legs, the second ending on b.
      if (d1 <= TACK_MAX_M && d2 <= TACK_MAX_M) {
        for (const h of [first, other]) {
          const p = tackTo(h, share(h));
          if (!p || this.land.legCrossesLandExact(p.lon, p.lat, b.lon, b.lat) || this.sailable(p, b.lon, b.lat, env) === null) continue;
          pts.push(p);
          return pts;
        }
        // Neither order works in two legs: shorter tacks below.
      }
      let placed: Waypoint | null = null;
      for (let len = Math.min(TACK_MAX_M, Math.max(share(first), share(other))); len >= TACK_MIN_M && !placed; len /= 2) {
        for (const h of [first, other]) {
          const d = Math.min(len, share(h));
          if (d < TACK_MIN_M) continue;
          placed = tackTo(h, d);
          if (placed) {
            lastHeading = h;
            break;
          }
        }
      }
      if (!placed)
        throw new RouteError(
          `experimental router: the beat from ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} towards ${b.lat.toFixed(4)}, ${b.lon.toFixed(4)} cannot be tacked clear of land at ${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}; put a waypoint outside the enclosed water, or use the isochrone router`
        );
      pts.push(placed);
      at = placed;
    }
    throw new RouteError(
      `experimental router: more than ${MAX_TACKS_PER_LEG} tacks on one leg from ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}`
    );
  }

  /** Seconds to sail a straight sub-leg from a waypoint (at its time) with the real polar, or null when it cannot be sailed. */
  private sailable(from: Waypoint, toLon: number, toLat: number, env: Env): number | null {
    const r = simulateLegTime(from.lon, from.lat, from.time, toLon, toLat, env.vessel, env.polar, env.wind, env.current, env.sim);
    return Number.isFinite(r.seconds) && r.seconds > 0 ? r.seconds : null;
  }
}
