/**
 * Route worker: one route request, leg by leg (corridor → propagator → smoothing), with its forecast and SMOC areas.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import { HOUR_S, NM_M } from '../../geo/units';
import { validateRouteRequest } from '../request_schema';
import { runLegPipeline, type LegPipelineInputs, type LegWind } from '../../engine/pipeline';
import * as path from 'node:path';
import { ForecastStore } from '../../data/forecast';
import { loadForecastForBBox, resolveCycle } from '../../data/loader';
import type { WindowOptions } from '../../data/decoded';
import { REGIONAL_DIR } from '../../data/regionaldecode';
import { LayeredWind, type RegionalWind } from '../../engine/layeredwind';
import { checkRouteForecastMemory } from '../memguard';
import { type BBox, bboxFromLonLat, bboxHeight, bboxWidth, haversineDistanceM } from '../../geo/geodesy';
import { LandMask } from '../../geo/landmask';
import { releaseMemory } from '../../util/gc';
import { NoCurrent } from '../../engine/environment';
import { RouteCancelled } from '../../engine/propagator';
import { RouteError } from '../../engine/errors';
import { nearestExactWater, waterAround } from '../../engine/corridor';
import { DEFAULT_ARRIVAL_RADIUS_M, DEFAULT_PRECISION, legLabel, type LegPlan, routeMultiLeg, type Stop } from '../../engine/multileg';
import type { Route, StageFront, StopSnap } from '../../engine/route';
import { routeToGeoJSON, routeToSignalKRoute, skeletonToGeoJSON } from '../routeformat';
import { PolarDiagram } from '../../vessel/polar';
import { loadPolarCached, resolvePolarPath } from '../polars';

import { type ResolvedConfig, routeVessel, type SelfDesign } from '../config';
import { type RouteRequest, type RouteSummary } from '../protocol';
import { requireInit } from './state';
import { extraParams, readWindow, releaseWindow } from './forecast';
import { landMaskFor } from './landgrid';
import { rebuildStack } from './currents';
import { GLOBAL_DLON_DEG } from './regional';
import { avoidAt, type AvoidArea } from '../../geo/avoid';
import type { WorkerState } from './state';
import { MeshStore } from '../../engine/mesh/store';
import { meshCovers } from '../../engine/mesh/route';
import type { MeshLegArgs, MeshLegRunner } from '../../engine/mesh/leg';
import { runChildTask } from '../childtask';
import type { MeshLegTask } from '../meshlegtask';
import { regionalRunsFor } from './regionalwind';
import { smocSettings } from './currents';
import { localMeshes, readyMeshDirs } from '../meshes';
import { beamFor, DEFAULT_SEARCH } from '../../engine/search/presets';

/**
 * The chart meshes for this route, or undefined when there are none: the
 * downloaded ones with a complete marker under the store directory
 * (plugin/meshes.ts; a multi-cluster mesh is one store per cluster) and
 * the folder configured by hand. Only each mesh's index (one small JSON)
 * is read here; a leg is covered when one mesh covers all its points, and
 * that leg is planned whole in a child process holding that mesh
 * (plugin/meshlegtask.ts), which exits with the leg, so its tile arrays
 * never stay in this worker. The child reads the forecast, the currents
 * and the regional runs from this worker's files; this worker has already
 * fetched what needed the network (loadAreas) before the leg starts.
 */
function meshLegRunner(
  st: WorkerState,
  cfg: ResolvedConfig,
  id: string,
  request: RouteRequest,
  progress: (m: string) => void
): MeshLegRunner | undefined {
  const stores: { name: string; dir: string; store: MeshStore }[] = [];
  const open = (name: string, dir: string): void => {
    try {
      stores.push({ name, dir, store: MeshStore.open(dir) });
    } catch (err) {
      progress(`WARNING: chart mesh ${name} not used: ${(err as Error).message}`);
    }
  };
  if (cfg.mesh.storeDir)
    for (const m of readyMeshDirs(cfg.mesh.storeDir)) {
      if (cfg.mesh.disabled.includes(m.name)) continue; // downloaded but switched off in the config
      for (const d of m.dirs) open(m.name, d);
    }
  // The folder managed by hand: one mesh, or a folder of them; the same Use switch applies.
  for (const m of localMeshes(cfg.meshDir)) {
    if (cfg.mesh.disabled.includes(m.name)) continue;
    for (const d of m.dirs) open(m.name, d);
  }
  if (!stores.length) return undefined;
  const meshFor = (points: [number, number][]): (typeof stores)[number] | undefined => stores.find(s => meshCovers(s.store, points));
  const useForecast = !request.no_forecast && request.mode !== 'motor';
  return {
    covers: points => meshFor(points) !== undefined,
    leg: async (a: MeshLegArgs) => {
      // The child reads the forecast from the decoded run's files; without one it would plan the leg with no wind.
      if (useForecast && !st.run) {
        a.progress(
          0,
          0,
          `WARNING: ${a.tag}chart mesh: no decoded forecast run yet for the mesh process to read; using the coastline search instead`
        );
        return null;
      }
      const m = meshFor([a.legStart]) ?? meshFor([a.plan.end]);
      if (!m) {
        a.progress(0, 0, `WARNING: ${a.tag}chart mesh: no mesh covers the leg; using the coastline search instead`);
        return null;
      }
      a.progress(0, 0, `${a.tag}chart mesh: ${m.name}`);
      const bbox = bboxFromLonLat([a.legStart[0], a.plan.end[0]], [a.legStart[1], a.plan.end[1]], 0.5);
      const task: MeshLegTask = {
        task: 'mesh-leg',
        dir: m.dir,
        plan: a.plan,
        legIndex: a.legIndex,
        legStart: a.legStart,
        legDepartureMs: a.legDeparture.getTime(),
        tag: a.tag,
        multi: a.multi,
        rules: a.rules,
        vessel: a.vessel,
        polar: a.polar ? { twa: Array.from(a.polar.twa), tws: Array.from(a.polar.tws), speeds: Array.from(a.polar.speeds) } : null,
        sim: a.sim,
        router: a.router,
        propagator: a.propagator,
        stages: a.stages,
        simplifyM: a.simplifyM,
        smoother: a.smoother,
        smootherTolerance: a.smootherTolerance,
        drawbridges: a.drawbridges,
        bridgeWaitS: a.bridgeWaitS,
        forecast: useForecast ? { runDir: st.run!.dir, area: expandBBox(bbox, ROUTE_FORECAST_MARGIN_DEG), params: ROUTE_PARAMS } : null,
        regional:
          useForecast && request.wind_model !== 'ecmwf'
            ? { root: path.join(st.cacheRoot, REGIONAL_DIR), globalDLon: st.run?.index.grid.dLon ?? GLOBAL_DLON_DEG }
            : null,
        currents: request.no_currents
          ? null
          : {
              smoc:
                st.smoc && cfg.currents.smocEnabled
                  ? { cacheDir: path.join(st.cacheRoot, 'smoc'), run: st.smoc.run, settings: smocSettings(cfg) }
                  : null,
              rtofs:
                st.rtofs && cfg.currents.rtofsEnabled
                  ? {
                      cacheDir: st.rtofsClient?.cacheDir ?? path.join(st.cacheRoot, 'rtofs'),
                      region: cfg.currents.rtofsRegion,
                      runMs: st.rtofs.runMs,
                      horizonS: cfg.currents.rtofsHorizonS,
                      stepS: cfg.currents.rtofsStepS,
                    }
                  : null,
              harmonicDir: cfg.currents.harmonicDir,
            },
      };
      // Cancel: the worker's flag, polled; aborting kills the child.
      const ac = new AbortController();
      const poll = setInterval(() => {
        if (a.shouldCancel()) ac.abort();
      }, 500);
      try {
        const r = await runChildTask(task, 15 * 60_000, ac.signal, e => {
          if (e.event === 'progress') a.progress(e.stage, e.total, e.message);
          else st.send({ type: 'frontier', id, leg: a.legIndex, ...compactFront(e.front) });
        });
        if (!r.ok) {
          if (r.fatal) throw new RouteError(r.reason);
          a.progress(0, 0, `WARNING: ${a.tag}chart mesh: ${r.reason}; using the coastline search instead`);
          return null;
        }
        return r.route;
      } finally {
        clearInterval(poll);
      }
    },
  };
}

/** The request as the API validated it; a job that slipped past (another caller) is refused the same way. */
export function validateRequest(r: RouteRequest): void {
  const err = validateRouteRequest(r);
  if (err) throw new Error(err);
}

/** A stage front as sent: points [lon, lat, timeMs, viaCount], best [lon, lat]. */
export function compactFront(f: StageFront): { stage: number; total: number; points: number[][]; best: number[][] } {
  return { stage: f.stage, total: f.totalStages, points: f.points.map(p => [p.lon, p.lat, p.timeMs, p.viaCount]), best: f.best };
}

/** Fields the engine samples: wind (at, atMany) and waves (wavesAt). */
const ROUTE_PARAMS = ['10u', '10v', 'swh', 'mwp', 'mwd'];

/**
 * Degrees added around the corridor box for the route's forecast area.
 * The engine can sample outside the land raster's box (outside it is
 * water to the land test); inside this margin every sample is exactly
 * the global forecast's value, beyond it the value of the area's edge.
 */
const ROUTE_FORECAST_MARGIN_DEG = 5;

export async function route(
  st: WorkerState,
  id: string,
  request: RouteRequest,
  avoidAreas: AvoidArea[] = [],
  self?: SelfDesign
): Promise<void> {
  const { config: cfg, client: cl } = requireInit(st);
  Atomics.store(st.cancelFlag, 0, 0);
  const shouldCancel = (): boolean => Atomics.load(st.cancelFlag, 0) === 1;
  const progress = (stage: number, total: number, message: string): void => st.send({ type: 'progress', id, stage, total, message });
  try {
    validateRequest(request);
    const start: [number, number] = [request.start.lon, request.start.lat];
    const end: [number, number] = [request.end.lon, request.end.lat];
    // Waypoints are leg ends (engine/multileg.ts): each leg is its own route.
    const stops: Stop[] = [
      { lon: start[0], lat: start[1] },
      ...(request.waypoints ?? []).map(w => ({ lon: w.lon, lat: w.lat, radiusM: w.radius_m })),
      { lon: end[0], lat: end[1] },
    ];
    const multi = stops.length > 2;
    // Search accuracy: the preset's beam, or the routing settings; an explicit stages in the request still wins.
    const search = request.search ?? DEFAULT_SEARCH;
    const beam = beamFor(search, {
      stages: cfg.routing.stages,
      subsectors: cfg.routing.subsectors,
      headings: cfg.routing.headings,
      headingIncrementDeg: cfg.routing.headingIncrementDeg,
    });
    const stages = request.stages ?? beam.stages;
    if (search !== 'normal')
      progress(
        0,
        0,
        `search: ${search} (stages ${stages}, ${beam.subsectors} cross-track bins, ${2 * beam.headings + 1} headings at {angle:${beam.headingIncrementDeg * (Math.PI / 180)}})`
      );
    // Areas to avoid marked on Signal K notes: land to the search. A route
    // point inside one cannot be reached, so it is an error that names both.
    const avoid = request.avoid_areas === false ? [] : avoidAreas;
    if (avoid.length) {
      progress(
        0,
        0,
        `avoid areas: ${avoid.length} marked on Signal K notes, treated as land (${avoid.map(a => `"${a.title}" {distance:${a.radiusM}}`).join(', ')})`
      );
      for (let i = 0; i < stops.length; i++) {
        const a = avoidAt(avoid, stops[i].lon, stops[i].lat);
        if (!a) continue;
        const who =
          i === 0
            ? 'The start point'
            : i === stops.length - 1
              ? 'The destination'
              : `Your point ${i + 1} of ${stops.length} (waypoint ${i})`;
        throw new Error(
          `${who} is inside the area to avoid "${a.title}" (a Signal K note, radius {distance:${a.radiusM}}); move it out, or turn off Avoid marked areas`
        );
      }
    }
    // A point on land according to the exact coastline polygons (a drawn
    // point a few metres inside the shore, a pier), or closer than
    // SNAP_CLEAR_M to the shore, is moved to the nearest point with that
    // much water around it, within SNAP_MAX_M, and reported in the log and
    // in the route (the original stays beside the anchor). The clearance
    // matters: the search tests legs against a land raster whose finest
    // cell is 0.0005° (about 55 m), so a point 50 m off the shore sits in
    // a land cell and no final leg to it is ever clear (job 6ea0c875, the
    // East River: "boxed in … 0 km from the destination"). Further than
    // SNAP_MAX_M is an error that names the point.
    const snaps: StopSnap[] = [];
    {
      const SNAP_MAX_M = 1000;
      // The land buffer, when larger, is the clearance a start or end needs (it could not leave otherwise).
      const SNAP_CLEAR_M = Math.max(150, cfg.routing.landBufferM);
      const label = (i: number): string =>
        i === 0 ? 'the start point' : i === stops.length - 1 ? 'the destination' : `your point ${i + 1} of ${stops.length} (waypoint ${i})`;
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        // Only the polygons near this stop (0.02° ≈ 2 km covers SNAP_MAX_M +
        // SNAP_CLEAR_M): one box over every stop would decode the coastline
        // of the whole route, both coasts of an ocean for a crossing. The
        // raster is coarse because only the polygons matter here.
        const land = LandMask.fromShapefiles(cfg.landShapefiles, bboxFromLonLat([s.lon], [s.lat], 0.02), { resolutionDeg: 0.05 });
        if (!land.hasPolygons || waterAround(land, s.lon, s.lat, SNAP_CLEAR_M)) continue;
        // Quantities as unit tokens ({length:…}): the web app writes them in its user's units.
        const why = land.isLandExact(s.lon, s.lat) ? 'is on land' : `is within {length:${SNAP_CLEAR_M}} of the shore`;
        const near = nearestExactWater(land, s.lon, s.lat, SNAP_MAX_M, SNAP_CLEAR_M);
        if (!near) {
          throw new Error(
            `${label(i)}, at ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}, ${why} according to the coastline data, with no open water ({length:${SNAP_CLEAR_M}} clear of the shore) within {length:${SNAP_MAX_M}}; move it into open water`
          );
        }
        const d = haversineDistanceM(s.lon, s.lat, near[0], near[1]);
        snaps.push({ index: i, original: [s.lon, s.lat], anchor: [near[0], near[1]], distanceM: d });
        stops[i] = { ...s, lon: near[0], lat: near[1] };
        progress(
          0,
          0,
          `${label(i)} ${why} according to the coastline data; moved {length:${d.toFixed(0)}} to open water at ${near[1].toFixed(4)}, ${near[0].toFixed(4)} (route points keep {length:${SNAP_CLEAR_M}} of water around them)`
        );
      }
      if (snaps.length) {
        start[0] = stops[0].lon;
        start[1] = stops[0].lat;
        end[0] = stops[stops.length - 1].lon;
        end[1] = stops[stops.length - 1].lat;
      }
    }

    const vessel = routeVessel(cfg, request.vessel, self);
    // Per-route polar: a library token from GET /api/polars, else the configured default.
    let routePolar: PolarDiagram | null = st.polar;
    let polarLabel: string | null = cfg.polarFile ? path.basename(cfg.polarFile) : null;
    if (request.vessel?.polar) {
      const file = resolvePolarPath(
        { polarFile: cfg.polarFile, polarsDir: cfg.polarsDir, userDir: cfg.polarUserDir },
        request.vessel.polar
      );
      if (file) {
        routePolar = loadPolarCached(file);
        polarLabel = path.basename(file);
        st.log('info', `job ${id}: polar ${polarLabel} (${routePolar.twa.length} TWA × ${routePolar.tws.length} TWS)`);
      }
    }
    if (routePolar && vessel.polarPerformance !== 1) {
      routePolar = routePolar.scaled(vessel.polarPerformance);
      st.log('info', `job ${id}: polar performance ${(vessel.polarPerformance * 100).toFixed(0)}%`);
    }
    if (routePolar && cfg.routing.noGoMinAngleDeg > 0) {
      const floored = routePolar.withNoGoFloor(cfg.routing.noGoMinAngleDeg);
      if (floored !== routePolar) {
        routePolar = floored;
        progress(
          0,
          0,
          `polar: rows closer than {angle:${cfg.routing.noGoMinAngleDeg * (Math.PI / 180)}} to the wind ignored (tightest sailable angle, Defaults)`
        );
      }
    }
    const departureMs = request.departure ? Date.parse(request.departure) : Date.now();
    const useForecast = !request.no_forecast && request.mode !== 'motor';
    if (request.mode !== 'motor' && request.no_forecast) progress(0, 0, 'no_forecast set: routing with calm wind');
    let wind: ForecastStore | null = null;
    let cycleLabel: string | undefined;
    // Regional wind (signalk-grib-downloader runs decoded by the data
    // worker), layered over ECMWF; counted for the log and the summary.
    const layers: LayeredWind[] = [];
    const regionalNames = new Map<string, string>();
    const loadRegional = async (area: BBox, what: string): Promise<RegionalWind[]> => {
      if (request.wind_model === 'ecmwf') return [];
      const out: RegionalWind[] = [];
      for (const r of regionalRunsFor(
        path.join(st.cacheRoot, REGIONAL_DIR),
        area,
        departureMs,
        st.run?.index.grid.dLon ?? GLOBAL_DLON_DEG
      )) {
        const { name, run, grid: g, firstMs, lastMs } = r;
        const steps = run.index.steps;
        const opts: WindowOptions = { bbox: area, params: ['10u', '10v'], marginCells: 1 };
        const need = run.windowBytes(opts);
        if (need <= 0) {
          // The overlap check passed but the grid has no cells in the area (an edge case): skip, never fail the route.
          progress(0, 0, `regional wind ${name}: no grid cells in the ${what}, not used`);
          continue;
        }
        const mem = checkRouteForecastMemory(need, cfg.forecast.memoryHeadroomBytes);
        if (!mem.ok) {
          progress(0, 0, `WARNING: regional wind ${name} not used for the ${what}: ${mem.message}`);
          continue;
        }
        const t0 = Date.now();
        const store = await run.window(opts);
        st.forecastMemory.heldBytes += store.bytes();
        st.routeRegional.push(store);
        regionalNames.set(name, `${name} run ${run.index.cycle.slice(0, 8)} ${run.index.cycle.slice(8)}Z`);
        out.push({ name, wind: store, grid: g, firstMs, lastMs });
        progress(
          0,
          0,
          `regional wind: ${name} (run ${run.index.cycle}, grid {angle:${g.dLon * (Math.PI / 180)}}, {time:${steps[0].stepHours * 3600}} to {time:${steps[steps.length - 1].stepHours * 3600}} after the run) for the ${what}: {dataSize:${store.bytes()}} in {time:${(Date.now() - t0) / 1000}}; layered over ECMWF where it covers the point and time`
        );
      }
      return out;
    };
    const releaseRegional = (): void => {
      for (const s2 of st.routeRegional) releaseWindow(st, s2);
      st.routeRegional = [];
    };

    // Forecast area and SMOC area for a box, held until releaseAreas().
    const loadAreas = async (bbox: BBox, what: string): Promise<LegWind | null> => {
      if (useForecast) {
        // The route area of the forecast: the corridor box plus a margin, the
        // fields the engine reads, every step. Held only while this route runs.
        const area = expandBBox(bbox, ROUTE_FORECAST_MARGIN_DEG);
        if (st.run) {
          const opts: WindowOptions = { bbox: area, params: ROUTE_PARAMS, marginCells: 1 };
          const need = st.run.windowBytes(opts);
          const mem = checkRouteForecastMemory(need, cfg.forecast.memoryHeadroomBytes);
          if (!mem.ok) throw new Error(mem.message);
          const t0 = Date.now();
          const store = await readWindow(st, `job ${id} ${what}`, opts);
          st.routeWindow = store;
          st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
          progress(
            0,
            0,
            `forecast: read the ${what} ({angle:${bboxWidth(area) * (Math.PI / 180)}} × {angle:${bboxHeight(area) * (Math.PI / 180)}}, ${store.steps.length} steps, ${store.meta.params.join('/')}) from the decoded run: {dataSize:${store.bytes()}} in {time:${(Date.now() - t0) / 1000}}`
          );
          wind = store;
        } else {
          // No decoded run yet (first boot, the data worker is still decoding).
          progress(0, 0, 'no decoded forecast run yet; decoding a route-specific forecast crop from the GRIB disk cache');
          const cycle = (
            await resolveCycle(cl, cfg.forecast.horizonS, {
              extraAtmParams: extraParams(cfg),
              log: m => st.log('info', `job ${id} forecast: ${m}`),
            })
          ).cycle;
          const store = await loadForecastForBBox(cl, area, {
            horizonS: cfg.forecast.horizonS,
            cycle,
            extraAtmParams: extraParams(cfg),
            shouldCancel,
            log: m => st.log('debug', `job ${id} forecast: ${m}`),
          });
          st.forecastMemory.heldBytes += store.bytes();
          st.routeWindow = store;
          st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
          wind = store;
        }
        cycleLabel = wind.meta.cycleTime.toISOString();
      }
      if (st.smoc && !request.no_currents) {
        // SMOC for the box over the currents window from departure, if the resident area does not cover it.
        const src = st.smoc;
        const steps = src.stepsBetween(departureMs, Math.max(departureMs, Date.now() + src.settings.horizonS * 1000));
        if (steps.length) {
          progress(0, 0, `currents: checking CMEMS SMOC coverage of the ${what}`);
          try {
            await src.ensure(bbox, steps, { reason: `job ${id} ${what}`, shouldCancel });
          } catch (err) {
            if (shouldCancel()) throw new RouteCancelled();
            progress(
              0,
              0,
              `WARNING: CMEMS SMOC not loaded for the ${what} (${(err as Error).message}); lower-priority current sources are used there`
            );
          }
          rebuildStack(st);
        }
      }
      if (shouldCancel()) throw new RouteCancelled();
      if (!wind) return null;
      const regional = await loadRegional(expandBBox(bbox, ROUTE_FORECAST_MARGIN_DEG), what);
      if (!regional.length) return wind;
      const layered = new LayeredWind(wind, regional);
      layers.push(layered);
      return layered;
    };
    const releaseAreas = (): void => {
      if (st.routeWindow) {
        releaseWindow(st, st.routeWindow);
        st.routeWindow = null;
      }
      releaseRegional();
      wind = null;
      if (st.smoc) st.smoc.trimOnDemand(0);
      rebuildStack(st);
      releaseMemory();
      st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
    };

    const legOne = async (plan: LegPlan, legStart: [number, number], legDeparture: Date): Promise<Route> => {
      try {
        return await legRoute(plan, legStart, legDeparture);
      } catch (err) {
        if (multi && err instanceof Error && !(err instanceof RouteCancelled) && !shouldCancel())
          err.message = `${legLabel(plan)}: ${err.message}`;
        throw err;
      }
    };
    let legCounter = 0;
    const router = request.router ?? cfg.routing.router;
    if (router !== 'standard')
      progress(0, 0, `router: ${router} (the search on the convexified polar, legs laid out afterwards, cross-track polish)`);
    const pipeline: LegPipelineInputs = {
      waterGrid: st.waterGrid,
      router,
      mesh: meshLegRunner(st, cfg, id, request, m => progress(0, 0, m)),
      avoidAreas: avoid.map(a => ({ lon: a.lon, lat: a.lat, radiusM: a.radiusM })),
      meshBufferM: cfg.routing.navigableBufferM,
      drawbridges: request.drawbridges ?? cfg.routing.drawbridges,
      bridgeWaitS: cfg.routing.bridgeWaitS,
      allowCanals: cfg.routing.allowCanals,
      landFor: b =>
        landMaskFor(st, b, cfg.routing.landRasterMaxCells, cfg.landShapefiles).withBuffer(cfg.routing.landBufferM).withAvoid(avoid),
      landBufferM: cfg.routing.landBufferM,
      stages,
      propagator: {
        subsectors: beam.subsectors,
        headings: beam.headings,
        headingIncrementDeg: beam.headingIncrementDeg,
      },
      vessel,
      polar: routePolar,
      sim: {
        modePolicy: request.mode ?? 'sail_max',
        sailThreshMs: request.sail_thresh_ms ?? cfg.routing.sailThreshMs,
        simStepM: cfg.routing.simStepM,
        maxWindMs: request.max_wind_ms ?? cfg.routing.maxWindMs ?? undefined,
        maxSwhM: request.max_swh_m ?? cfg.routing.maxSwhM ?? undefined,
        comfortWeight: request.comfort_weight ?? cfg.routing.comfortWeight,
        tackPenaltyS: cfg.routing.tackPenaltyS,
      },
      simplifyM: request.simplify_m ?? cfg.routing.simplifyM,
      // Both routers (the owner's decision, 2026-10-08): the smoother times every shortcut with the real polar, so two laid-out tacks become one straight leg only where that course is sailable within the tolerance.
      smoother: request.smoother ?? cfg.routing.smoother,
      smootherTolerance: request.smoother_tolerance ?? cfg.routing.smootherTolerance,
      loadAreas,
      releaseAreas,
      currents: () =>
        request.no_currents || st.stack.isEmpty
          ? { source: new NoCurrent(), names: null }
          : { source: st.stack, names: st.stack.sources.map(s => s.name) },
      multi,
      progress,
      shouldCancel,
      // Each stage's front, streamed for the web app's display (never stored with the job).
      onFrontier: (leg, front) => st.send({ type: 'frontier', id, leg, ...compactFront(front) }),
      log: m => st.log('info', `job ${id}: ${m}`),
    };
    const legRoute = (plan: LegPlan, legStart: [number, number], legDeparture: Date): Promise<Route> =>
      runLegPipeline(pipeline, plan, legCounter++, legStart, legDeparture);

    const t = Date.now();
    const result = await routeMultiLeg({
      stops,
      departureTime: new Date(departureMs),
      precision: request.precision,
      arrivalRadiusM: request.arrival_radius_m,
      runLeg: legOne,
      onProgress: progress,
    });
    if (cycleLabel) result.forecastCycle = cycleLabel;
    if (snaps.length) result.snaps = snaps;
    // Which model answered the wind, over every leg's samples.
    let regionalWind: { name: string; run: string; share: number }[] | undefined;
    if (layers.length) {
      let samples = 0;
      const answered = new Map<string, number>();
      for (const l of layers) {
        const t = l.tally();
        samples += t.samples;
        for (const [k, v] of Object.entries(t.answered)) answered.set(k, (answered.get(k) ?? 0) + v);
      }
      regionalWind = [...answered].map(([name, n]) => ({ name, run: regionalNames.get(name) ?? name, share: samples ? n / samples : 0 }));
      const parts = regionalWind.map(r => `${r.run} {percentage:${r.share.toFixed(3)}}`);
      const rest = 1 - regionalWind.reduce((a2, r) => a2 + r.share, 0);
      progress(
        0,
        0,
        `wind: ${parts.join(', ')}, ECMWF {percentage:${rest.toFixed(3)}} of the wind samples the search took (regional where it covers the point and time, blended at its border and over its last hours)`
      );
    }
    // What the route was asked for, so a client can keep its waypoint pins
    // where the user put them (the route's own via points are where it
    // entered each circle) and draw the circles.
    const precision = request.precision ?? DEFAULT_PRECISION;
    const defaultRadius = request.arrival_radius_m ?? DEFAULT_ARRIVAL_RADIUS_M;
    result.precision = precision;
    result.stops = stops.map((s, i) => {
      const inner = i > 0 && i < stops.length - 1;
      return inner && precision === 'approximate'
        ? { lon: s.lon, lat: s.lat, radiusM: s.radiusM ?? defaultRadius }
        : { lon: s.lon, lat: s.lat };
    });
    if (!request.no_currents && !st.stack.isEmpty) result.currentSources = st.stack.sources.map(s => s.name);
    const name =
      request.name && request.name.trim()
        ? request.name.trim()
        : `${cfg.publish.routeNamePrefix} ${request.start.lat.toFixed(2)},${request.start.lon.toFixed(2)} → ${request.end.lat.toFixed(2)},${request.end.lon.toFixed(2)}`;
    const wps = result.waypoints;
    const summary: RouteSummary = {
      total_distance_m: result.totalDistanceM,
      total_time_s: result.totalTimeS,
      sailing_time_s: result.sailingTimeS,
      motoring_time_s: result.motoringTimeS,
      waypoint_count: wps.length,
      warnings: result.warnings?.length ?? 0,
      departure: wps[0].time.toISOString(),
      arrival: wps[wps.length - 1].time.toISOString(),
      forecast_cycle: cycleLabel,
      regional_wind: regionalWind,
      current_sources: result.currentSources,
      polar: polarLabel,
      polar_performance: routePolar ? vessel.polarPerformance : undefined,
      auto_vias: result.autoVias?.map(v => ({ name: v.name, width_m: Math.round(v.widthM) })),
    };
    if (multi) {
      summary.legs = stops.length - 1;
      summary.precision = request.precision ?? DEFAULT_PRECISION;
    }
    if (result.meshLeg) summary.mesh = true;
    if (result.drawbridges?.length) {
      summary.drawbridges = result.drawbridges.map(b => ({ lat: b.lat, lon: b.lon, clear_m: b.clearM, leg_index: b.legIndex }));
      summary.drawbridges_rule = request.drawbridges ?? cfg.routing.drawbridges;
    }
    summary.router = router;
    summary.search = search;
    if (result.corridorFallback) {
      summary.corridor_fallback = true;
      st.log('info', 'WARNING: corridor search failed on at least one leg; the route ran on the coarse per-route skeleton');
    }
    st.log(
      'info',
      `job ${id}: ${wps.length} waypoints, ${(result.totalDistanceM / NM_M).toFixed(1)} nm, ${(result.totalTimeS / HOUR_S).toFixed(1)} h, ${Date.now() - t} ms`
    );
    st.send({
      type: 'done',
      id,
      geojson: routeToGeoJSON(result),
      skRoute: routeToSignalKRoute(result, name),
      skeleton: skeletonToGeoJSON(result),
      fronts: result.fronts ? result.fronts.map(f => ({ leg: f.leg, ...compactFront(f) })) : null,
      summary,
    });
  } catch (err) {
    if (err instanceof RouteCancelled || shouldCancel()) st.send({ type: 'error', id, message: 'cancelled', cancelled: true });
    else st.send({ type: 'error', id, message: (err as Error).message });
  } finally {
    // The route's forecast area and its SMOC on-demand areas go with the route.
    if (st.routeWindow) {
      releaseWindow(st, st.routeWindow);
      st.routeWindow = null;
    }
    for (const s2 of st.routeRegional) releaseWindow(st, s2);
    st.routeRegional = [];
    if (st.smoc) st.smoc.trimOnDemand(0);
    rebuildStack(st);
    releaseMemory();
    st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
  }
}

export function expandBBox(b: BBox, d: number): BBox {
  const width = bboxWidth(b);
  if (width + 2 * d >= 360) return { west: -180, east: 180, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
  return { west: b.west - d, east: b.west + width + d, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
}
