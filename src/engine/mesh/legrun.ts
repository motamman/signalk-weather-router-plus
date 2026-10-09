/**
 * One leg on the chart mesh, planned where the mesh is loaded: the parent
 * planner's hybrid rule. The mesh route is the skeleton; under motor it is
 * the route; otherwise its narrow passages (both shores within
 * CONSTRAINED_WIDTH_M) are motored along the mesh (sailed when the sail
 * threshold is 0) and each open stretch between them is sailed by the
 * selected router, whose every move is tested against the mesh's blocked
 * triangles (land.ts): charted depth under the draught, clearance under
 * the air draft, hazards, marks, structures, areas to avoid. No copy of
 * the chart, no raster (docs/plans/sailing-search-on-the-mesh.md).
 *
 * The plugin runs this in the child process that holds the mesh
 * (plugin/meshlegtask.ts); the tests run it in-process on small meshes.
 */

import { NoWind, type CurrentSource } from '../environment';
import { ExperimentalPropagator } from '../experimental/propagator';
import { forecastHorizonNote, type LegWind } from '../horizon';
import { enrichLegRanges, enrichWaypoints } from '../propagator';
import { recomputePerWaypointMetadata } from '../route';
import { rdpSimplify, recomputeTotals, revalidateLand, shortcutSmoother } from '../smoother';
import type { ModePolicy, SimOptions } from '../legsim';
import type { LegPlan } from '../multileg';
import { RouteCancelled, type PropagatorOptions } from '../propagator';
import type { ProgressFn } from '../progress';
import { DEFAULT_ROUTER, makeRouter, type RouterKind } from '../router';
import type { Route, StageFront } from '../route';
import type { LandTest } from '../../geo/landmask';
import type { PolarDiagram } from '../../vessel/polar';
import type { VesselParams } from '../../vessel/vessel';
import {
  classifySegments,
  meshCorridor,
  type MeshSegment,
  MIN_OPEN_SEGMENT_M,
  pathLengthM,
  routeFromMeshPath,
  stitchMeshSegments,
} from './leg';
import type { DrawbridgeChoice, MeshRouteResult, MeshRules } from './route';

/** The mesh as the leg's land, plus the charted depth under a point and the opening bridges along a move. */
export interface MeshLegLand extends LandTest {
  depthAt(lon: number, lat: number): number | null;
  openingBridgesAlong(lonA: number, latA: number, lonB: number, latB: number): { lon: number; lat: number; clearM: number | null }[];
}

/** What a mesh leg is planned from, wherever it runs. */
export interface MeshLegInputs {
  /** The mesh search's answer for the leg (route.ts); null when the mesh cannot take it. */
  result: MeshRouteResult;
  /** The mesh as land (land.ts), on the box the search read; null when the search failed. */
  land: MeshLegLand | null;
  plan: LegPlan;
  legStart: [number, number];
  legDeparture: Date;
  /** "leg 2/3 " on a multi-leg route, else "". */
  tag: string;
  multi: boolean;
  rules: MeshRules;
  vessel: VesselParams;
  polar: PolarDiagram | null;
  sim: SimOptions;
  router?: RouterKind;
  propagator: Omit<PropagatorOptions, 'stages'>;
  stages: number;
  simplifyM: number;
  smoother: boolean;
  smootherTolerance: number;
  /** Opening bridges: ask (plan as open, report), open, avoid (the rules already block them). */
  drawbridges: DrawbridgeChoice;
  /** Seconds added at each opening bridge the route passes under. */
  bridgeWaitS: number;
  wind: LegWind | null;
  current: CurrentSource;
  progress: ProgressFn;
  shouldCancel: () => boolean;
  onFrontier?: (front: StageFront) => void;
}

/**
 * The leg on the mesh, or null when the mesh cannot take it (no route,
 * a stretch that cannot be made): the caller logs the reason it was given
 * and routes the leg on the coastline search instead.
 */
export function runMeshLeg(inp: MeshLegInputs): Route | null {
  const { result: res, land, plan, legStart, legDeparture, tag, progress, shouldCancel, stages } = inp;
  const st = res.stats;
  const timing = `${st.trianglesLoaded} triangles read in {time:${(st.readMs + st.prepMs) / 1000}}, ${st.blocked} blocked, search {time:${st.searchMs / 1000}} (${st.expanded} edges)${
    st.attempts > 1
      ? `; the box around the leg's ends widened to {angle:${(st.padDeg * Math.PI) / 180}} after ${st.attempts - 1} search(es) found no route`
      : ''
  }`;
  if (!res.ok || !land) {
    progress(0, 0, `WARNING: ${tag}chart mesh: ${res.ok ? 'no mesh land' : res.reason} (${timing}); using the coastline search instead`);
    return null;
  }
  progress(0, 0, `${tag}chart mesh: {distance:${res.lengthM.toFixed(0)}}, ${res.path.length} points; ${timing}`);
  if (st.bufferM > 0)
    progress(
      0,
      0,
      `${tag}chart mesh: buffer {length:${st.bufferM}} from unusable water: ${st.buffered} more triangles blocked in {time:${st.bufferMs / 1000}}`
    );
  const wind = inp.wind ?? new NoWind();
  const current = inp.current;
  const motor = inp.sim.modePolicy === 'motor';
  // Sail only: sail_max with a threshold of 0 never motors (legsim.ts), so
  // the narrow passages are sailed along the mesh route too (2026-10-08,
  // the owner's decision); above 0 they are motored as the parent does.
  const sailOnly = inp.sim.modePolicy === 'sail_max' && inp.sim.sailThreshMs <= 0 && inp.polar !== null;
  const segs: MeshSegment[] = motor
    ? [{ type: 'constrained', start: 0, end: res.path.length - 1 }]
    : classifySegments(res.path, res.widths);
  if (!motor)
    progress(
      0,
      0,
      `${tag}chart mesh: ${segs.length} segment(s): ${segs.filter(s => s.type === 'constrained').length} narrow (${sailOnly ? 'sailed along the mesh route, the sail threshold being 0' : 'motored along the mesh route'}), ${segs.filter(s => s.type === 'open').length} open water (isochrone search on the mesh)`
    );
  /**
   * A segment along the mesh route itself, under the request's policy: a
   * narrow passage, an open stretch too short to search, or one whose
   * search failed. Under sail_max it is laid out as the refined router
   * lays out its legs (tacks where the wind there and then needs them,
   * each tested against the mesh; motor only below a positive threshold);
   * it fails the route when a stretch cannot be sailed, never motors
   * instead (2026-10-08, job 1c1fda5b: a failed search motored 106 km
   * under a sail threshold of 0). Under fastest the walk picks per step;
   * narrow passages are motored unless the request is sail only.
   */
  const alongMesh = (seg: MeshSegment, pts: [number, number][], at: Date, label: string, lenM: number): Route | null => {
    const sailed = seg.type === 'open' ? inp.sim.modePolicy === 'sail_max' && inp.polar !== null : sailOnly;
    if (sailed) {
      const lay = new ExperimentalPropagator(land, { ...inp.propagator, stages });
      const part = lay.sailPolyline(pts, at, {
        vessel: inp.vessel,
        polar: inp.polar!,
        wind: inp.wind ?? undefined,
        current,
        sim: inp.sim,
        who: label,
        advice: 'raise the sail threshold (Route → Options) so that stretch is motored, or route under motor',
        onProgress: (s: number, tot: number, m: string) => progress(s, tot, `${label}: ${m}`),
      });
      progress(
        0,
        0,
        `${label}: ${seg.type === 'open' ? 'open water' : 'narrow passage'}, sailed along the mesh route: {distance:${lenM.toFixed(0)}}, {time:${part.totalTimeS}} (sailing {time:${part.sailingTimeS}})`
      );
      return part;
    }
    const policy: ModePolicy = seg.type === 'open' && !motor ? inp.sim.modePolicy : 'motor';
    const part = routeFromMeshPath(pts, at, inp.vessel, inp.polar, wind, current, { ...inp.sim, modePolicy: policy });
    if (part && !motor)
      progress(
        0,
        0,
        `${label}: ${seg.type === 'open' ? `open water under ${policy},` : 'narrow passage, motored along the mesh route,'} {distance:${lenM.toFixed(0)}}, {time:${part.totalTimeS}}`
      );
    return part;
  };
  const parts: Route[] = [];
  let at = legDeparture;
  for (let si = 0; si < segs.length; si++) {
    if (shouldCancel()) throw new RouteCancelled();
    const seg = segs[si];
    const pts = res.path.slice(seg.start, seg.end + 1);
    const lenM = pathLengthM(pts);
    const label = `${tag}chart mesh segment ${si + 1}/${segs.length}`;
    let part: Route | null = null;
    if (seg.type === 'open' && lenM >= MIN_OPEN_SEGMENT_M && !motor) {
      const last = seg.end === res.path.length - 1;
      const prop = makeRouter(inp.router ?? DEFAULT_ROUTER, land, { ...inp.propagator, stages });
      try {
        part = prop.computeRoute({
          start: pts[0],
          end: pts[pts.length - 1],
          departureTime: at,
          vessel: inp.vessel,
          polar: inp.polar,
          wind: inp.wind ?? undefined,
          current,
          corridor: meshCorridor(pts, res.widths.slice(seg.start, seg.end + 1)),
          modePolicy: inp.sim.modePolicy,
          sailThreshMs: inp.sim.sailThreshMs,
          maxWindMs: inp.sim.maxWindMs,
          maxSwhM: inp.sim.maxSwhM,
          comfortWeight: inp.sim.comfortWeight,
          tackPenaltyS: inp.sim.tackPenaltyS,
          forecastEndMs: inp.wind ? inp.wind.validRange[1].getTime() : undefined,
          simStepM: inp.sim.simStepM,
          arrivalRadiusM: last ? plan.arrivalRadiusM : undefined,
          snapToExact: last ? plan.snapToExact : true,
          onProgress: (s: number, tot: number, m: string) => progress(s, tot, `${label}: ${m}`),
          onFrontier: inp.onFrontier,
          shouldCancel,
        });
        progress(
          0,
          0,
          `${label}: open water, {distance:${lenM.toFixed(0)}} along the mesh route; the isochrone search made it ${part.waypoints.length} waypoints, {time:${part.totalTimeS}} (sailing {time:${part.sailingTimeS}})`
        );
        // Simplification as on a coastline leg (parent order: RDP, then the
        // shortcut smoother), with the mesh as land so a shortcut is taken
        // only where the mesh allows it. The refined router arrives with the
        // smoother already off (its polish replaces it).
        const nRdp = rdpSimplify(part, land, inp.simplifyM);
        if (nRdp) recomputeTotals(part);
        const nSm = inp.smoother
          ? shortcutSmoother(part, {
              land,
              vessel: inp.vessel,
              polar: inp.polar,
              wind,
              current,
              sim: inp.sim,
              tolerance: inp.smootherTolerance,
            })
          : 0;
        if (nSm) part.smootherDrops = (part.smootherDrops ?? 0) + nSm;
        if (nRdp || nSm) {
          enrichWaypoints(part.waypoints, wind, current);
          recomputePerWaypointMetadata(part);
          revalidateLand(part, land);
          enrichLegRanges(part, wind);
          progress(
            0,
            0,
            `${label}: simplified: ${nRdp} waypoint(s) within {length:${inp.simplifyM}} of a straight line, ${nSm} replaced by straight shortcuts; ${part.waypoints.length} left`
          );
        }
      } catch (err) {
        if (shouldCancel() || err instanceof RouteCancelled) throw new RouteCancelled();
        progress(
          0,
          0,
          `WARNING: ${label}: open water, but the isochrone search failed (${(err as Error).message}); following the mesh route instead under ${inp.sim.modePolicy}`
        );
        part = null;
      }
    }
    if (!part) {
      part = alongMesh(seg, pts, at, label, lenM);
      if (!part) {
        progress(0, 0, `WARNING: ${label}: cannot be made against the current; using the coastline search for the leg instead`);
        return null;
      }
    }
    parts.push(part);
    at = part.waypoints[part.waypoints.length - 1].time;
  }
  const route = parts.length === 1 ? parts[0] : stitchMeshSegments(parts, wind);
  route.meshLeg = true;
  // The charted depth under each waypoint, from the triangle under it.
  let n = 0;
  for (const w of route.waypoints) {
    const d = land.depthAt(w.lon, w.lat);
    if (d !== null) {
      w.depthM = d;
      n++;
    }
  }
  progress(0, 0, `${tag}chart mesh: charted depth under ${n} of ${route.waypoints.length} waypoints`);
  // Opening bridges the route passes under (planned as open): reported, and
  // each costs the wait; under 'avoid' the rules blocked them already.
  if (inp.drawbridges !== 'avoid') {
    const wps = route.waypoints;
    const found: { lon: number; lat: number; clearM: number | null; legIndex: number }[] = [];
    for (let i = 1; i < wps.length; i++)
      for (const b of land.openingBridgesAlong(wps[i - 1].lon, wps[i - 1].lat, wps[i].lon, wps[i].lat)) found.push({ ...b, legIndex: i });
    if (found.length) {
      route.drawbridges = found;
      if (inp.bridgeWaitS > 0) {
        // Each crossing delays everything after it; shifts accumulate along the route.
        let shiftS = 0;
        let k = 0;
        for (let i = 1; i < wps.length; i++) {
          while (k < found.length && found[k].legIndex === i) {
            shiftS += inp.bridgeWaitS;
            k++;
          }
          if (shiftS > 0) wps[i].time = new Date(wps[i].time.getTime() + shiftS * 1000);
        }
        enrichWaypoints(wps, wind, current);
        recomputePerWaypointMetadata(route);
        recomputeTotals(route);
        enrichLegRanges(route, wind);
      }
      const list = found
        .map(
          b =>
            `${b.lat.toFixed(4)}, ${b.lon.toFixed(4)}${b.clearM === null ? ' (open clearance not charted)' : ` (open clearance {length:${b.clearM}})`}`
        )
        .join('; ');
      progress(
        0,
        0,
        `${tag}chart mesh: the route passes under ${found.length} opening bridge(s): ${list}${inp.bridgeWaitS > 0 ? `; {time:${inp.bridgeWaitS}} waited at each` : ''}${inp.drawbridges === 'ask' ? '; re-plan with Drawbridges = Avoid to keep clear of them' : ''}`
      );
    }
  }
  const limited = inp.sim.maxWindMs !== undefined || inp.sim.maxSwhM !== undefined;
  forecastHorizonNote(route, inp.wind, limited, tag, progress);
  void legStart;
  return route;
}
