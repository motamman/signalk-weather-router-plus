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
import { bboxFromLonLat, bboxHeight, bboxWidth, haversineDistanceM, type BBox } from '../geo/geodesy';
import type { LandMask } from '../geo/landmask';
import type { WaterGrid } from '../geo/watergrid';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';
import { CorridorError, mergeVias, planCorridor, type ChainVia, type Corridor } from './corridor';
import { NoWind, type CurrentSource } from './environment';
import { RouteError } from './errors';
import { forecastHorizonNote, type LegWind } from './horizon';
import type { LimitMode, ModePolicy } from './legsim';
import { stitchLegParts } from './mesh/handover';
import { isRefusal, type LegReach, type MeshLegRunner, type MeshRefusal, meshRulesFor } from './mesh/leg';
import { type DrawbridgeChoice, MESH_BOX_PAD_MAX_DEG, type MeshRules } from './mesh/route';
import { legLabel, type LegPlan } from './multileg';
import { DEFAULT_ROUTER, makeRouter, type RouterKind } from './router';
import { enrichLegRanges, enrichWaypoints, RouteCancelled, ViasNotCrossedError, type PropagatorOptions } from './propagator';
import type { ProgressFn } from './progress';
import { recomputePerWaypointMetadata, type Route, type StageFront } from './route';
import { limitWarnings, rdpSimplify, recomputeTotals, revalidateLand, shortcutSmoother } from './smoother';
import { computeAvoidingLimits } from './limitavoid';

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
    maxWindMode?: LimitMode;
    maxSwhMode?: LimitMode;
    limitAvoidStrength?: number;
    comfortWeight?: number;
    tackPenaltyS?: number;
  };
  /** RDP tolerance, metres (0 = off); the shortcut smoother and its time tolerance (ratio). */
  simplifyM: number;
  smoother: boolean;
  smootherTolerance: number;
  /** The smoother's simulation step, metres (absent: sim.simStepM, the search's). */
  smootherSimStepM?: number;
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
 * process reads only disk). A refusal when the mesh cannot take the leg,
 * with the reason; the caller decides what follows (runLegPipeline).
 */
/** A mesh leg's rules: the boat's, the areas to avoid, the buffer from unusable water, the Drawbridges choice. */
function legMeshRules(inp: LegPipelineInputs, base: MeshRules): MeshRules {
  return {
    ...base,
    avoid: inp.avoidAreas,
    ...(inp.meshBufferM !== undefined ? { bufferM: inp.meshBufferM } : {}),
    openingBridges: (inp.drawbridges ?? 'ask') === 'avoid' ? 'avoid' : 'open',
  };
}

async function meshLeg(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date,
  tag: string,
  /** A leg inside one mesh: its reach on the rough cut, when the runner offers one (part 4); a stretch of a longer leg has none. */
  useReach = false,
  /** The mesh to plan it on (the runner's id from its plan); absent: the one holding the leg's points. */
  meshId?: string
): Promise<Route | MeshRefusal> {
  const { progress, shouldCancel, multi, stages } = inp;
  const r = meshRulesFor(inp.vessel);
  if (!r.rules) {
    progress(0, 0, `${tag}chart mesh covers the leg but is not used: ${r.why}`);
    return { refused: r.why };
  }
  const t = Date.now();
  progress(
    0,
    0,
    `${tag}chart mesh: routing on charted depths (draught {depth:${r.rules.draughtM}}, air draft {length:${r.rules.airDraftM}})`
  );
  const rules = legMeshRules(inp, r.rules);
  // Whether water connects the leg's points for this boat under those rules, where each approximate waypoint is
  // aimed, and the extent of that water (the rough cut, coarse.ts).
  let reach: LegReach | undefined;
  if (useReach && inp.mesh!.reach) {
    const c = await inp.mesh!.reach({
      legStart,
      plan,
      rules,
      ...(meshId ? { meshId } : {}),
      tag,
      progress,
      shouldCancel,
    });
    if (shouldCancel()) throw new RouteCancelled();
    if (isRefusal(c)) return c;
    reach = c;
  }
  // The weather the mesh process reads: it reads the forecast and the
  // currents from this worker's files only, so what is loaded here must
  // cover where the leg can go: the box around its ends
  // (MESH_BOX_PAD_MAX_DEG), and the tiles its water runs through when the
  // rough cut gave them. The search itself has no area (paged.ts).
  const pts: [number, number][] = [legStart, ...plan.vias.map(v => [v.lon, v.lat] as [number, number]), plan.end];
  const ends = bboxFromLonLat(
    pts.map(p => p[0]),
    pts.map(p => p[1]),
    MESH_BOX_PAD_MAX_DEG
  );
  const bbox: BBox = reach
    ? {
        west: Math.min(ends.west, reach.box.west),
        south: Math.min(ends.south, reach.box.south),
        east: Math.max(ends.east, reach.box.east),
        north: Math.max(ends.north, reach.box.north),
      }
    : ends;
  await inp.loadAreas(bbox, multi ? `${tag}area` : 'route area');
  const { names: currentNames } = inp.currents();
  if (currentNames && plan.index === 0) progress(0, 0, `currents: ${currentNames.join(' > ')}`);
  let route: Route | MeshRefusal;
  try {
    route = await inp.mesh!.leg({
      plan,
      legIndex,
      legStart,
      legDeparture,
      tag,
      multi,
      rules,
      vessel: inp.vessel,
      polar: inp.polar,
      sim: inp.sim,
      router: inp.router,
      propagator: inp.propagator,
      stages,
      simplifyM: inp.simplifyM,
      smoother: inp.smoother,
      smootherTolerance: inp.smootherTolerance,
      smootherSimStepM: inp.smootherSimStepM,
      drawbridges: inp.drawbridges ?? 'ask',
      bridgeWaitS: inp.bridgeWaitS ?? 0,
      reach,
      ...(meshId ? { meshId } : {}),
      progress,
      shouldCancel,
    });
  } catch (err) {
    if (shouldCancel() || err instanceof RouteCancelled) throw new RouteCancelled();
    // A leg that cannot be made as asked (a stretch that cannot be sailed under the policy) fails the route with that reason.
    if (err instanceof RouteError) throw err;
    inp.releaseAreas?.();
    return { refused: `the mesh process failed (${(err as Error).message})` };
  }
  if (shouldCancel()) throw new RouteCancelled();
  if (isRefusal(route)) {
    inp.releaseAreas?.();
    return route;
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
  // The chart meshes first (docs/drafts/mesh-no-gshhg-design.md, part 5; the owner's design of 2026-10-13): the mesh
  // decides wherever it has triangles, the coastline search plans only in water outside every mesh, and a leg moves
  // between them only where a mesh's usable water meets the coastline's open water, or where two meshes both call
  // the water usable. Any leg whose area a mesh meets is planned that way (chartsLeg): on one mesh when it holds the
  // leg, else through the waters with the fewest changes between charts and open water. A leg through waypoint
  // circles that one mesh holds is planned on it through them (part 3); one that no one mesh holds, circle by circle
  // (circlesLeg). A leg no mesh comes near is the coastline search's, as before. The worker's final depth check runs
  // on every route either way.
  if (inp.mesh) {
    const box = bboxFromLonLat(
      chain.map(p => p[0]),
      chain.map(p => p[1]),
      1.0
    );
    if (inp.mesh.meets(box)) {
      if (bboxWidth(box) > 120 || bboxHeight(box) > 90) throw new Error('route bounding box is too large (max 120° × 90°)');
      if (plan.vias.length === 0) return chartsLeg(inp, plan, legIndex, legStart, legDeparture, tag, box);
      if (inp.mesh.covers(chain)) {
        const mr = await meshLeg(inp, plan, legIndex, legStart, legDeparture, tag, true);
        if (!isRefusal(mr)) return mr;
        // No tag: the worker names the leg of a multi-leg route on every error (worker/route.ts legOne).
        throw new RouteError(`the chart mesh covers this leg but cannot take it: ${mr.refused}`);
      }
      return circlesLeg(inp, plan, legIndex, legStart, legDeparture);
    }
  }
  const c = inp.waterGrid ? corridorFor(inp, chain, tag) : { corridor: null, fallback: false };
  return openWaterLeg(inp, plan, legIndex, legStart, legDeparture, tag, c.corridor, c.fallback);
}

/**
 * A leg whose area a mesh meets (mesh/waters.ts, through the runner's plan): on one mesh when it holds both ends in
 * one water; on the coastline search with every mesh's water as land when open water joins the ends; else stretch by
 * stretch through the waters with the fewest changes between charts and open water, each mesh stretch on its mesh,
 * each open stretch on the coastline search with every mesh's water as land, joined into one leg. A refusal fails the
 * route with the reason; nothing in charted water goes to the coastline search.
 */
async function chartsLeg(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date,
  tag: string,
  box: BBox
): Promise<Route> {
  const { progress, shouldCancel } = inp;
  const r = meshRulesFor(inp.vessel);
  // Without the draught and air draft a leg in one mesh's water cannot be judged (open water may still join others).
  if (!r.rules && inp.mesh!.covers([legStart, plan.end]))
    throw new RouteError(`the chart mesh covers this leg but cannot take it: ${r.why}`);
  const rules = r.rules ? legMeshRules(inp, r.rules) : null;
  const p = await inp.mesh!.plan({
    start: legStart,
    end: plan.end,
    names: { start: 'the start', end: 'the end' },
    rules,
    why: r.rules ? '' : r.why,
    box,
    tag,
    progress,
    shouldCancel,
  });
  if (shouldCancel()) throw new RouteCancelled();
  if (isRefusal(p)) throw new RouteError(p.refused);
  if (p.kind === 'one-mesh') {
    const mr = await meshLeg(inp, plan, legIndex, legStart, legDeparture, tag, true, p.mesh);
    if (!isRefusal(mr)) return mr;
    // No tag: the worker names the leg of a multi-leg route on every error (worker/route.ts legOne).
    throw new RouteError(`the chart mesh covers this leg but cannot take it: ${mr.refused}`);
  }
  // Every mesh's water is land to the coastline search (a chain on the charts alone has no open stretch, no mask).
  const mask = p.mask;
  const coastal: LegPipelineInputs = { ...inp, landFor: b => (mask ? inp.landFor(b).withExtraLand(mask) : inp.landFor(b)) };
  if (p.kind === 'open') return openWaterLeg(coastal, plan, legIndex, legStart, legDeparture, tag, null, false, box);
  const exactAt = (end: [number, number]): LegPlan => ({ ...plan, end, snapToExact: true, arrivalRadiusM: undefined });
  const where = (q: [number, number]): string => `${q[1].toFixed(4)}, ${q[0].toFixed(4)}`;
  const parts: Route[] = [];
  let at = legDeparture;
  for (let k = 0; k < p.stretches.length; k++) {
    const st = p.stretches[k];
    const sub = k === p.stretches.length - 1 ? plan : exactAt(st.to);
    let part: Route;
    if (st.kind === 'mesh') {
      const mr = await meshLeg(inp, sub, legIndex, st.from, at, tag, false, st.mesh);
      if (isRefusal(mr))
        throw new RouteError(
          `the chart mesh cannot take the leg's stretch on the charts from ${where(st.from)} to ${where(st.to)}: ${mr.refused}`
        );
      part = mr;
    } else part = await openWaterLeg(coastal, sub, legIndex, st.from, at, tag, null, false, box);
    inp.releaseAreas?.();
    parts.push(part);
    at = part.waypoints[part.waypoints.length - 1].time;
  }
  return joinParts(parts);
}

/**
 * A leg through waypoint circles that no one mesh holds: circle by circle, each piece ending where it enters its circle
 * and planned as any leg is (runLegPipeline), the next starting there; the point where it entered each circle is
 * marked as the waypoint.
 */
async function circlesLeg(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date
): Promise<Route> {
  const parts: Route[] = [];
  let from = legStart;
  let at = legDeparture;
  for (let k = 0; k <= plan.vias.length; k++) {
    const v = plan.vias[k];
    const piece: LegPlan = v
      ? { ...plan, vias: [], end: [v.lon, v.lat], arrivalRadiusM: v.radiusM, snapToExact: false }
      : { ...plan, vias: [] };
    const r = await runLegPipeline(inp, piece, legIndex, from, at);
    const last = r.waypoints[r.waypoints.length - 1];
    if (v) last.role = 'via';
    parts.push(r);
    from = [last.lon, last.lat];
    at = last.time;
  }
  return joinParts(parts);
}

/** Parts of one leg, each starting where and when the one before ended, as one Route; its source from theirs. */
function joinParts(parts: Route[]): Route {
  if (parts.length === 1) return parts[0];
  const sources = parts.map(r => r.legSources?.[0] ?? (r.meshLeg ? 'mesh' : 'coastline'));
  const route = parts.slice(1).reduce((a, b) => stitchLegParts(a, b), parts[0]);
  if (sources.some(x => x !== 'coastline')) route.meshLeg = true;
  else delete route.meshLeg;
  route.legSources = [sources.every(x => x === sources[0]) ? sources[0] : 'mixed'];
  return route;
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
          // The qualifying auto via nearest the narrowest point names the passage (within a few km of it; else its position).
          let via: (typeof corridor.autoVias)[number] | undefined;
          let viaD = 5000;
          for (const v of corridor.autoVias) {
            if (!(v.widthM < 2 * inp.landBufferM)) continue;
            const d = haversineDistanceM(v.lon, v.lat, p.lon, p.lat);
            if (d < viaD) {
              viaD = d;
              via = v;
            }
          }
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
  corridorFallback: boolean,
  /** The area, when the caller fixed it (a leg's coastline part beyond the charts: the box its land mask was made for). */
  area?: BBox
): Promise<Route> {
  const { progress, shouldCancel, multi, stages } = inp;
  const legEnd = plan.end;
  const chain: [number, number][] = [legStart, ...plan.vias.map(v => [v.lon, v.lat] as [number, number]), legEnd];
  let bbox: BBox;
  if (corridor) {
    bbox = corridor.bbox;
  } else if (area) {
    bbox = area;
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
    maxWindMode: inp.sim.maxWindMode,
    maxSwhMode: inp.sim.maxSwhMode,
    limitAvoidStrength: inp.sim.limitAvoidStrength,
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
  // Limits set to avoid: the route searched through, compared with the way round (engine/limitavoid.ts).
  const search = (a: typeof legArgs): Route =>
    computeAvoidingLimits(
      x => prop.computeRoute(x),
      a,
      m => progress(0, 0, `${tag}${m}`)
    );
  let r: Route;
  try {
    r = search(legArgs);
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
    r = search({ ...legArgs, vias: plan.vias.length ? plan.vias : undefined });
  }
  // Simplification: RDP, then the shortcut smoother.
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
          simStepM: inp.smootherSimStepM ?? legArgs.simStepM,
          maxWindMs: legArgs.maxWindMs,
          maxSwhM: legArgs.maxSwhM,
          maxWindMode: legArgs.maxWindMode,
          maxSwhMode: legArgs.maxSwhMode,
          limitAvoidStrength: legArgs.limitAvoidStrength,
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
  // Legs over a limit set to avoid, on the route as it now stands.
  limitWarnings(r, {
    vessel: inp.vessel,
    polar: inp.polar,
    wind: legWind ?? new NoWind(),
    current,
    sim: { ...inp.sim, simStepM: legArgs.simStepM },
  });
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
