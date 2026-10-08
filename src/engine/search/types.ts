/**
 * Types, constants and errors of the isochrone search.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import type { LandMask } from '../../geo/landmask';
import type { CurrentSource, WindSource } from '../environment';
import type { ModePolicy, SimOptions } from '../legsim';
import type { Route, StageFront } from '../route';
import type { PolarDiagram } from '../../vessel/polar';
import type { VesselParams } from '../../vessel/vessel';
import type { ProgressFn } from '../progress';

export interface PropagatorOptions {
  /** Number of isochrone stages spanning the great-circle distance. */
  stages?: number;
  /** Subsector half-count k (2k bins across the corridor). */
  subsectors?: number;
  /** Heading half-count m (2m+1 candidates per parent). */
  headings?: number;
  /** Heading spacing in degrees. */
  headingIncrementDeg?: number;
  /** Coarse skeleton grid resolution in degrees. */
  skeletonResolutionDeg?: number;
  /** Padding around the leg's bbox for the skeleton grid, degrees. */
  skeletonPaddingDeg?: number;
}

export interface Via {
  lon: number;
  lat: number;
  /** Disc radius the polyline must pass through, metres (> 0). */
  radiusM: number;
  /** Inserted by the router at a narrow passage (not a user waypoint). */
  auto?: boolean;
  /** Passage name for progress messages (auto vias). */
  name?: string;
  /** Passage width, metres (auto vias). */
  widthM?: number;
}

/** Precomputed corridor (engine/corridor.ts). */
export interface CorridorInput {
  skeleton: { lon: number; lat: number }[];
  /** Across-track water width per skeleton point, metres (Infinity = open water). */
  widthM?: ArrayLike<number>;
}

/** Bins across a narrow passage. */
export const NARROW_BINS = 6;
/** Stages in a row without the front coming closer to the destination, straight or along the skeleton (after the planned stages), before the search is called boxed in. */
export const STALL_STAGES = 3;
/** Share of a stage's water candidates dead upwind from which the front counts as beating (stall detection waits for the hard stage ceiling). */
export const BEATING_SHARE = 0.1;
/** Terminal candidates (nearest first) whose final leg is simulated to pick the earliest predicted arrival. */
export const TERMINAL_EVAL = 64;

export interface ComputeRouteArgs {
  start: [number, number];
  end: [number, number];
  departureTime: Date;
  vessel: VesselParams;
  polar?: PolarDiagram | null;
  wind?: WindSource;
  current?: CurrentSource;
  modePolicy?: ModePolicy;
  sailThreshMs?: number;
  simStepM?: number;
  /**
   * Stop as soon as a candidate is within this distance of the end (the
   * reference's arrival_radius_m, rule (a)); the one-stage-step rule (b)
   * always applies as well.
   */
  arrivalRadiusM?: number;
  /**
   * true (default): the route ends exactly on `end` (a straight final leg
   * from the best candidate). false (an approximate intermediate
   * waypoint; needs arrivalRadiusM > 0): the route ends where it enters
   * the arrival circle: at the best candidate when it is inside the
   * circle, else at the point where the straight leg from it towards
   * `end` reaches the circle.
   */
  snapToExact?: boolean;
  vias?: Via[];
  /** Corridor from the global water grid; replaces the internal coarse A* skeleton. */
  corridor?: CorridorInput;
  /** Wind speed (m/s) and significant wave height (m) a leg must not exceed; candidates over them are not allowed. */
  maxWindMs?: number;
  maxSwhM?: number;
  /** Comfort weight (0 or absent: off): the search prefers calmer water, as the boat meets it, at some cost in time (engine/seas.ts). */
  comfortWeight?: number;
  /** The forecast's last valid step (ms); conditions after it are held at that step. Named in a boxed-in search's error. */
  forecastEndMs?: number;
  /** Called after every stage with its front and the best path so far (display only). */
  onFrontier?: (front: StageFront) => void;
  /** Progress callback; messages are short human-readable lines. */
  onProgress?: ProgressFn;
  /** Return true to abort; a RouteCancelled error is thrown. */
  shouldCancel?: () => boolean;
}

export { RouteCancelled, RouteError, ViasNotCrossedError } from '../errors';

export interface Candidate {
  lon: number;
  lat: number;
  timeMs: number;
  elapsedS: number;
  /** The search's cost to here: elapsedS plus the comfort cost of rough water (engine/seas.ts); equals elapsedS without a comfort weight. Used only to compare candidates; times stay real. */
  costS: number;
  parentIdx: number;
  sogMs: number;
  cogDeg: number;
  mode: 'sailing' | 'motoring';
  sailingS: number;
  motoringS: number;
  viaCount: number;
  viaIdxs: number[];
}

/** The propagator's tuning, as OceanPropagator holds it. */
export interface PropagatorParams {
  readonly landMask: LandMask;
  readonly K: number;
  readonly k: number;
  readonly m: number;
  readonly deltaC: number;
  readonly skeletonResolutionDeg: number;
  readonly skeletonPaddingDeg: number;
}

/** Stage sizing: re-sized once to the skeleton's length when that is longer than the straight line. */
export interface Budget {
  budgetDistM: number;
  dtS: number;
  deltaD: number;
  candStepM: number;
}

/**
 * What happened to the candidates of the last proposal: how many were
 * tried, crossed land, were over the wind/wave limit, or were stuck for
 * another reason (no boat speed). For the progress line and the errors.
 */
export interface TryStats {
  tried: number;
  land: number;
  limited: number;
  noGo: number;
  stuck: number;
  latestMs: number;
}

/** Everything one computeRoute call shares between its sections. */
export interface SearchContext extends PropagatorParams {
  args: ComputeRouteArgs;
  wind: WindSource;
  current: CurrentSource;
  polar: PolarDiagram | null;
  vessel: VesselParams;
  modePolicy: ModePolicy;
  simOpts: SimOptions;
  progress: (stage: number, totalStages: number, message: string) => void;
  checkCancel: () => void;
  hasLimit: boolean;
  limitNote: string;
  lastTry: TryStats;
  sLon: number;
  sLat: number;
  eLon: number;
  eLat: number;
  snapToExact: boolean;
  /** Vias then the end (radius 0). */
  goals: Via[];
  nVias: number;
  startViaCount: number;
  totalDistM: number;
  cruise: number;
  budget: Budget;
  fronts: StageFront[];
  /** Set when start and end coincide: the one-waypoint route to return. */
  degenerateRoute?: Route;
}
