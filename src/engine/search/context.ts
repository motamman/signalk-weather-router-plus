/**
 * The search context: inputs resolved, endpoints checked, goals and budget set.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import { HOUR_MS } from '../../geo/units';
import { NoCurrent, NoWind } from '../environment';
import type { EngineErrorCode } from '../errors';
import { fmtUtc, limitsAt, limitsEaseAt, type RefusalPlace, RouteRefused, type RouteRefusal } from '../refusal';
import type { Waypoint } from '../route';
import {
  RouteCancelled,
  RouteError,
  type Budget,
  type Candidate,
  type ComputeRouteArgs,
  type PropagatorParams,
  type SearchContext,
  type Via,
} from './types';

/** Stage sizing for a distance: K stages at cruise speed, 2k subsector bins. */
export function sizeBudget(distM: number, cruise: number, K: number, k: number): Budget {
  const dtS = distM / cruise / K;
  const deltaD = distM / (2 * k);
  return { budgetDistM: distM, dtS, deltaD, candStepM: cruise * dtS };
}

/** Re-size the budget to a longer distance (the skeleton's length). */
export function resizeBudget(ctx: SearchContext, distM: number): void {
  ctx.budget = sizeBudget(distM, ctx.cruise, ctx.K, ctx.k);
}

export function resetTry(ctx: SearchContext, parents: Candidate[]): void {
  const { lastTry } = ctx;
  lastTry.tried = 0;
  lastTry.land = 0;
  lastTry.limited = 0;
  lastTry.noGo = 0;
  lastTry.stuck = 0;
  lastTry.latestMs = 0;
  for (const p of parents) lastTry.latestMs = Math.max(lastTry.latestMs, p.timeMs);
}

export function tryNote(ctx: SearchContext): string {
  const { lastTry } = ctx;
  const parts: string[] = [];
  if (lastTry.limited) parts.push(`${lastTry.limited} over the wind/wave limit`);
  if (lastTry.land) parts.push(`${lastTry.land} crossing land`);
  if (lastTry.noGo) parts.push(`${lastTry.noGo} dead upwind (in the polar's no-go angle)`);
  if (lastTry.stuck) parts.push(`${lastTry.stuck} stopped (no boat speed, or a foul current)`);
  return parts.length
    ? `of the last stage's ${lastTry.tried} candidates, ${parts.join(', ')}`
    : `the last stage tried ${lastTry.tried} candidates`;
}

export { fmtUtc } from '../refusal';

export function forecastNote(ctx: SearchContext): string {
  const { args, lastTry } = ctx;
  if (args.forecastEndMs === undefined || lastTry.latestMs <= args.forecastEndMs) return '';
  // Moves stopped by land alone, at least half of those tried: no forecast changes the coast, so a longer horizon is
  // no way out and is not offered.
  if (lastTry.land > 0 && lastTry.limited + lastTry.noGo + lastTry.stuck === 0 && 2 * lastTry.land >= lastTry.tried) return '';
  return ` The forecast ends ${fmtUtc(args.forecastEndMs)} and the search is ${((lastTry.latestMs - args.forecastEndMs) / HOUR_MS).toFixed(0)} h past it, on conditions held at that last step: a longer forecast horizon (Defaults) may open a way.`;
}

/** How far ahead a limit's ease is looked for when the forecast's end is not known. */
const EASE_LOOKAHEAD_MS = 72 * HOUR_MS;

/**
 * The refusal for a front with nowhere to go from `stuck` (the candidates whose every move failed), from what the
 * last try counted: over a limit when the limit stopped most moves, placed at the candidate it stopped hardest; land,
 * the no-go angle or no boat speed only when it stopped every move; else the reasons listed. Over a limit,
 * the wind and waves are read at each candidate and one stage step ahead of it towards its goal (a move is stopped
 * where it would arrive), the worst against its limit is named, and the hour they ease there is looked for up to the
 * forecast's end. The counts (tryNote) go on the error as its detail, for the log; `suffix` follows the sentence.
 */
export function refuseDeadEnd(ctx: SearchContext, stuck: Candidate[], code: EngineErrorCode = 'route', suffix = ''): RouteRefused {
  const { args, wind, lastTry, goals } = ctx;
  const detail = tryNote(ctx);
  const start: Candidate = {
    ...stuck[0],
    lon: ctx.sLon,
    lat: ctx.sLat,
    timeMs: args.departureTime.getTime(),
    parentIdx: -1,
    elapsedS: 0,
    viaCount: stuck[0]?.viaCount ?? ctx.startViaCount,
  };
  const first = stuck[0] ?? start;
  const place = (c: Candidate): RefusalPlace => (c.parentIdx < 0 && c.elapsedS === 0 ? null : { lon: c.lon, lat: c.lat });
  const top = Math.max(lastTry.limited, lastTry.land, lastTry.noGo, lastTry.stuck);
  if (top > 0 && lastTry.limited === top) {
    let worst = first;
    let worstAhead = false;
    let worstOver = -Infinity;
    let worstL = limitsAt(wind, first.lon, first.lat, first.timeMs, args.maxWindMs, args.maxSwhM);
    const aheadS = ctx.budget.candStepM / ctx.cruise;
    for (const c of stuck.length ? stuck : [first]) {
      const g = goals[Math.min(c.viaCount, goals.length - 1)];
      const [aLon, aLat] = projectAlongBearing(c.lon, c.lat, haversineBearing(c.lon, c.lat, g.lon, g.lat), ctx.budget.candStepM);
      for (const [lon, lat, t, ahead] of [
        [c.lon, c.lat, c.timeMs, false],
        [aLon, aLat, c.timeMs + aheadS * 1000, true],
      ] as const) {
        const l = limitsAt(wind, lon, lat, t, args.maxWindMs, args.maxSwhM);
        const over = Math.max(l.wind ? l.wind.seen / l.wind.limit : 0, l.waves ? l.waves.seen / l.waves.limit : 0);
        if (over > worstOver) {
          worstOver = over;
          worst = { ...c, lon, lat, timeMs: t };
          worstAhead = ahead;
          worstL = l;
        }
      }
    }
    // Up to the forecast's end when it is known: past it the last step is held, so nothing can ease there (a reading past
    // it is told as past the forecast's end, refusalText).
    const untilMs = args.forecastEndMs ?? worst.timeMs + EASE_LOOKAHEAD_MS;
    const refusal: RouteRefusal = {
      kind: 'over_limit',
      // The start keeps its name even when the reading one step ahead of it is the worst.
      at: place(first) === null ? null : { lon: worst.lon, lat: worst.lat },
      atMs: worst.timeMs,
      wind: worstL.wind,
      waves: worstL.waves,
      easesMs: limitsEaseAt(wind, worst.lon, worst.lat, worst.timeMs, untilMs, args.maxWindMs, args.maxSwhM),
      untilMs,
      untilForecastEnd: args.forecastEndMs !== undefined,
      // Where a refused move would arrive: never reached (refusalText says "one step ahead of the front").
      ahead: worstAhead,
    };
    // Only when a reading is over a limit: the moves the limit stopped can be on other headings than the two readings,
    // and "over your limits on every heading" would then be false. Else the reasons are listed, the limit among them.
    if (worstL.wind || worstL.waves) return new RouteRefused(refusal, detail, code, suffix);
  }
  // One cause is named only when every move tried failed for it (then it held at every candidate, `first` among
  // them); otherwise the reasons are listed, at `first` only when it was the one candidate.
  const all = (n: number): boolean => lastTry.tried > 0 && n === lastTry.tried;
  const kind = all(lastTry.land) ? 'coast' : all(lastTry.noGo) ? 'dead_upwind' : all(lastTry.stuck) ? 'stopped' : null;
  if (kind) return new RouteRefused({ kind, at: place(first), atMs: first.timeMs }, detail, code, suffix);
  const reasons: ('land' | 'no_go' | 'stopped' | 'limit')[] = [];
  if (lastTry.land) reasons.push('land');
  if (lastTry.noGo) reasons.push('no_go');
  if (lastTry.stuck) reasons.push('stopped');
  if (lastTry.limited) reasons.push('limit');
  let latestMs = first.timeMs;
  for (const c of stuck) latestMs = Math.max(latestMs, c.timeMs);
  const at = stuck.length <= 1 ? place(first) : 'front';
  return new RouteRefused({ kind: 'mixed', at, atMs: at === 'front' ? latestMs : first.timeMs, reasons }, detail, code, suffix);
}

/**
 * Resolve the inputs, check the endpoints and vias against the exact
 * polygons, build the goal queue and the stage budget. Throws RouteError
 * for bad inputs; sets `degenerateRoute` when start and end coincide.
 */
export function buildContext(prop: PropagatorParams, args: ComputeRouteArgs): SearchContext {
  const wind = args.wind ?? new NoWind();
  const current = args.current ?? new NoCurrent();
  const polar = args.polar ?? null;
  const vessel = args.vessel;
  const modePolicy = args.modePolicy ?? 'sail_max';
  const sailThreshMs = args.sailThreshMs ?? 2.5;
  const simStepM = args.simStepM ?? 200;
  const progress = args.onProgress ?? (() => undefined);
  const shouldCancel = args.shouldCancel ?? (() => false);
  const checkCancel = (): void => {
    if (shouldCancel()) throw new RouteCancelled();
  };
  const simOpts = {
    modePolicy,
    sailThreshMs,
    simStepM,
    maxWindMs: args.maxWindMs,
    maxSwhM: args.maxSwhM,
    maxWindMode: args.maxWindMode,
    maxSwhMode: args.maxSwhMode,
    limitAvoidStrength: args.limitAvoidStrength,
    comfortWeight: args.comfortWeight,
    tackPenaltyS: args.tackPenaltyS,
  };
  const hasLimit = args.maxWindMs !== undefined || args.maxSwhM !== undefined;
  const limitNote = hasLimit ? ' or over the wind/wave limit' : '';
  const lastTry = { tried: 0, land: 0, limited: 0, noGo: 0, stuck: 0, latestMs: 0 };

  const [sLon, sLat] = args.start;
  const [eLon, eLat] = args.end;
  const snapToExact = args.snapToExact ?? true;
  if (!snapToExact && !(args.arrivalRadiusM !== undefined && args.arrivalRadiusM > 0)) {
    throw new RouteError('snapToExact=false needs arrivalRadiusM > 0');
  }

  // Pre-flight endpoint checks against the exact polygons.
  if (prop.landMask.isLandExact(sLon, sLat)) {
    throw new RouteError(`start point (${sLat.toFixed(4)}, ${sLon.toFixed(4)}) is on land`);
  }
  if (prop.landMask.isLandExact(eLon, eLat)) {
    throw new RouteError(`end point (${eLat.toFixed(4)}, ${eLon.toFixed(4)}) is on land`);
  }

  // Goal queue: vias then the end (radius 0).
  const goals: Via[] = [];
  if (args.vias) {
    args.vias.forEach((v, idx) => {
      if (!(v.radiusM > 0)) throw new RouteError(`via ${idx} arrival radius must be > 0 (got ${v.radiusM})`);
      if (prop.landMask.isLandExact(v.lon, v.lat)) {
        throw new RouteError(`via ${idx} (${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}) is on land`);
      }
      goals.push({ ...v });
    });
  }
  goals.push({ lon: eLon, lat: eLat, radiusM: 0 });
  const nVias = goals.length - 1;
  let startViaCount = 0;
  while (startViaCount < nVias) {
    const g = goals[startViaCount];
    if (haversineDistanceM(sLon, sLat, g.lon, g.lat) <= g.radiusM) startViaCount++;
    else break;
  }

  // Distance budget.
  let chainDist = 0;
  let prev: [number, number] = [sLon, sLat];
  for (const g of goals) {
    chainDist += haversineDistanceM(prev[0], prev[1], g.lon, g.lat);
    prev = [g.lon, g.lat];
  }
  const totalDistM = Math.max(chainDist, haversineDistanceM(sLon, sLat, eLon, eLat));

  const ctx: SearchContext = {
    landMask: prop.landMask,
    K: prop.K,
    k: prop.k,
    m: prop.m,
    deltaC: prop.deltaC,
    skeletonResolutionDeg: prop.skeletonResolutionDeg,
    skeletonPaddingDeg: prop.skeletonPaddingDeg,
    args,
    wind,
    current,
    polar,
    vessel,
    modePolicy,
    simOpts,
    progress,
    checkCancel,
    hasLimit,
    limitNote,
    lastTry,
    sLon,
    sLat,
    eLon,
    eLat,
    snapToExact,
    goals,
    nVias,
    startViaCount,
    totalDistM,
    cruise: 0,
    budget: { budgetDistM: 0, dtS: 0, deltaD: 0, candStepM: 0 },
    fronts: [],
  };
  if (totalDistM <= 0) {
    const wp: Waypoint = { lon: sLon, lat: sLat, time: args.departureTime, sogMs: 0, cogDeg: 0, mode: 'motoring', leg: 'ocean' };
    ctx.degenerateRoute = { waypoints: [wp], totalTimeS: 0, totalDistanceM: 0, motoringTimeS: 0, sailingTimeS: 0, validated: true };
    return ctx;
  }
  const cruise = vessel.motorSpeedMs;
  if (!(cruise > 0)) throw new RouteError('vessel.motorSpeedMs must be > 0');
  ctx.cruise = cruise;
  // Stage budget: K stages sized to the straight-line distance, re-sized
  // to the coarse skeleton's length once it is known (skeleton.ts), so a
  // passage that must detour around land still fits in K stages instead
  // of running out of stages short of the destination.
  ctx.budget = sizeBudget(totalDistM, cruise, prop.K, prop.k);
  return ctx;
}
