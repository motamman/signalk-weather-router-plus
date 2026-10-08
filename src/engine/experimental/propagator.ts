/**
 * The experimental open-water router (docs/drafts/routing-thought-experiment.md).
 *
 * Step 1 (now): the convexified polar (vessel/convexpolar.ts). The
 * isochrone search runs unchanged but on the hull polar, so a leg into
 * the wind is a straight line at the beat's exact VMG and the search
 * needs no beat handling. Afterwards every sailed leg is laid out
 * forward in time in steps of at most TACK_MAX_M: at each step the wind
 * there and then decides whether the course to the leg's end is a mix of
 * two polar headings (then a tack is placed, alternating sides, the last
 * one landing on the end) or a heading the polar sails directly (then
 * one straight step). The hull's promise, "this course is a time-share
 * of two headings", holds for one wind, not for a leg: a 75 km leg is
 * hours of forecast, and a course sailable at its start can be in the
 * no-go angle before its end (2026-10-08, a Bermuda run failed on such a
 * leg when only the leg's start was checked). A tack that would cross
 * land or that the real polar cannot sail is tried on the other side,
 * then shorter, down to TACK_MIN_M. Every leg is timed with the real
 * polar and each tack costs TACK_PENALTY_S. Anything that still cannot
 * be sailed fails the route (a RouteError naming the leg): no leg ever
 * gets an invented duration (2026-10-08: a sub-leg in irons was given
 * the search's duration for a tack point, nothing, and showed as 43.9 nm
 * in one minute).
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
import { simulateLegTime, type LegSimResult, type SimOptions } from '../legsim';
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
  /** Who the errors speak as ('experimental router', or a fixed polyline's caller). */
  who: string;
  /** What a failed leg's error suggests (the search's legs: another router or a waypoint; a fixed polyline: its caller's advice). */
  advice: string;
}

const SEARCH_ADVICE = 'use the isochrone router, or put a waypoint outside the enclosed water';

/** A polyline to lay out and time under a policy (sailMeshPath). */
export interface PolylineArgs {
  vessel: VesselParams;
  polar: PolarDiagram;
  wind?: WindSource;
  current?: CurrentSource;
  sim: SimOptions;
  /** Who the errors speak as, and what they say to do when a stretch cannot be sailed. */
  who: string;
  advice: string;
  onProgress?: ComputeRouteArgs['onProgress'];
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

  /**
   * A fixed polyline (a mesh route) sailed under the policy: every leg
   * laid out forward in time as the search's legs are (tacks where the
   * wind there and then needs them, each checked against the land mask
   * and timed with the real polar), no search and no polish. Fails with a
   * RouteError carrying `advice` when a stretch cannot be sailed.
   */
  sailPolyline(points: [number, number][], departure: Date, args: PolylineArgs): Route {
    const waypoints: Waypoint[] = points.map(([lon, lat], i) => ({
      lon,
      lat,
      time: departure,
      sogMs: 0,
      cogDeg: 0,
      mode: i ? 'sailing' : 'motoring',
    }));
    const route: Route = { waypoints, totalTimeS: 0, totalDistanceM: 0, motoringTimeS: 0, sailingTimeS: 0, validated: true };
    this.layTacks(
      route,
      new ConvexPolar(args.polar),
      {
        vessel: args.vessel,
        polar: args.polar,
        wind: args.wind,
        current: args.current,
        ...args.sim,
        onProgress: args.onProgress,
      },
      args.who,
      args.advice
    );
    return route;
  }

  /** Replace each mixed sailing leg by its tacks, timing every leg with the real polar as the polyline is built. */
  private layTacks(
    route: Route,
    cp: ConvexPolar,
    args: Omit<ComputeRouteArgs, 'start' | 'end' | 'departureTime'>,
    who = 'experimental router',
    advice = SEARCH_ADVICE
  ): Env {
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
      who,
      advice,
    };
    const old = route.waypoints;
    const out: Waypoint[] = [{ ...old[0] }];
    let split = 0;
    let tacks = 0;
    for (let i = 1; i < old.length; i++) {
      const b: Waypoint = { ...old[i] };
      if (b.mode === 'sailing') {
        const pts = this.layOut(out[out.length - 1], b, cp, env);
        const n = pts.filter(p => p.tack).length;
        if (n) split++;
        tacks += n;
        for (const p of pts) out.push(p);
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
      `${env.who}: the leg from ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} to ${b.lat.toFixed(4)}, ${b.lon.toFixed(4)} cannot be sailed under the ${env.sim.modePolicy} policy (${r.reason ?? 'no speed'}); ${env.advice}`
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
   * The points laid out from a (at its time) to b, forward in time and
   * never more than TACK_MAX_M apart: at each point the wind there and
   * then decides between a tack (the course to b is a mix of two polar
   * headings: one tack on the heading the hull gives, alternating sides,
   * the last landing on b) and a straight step along the course. Each
   * point carries its arrival time. The leg a → last point → b is what the
   * caller times; the straight step points are collinear and the route's
   * simplification thins them afterwards.
   */
  private layOut(a: Waypoint, b: Waypoint, cp: ConvexPolar, env: Env): Waypoint[] {
    const pts: Waypoint[] = [];
    let at: Waypoint = a;
    let lastHeading = -1;
    const stepTo = (h: number, d: number, tack: boolean): Waypoint | null => {
      const [tLon, tLat] = projectAlongBearing(at.lon, at.lat, h, d);
      if (this.land.legCrossesLandExact(at.lon, at.lat, tLon, tLat)) return null;
      const r = this.sailable(at, tLon, tLat, env);
      if (r === null) return null;
      // Mode and mixed-mode split as tryTimeLeg records them, so the totals book motored time as motoring.
      const p: Waypoint = {
        lon: tLon,
        lat: tLat,
        time: new Date(at.time.getTime() + (r.seconds + (tack ? TACK_PENALTY_S : 0)) * 1000),
        sogMs: 0,
        cogDeg: 0,
        mode: r.dominantMode === 'sailing' ? 'sailing' : 'motoring',
      };
      if (r.sailingSeconds > 0 && r.motoringSeconds > 0) p.arrivingSplit = [r.sailingSeconds, r.motoringSeconds];
      if (tack) p.tack = true;
      return p;
    };
    const tackTo = (h: number, d: number): Waypoint | null => stepTo(h, d, true);
    for (let n = 0; n < MAX_TACKS_PER_LEG; n++) {
      const D = haversineDistanceM(at.lon, at.lat, b.lon, b.lat);
      const theta = haversineBearing(at.lon, at.lat, b.lon, b.lat);
      const mix = this.mixAt(at.lon, at.lat, at.time, theta, cp, env.wind);
      // The two headings' shares of the remaining distance (a 2 × 2 solve); a beat only when both are positive.
      let d1 = 0;
      let d2 = 0;
      if (mix) {
        const det = Math.sin((mix.h1 - mix.h2) * DEG);
        if (Math.abs(det) >= 1e-9) {
          d1 = (D * Math.sin((theta - mix.h2) * DEG)) / det;
          d2 = (D * Math.sin((mix.h1 - theta) * DEG)) / det;
        }
      }
      if (!mix || !(d1 > 0 && d2 > 0)) {
        // A direct heading in this wind: the rest in one go when it fits a step, else one straight step and look again.
        if (D <= TACK_MAX_M) return pts;
        const p = stepTo(theta, TACK_MAX_M, false);
        if (!p)
          throw new RouteError(
            `${env.who}: the leg from ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} to ${b.lat.toFixed(4)}, ${b.lon.toFixed(4)} cannot be sailed at ${at.lat.toFixed(4)}, ${at.lon.toFixed(4)} under the ${env.sim.modePolicy} policy; ${env.advice}`
          );
        pts.push(p);
        at = p;
        lastHeading = -1;
        continue;
      }
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
          `${env.who}: the beat from ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} towards ${b.lat.toFixed(4)}, ${b.lon.toFixed(4)} cannot be tacked at ${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}: every tack tried crossed land or could not be sailed under the ${env.sim.modePolicy} policy; ${env.advice}`
        );
      pts.push(placed);
      at = placed;
    }
    throw new RouteError(`${env.who}: more than ${MAX_TACKS_PER_LEG} tacks on one leg from ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}`);
  }

  /** The real polar's timing of a straight sub-leg from a waypoint (at its time), or null when it cannot be sailed. */
  private sailable(from: Waypoint, toLon: number, toLat: number, env: Env): LegSimResult | null {
    const r = simulateLegTime(from.lon, from.lat, from.time, toLon, toLat, env.vessel, env.polar, env.wind, env.current, env.sim);
    return Number.isFinite(r.seconds) && r.seconds > 0 ? r : null;
  }
}
