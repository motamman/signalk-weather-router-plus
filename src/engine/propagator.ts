/**
 * Subsector isochrone propagator for open-water legs. Port of
 * routing/engine/ocean_propagator.py (Hagiwara 1989 / Chen & Mao 2024
 * IPO family) without the bathymetry gate.
 *
 * Per stage:
 *  1. From each retained parent, project (2m+1) candidates at evenly
 *     spaced headings around the bearing to the next skeleton target,
 *     one stage step away.
 *  2. Drop candidates whose great-circle leg touches land.
 *  3. Score survivors with the batched leg simulator (wind, current,
 *     polar, mode policy).
 *  4. Bin by cross-track offset from the start→end great circle into 2k
 *     subsectors; keep the cheapest (elapsed + remaining/cruise) per bin
 *     and per via-count.
 *  5. Stop early when a candidate is within one stage step (or the
 *     caller's arrival radius) of the destination.
 * Then a straight final leg to the destination, back-trace, enrich each
 * waypoint with wind/waves/current, and validate every leg against the
 * exact polygons.
 *
 * A skeleton (land-avoiding motor path) biases the heading sweep so
 * channels and around-island detours are found without widening the
 * sweep at every stage. The router passes a corridor from the global
 * water grid (engine/corridor.ts) with a width profile; without one, a
 * coarse A* on a raster of the route's land mask is used.
 *
 * Narrow passages (from the corridor's width profile):
 *  - a parent's stage step is limited so it never jumps past a point
 *    where the passage is narrower than step / STEP_PER_WIDTH: it may
 *    step up to that point, and inside the passage it steps at most
 *    STEP_PER_WIDTH × the local width (never below MIN_STEP_M); the stage
 *    budget grows by the stages this costs;
 *  - inside a stretch narrower than one subsector bin, candidates are
 *    binned by their offset across the passage (NARROW_BINS bins across
 *    the local width) instead of by the start→end offset, so several
 *    branches survive through the passage instead of one per bin.
 * Automatic vias (Via.auto) work like user vias but are never reported as
 * route waypoints.
 *
 * INTO_CIRCLE_NOTE (deviation from the reference): a parent whose next
 * user via's circle is closer than one stage step also gets one candidate
 * on the straight line to the via, ending just inside its circle (the
 * same hop the approximate final leg uses). Without it a branch reaches a
 * small circle only if a full stage step happens to cross it, which
 * fails where the course turns at the waypoint (Baja job 5e0abb0d,
 * docs/plans/waypoints-multi-leg.md).
 */

import { assembleRoute } from './search/assemble';
import { buildContext } from './search/context';
import { buildSkeleton } from './search/skeleton';
import { runStages } from './search/stages';
import { chooseTerminal } from './search/terminal';
import { buildGuide } from './search/zones';
import type { ComputeRouteArgs, PropagatorOptions } from './search/types';
import type { LandTest } from '../geo/landmask';
import type { Route } from './route';

export {
  BEATING_SHARE,
  NARROW_BINS,
  RouteCancelled,
  RouteError,
  STALL_STAGES,
  TERMINAL_EVAL,
  ViasNotCrossedError,
  type ComputeRouteArgs,
  type CorridorInput,
  type PropagatorOptions,
  type Via,
} from './search/types';
export { enrichLegRanges, enrichWaypoints } from './search/enrich';

export class OceanPropagator {
  readonly K: number;
  readonly k: number;
  readonly m: number;
  readonly deltaC: number;
  readonly skeletonResolutionDeg: number;
  readonly skeletonPaddingDeg: number;

  constructor(
    readonly landMask: LandTest,
    opts: PropagatorOptions = {}
  ) {
    this.K = Math.max(1, Math.floor(opts.stages ?? 20));
    this.k = Math.max(1, Math.floor(opts.subsectors ?? 30));
    this.m = Math.max(1, Math.floor(opts.headings ?? 30));
    this.deltaC = opts.headingIncrementDeg ?? 1.0;
    this.skeletonResolutionDeg = opts.skeletonResolutionDeg ?? 0.005;
    this.skeletonPaddingDeg = opts.skeletonPaddingDeg ?? 1.0;
  }

  /**
   * One route: context (inputs, goals, budget) → skeleton → narrow-passage
   * guide → stage loop → terminal choice → waypoints. Each step is its own
   * module under search/.
   */
  computeRoute(args: ComputeRouteArgs): Route {
    const ctx = buildContext(this, args);
    if (ctx.degenerateRoute) return ctx.degenerateRoute;
    const guide = buildGuide(ctx, buildSkeleton(ctx));
    const { candStepM, budgetDistM } = ctx.budget;
    ctx.progress(
      0,
      guide.kEff,
      `K=${this.K} stages, k=${this.k} subsectors, m=${this.m} headings, step {distance:${candStepM.toFixed(0)}}, budget {distance:${budgetDistM.toFixed(0)}} (straight {distance:${ctx.totalDistM.toFixed(0)}})`
    );
    const stages = runStages(ctx, guide);
    const terminal = chooseTerminal(ctx, guide, stages);
    return assembleRoute(ctx, guide, stages, terminal);
  }
}
