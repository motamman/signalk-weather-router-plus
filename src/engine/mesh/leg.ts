/**
 * A leg on the chart mesh, as the leg pipeline uses it: whether the mesh
 * takes the leg, the split of the mesh route into narrow and open-water
 * segments (with a sail threshold of 0 the narrow passages are sailed
 * too), the Route for a stretch walked along the mesh polyline, and the
 * stitching of the segments.
 *
 * The search itself runs wherever the host puts it (the plugin: a child
 * process, so the tile arrays go back to the operating system after the
 * leg); the pipeline only sees MeshLegRouter.
 */

import type { PolarDiagram } from '../../vessel/polar';
import type { VesselParams } from '../../vessel/vessel';
import type { CurrentSource, WindSource } from '../environment';
import { simulateLegTime, type LegSimResult, type SimOptions } from '../legsim';
import type { LegPlan } from '../multileg';
import type { ProgressFn } from '../progress';
import type { PropagatorOptions } from '../propagator';
import type { RouterKind } from '../router';
import type { CorridorInput } from '../search/types';
import { MAX_SCAN_M } from './width';
import { enrichLegRanges, enrichWaypoints } from '../propagator';
import { haversineDistanceM, type BBox } from '../../geo/geodesy';
import type { CellMask } from '../../geo/landmask';
import { recomputePerWaypointMetadata, type Route, type RouteWarning, type Waypoint } from '../route';
import { recomputeTotals } from '../smoother';
import type { DrawbridgeChoice, MeshRules } from './route';

/** What the pipeline hands over for a leg on the mesh (legrun.ts plans it where the mesh is loaded). */
export interface MeshLegArgs {
  plan: LegPlan;
  legIndex: number;
  legStart: [number, number];
  legDeparture: Date;
  tag: string;
  multi: boolean;
  rules: MeshRules;
  vessel: VesselParams;
  polar: PolarDiagram | null;
  sim: SimOptions;
  router?: RouterKind;
  propagator: Omit<PropagatorOptions, 'stages'>;
  stages: number;
  /** RDP tolerance, metres (0 = off); the shortcut smoother and its time tolerance (ratio), as on coastline legs. */
  simplifyM: number;
  smoother: boolean;
  smootherTolerance: number;
  /** The smoother's simulation step, metres (absent: sim.simStepM). */
  smootherSimStepM?: number;
  drawbridges: DrawbridgeChoice;
  bridgeWaitS: number;
  /** The leg's reach on the rough cut (coarse.ts), when the runner gave one: the extent of its water, for the forecast area. */
  reach?: LegReach;
  /** The mesh to plan it on (the runner's id from `plan`); absent: the mesh holding the leg's points. */
  meshId?: string;
  progress: ProgressFn;
  shouldCancel: () => boolean;
}

/**
 * A leg's reach (coarse.ts PieceGraph): the box of the tiles its water runs through, the chains' length (not a search
 * area), and per target after the start (route.ts runTargets) the point an approximate waypoint is aimed at: itself,
 * or the nearest usable water connected to the start; null for an exact one.
 */
export interface LegReach {
  box: BBox;
  lengthM: number;
  aims: ({ lon: number; lat: number; tri: number; movedM: number } | null)[];
}

/**
 * Why the mesh cannot take a leg: no route on the mesh, an end on a blocked
 * triangle, a stretch that cannot be made against the current, no mesh or
 * no forecast for the mesh process. A sentence for the user, without the
 * leg's tag.
 */
export interface MeshRefusal {
  refused: string;
}

export function isRefusal<T extends object>(r: T | MeshRefusal): r is MeshRefusal {
  return (r as MeshRefusal).refused !== undefined;
}

/**
 * The chart mesh for the pipeline: which legs it covers, and the whole leg
 * planned on it (the plugin: in the child process holding the mesh,
 * plugin/meshlegtask.ts; the tests: in-process). A refusal when the mesh
 * cannot take the leg: a leg inside the mesh then fails with that reason
 * (no fallback to the coastline search, the owner's rule of 2026-10-12);
 * the mesh part of a handover leg goes to the coastline search as before.
 */
export interface MeshLegRunner {
  /** Every point lies in the mesh (a tile exists and holds the point). */
  covers(points: [number, number][]): boolean;
  leg(args: MeshLegArgs): Promise<Route | MeshRefusal>;
  /**
   * The reach of a leg inside one mesh, from the rough cut for these rules (built first when missing), through the
   * plan's waypoint circles, or why there is none (an end on water the boat cannot use, no water connecting two of its
   * points). Absent: the forecast area is the box around the leg's points.
   */
  reach?(args: {
    legStart: [number, number];
    plan: LegPlan;
    rules: MeshRules;
    /** The mesh (the runner's id from `plan`); absent: the one holding the leg's points. */
    meshId?: string;
    tag: string;
    progress: ProgressFn;
    shouldCancel: () => boolean;
  }): Promise<LegReach | MeshRefusal>;
  /** Whether any mesh meets the box (from the meshes' indexes alone). */
  meets(box: BBox): boolean;
  /**
   * A leg's way across the limits of the charts (part 5, engine/mesh/waters.ts), for the coastline search's land over
   * `box`: one mesh holds the leg (its id, for `leg`); or open water outside every mesh joins its ends; or the
   * stretches it goes through, each on a mesh (by id) or on open water, with every mesh's water as cells the coastline
   * parts must treat as land; or why there is none. `rules` null: the boat's draught or air draft is not set (`why`).
   */
  plan(args: {
    start: [number, number];
    end: [number, number];
    names: { start: string; end: string };
    rules: MeshRules | null;
    why: string;
    box: BBox;
    tag: string;
    progress: ProgressFn;
    shouldCancel: () => boolean;
  }): Promise<MeshPlan | MeshRefusal>;
  /**
   * Where a leg with one end in a mesh (`inside`) and the other outside every mesh (`outside`) leaves the mesh
   * (part 5, engine/mesh/exit.ts), for the coastline search's land over `box`: the crossing point, and the mesh's
   * water as cells the coastline part must treat as land; or why there is none.
   */
  exit?(args: {
    inside: [number, number];
    outside: [number, number];
    names: { inside: string; outside: string };
    rules: MeshRules;
    box: BBox;
    tag: string;
    progress: ProgressFn;
    shouldCancel: () => boolean;
  }): Promise<{ exit: [number, number]; mask: CellMask } | MeshRefusal>;
  /**
   * Where a leg with its start in one mesh and its end in another changes meshes (part 5 step 2,
   * engine/mesh/transfer.ts): in their overlap, a point both meshes call usable, reached on the start's mesh and
   * connected on the end's to the end; else across the water between them, the start mesh's exit and the end mesh's
   * entry, with both meshes' water as cells the coastline part over `box` must treat as land; or why neither.
   */
  transfer?(args: {
    start: [number, number];
    end: [number, number];
    names: { start: string; end: string };
    rules: MeshRules;
    box: BBox;
    tag: string;
    progress: ProgressFn;
    shouldCancel: () => boolean;
  }): Promise<{ point: [number, number] } | { exit: [number, number]; entry: [number, number]; mask: CellMask } | MeshRefusal>;
}

/** A leg's way across the limits of the charts, as the runner answers it (meshes named by id). */
export type MeshPlan =
  | { kind: 'one-mesh'; mesh: string }
  | { kind: 'open'; mask: CellMask }
  | {
      kind: 'chain';
      stretches: (
        | { kind: 'mesh'; mesh: string; from: [number, number]; to: [number, number] }
        | { kind: 'open'; from: [number, number]; to: [number, number] }
      )[];
      /** Null when the leg stays on the charts (no open stretch). */
      mask: CellMask | null;
    };

/**
 * The mesh route as the open-water search's corridor (the mesh route is
 * the skeleton). Without it the search drew its own coarse skeleton on
 * the coastline, which cut across the tip of Monomoy where the mesh route
 * rounds it (2026-10-08, job 219300ca). The width is the water on both sides of the track from the mesh ray walk;
 * where both sides reached its cap the water counts as open, so the search
 * keeps its open-water freedom to leave the line.
 */
export function meshCorridor(pts: [number, number][], widths: [number, number][]): CorridorInput {
  const widthM = Float64Array.from(widths, ([l, r]) => (l >= MAX_SCAN_M && r >= MAX_SCAN_M ? Infinity : l + r));
  return { skeleton: pts.map(([lon, lat]) => ({ lon, lat })), widthM, source: 'the chart mesh route' };
}

/**
 * The rules the mesh needs from the vessel, or null (with why) when the
 * mesh cannot be used for this leg: its blocking rules need the draught
 * and the air draft.
 */
export function meshRulesFor(vessel: VesselParams): { rules: MeshRules } | { rules: null; why: string } {
  if (vessel.draughtM === null || vessel.airDraftM === null)
    return {
      rules: null,
      why: `the vessel's ${vessel.draughtM === null ? 'draught (Signal K design.draft.maximum' : 'air draft (Signal K design.airHeight'}, or the request's vessel override) is not set`,
    };
  return {
    rules: {
      draughtM: vessel.draughtM,
      airDraftM: vessel.airDraftM,
      motorSpeedMs: vessel.motorSpeedMs,
      underKeelClearanceM: vessel.underKeelClearanceM,
      overheadClearanceM: vessel.overheadClearanceM,
    },
  };
}

export interface MeshSegment {
  type: 'open' | 'constrained';
  /** Indices into the mesh path, inclusive. */
  start: number;
  end: number;
}

/** Both shores within this of the track: a constrained passage. */
export const CONSTRAINED_WIDTH_M = 1000;
/**
 * Track of the other kind before the classification flips. The mesh
 * route's points are the corners the string-pulled path turns at, sparse
 * and uneven, so the hysteresis is by distance, not by a count of points.
 */
const HYSTERESIS_M = 1000;
/** How far a constrained segment reaches back / on through constrained points at its ends. */
const PAD_M = 2000;
/** An open segment shorter than this is motored along the mesh route rather than sailed. */
export const MIN_OPEN_SEGMENT_M = 100;

/**
 * Split a mesh route into constrained and open segments by the water on
 * each side of the track. Constrained only where BOTH sides are within
 * CONSTRAINED_WIDTH_M (one-sided proximity is coastal sailing); a flip
 * needs HYSTERESIS_M of track of the other kind, and the segment boundary
 * sits where that run completes, so a constrained segment takes in the
 * open run-out after it (padding into open water, so the sailing search
 * never starts at a channel mouth) and reaches back over constrained
 * lead-in points up to PAD_M.
 */
export function classifySegments(path: [number, number][], widths: [number, number][], thresholdM = CONSTRAINED_WIDTH_M): MeshSegment[] {
  const n = path.length;
  if (n < 2) return [{ type: 'open', start: 0, end: n - 1 }];
  const constrained = widths.map(([l, r]) => l < thresholdM && r < thresholdM);
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversineDistanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  let current: MeshSegment['type'] = constrained[0] ? 'constrained' : 'open';
  const transitions = [0];
  const types: MeshSegment['type'][] = [current];
  let runStart = -1; // first point of the current run of the other kind
  for (let i = 1; i < n; i++) {
    const want = constrained[i];
    if ((current === 'open') !== want) {
      runStart = -1;
      continue;
    }
    if (runStart < 0) runStart = i;
    if (cum[i] - cum[runStart] < HYSTERESIS_M) continue;
    if (current === 'open') {
      current = 'constrained';
      let at = runStart;
      for (let p = runStart; p > transitions[transitions.length - 1] && cum[runStart] - cum[p] <= PAD_M; p--) {
        if (constrained[p]) at = p;
        else break;
      }
      transitions.push(Math.max(transitions[transitions.length - 1] + 1, at));
      types.push('constrained');
    } else {
      current = 'open';
      let at = i;
      for (let p = i; p < n && cum[p] - cum[i] <= PAD_M; p++) {
        if (constrained[p]) at = p + 1;
        else break;
      }
      transitions.push(Math.min(n - 1, at));
      types.push('open');
    }
    runStart = -1;
  }
  const out: MeshSegment[] = [];
  for (let s = 0; s < transitions.length; s++) {
    const start = transitions[s];
    const end = s + 1 < transitions.length ? transitions[s + 1] : n - 1;
    if (start >= end) continue;
    out.push({ type: types[s], start, end });
  }
  return out.length ? out : [{ type: constrained[0] ? 'constrained' : 'open', start: 0, end: n - 1 }];
}

/** Length of a polyline, metres. */
export function pathLengthM(path: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += haversineDistanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  return d;
}

/**
 * The Route for a mesh polyline walked straight: waypoints timed segment
 * by segment with the leg simulator under `sim` (motor for a narrow
 * passage; the request's own policy for an open stretch the pipeline
 * follows along the mesh), then wind / wave / current enrichment. Null
 * when a segment cannot be made (stuck, or the current cancels the
 * boat's speed), with the simulator's reason in `stuck` when given: the
 * caller falls back to the coastline search, or names the reason. A
 * sail_max stretch is not walked here but laid out with tacks
 * (experimental/propagator.ts sailPolyline).
 */
export function routeFromMeshPath(
  path: [number, number][],
  departure: Date,
  vessel: VesselParams,
  polar: PolarDiagram | null,
  wind: WindSource,
  current: CurrentSource,
  sim: SimOptions,
  stuck?: { reason?: LegSimResult['reason'] }
): Route | null {
  const wps: Waypoint[] = [{ lon: path[0][0], lat: path[0][1], time: departure, sogMs: 0, cogDeg: 0, mode: 'motoring' }];
  let t = departure;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const c = path[i];
    const r = simulateLegTime(a[0], a[1], t, c[0], c[1], vessel, polar, wind, current, sim);
    if (!Number.isFinite(r.seconds)) {
      if (stuck) stuck.reason = r.reason;
      return null;
    }
    t = new Date(t.getTime() + r.seconds * 1000);
    wps.push({ lon: c[0], lat: c[1], time: t, sogMs: 0, cogDeg: 0, mode: r.dominantMode === 'sailing' ? 'sailing' : 'motoring' });
  }
  const route: Route = {
    waypoints: wps,
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
    meshLeg: true,
  };
  enrichWaypoints(wps, wind, current);
  recomputePerWaypointMetadata(route);
  recomputeTotals(route);
  enrichLegRanges(route, wind);
  return route;
}

/**
 * One leg from its segments in order (each starting where the previous
 * ended, at its arrival time): the junction point is kept once, warnings
 * are re-based, stage fronts kept for display, totals recomputed.
 */
export function stitchMeshSegments(parts: Route[], wind: WindSource): Route {
  const waypoints: Waypoint[] = parts[0].waypoints.map(w => ({ ...w }));
  const warnings: RouteWarning[] = (parts[0].warnings ?? []).map(w => ({ ...w }));
  const fronts = parts.flatMap(p => p.fronts ?? []);
  let validated = parts[0].validated;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    let wps = p.waypoints;
    let offset = waypoints.length - 1;
    const last = waypoints[waypoints.length - 1];
    if (wps.length && Math.abs(last.lon - wps[0].lon) < 1e-6 && Math.abs(last.lat - wps[0].lat) < 1e-6) wps = wps.slice(1);
    else offset = waypoints.length;
    for (const w of wps) waypoints.push({ ...w });
    for (const w of p.warnings ?? []) warnings.push({ ...w, leg_index: w.leg_index + offset });
    validated = validated && p.validated;
  }
  const route: Route = { waypoints, totalTimeS: 0, totalDistanceM: 0, motoringTimeS: 0, sailingTimeS: 0, validated, meshLeg: true };
  if (warnings.length) route.warnings = warnings;
  if (fronts.length) route.fronts = fronts;
  const drops = parts.reduce((n, p) => n + (p.smootherDrops ?? 0), 0);
  if (drops) route.smootherDrops = drops;
  recomputePerWaypointMetadata(route);
  recomputeTotals(route);
  enrichLegRanges(route, wind);
  return route;
}
