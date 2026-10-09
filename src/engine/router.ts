/**
 * The open-water router behind the leg pipeline: the one call both
 * pathways answer, `computeRoute(args)` from a start to an end through
 * wind and current. `standard` is the isochrone search (propagator.ts);
 * `refined` (experimental/) is the same search on the convexified polar
 * with the legs laid out afterwards and a cross-track polish, taking the
 * method changes one at a time, so a route can be run both
 * ways on the same request and the difference is the router's alone.
 * Selected per request (`router`), else by the routing.router setting.
 */

import type { LandTest } from '../geo/landmask';
import { ExperimentalPropagator } from './experimental/propagator';
import { OceanPropagator } from './propagator';
import type { Route } from './route';
import type { ComputeRouteArgs, PropagatorOptions } from './search/types';

export const ROUTER_KINDS = ['standard', 'refined'] as const;
export type RouterKind = (typeof ROUTER_KINDS)[number];
export const DEFAULT_ROUTER: RouterKind = 'standard';

export interface OpenWaterRouter {
  computeRoute(args: ComputeRouteArgs): Route;
}

export function makeRouter(kind: RouterKind, land: LandTest, opts: PropagatorOptions): OpenWaterRouter {
  return kind === 'refined' ? new ExperimentalPropagator(land, opts) : new OceanPropagator(land, opts);
}
