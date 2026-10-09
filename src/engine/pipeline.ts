/**
 * One leg of a route, from the request's parameters to the finished
 * waypoints: the chart mesh when it covers a motoring leg (engine/mesh),
 * else corridor from the global water grid (or the per-route
 * skeleton inside the box), land mask, the leg's forecast and current
 * areas, the isochrone search with its retry without automatic vias,
 * RDP simplification, the shortcut smoother, re-enrichment and
 * re-validation, the forecast-horizon warning. The route worker and the
 * CLI both run this; what differs between them (where the forecast comes
 * from, how progress is shown) comes in through `LegPipelineInputs`.
 *
 * Extracted from plugin/worker.ts (docs/plans/structural-cleanup.md,
 * phase 3.5); the progress messages are the worker's.
 */

import { HOUR_S, NM_M } from '../geo/units';
import { bboxFromLonLat, bboxHeight, bboxWidth, type BBox } from '../geo/geodesy';
import type { LandMask } from '../geo/landmask';
import type { WaterGrid } from '../geo/watergrid';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';
import { CorridorError, mergeVias, planCorridor, type ChainVia, type Corridor } from './corridor';
import { NoWind, type CurrentSource } from './environment';
import { RouteError } from './errors';
import { forecastHorizonNote, type LegWind } from './horizon';
import type { ModePolicy } from './legsim';
import { findHandover, sliceCorridor, stitchLegParts } from './mesh/handover';
import { type MeshLegRunner, meshRulesFor } from './mesh/leg';
import type { DrawbridgeChoice } from './mesh/route';
import { legLabel, type LegPlan } from './multileg';
import { DEFAULT_ROUTER, makeRouter, type RouterKind } from './router';
import { enrichLegRanges, enrichWaypoints, RouteCancelled, ViasNotCrossedError, type PropagatorOptions } from './propagator';
import type { ProgressFn } from './progress';
import { recomputePerWaypointMetadata, type Route, type StageFront } from './route';
import { rdpSimplify, recomputeTotals, revalidateLand, shortcutSmoother } from './smoother';

export type { LegWind } from './horizon';

export interface LegPipelineInputs {
  /** The global water grid for the corridor search, or null (per-route skeleton inside the box). */
  waterGrid: WaterGrid | null;
  /** The chart mesh, when one is configured: a leg it covers is planned on it (mesh/legrun.ts) instead of the coastline search. */
  mesh?: MeshLegRunner;
  allowCanals: boolean;
  /** The land mask for a box (the corridor's box, or the box around the leg's ends). */
  landFor: (bbox: BBox) => LandMask;
  stages: number;
  propagator: Omit<PropagatorOptions, 'stages'>;
  /** Which open-water router answers the search (engine/router.ts); default the isochrone search. */
  router?: RouterKind;
  vessel: VesselParams;
  polar: PolarDiagram | null;
  sim: {
    modePolicy: ModePolicy;
    sailThreshMs: number;
    simStepM: number;
    maxWindMs?: number;
    maxSwhM?: number;
    comfortWeight?: number;
    tackPenaltyS?: number;
  };
  /** RDP tolerance, metres (0 = off); the shortcut smoother and its time tolerance (ratio). */
  simplifyM: number;
  smoother: boolean;
  smootherTolerance: number;
  /** Load the leg's forecast (and current) areas for the box; the forecast for the leg, or null for calm wind. */
  loadAreas: (bbox: BBox, what: string) => Promise<LegWind | null>;
  /** After a leg of a multi-leg route: the areas go with the leg. */
  releaseAreas?: () => void;
  /** The current source for the leg (after loadAreas), with the names of the stacked sources, or null when there are none. */
  currents: () => { source: CurrentSource; names: string[] | null };
  multi: boolean;
  progress: ProgressFn;
  shouldCancel: () => boolean;
  /** Each stage's front, for display. */
  onFrontier?: (legIndex: number, front: StageFront) => void;
  /** The per-leg summary line of a multi-leg route. */
  log?: (message: string) => void;
  /** Areas to avoid (Signal K notes), for the mesh (the land mask carries them for the coastline search). */
  avoidAreas?: { lon: number; lat: number; radiusM: number }[];
  /** On a mesh leg, keep at least this far from every blocked triangle (metres; 0 or absent: none). */
  meshBufferM?: number;
  /** Keep at least this far from the coastline (metres; 0 or absent: none); the land masks from landFor already keep it, this is for the passage check. */
  landBufferM?: number;
  /** Opening bridges on mesh legs: ask (plan as open, report the ones crossed), open, or avoid; default ask. */
  drawbridges?: DrawbridgeChoice;
  /** Seconds added at each opening bridge passed under (default 0). */
  bridgeWaitS?: number;
}

/**
 * A leg both ends of which the mesh covers: planned on the mesh (the
 * runner: the child process holding it in the plugin, in-process in the
 * tests), with the forecast and current areas loaded here first (the
 * worker fetches on-demand current areas over the network; the mesh
 * process reads only disk). Null when the mesh cannot take the leg: the
 * caller routes it on the coastline search, unchanged.
 */
async function meshLeg(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date,
  tag: string
): Promise<Route | null> {
  const { progress, shouldCancel, multi, stages } = inp;
  const r = meshRulesFor(inp.vessel, plan.vias.length > 0);
  if (!r.rules) {
    progress(0, 0, `${tag}chart mesh covers the leg but is not used: ${r.why}`);
    return null;
  }
  const t = Date.now();
  progress(
    0,
    0,
    `${tag}chart mesh: routing on charted depths (draught {depth:${r.rules.draughtM}}, air draft {length:${r.rules.airDraftM}})`
  );
  const bbox = bboxFromLonLat([legStart[0], plan.end[0]], [legStart[1], plan.end[1]], 0.5);
  await inp.loadAreas(bbox, multi ? `${tag}area` : 'route area');
  const { names: currentNames } = inp.currents();
  if (currentNames && plan.index === 0) progress(0, 0, `currents: ${currentNames.join(' > ')}`);
  let route: Route | null;
  try {
    route = await inp.mesh!.leg({
      plan,
      legIndex,
      legStart,
      legDeparture,
      tag,
      multi,
      rules: {
        ...r.rules,
        avoid: inp.avoidAreas,
        ...(inp.meshBufferM !== undefined ? { bufferM: inp.meshBufferM } : {}),
        openingBridges: (inp.drawbridges ?? 'ask') === 'avoid' ? 'avoid' : 'open',
      },
      vessel: inp.vessel,
      polar: inp.polar,
      sim: inp.sim,
      router: inp.router,
      propagator: inp.propagator,
      stages,
      simplifyM: inp.simplifyM,
      smoother: inp.smoother,
      smootherTolerance: inp.smootherTolerance,
      drawbridges: inp.drawbridges ?? 'ask',
      bridgeWaitS: inp.bridgeWaitS ?? 0,
      progress,
      shouldCancel,
    });
  } catch (err) {
    if (shouldCancel() || err instanceof RouteCancelled) throw new RouteCancelled();
    // A leg that cannot be made as asked (a stretch that cannot be sailed under the policy) fails the route with that reason.
    if (err instanceof RouteError) throw err;
    progress(0, 0, `WARNING: ${tag}chart mesh: the mesh leg failed (${(err as Error).message}); using the coastline search instead`);
    inp.releaseAreas?.();
    return null;
  }
  if (shouldCancel()) throw new RouteCancelled();
  if (!route) {
    inp.releaseAreas?.();
    return null;
  }
  if (multi)
    inp.log?.(
      `${tag}${route.waypoints.length} waypoints, ${(route.totalDistanceM / NM_M).toFixed(1)} nm, ${(route.totalTimeS / HOUR_S).toFixed(1)} h, ${Date.now() - t} ms (chart mesh)`
    );
  if (multi) inp.releaseAreas?.();
  return route;
}

export async function runLegPipeline(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date
): Promise<Route> {
  const { multi } = inp;
  const legEnd = plan.end;
  // A collapsed approximate run passes through its waypoint circles (plan.vias).
  const chain: [number, number][] = [legStart, ...plan.vias.map(v => [v.lon, v.lat] as [number, number]), legEnd];
  const tag = multi ? `${legLabel(plan)} ` : '';
  // The chart mesh first: a leg inside it is routed on charted depths,
  // clearances and obstructions (narrow water motored, open water by the
  // selected router); a leg with one end inside it is routed on the mesh
  // as far as open water and handed over to the coastline search there;
  // anything the mesh cannot take falls through to the coastline search
  // below, unchanged.
  if (inp.mesh) {
    const cs = inp.mesh.covers([legStart]);
    const ce = inp.mesh.covers([legEnd]);
    if (cs && ce) {
      const mr = await meshLeg(inp, plan, legIndex, legStart, legDeparture, tag);
      if (mr) return mr;
    } else if ((cs || ce) && inp.waterGrid && plan.vias.length === 0) {
      const c = corridorFor(inp, chain, tag);
      if (c.corridor) {
        const hr = await meshHandoverLeg(inp, plan, legIndex, legStart, legDeparture, tag, c.corridor, cs ? 'start' : 'end');
        if (hr) return hr;
      }
      return openWaterLeg(inp, plan, legIndex, legStart, legDeparture, tag, c.corridor, c.fallback);
    }
  }
  const c = inp.waterGrid ? corridorFor(inp, chain, tag) : { corridor: null, fallback: false };
  return openWaterLeg(inp, plan, legIndex, legStart, legDeparture, tag, c.corridor, c.fallback);
}

/**
 * A leg with one end inside the mesh: the mesh as far as the handover
 * point (mesh/handover.ts), the coastline search from there with the
 * corridor cut at that point, stitched into one leg. Null when the mesh
 * part cannot be made, so the caller routes the whole leg as today.
 */
async function meshHandoverLeg(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date,
  tag: string,
  corridor: Corridor,
  covered: 'start' | 'end'
): Promise<Route | null> {
  const { progress } = inp;
  const h = findHandover(corridor, covered, inp.mesh!);
  if (!h) {
    progress(
      0,
      0,
      `${tag}chart mesh: the leg leaves the mesh and its ${covered} is already in open water; the coastline search takes the whole leg`
    );
    return null;
  }
  progress(
    0,
    0,
    `${tag}chart mesh: the leg leaves the mesh; its ${covered === 'start' ? 'first' : 'last'} {distance:${h.distanceM.toFixed(0)}} to open water at ${h.point[1].toFixed(4)}, ${h.point[0].toFixed(4)} is routed on the mesh, the rest on the coastline search`
  );
  const exactAt = (end: [number, number]): LegPlan => ({ ...plan, end, snapToExact: true, arrivalRadiusM: undefined });
  if (covered === 'start') {
    const meshPart = await meshLeg(inp, exactAt(h.point), legIndex, legStart, legDeparture, tag);
    if (!meshPart) {
      progress(0, 0, `WARNING: ${tag}chart mesh: no route on the mesh to the handover point; the coastline search takes the whole leg`);
      return null;
    }
    inp.releaseAreas?.();
    const arrive = meshPart.waypoints[meshPart.waypoints.length - 1].time;
    const openPart = await openWaterLeg(inp, plan, legIndex, h.point, arrive, tag, sliceCorridor(corridor, h.index, 'after'), false);
    return stitchLegParts(meshPart, openPart);
  }
  const openPart = await openWaterLeg(
    inp,
    exactAt(h.point),
    legIndex,
    legStart,
    legDeparture,
    tag,
    sliceCorridor(corridor, h.index, 'before'),
    false
  );
  inp.releaseAreas?.();
  const arrive = openPart.waypoints[openPart.waypoints.length - 1].time;
  const meshPart = await meshLeg(inp, plan, legIndex, h.point, arrive, tag);
  if (!meshPart) {
    progress(0, 0, `WARNING: ${tag}chart mesh: no route on the mesh from the handover point; the coastline search takes the whole leg`);
    return openWaterLeg(inp, plan, legIndex, legStart, legDeparture, tag, corridor, false);
  }
  return stitchLegParts(openPart, meshPart);
}

/** The corridor from the global water grid for the chain, or null (with the fallback flag) when its search failed. */
function corridorFor(inp: LegPipelineInputs, chain: [number, number][], tag: string): { corridor: Corridor | null; fallback: boolean } {
  const { progress, shouldCancel, multi, stages } = inp;
  if (!inp.waterGrid) return { corridor: null, fallback: false };
  // Corridor from the global water grid: its box (not the endpoints') sets
  // the land raster, SMOC area and forecast crop.
  let corridor: Corridor | null;
  let corridorFallback = false;
  {
    inp.waterGrid.setCanalsAllowed(inp.allowCanals);
    progress(
      0,
      0,
      `${tag}corridor: searching the global {angle:0.000349066} water grid (canals ${inp.allowCanals ? 'allowed' : 'blocked'})`
    );
    try {
      corridor = planCorridor(inp.waterGrid, chain, {
        landFor: inp.landFor,
        stages,
        onProgress: (_s, _t, m) => progress(0, 0, `${tag}corridor: ${m}`),
        shouldCancel,
      });
      const cst = corridor.stats;
      progress(
        0,
        0,
        `${tag}corridor: {distance:${corridor.lengthM.toFixed(0)}}, A* {time:${cst.astarMs / 1000}} (${cst.expanded} cells), ${cst.refines} local refinement(s), ${cst.reroutes} re-route(s)`
      );
      for (const v of corridor.autoVias) progress(0, 0, `${tag}corridor: auto via at ${v.name}, width {distance:${v.widthM.toFixed(0)}}`);
      // A passage narrower than twice the land buffer cannot be passed with the buffer kept on both sides.
      if (inp.landBufferM && inp.landBufferM > 0) {
        let narrowest = -1;
        for (let i = 0; i < corridor.widthM.length; i++)
          if (corridor.widthM[i] < 2 * inp.landBufferM && (narrowest < 0 || corridor.widthM[i] < corridor.widthM[narrowest])) narrowest = i;
        if (narrowest >= 0) {
          const p = corridor.skeleton[narrowest];
          const via = corridor.autoVias.find(v => v.widthM < 2 * inp.landBufferM!);
          throw new RouteError(
            `the passage ${via ? `at ${via.name}` : `at ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`} is {length:${corridor.widthM[narrowest].toFixed(0)}} wide, narrower than twice the land buffer ({length:${inp.landBufferM}}); lower the buffer (Defaults) or route round it with a waypoint`
          );
        }
      }
    } catch (err) {
      if (shouldCancel()) throw new RouteCancelled();
      if (!(err instanceof CorridorError) || err.fatal) throw err;
      progress(
        0,
        0,
        `WARNING: ${tag}corridor search failed (${err.message}); using the per-route skeleton inside the box around ${multi ? "the leg's ends" : 'start and end'}`
      );
      corridor = null;
      corridorFallback = true;
    }
  }
  return { corridor, fallback: corridorFallback };
}

/**
 * The leg on the coastline search: the corridor's box (or the box around
 * the ends) sets the land raster, the forecast and current areas; the
 * selected router searches; then RDP, the shortcut smoother,
 * re-enrichment and re-validation, and the forecast-horizon warning.
 */
async function openWaterLeg(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date,
  tag: string,
  corridor: Corridor | null,
  corridorFallback: boolean
): Promise<Route> {
  const { progress, shouldCancel, multi, stages } = inp;
  const legEnd = plan.end;
  const chain: [number, number][] = [legStart, ...plan.vias.map(v => [v.lon, v.lat] as [number, number]), legEnd];
  let bbox: BBox;
  if (corridor) {
    bbox = corridor.bbox;
  } else {
    bbox = bboxFromLonLat(
      chain.map(p => p[0]),
      chain.map(p => p[1]),
      1.0
    );
    if (bboxWidth(bbox) > 120 || bboxHeight(bbox) > 90) throw new Error('route bounding box is too large (max 120° × 90°)');
  }
  const land = corridor ? corridor.land : inp.landFor(bbox);
  if (shouldCancel()) throw new RouteCancelled();
  // Forecast and SMOC areas per leg (measured on brain: the same time as
  // one area for all legs, and at most the same memory).
  const legWind = await inp.loadAreas(bbox, multi ? `${tag}area` : 'route area');
  const { source: current, names: currentNames } = inp.currents();
  if (currentNames && plan.index === 0) progress(0, 0, `currents: ${currentNames.join(' > ')}`);

  const prop = makeRouter(inp.router ?? DEFAULT_ROUTER, land, { ...inp.propagator, stages });
  const t = Date.now();
  const vias: ChainVia[] = corridor ? mergeVias(plan.vias, corridor.autoVias) : plan.vias;
  const hasAuto = vias.some(v => v.auto);
  const legArgs = {
    start: legStart,
    end: legEnd,
    departureTime: legDeparture,
    vessel: inp.vessel,
    polar: inp.polar,
    wind: legWind ?? undefined,
    current,
    modePolicy: inp.sim.modePolicy,
    sailThreshMs: inp.sim.sailThreshMs,
    maxWindMs: inp.sim.maxWindMs,
    maxSwhM: inp.sim.maxSwhM,
    comfortWeight: inp.sim.comfortWeight,
    tackPenaltyS: inp.sim.tackPenaltyS,
    forecastEndMs: legWind ? legWind.validRange[1].getTime() : undefined,
    simStepM: inp.sim.simStepM,
    vias: vias.length ? vias : undefined,
    corridor: corridor ? { skeleton: corridor.skeleton, widthM: corridor.widthM } : undefined,
    arrivalRadiusM: plan.arrivalRadiusM,
    snapToExact: plan.snapToExact,
    onProgress: multi ? (st: number, tot: number, m: string) => progress(st, tot, `${tag}${m}`) : progress,
    // Each stage's front, streamed for the web app's display (never stored with the job).
    onFrontier: inp.onFrontier ? (front: StageFront) => inp.onFrontier!(legIndex, front) : undefined,
    shouldCancel,
  };
  let r: Route;
  try {
    r = prop.computeRoute(legArgs);
  } catch (err) {
    // The corridor's automatic vias are only guidance: when the search
    // finds another passage (e.g. The Race instead of the gap past
    // Gardiners Island) no branch crosses them. Retry without them,
    // keeping the waypoint circles of a collapsed run.
    if (!(err instanceof ViasNotCrossedError) || !hasAuto) throw err;
    progress(
      0,
      0,
      `${tag}no branch went through the auto via(s) at ${vias
        .filter(v => v.auto)
        .map(v => v.name ?? 'a narrow passage')
        .join(', ')}; routing again without them`
    );
    r = prop.computeRoute({ ...legArgs, vias: plan.vias.length ? plan.vias : undefined });
  }
  // Simplification (parent order: RDP, then the shortcut smoother).
  const nRdp = rdpSimplify(r, land, inp.simplifyM);
  if (nRdp) recomputeTotals(r);
  const nSm = inp.smoother
    ? shortcutSmoother(r, {
        land,
        vessel: inp.vessel,
        polar: inp.polar,
        wind: legWind ?? new NoWind(),
        current,
        sim: {
          modePolicy: legArgs.modePolicy,
          sailThreshMs: legArgs.sailThreshMs,
          simStepM: legArgs.simStepM,
          maxWindMs: legArgs.maxWindMs,
          maxSwhM: legArgs.maxSwhM,
          comfortWeight: legArgs.comfortWeight,
        },
        tolerance: inp.smootherTolerance,
      })
    : 0;
  if (nSm) r.smootherDrops = nSm;
  if (nRdp || nSm) {
    enrichWaypoints(r.waypoints, legWind ?? new NoWind(), current);
    recomputePerWaypointMetadata(r);
    revalidateLand(r, land);
    progress(
      0,
      0,
      `${tag}simplified: ${nRdp} waypoint(s) within {length:${inp.simplifyM}} of a straight line, ${nSm} replaced by straight shortcuts; ${r.waypoints.length} left`
    );
  }
  // The wind/wave range of each leg, for the briefing cards: a smoothed
  // leg can span many hours, where one end-of-leg sample misleads.
  enrichLegRanges(r, legWind ?? new NoWind());
  forecastHorizonNote(
    r,
    legWind,
    inp.sim.maxWindMs !== undefined || inp.sim.maxSwhM !== undefined,
    inp.multi ? `${legLabel(plan)} ` : '',
    inp.progress
  );
  if (currentNames) r.currentSources = currentNames;
  if (corridorFallback) r.corridorFallback = true;
  if (multi)
    inp.log?.(
      `${tag}${r.waypoints.length} waypoints, ${(r.totalDistanceM / NM_M).toFixed(1)} nm, ${(r.totalTimeS / HOUR_S).toFixed(1)} h, ${Date.now() - t} ms`
    );
  if (multi) inp.releaseAreas?.();
  return r;
}
