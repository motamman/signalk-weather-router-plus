/**
 * Limits set to avoid (engine/legsim.ts SimOptions maxWindMode / maxSwhMode): the search lets a branch through water
 * over a limit at a price, but it keeps one branch per bin on its cost so far (search/stages.ts), so a branch that
 * swings wide round that water is dropped before the straight one reaches it and pays: the detour is never seen
 * (measured 2026-10-30, a band over the wind limit across a 1° leg: straight through at strength 10 with 20
 * subsectors, round it at 80). So the two complete answers are compared instead: the route searched with the limits
 * on avoid, and, when that one spends time over a limit, the route searched with them on block (the best way round,
 * which never goes over). The cheaper on time plus surcharge (strength × the seconds over) is kept; when no way round
 * exists (the block search fails) the avoid route stands. It chooses between going through and going round; a route
 * that only clips the water, if cheaper than both, is not looked for.
 */

import { NoCurrent, NoWind } from './environment';
import { RouteCancelled, EngineError } from './errors';
import { DEFAULT_LIMIT_AVOID_STRENGTH, limitAvoidActive, simulateLegTime, type SimOptions } from './legsim';
import type { Route } from './route';
import type { ComputeRouteArgs } from './search/types';

/** Seconds a route's legs spend over a limit set to avoid (over both at once counts once), each leg timed from its start. */
export function overLimitSeconds(route: Route, args: ComputeRouteArgs): number {
  const sim: SimOptions = {
    modePolicy: args.modePolicy ?? 'sail_max',
    sailThreshMs: args.sailThreshMs ?? 2.5,
    simStepM: args.simStepM ?? 200,
    maxWindMs: args.maxWindMs,
    maxSwhM: args.maxSwhM,
    maxWindMode: args.maxWindMode,
    maxSwhMode: args.maxSwhMode,
  };
  const wind = args.wind ?? new NoWind();
  const current = args.current ?? new NoCurrent();
  const wps = route.waypoints;
  let over = 0;
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    const r = simulateLegTime(a.lon, a.lat, a.time, b.lon, b.lat, args.vessel, args.polar ?? null, wind, current, sim);
    if (Number.isFinite(r.overLimitSeconds)) over += r.overLimitSeconds;
  }
  return over;
}

/**
 * `compute` (a router's computeRoute) under the request's limits: as is when no limit is set to avoid; else the avoid
 * route, compared with the block route when it goes over (see the module comment). `log` says which was kept and why.
 */
export function computeAvoidingLimits(
  compute: (args: ComputeRouteArgs) => Route,
  args: ComputeRouteArgs,
  log: (message: string) => void
): Route {
  if (!limitAvoidActive(args)) return compute(args);
  const through = compute(args);
  const over = overLimitSeconds(through, args);
  if (over <= 0) return through;
  const strength = args.limitAvoidStrength ?? DEFAULT_LIMIT_AVOID_STRENGTH;
  const throughCost = through.totalTimeS + strength * over;
  let round: Route;
  try {
    round = compute({
      ...args,
      maxWindMode: args.maxWindMode === 'avoid' ? 'block' : args.maxWindMode,
      maxSwhMode: args.maxSwhMode === 'avoid' ? 'block' : args.maxSwhMode,
    });
  } catch (err) {
    if (err instanceof RouteCancelled || !(err instanceof EngineError)) throw err;
    log(
      `over a limit set to avoid for {time:${Math.round(over)}}; no way round it (${(err as Error).message.split('\n')[0]}): the route goes through`
    );
    return through;
  }
  const keepRound = round.totalTimeS < throughCost;
  log(
    `over a limit set to avoid for {time:${Math.round(over)}} (surcharge {time:${Math.round(strength * over)}}); ` +
      `through {time:${Math.round(through.totalTimeS)}}, round {time:${Math.round(round.totalTimeS)}}: ` +
      (keepRound ? 'the route goes round' : 'the route goes through, the way round costing more')
  );
  return keepRound ? round : through;
}
