/**
 * The open-water router behind the leg pipeline: the one call both
 * pathways answer, `computeRoute(args)` from a start to an end through
 * wind and current. The isochrone search (propagator.ts) is the standard
 * one; the experimental pathway (experimental/) starts as the same thing
 * and takes the method changes one at a time, so a route can be run both
 * ways on the same request and the difference is the router's alone.
 * Selected per request (`router`), else by the routing.router setting.
 */

import type { LandMask } from '../geo/landmask';
import { ExperimentalPropagator } from './experimental/propagator';
import { OceanPropagator } from './propagator';
import type { Route } from './route';
import type { ComputeRouteArgs, PropagatorOptions } from './search/types';

export const ROUTER_KINDS = ['isochrone', 'experimental'] as const;
export type RouterKind = (typeof ROUTER_KINDS)[number];
export const DEFAULT_ROUTER: RouterKind = 'isochrone';

export interface OpenWaterRouter {
  computeRoute(args: ComputeRouteArgs): Route;
}

export function makeRouter(kind: RouterKind, land: LandMask, opts: PropagatorOptions): OpenWaterRouter {
  return kind === 'experimental' ? new ExperimentalPropagator(land, opts) : new OceanPropagator(land, opts);
}
