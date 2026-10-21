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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { boundaryFile, coarseFile, coarseRulesOf, joinsFile, markCoarseUsed, withBuildLock } from '../meshcoarse';
import { ForecastStore } from '../../data/forecast';
import { loadForecastForBBox, resolveCycle } from '../../data/loader';
import type { WindowOptions } from '../../data/decoded';
import { REGIONAL_DIR } from '../../data/regionaldecode';
import { LayeredWind, type RegionalWind } from '../../engine/layeredwind';
import { checkRouteForecastMemory } from '../memguard';
import { type BBox, bboxFromLonLat, bboxHeight, bboxWidth, boxesMeet, haversineDistanceM, latLonText } from '../../geo/geodesy';
import { LandMask } from '../../geo/landmask';
import { releaseMemory } from '../../util/gc';
import { NoCurrent } from '../../engine/environment';
import { RouteCancelled } from '../../engine/propagator';
import { RouteError } from '../../engine/errors';
import { nearestExactWater, waterAround } from '../../engine/corridor';
import { DEFAULT_ARRIVAL_RADIUS_M, DEFAULT_PRECISION, legLabel, type LegPlan, routeMultiLeg, type Stop } from '../../engine/multileg';
import { type LegDepth, recomputePerWaypointMetadata, type Route, type StageFront, type StopSnap, type Waypoint } from '../../engine/route';
import { recomputeTotals } from '../../engine/smoother';
import type { CheckRules, DepthViolation, RouteDepthCheck } from '../../engine/mesh/check';
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
import { meshCovers, runTargets } from '../../engine/mesh/route';
import type { MeshLegArgs, MeshLegRunner, MeshRefusal } from '../../engine/mesh/leg';
import type { MeshRules } from '../../engine/mesh/route';
import { runChildTask } from '../childtask';
import type { MeshLegTask } from '../meshlegtask';
import { regionalRunsFor } from './regionalwind';
import { smocSettings } from './currents';
import type { ArcoLayout, ArcoResolution } from '../../data/arco';
import { localMeshes, meshesToOpen, readyMeshDirs } from '../meshes';
import { beamFor, DEFAULT_SEARCH } from '../../engine/search/presets';

/** One opened chart mesh (one cluster of a multi-cluster mesh): its name, folder and index. */
type OpenMesh = { name: string; dir: string; store: MeshStore };

/**
 * The chart meshes for this route: the downloaded ones with a complete
 * marker under the store directory (plugin/meshes.ts; a multi-cluster mesh
 * is one store per cluster) and the folder configured by hand (where the
 * two share a name, the newer copy: meshes.ts meshesToOpen). Only each
 * mesh's index (one small JSON) is read here.
 */
function openMeshes(cfg: ResolvedConfig, progress: (m: string) => void): OpenMesh[] {
  const stores: OpenMesh[] = [];
  const open = (name: string, dir: string): void => {
    try {
      stores.push({ name, dir, store: MeshStore.open(dir) });
    } catch (err) {
      progress(`WARNING: chart mesh ${name} not used: ${(err as Error).message}`);
    }
  };
  // Downloaded meshes first, then the folder managed by hand (one mesh, or a folder of them); the same
  // Use switch applies to both, and where the two share a name only the newer copy is opened.
  const downloaded = cfg.mesh.storeDir ? readyMeshDirs(cfg.mesh.storeDir) : [];
  for (const m of meshesToOpen(downloaded, localMeshes(cfg.meshDir), cfg.mesh.disabled, cfg.mesh.preferLocal, cfg.mesh.preferDownload))
    for (const d of m.dirs) open(m.name, d);
  return stores;
}

/** Whether two opened meshes' extents meet (their indexes): only then can their waters join. */
function extentsMeet(a: OpenMesh, b: OpenMesh): boolean {
  return boxesMeet(a.store.index, b.store.index);
}

/**
 * An AbortSignal that fires when the route is cancelled (the shared flag, polled twice a second), for the child
 * tasks and the waits of one step; `stop()` ends the polling when the step is over.
 */
function cancelPoll(shouldCancel: () => boolean): { signal: AbortSignal; stop: () => void } {
  const ac = new AbortController();
  const poll = setInterval(() => {
    if (shouldCancel()) ac.abort();
  }, 500);
  return { signal: ac.signal, stop: () => clearInterval(poll) };
}

/**
 * The rough cut of a mesh for the route's rules (parts 2–5): built first, in a child process (meshcoarse.ts), when
 * it is not on disk, with its joins to every other opened mesh whose extent meets it. Its file, or a refusal when it
 * could not be built.
 */
async function ensureRoughCut(
  st: WorkerState,
  m: OpenMesh,
  rules: MeshRules,
  tag: string,
  progress: MeshLegArgs['progress'],
  signal: AbortSignal,
  /** Every opened mesh (the joins go to those whose extent meets this one's). */
  all: OpenMesh[]
): Promise<string | MeshRefusal> {
  const r = coarseRulesOf(rules);
  const file = coarseFile(st.cacheRoot, m.dir, r);
  if (fs.existsSync(file)) {
    // Used now: pruneCoarse keeps the most recently used rough cuts, so this route's is never the one it removes.
    markCoarseUsed(file);
    return file;
  }
  const joins = all
    .filter(o => o !== m && extentsMeet(o, m))
    .map(o => ({ dir: o.dir, mapFile: coarseFile(st.cacheRoot, o.dir, r), name: o.name }));
  try {
    // One build of a file at a time, here or on the main thread (index.ts rebuildRoughCuts): a build under way is waited for.
    const { result: b } = await withBuildLock(
      file,
      () => {
        progress(
          0,
          0,
          `${tag}chart mesh: building the rough cut of ${m.name} for this boat (draught {depth:${r.draughtM}}, air draft {length:${r.airDraftM}}, buffer {length:${r.bufferM}}, opening bridges ${r.openingBridges === 'avoid' ? 'avoided' : 'open'}), once`
        );
        return runChildTask({ task: 'mesh-coarse', dir: m.dir, out: file, rules: r, joins }, 15 * 60_000, signal);
      },
      { signal, onWait: () => progress(0, 0, `${tag}chart mesh: the rough cut of ${m.name} is being built already; waiting for it`) }
    );
    if (b)
      progress(
        0,
        0,
        `${tag}chart mesh: rough cut built: ${b.pieces} pieces of water, ${b.links} links, ${b.boundaryBlocked} blocked triangles on tile edges, {dataSize:${b.bytes}} in {time:${b.ms / 1000}}` +
          b.joins.map(j => `; ${j.joins} joins to ${j.name} ({time:${j.ms / 1000}})`).join('')
      );
    else progress(0, 0, `${tag}chart mesh: the rough cut of ${m.name} is ready (built meanwhile)`);
  } catch (err) {
    if (signal.aborted) throw err;
    return { refused: `the rough cut of ${m.name} could not be built (${(err as Error).message})` };
  }
  return file;
}

/**
 * The meshes as the leg pipeline's runner, or undefined when there are
 * none. A leg is covered when one mesh covers all its points, and that leg
 * is planned whole in a child process holding that mesh
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
  stores: OpenMesh[],
  /** The SMOC area and steps loadAreas loaded for the current leg; the mesh process asks for exactly these. */
  smocLeg: () => { area: BBox; steps: number[]; as: { res: ArcoResolution; layout: ArcoLayout } | null } | null
): MeshLegRunner | undefined {
  if (!stores.length) return undefined;
  const meshFor = (points: [number, number][]): (typeof stores)[number] | undefined => stores.find(s => meshCovers(s.store, points));
  const useForecast = !request.no_forecast && request.mode !== 'motor';
  const roughCut = (m: OpenMesh, rules: MeshRules, tag: string, progress: MeshLegArgs['progress'], signal: AbortSignal) =>
    ensureRoughCut(st, m, rules, tag, progress, signal, stores);
  return {
    covers: points => meshFor(points) !== undefined,
    meets: box => stores.some(s => boxesMeet(s.store.index, box)),
    // A leg's way across the limits of the charts (part 5): in a child process (plugin/meshwaters.ts) holding every
    // mesh meeting the leg's area; their rough cuts and joins first when missing. Meshes go to the pipeline by folder.
    plan: async c => {
      const near = stores.filter(s => boxesMeet(s.store.index, c.box));
      const ac = cancelPoll(c.shouldCancel);
      try {
        const meshes: { dir: string; mapFile: string | null; name: string }[] = [];
        if (c.rules) {
          const r = coarseRulesOf(c.rules);
          for (const m of near) {
            const file = await roughCut(m, c.rules, c.tag, c.progress, ac.signal);
            if (typeof file !== 'string') return file;
            meshes.push({ dir: m.dir, mapFile: file, name: m.name });
          }
          // Joins towards a mesh whose build the rough cut has none for (downloaded or updated since): built now.
          for (const a of near)
            for (const b of near) {
              if (a === b || !extentsMeet(a, b)) continue;
              const mapFile = coarseFile(st.cacheRoot, a.dir, r);
              if (fs.existsSync(joinsFile(mapFile, b.dir))) continue;
              c.progress(0, 0, `${c.tag}chart mesh: finding where ${a.name}'s water joins ${b.name}'s for this boat, once`);
              const { result: j } = await withBuildLock(
                joinsFile(mapFile, b.dir),
                () =>
                  runChildTask(
                    {
                      task: 'mesh-joins',
                      dir: a.dir,
                      mapFile,
                      rules: r,
                      other: { dir: b.dir, mapFile: coarseFile(st.cacheRoot, b.dir, r), name: b.name },
                    },
                    15 * 60_000,
                    ac.signal
                  ),
                { signal: ac.signal }
              );
              if (j) c.progress(0, 0, `${c.tag}chart mesh: ${j.joins} joins from ${a.name} to ${b.name} ({time:${j.ms / 1000}})`);
            }
        } else for (const m of near) meshes.push({ dir: m.dir, mapFile: null, name: m.name });
        const r = await runChildTask(
          {
            task: 'mesh-waters',
            meshes,
            rules: c.rules,
            why: c.why,
            start: c.start,
            end: c.end,
            names: c.names,
            land: {
              shapefiles: cfg.landShapefiles,
              bbox: c.box,
              maxCells: cfg.routing.landRasterMaxCells,
              bufferM: cfg.routing.landBufferM,
            },
          },
          10 * 60_000,
          ac.signal
        );
        if (!r.ok) return { refused: r.reason };
        if (r.kind === 'one-mesh') return { kind: 'one-mesh', mesh: near[r.mesh].dir };
        if (r.kind === 'open') {
          c.progress(
            0,
            0,
            `${c.tag}chart mesh: open water outside the charts joins the leg's ends; the coastline search plans it with the charts' water as land ({time:${r.ms / 1000}})`
          );
          return { kind: 'open', mask: r.mask };
        }
        const at = (p: [number, number]): string => latLonText(p[1], p[0]);
        const words = r.stretches.map(s =>
          s.kind === 'mesh' ? `${near[s.mesh].name} from ${at(s.from)} to ${at(s.to)}` : `open water from ${at(s.from)} to ${at(s.to)}`
        );
        c.progress(
          0,
          0,
          `${c.tag}chart mesh: the leg crosses the limits of the charts with ${r.changes} change(s) between charts and open water and ${r.transfers} from one district's charts to another's${r.ways > 1 ? ` (the cheapest of ${r.ways} ways with as few changes)` : ''}: ${words.join('; ')} ({time:${r.ms / 1000}})`
        );
        return {
          kind: 'chain',
          stretches: r.stretches.map(s => (s.kind === 'mesh' ? { kind: 'mesh', mesh: near[s.mesh].dir, from: s.from, to: s.to } : s)),
          mask: r.mask,
        };
      } finally {
        ac.stop();
      }
    },
    leg: async (a: MeshLegArgs) => {
      // The child reads the forecast from the decoded run's files; without one it would plan the leg with no wind.
      if (useForecast && !st.run)
        return { refused: 'the forecast is still being decoded, and the mesh process reads only a decoded run; try again shortly' };
      // The mesh the plan named; else the one holding the leg's points (a handover leg, with one end outside every
      // mesh: the one holding either).
      const m = a.meshId
        ? stores.find(s => s.dir === a.meshId)
        : (meshFor([a.legStart, ...a.plan.vias.map(v => [v.lon, v.lat] as [number, number]), a.plan.end]) ??
          meshFor([a.legStart]) ??
          meshFor([a.plan.end]));
      if (!m) return { refused: 'no mesh covers the leg' };
      a.progress(0, 0, `${a.tag}chart mesh: ${m.name}`);
      // Cancel: the worker's flag, polled; aborting kills the child.
      const ac = cancelPoll(a.shouldCancel);
      try {
        // The rough cut's tile-boundary triangles seed the buffer across tile edges (paged.ts).
        const map = await roughCut(m, a.rules, a.tag, a.progress, ac.signal);
        if (typeof map !== 'string') return map;
        // The forecast area: the reach's tiles when there is one (the search may run far from the ends), else the ends.
        const bbox = a.reach ? a.reach.box : bboxFromLonLat([a.legStart[0], a.plan.end[0]], [a.legStart[1], a.plan.end[1]], 0.5);
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
          smootherSimStepM: a.smootherSimStepM,
          drawbridges: a.drawbridges,
          bridgeWaitS: a.bridgeWaitS,
          boundaryFile: boundaryFile(map),
          ...(a.reach ? { aims: a.reach.aims } : {}),
          forecast: useForecast ? { runDir: st.run!.dir, area: expandBBox(bbox, ROUTE_FORECAST_MARGIN_DEG), params: ROUTE_PARAMS } : null,
          regional:
            useForecast && request.wind_model !== 'ecmwf'
              ? { root: path.join(st.cacheRoot, REGIONAL_DIR), globalDLon: st.run?.index.grid.dLon ?? GLOBAL_DLON_DEG }
              : null,
          currents: request.no_currents
            ? null
            : {
                smoc:
                  st.smoc && cfg.currents.smocEnabled && smocLeg()
                    ? { cacheDir: path.join(st.cacheRoot, 'smoc'), run: st.smoc.run, settings: smocSettings(cfg), ...smocLeg()! }
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
        const r = await runChildTask(task, 15 * 60_000, ac.signal, e => {
          if (e.event === 'progress') a.progress(e.stage, e.total, e.message);
          else if (e.event === 'frontier') st.send({ type: 'frontier', id, leg: a.legIndex, ...compactFront(e.front) });
        });
        if (!r.ok) {
          if (r.fatal) throw new RouteError(r.reason);
          return { refused: r.reason };
        }
        return r.route;
      } finally {
        ac.stop();
      }
    },
    // Where a leg leaving the charts crosses to the coastline (part 5): in a child process (plugin/meshexit.ts), on the
    // coastline search's own land raster for the leg's area; the rough cut first when missing (its boundary record).
    exit: async c => {
      const m = meshFor([c.inside]);
      if (!m) return { refused: 'no mesh covers the leg' };
      const ac = cancelPoll(c.shouldCancel);
      try {
        const file = await roughCut(m, c.rules, c.tag, c.progress, ac.signal);
        if (typeof file !== 'string') return file;
        const r = await runChildTask(
          {
            task: 'mesh-exit',
            dir: m.dir,
            mapFile: file,
            rules: c.rules,
            inside: c.inside,
            outside: c.outside,
            names: c.names,
            land: {
              shapefiles: cfg.landShapefiles,
              bbox: c.box,
              maxCells: cfg.routing.landRasterMaxCells,
              bufferM: cfg.routing.landBufferM,
            },
          },
          10 * 60_000,
          ac.signal
        );
        if (!r.ok) return { refused: r.reason };
        c.progress(
          0,
          0,
          `${c.tag}chart mesh: the leg leaves the charts at ${latLonText(r.exit[1], r.exit[0])} (${r.exits} places where the chart mesh's water meets the coastline's water that reaches ${c.names.outside}; {time:${r.ms / 1000}})`
        );
        return { exit: r.exit, mask: r.mask };
      } finally {
        ac.stop();
      }
    },
    // Where a leg from one mesh to another changes meshes in their overlap (part 5 step 2): in a child process
    // (plugin/meshtransfer.ts) holding both; the two rough cuts first when missing.
    transfer: async c => {
      const a = meshFor([c.start]);
      const b = meshFor([c.end]);
      if (!a || !b) return { refused: 'no mesh covers the leg' };
      const ac = cancelPoll(c.shouldCancel);
      try {
        const fa = await roughCut(a, c.rules, c.tag, c.progress, ac.signal);
        if (typeof fa !== 'string') return fa;
        const fb = await roughCut(b, c.rules, c.tag, c.progress, ac.signal);
        if (typeof fb !== 'string') return fb;
        const r = await runChildTask(
          {
            task: 'mesh-transfer',
            from: { dir: a.dir, mapFile: fa, name: a.name },
            to: { dir: b.dir, mapFile: fb, name: b.name },
            rules: c.rules,
            start: c.start,
            end: c.end,
            names: c.names,
            land: {
              shapefiles: cfg.landShapefiles,
              bbox: c.box,
              maxCells: cfg.routing.landRasterMaxCells,
              bufferM: cfg.routing.landBufferM,
            },
          },
          10 * 60_000,
          ac.signal
        );
        if (!r.ok) return { refused: r.reason };
        if (r.kind === 'transfer') {
          c.progress(
            0,
            0,
            `${c.tag}chart mesh: the leg changes from ${a.name} to ${b.name} at ${latLonText(r.point[1], r.point[0])}, water both call usable for this boat (${r.transfers} such triangles of ${r.tested} tested in ${r.candidateTiles} of ${r.sharedTiles} shared tiles, those the rough cuts connect to both ends; {time:${r.ms / 1000}})`
          );
          return { point: r.point };
        }
        c.progress(
          0,
          0,
          `${c.tag}chart mesh: the leg cannot change from ${a.name} to ${b.name} in their overlap (${r.overlap}); it leaves ${a.name} at ${latLonText(r.exit[1], r.exit[0])} and enters ${b.name} at ${latLonText(r.entry[1], r.entry[0])}, the coastline search between them with both meshes' water as land (${r.exits} exits, ${r.entries} entries; {time:${r.ms / 1000}})`
        );
        return { exit: r.exit, entry: r.entry, mask: r.mask };
      } finally {
        ac.stop();
      }
    },
    // The leg's reach on the rough cut (part 4): whether water connects its ends for the boat, and where it runs;
    // the rough cut built first when this boat has none for the mesh, both in child processes (meshcoarse.ts), so
    // no mesh tile is read in this worker.
    reach: async c => {
      const m = c.meshId
        ? stores.find(s => s.dir === c.meshId)
        : meshFor([c.legStart, ...c.plan.vias.map(v => [v.lon, v.lat] as [number, number]), c.plan.end]);
      if (!m) return { refused: 'no mesh covers the leg' };
      const ac = cancelPoll(c.shouldCancel);
      try {
        const file = await roughCut(m, c.rules, c.tag, c.progress, ac.signal);
        if (typeof file !== 'string') return file;
        const t0 = Date.now();
        const r = await runChildTask(
          {
            task: 'mesh-reach',
            dir: m.dir,
            mapFile: file,
            points: [{ lon: c.legStart[0], lat: c.legStart[1], name: 'the start' }, ...runTargets(c.plan)],
            rules: coarseRulesOf(c.rules),
            ...(c.rules.avoid?.length ? { avoid: c.rules.avoid } : {}),
          },
          5 * 60_000,
          ac.signal
        );
        if (!r.ok) return { refused: r.reason };
        c.progress(
          0,
          0,
          `${c.tag}chart mesh: rough cut: water connects the leg's points through ${r.chainTiles} tiles, {distance:${r.lengthM.toFixed(0)}} between their pieces; the forecast and currents are loaded over them ({time:${(Date.now() - t0) / 1000}})`
        );
        return { box: r.box, lengthM: r.lengthM, aims: r.aims };
      } finally {
        ac.stop();
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
 * The engine can sample outside the land raster's box (the land test
 * treats outside it as land, geo/landmask.ts); inside this margin every sample is exactly
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
  // The flag is cleared by the main thread before it posts the route (index.ts dispatchRoute).
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
    const vessel = routeVessel(cfg, request.vessel, self);
    const meshes = openMeshes(cfg, m => progress(0, 0, m));
    const snaps: StopSnap[] = [];
    {
      const SNAP_MAX_M = 1000;
      // The land buffer, when larger, is the clearance a start or end needs (it could not leave otherwise).
      const SNAP_CLEAR_M = Math.max(150, cfg.routing.landBufferM);
      const label = (i: number): string =>
        i === 0 ? 'the start point' : i === stops.length - 1 ? 'the destination' : `your point ${i + 1} of ${stops.length} (waypoint ${i})`;
      const meshOf = (p: Stop): OpenMesh | undefined => meshes.find(m => m.store.covers(p.lon, p.lat));
      // Stops in mesh water are snapped on the mesh (docs/drafts/mesh-no-gshhg-design.md, part 2; the owner's
      // choices of 2026-10-12): the start, the destination and exact waypoints, each mesh's stops together, to the
      // nearest water the boat can use connected to the route, at most SNAP_MAX_M. An approximate waypoint is not
      // snapped: its circle is aimed at usable water when its leg is planned (part 3). No coastline snap in mesh
      // water; without the draught and air draft the mesh cannot judge, and the leg says so.
      const approximate = (request.precision ?? DEFAULT_PRECISION) === 'approximate';
      const byMesh = new Map<OpenMesh, number[]>();
      for (let i = 0; i < stops.length; i++) {
        const m = meshOf(stops[i]);
        if (!m || (approximate && i > 0 && i < stops.length - 1)) continue;
        byMesh.set(m, [...(byMesh.get(m) ?? []), i]);
      }
      if (byMesh.size && vessel.draughtM !== null && vessel.airDraftM !== null) {
        const rules: MeshRules = {
          draughtM: vessel.draughtM,
          airDraftM: vessel.airDraftM,
          underKeelClearanceM: vessel.underKeelClearanceM,
          overheadClearanceM: vessel.overheadClearanceM,
          motorSpeedMs: vessel.motorSpeedMs,
          bufferM: cfg.routing.navigableBufferM,
          openingBridges: (request.drawbridges ?? cfg.routing.drawbridges) === 'avoid' ? 'avoid' : 'open',
          ...(avoid.length ? { avoid: avoid.map(a => ({ lon: a.lon, lat: a.lat, radiusM: a.radiusM })) } : {}),
        };
        const ac = cancelPoll(shouldCancel);
        try {
          for (const [m, idx] of byMesh) {
            const file = await ensureRoughCut(st, m, rules, '', progress, ac.signal, meshes);
            if (typeof file !== 'string') throw new RouteError(file.refused);
            const r = await runChildTask(
              {
                task: 'mesh-snap',
                dir: m.dir,
                mapFile: file,
                points: idx.map(i => ({ lon: stops[i].lon, lat: stops[i].lat, name: label(i) })),
                rules: coarseRulesOf(rules),
                ...(rules.avoid ? { avoid: rules.avoid } : {}),
                maxMoveM: SNAP_MAX_M,
              },
              5 * 60_000,
              ac.signal
            );
            if (!r.ok) throw new RouteError(r.reason);
            idx.forEach((i, k) => {
              const p = r.points[k];
              if (p.outsideGroup && !(p.movedM > 0))
                progress(
                  0,
                  0,
                  `${label(i)} is on water this boat can use that does not connect on the chart mesh to the route's within {length:${SNAP_MAX_M}}; left where it is, its leg looks for a way through other charts or open water`
                );
              if (!(p.movedM > 0)) return;
              const s = stops[i];
              snaps.push({ index: i, original: [s.lon, s.lat], anchor: [p.lon, p.lat], distanceM: p.movedM });
              // A moved stop after the start sits on the edge of unusable water: its leg ends on entering the circle
              // of the distance moved round it (the owner's choice, 2026-10-12; multileg.ts Stop.snapped).
              stops[i] = i > 0 ? { ...s, lon: p.lon, lat: p.lat, radiusM: p.movedM, snapped: true } : { ...s, lon: p.lon, lat: p.lat };
              progress(
                0,
                0,
                `${p.outsideGroup ? 'WARNING: ' : ''}${label(i)} ${p.why} according to the chart mesh; moved {length:${p.movedM.toFixed(0)}} to water this boat can use, connected to the route, at ${latLonText(p.lat, p.lon)}${i > 0 ? `; its leg ends on coming within {length:${p.movedM.toFixed(0)}} of it` : ''}`
              );
            });
          }
        } catch (err) {
          if (shouldCancel()) throw new RouteCancelled();
          throw err;
        } finally {
          ac.stop();
        }
      }
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        // Mesh water: the mesh decides (above), never the coastline.
        if (meshOf(s)) continue;
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
            `${label(i)}, at ${latLonText(s.lat, s.lon)}, ${why} according to the coastline data, with no open water ({length:${SNAP_CLEAR_M}} clear of the shore) within {length:${SNAP_MAX_M}}; move it into open water`
          );
        }
        const d = haversineDistanceM(s.lon, s.lat, near[0], near[1]);
        snaps.push({ index: i, original: [s.lon, s.lat], anchor: [near[0], near[1]], distanceM: d });
        stops[i] = { ...s, lon: near[0], lat: near[1] };
        progress(
          0,
          0,
          `${label(i)} ${why} according to the coastline data; moved {length:${d.toFixed(0)}} to open water at ${latLonText(near[1], near[0])} (route points keep {length:${SNAP_CLEAR_M}} of water around them)`
        );
      }
      snaps.sort((a, b) => a.index - b.index);
      if (snaps.length) {
        start[0] = stops[0].lon;
        start[1] = stops[0].lat;
        end[0] = stops[stops.length - 1].lon;
        end[1] = stops[stops.length - 1].lat;
      }
    }

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
    // The SMOC box and steps loaded for the leg: the mesh process reads the
    // same from the disk cache, so both sides ask for one area and one step
    // list and the chunks it wants are the ones written here. `as`: the
    // resolution and layout of the area that answered (often the resident
    // area, loaded from its own layout): the mesh process loads the same, as
    // the chunks of the layout it would choose for the leg box alone may never
    // have been downloaded.
    let smocLeg: { area: BBox; steps: number[]; as: { res: ArcoResolution; layout: ArcoLayout } | null } | null = null;
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
          const { store } = await readWindow(st, `job ${id} ${what}`, opts);
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
            smocLeg = { area: bbox, steps, as: src.answering(bbox, steps) };
          } catch (err) {
            smocLeg = null;
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
      smocLeg = null;
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
      mesh: meshLegRunner(st, cfg, id, request, meshes, () => smocLeg),
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
        tackPenaltyS: request.tack_penalty ?? cfg.routing.tackPenaltyS,
      },
      simplifyM: request.simplify_m ?? cfg.routing.simplifyM,
      // Both routers (the owner's decision, 2026-10-08): the smoother times every shortcut with the real polar, so two laid-out tacks become one straight leg only where that course is sailable within the tolerance.
      smoother: request.smoother ?? cfg.routing.smoother,
      smootherTolerance: request.smoother_tolerance ?? cfg.routing.smootherTolerance,
      smootherSimStepM: request.smoother_sim_step_m,
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

    // Repair detours (finalDepthCheck): the blocked segment routed again with the same leg pipeline, sail
    // threshold 0, so the detour sails and motors only where sailing cannot move the boat (the owner's decision,
    // 2026-10-15).
    const detourPipeline: LegPipelineInputs = { ...pipeline, sim: { ...pipeline.sim, sailThreshMs: 0 } };
    let detourCounter = 0;
    const detour = (a: Waypoint, b: Waypoint): Promise<Route> =>
      runLegPipeline(
        detourPipeline,
        { index: 0, lastIndex: 0, count: 1, vias: [], end: [b.lon, b.lat], snapToExact: true },
        1000 + detourCounter++,
        [a.lon, a.lat],
        a.time
      );

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
    // The final depth check: whatever planned each leg, a crossing of water a chart mesh blocks for this boat is
    // repaired here (each blocked segment routed again and the detour spliced in); a route that still crosses
    // such water after the repair fails and is never returned (the owner's decision, 2026-10-15).
    await finalDepthCheck(
      result,
      meshes,
      vessel,
      {
        openingBridges: (request.drawbridges ?? cfg.routing.drawbridges) === 'avoid' ? 'avoid' : 'open',
        avoid: avoid.map(a => ({ lon: a.lon, lat: a.lat, radiusM: a.radiusM })),
      },
      progress,
      shouldCancel,
      // Under sail_max a detour (threshold 0) motors only where sailing cannot move the boat: worth a warning. Under
      // fastest motoring is chosen whenever it is quicker, so it says nothing about the wind.
      { detour, sailing: (request.mode ?? 'sail_max') === 'sail_max' }
    );
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
      return (inner && precision === 'approximate') || s.snapped
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
    if (result.depthCheck) {
      summary.depth_checked = true;
      summary.legs_detail = result.depthCheck.legs.map(l => ({
        leg: l.leg,
        source: result.legSources?.[l.leg] ?? 'coastline',
        on_mesh_m: Math.round(l.onMeshM),
        unknown_depth_m: Math.round(l.unknownDepthM),
        outside_mesh_m: Math.round(l.outsideMeshM),
        shallowest_m: l.shallowestM,
        shallowest_at: l.shallowestAt,
      }));
    }
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

/** A blocked crossing in words, quantities as unit tokens (the web app writes them in its user's units). */
function violationText(v: DepthViolation): string {
  switch (v.kind) {
    case 'depth':
      return `charted depth {depth:${v.value}}${v.value !== null && v.value < 0 ? ' (dries)' : ''}`;
    case 'hazard':
      return v.value === null ? 'a rock, wreck or obstruction with no charted depth' : `a rock, wreck or obstruction at {depth:${v.value}}`;
    case 'clearance':
      return `vertical clearance {length:${v.value}}`;
    case 'opening bridge':
      return 'an opening bridge (Drawbridges is set to Avoid)';
    case 'mark':
      return 'within 20 m of a buoy, beacon or light';
    case 'structure':
      return 'a structure (pier, pile, pontoon or the like)';
    case 'area to avoid':
      return 'an area to avoid (a Signal K note)';
  }
}

/**
 * The final depth check (docs/drafts/mesh-no-gshhg-design.md, part 1): the
 * finished route walked through every chart mesh it meets, in a child
 * process (plugin/meshchecktask.ts). With `repair`, each segment that
 * crosses water a mesh blocks for this boat is routed again and the detour
 * spliced in (repairViolations; the owner's decision, 2026-10-15); a
 * crossing still left after that fails the route (RouteError naming the
 * places). Otherwise what each leg crossed is recorded on the route
 * (`depthCheck`). Nothing happens when no mesh meets the route.
 */
async function finalDepthCheck(
  route: Route,
  meshes: OpenMesh[],
  vessel: { draughtM: number | null; airDraftM: number | null; underKeelClearanceM: number; overheadClearanceM: number },
  rules: Pick<CheckRules, 'openingBridges' | 'avoid'>,
  progress: (stage: number, total: number, message: string) => void,
  shouldCancel: () => boolean,
  repair?: { detour: (a: Waypoint, b: Waypoint) => Promise<Route>; sailing: boolean }
): Promise<void> {
  const near = (path: [number, number][]): OpenMesh[] => {
    const box = bboxFromLonLat(
      path.map(p => p[0]),
      path.map(p => p[1]),
      0.01
    );
    return meshes.filter(m => boxesMeet(m.store.index, box));
  };
  if (route.waypoints.length < 2 || !meshes.length) return;
  const path0: [number, number][] = route.waypoints.map(w => [w.lon, w.lat]);
  const near0 = near(path0);
  if (!near0.length) return;
  if (vessel.draughtM === null || vessel.airDraftM === null) {
    if (path0.some(p => near0.some(m => m.store.covers(p[0], p[1]))))
      throw new RouteError(
        `the route passes through water a chart mesh covers, but the vessel's ${vessel.draughtM === null ? 'draught' : 'air draft'} is not set, so it cannot be checked against charted depth; set the draught and air draft (Signal K design.draft.maximum and design.airHeight)`
      );
    return;
  }
  const draughtM = vessel.draughtM;
  const airDraftM = vessel.airDraftM;
  let legCount = 1;
  // The route as it stands (a repair changes its waypoints), checked again after each repair pass.
  const runCheck = async (): Promise<RouteDepthCheck> => {
    const wps = route.waypoints;
    const path: [number, number][] = wps.map(w => [w.lon, w.lat]);
    // The leg of each segment: a leg ends at each waypoint of role 'via' (multileg.ts stitchLegs).
    const legOf: number[] = [];
    let leg = 0;
    for (let k = 0; k + 1 < wps.length; k++) {
      if (k > 0 && wps[k].role === 'via') leg++;
      legOf.push(leg);
    }
    legCount = Math.max(leg + 1, route.legSources?.length ?? 0);
    const ac = cancelPoll(shouldCancel);
    try {
      return await runChildTask(
        {
          task: 'mesh-check',
          dirs: near(path).map(m => m.dir),
          path,
          legOf,
          legCount,
          rules: {
            draughtM,
            airDraftM,
            underKeelClearanceM: vessel.underKeelClearanceM,
            overheadClearanceM: vessel.overheadClearanceM,
            ...rules,
          },
        },
        10 * 60_000,
        ac.signal
      );
    } catch (err) {
      if (shouldCancel()) throw new RouteCancelled();
      throw new RouteError(
        `the final depth check against the chart mesh could not run (${(err as Error).message}); no route is returned unchecked`
      );
    } finally {
      ac.stop();
    }
  };
  const t0 = Date.now();
  let check = await runCheck();
  if (check.violations.length && repair) check = await repairViolations(route, check, repair, runCheck, progress, shouldCancel);
  const multi = legCount > 1;
  if (check.violations.length) {
    const first = check.violations
      .slice(0, 3)
      .map(v => `${multi ? `leg ${v.leg + 1} ` : ''}at ${latLonText(v.lat, v.lon)}: ${violationText(v)}`)
      .join('; ');
    const more = check.violations.length > 3 ? `; and ${check.violations.length - 3} more place(s)` : '';
    const tried = route.repairsApplied ? ` (after ${route.repairsApplied} detour(s))` : repair ? ' (no detour cleared it)' : '';
    throw new RouteError(
      `the route crosses water the chart mesh says this boat cannot use${tried} (draught {depth:${draughtM}}, so at least {depth:${draughtM + vessel.underKeelClearanceM}} of water; air draft {length:${airDraftM}}): ${first}${more}`
    );
  }
  const sum = (f: (l: LegDepth) => number): number => check.legs.reduce((a, l) => a + f(l), 0);
  let shallow: LegDepth | null = null;
  for (const l of check.legs) if (l.shallowestM !== null && (shallow === null || l.shallowestM < shallow.shallowestM!)) shallow = l;
  progress(
    0,
    0,
    `depth check: {distance:${sum(l => l.onMeshM).toFixed(0)}} on the chart mesh` +
      (shallow
        ? `, shallowest charted depth {depth:${shallow.shallowestM}}${multi ? ` (leg ${shallow.leg + 1})` : ''} at ${latLonText(shallow.shallowestAt![1], shallow.shallowestAt![0])}`
        : '') +
      `, {distance:${sum(l => l.unknownDepthM).toFixed(0)}} with no charted depth, {distance:${sum(l => l.outsideMeshM).toFixed(0)}} outside the chart mesh; nothing the boat cannot use` +
      (route.repairsApplied ? ` after ${route.repairsApplied} detour(s)` : '') +
      ` ({time:${(Date.now() - t0) / 1000}})`
  );
  route.depthCheck = { legs: check.legs };
}

/** Repair limits: passes over the route, and detours in all. */
const REPAIR_MAX_PASSES = 2;
const REPAIR_MAX_DETOURS = 5;

/**
 * Route again each segment the check found blocked, back to front so the
 * earlier segments keep their indices, and splice the detour in place of
 * the segment; the waypoints after it move by the time the detour added
 * (a shift, not a re-timing: the detour's own times, opening-bridge waits
 * included). Warnings and opening bridges after it move with its
 * waypoints; the detour's own opening bridges are added.
 * Then check again; at most REPAIR_MAX_PASSES passes and
 * REPAIR_MAX_DETOURS detours. A detour that motors on a sail_max route is
 * a `detour_motored` warning: its sail threshold is 0, so it motors only
 * where sailing cannot move the boat. Returns the last check; the caller
 * fails the route on what it still finds.
 */
export async function repairViolations(
  route: Route,
  first: RouteDepthCheck,
  repair: { detour: (a: Waypoint, b: Waypoint) => Promise<Route>; sailing: boolean },
  runCheck: () => Promise<RouteDepthCheck>,
  progress: (stage: number, total: number, message: string) => void,
  shouldCancel: () => boolean
): Promise<RouteDepthCheck> {
  let check = first;
  let used = 0;
  for (let pass = 0; pass < REPAIR_MAX_PASSES && check.violations.length && used < REPAIR_MAX_DETOURS; pass++) {
    const segments = [...new Set(check.violations.map(v => v.segment))].sort((x, y) => y - x);
    let spliced = 0;
    for (const k of segments) {
      if (used >= REPAIR_MAX_DETOURS) break;
      if (shouldCancel()) throw new RouteCancelled();
      const wps = route.waypoints;
      const a = wps[k];
      const b = wps[k + 1];
      if (!a || !b) continue;
      used++;
      const v = check.violations.find(x => x.segment === k)!;
      const at = latLonText(v.lat, v.lon);
      let d: Route;
      try {
        d = await repair.detour(a, b);
      } catch (err) {
        if (shouldCancel() || err instanceof RouteCancelled) throw new RouteCancelled();
        // The detour sails with the threshold at 0 (never motor): the layout's advice to raise Min sail speed is
        // about the detour, not the user's setting.
        const reason = (err as Error).message.includes('Min sail speed is 0')
          ? 'a sailing detour could not tack clear of the blocked water (the repair does not motor)'
          : (err as Error).message.replace(/^.*?ROUTE FAILED: /, '');
        progress(0, 0, `WARNING: repair: no detour around ${at} (${violationText(v)}): ${reason}`);
        continue;
      }
      const dw = d.waypoints;
      if (dw.length < 2) continue;
      const end = dw[dw.length - 1];
      const shiftMs = end.time.getTime() - b.time.getTime();
      // The detour replaces the segment: its start is waypoint k (kept), its end takes waypoint k + 1's place and role.
      const mid: Waypoint[] = dw.slice(1, -1).map(w => {
        const c = { ...w };
        delete c.role;
        return c;
      });
      const last: Waypoint = { ...end };
      if (b.role) last.role = b.role;
      else delete last.role;
      const after = wps.slice(k + 2).map(w => ({ ...w, time: new Date(w.time.getTime() + shiftMs) }));
      route.waypoints = [...wps.slice(0, k + 1), ...mid, last, ...after];
      // Warnings index the route's segments (multileg.ts stitchLegs): those after the detour move with its waypoints.
      for (const w of route.warnings ?? []) if (w.leg_index > k) w.leg_index += mid.length;
      // Opening bridges index the waypoint their crossing leg arrives at, the same way: the one on the replaced
      // segment goes (the detour says what it passes under), those after it move, and the detour's own come in at
      // its place (its waypoint j is the route's k + j).
      const bridges = (route.drawbridges ?? [])
        .filter(br => br.legIndex !== k + 1)
        .map(br => (br.legIndex > k + 1 ? { ...br, legIndex: br.legIndex + mid.length } : br));
      for (const br of d.drawbridges ?? []) bridges.push({ ...br, legIndex: br.legIndex + k });
      bridges.sort((x, y) => x.legIndex - y.legIndex);
      if (bridges.length) route.drawbridges = bridges;
      else delete route.drawbridges;
      route.repairsApplied = (route.repairsApplied ?? 0) + 1;
      spliced++;
      progress(
        0,
        0,
        `repair: the segment through ${at} crossed ${violationText(v)}; detour of ${mid.length} waypoint(s), {distance:${d.totalDistanceM.toFixed(0)}}, arrival {time:${Math.abs(shiftMs) / 1000}} ${shiftMs >= 0 ? 'later' : 'earlier'}`
      );
      if (repair.sailing && d.motoringTimeS > 0) {
        route.warnings = route.warnings ?? [];
        route.warnings.push({
          leg_index: k,
          violation: 'detour_motored',
          from: [a.lon, a.lat],
          to: [b.lon, b.lat],
          repaired: true,
          detail: String(Math.round(d.motoringTimeS)),
        });
        progress(
          0,
          0,
          `WARNING: repair: the detour around ${at} motored {time:${d.motoringTimeS}}: the wind could not move the boat there under sail`
        );
      }
    }
    if (!spliced) break;
    recomputeTotals(route);
    recomputePerWaypointMetadata(route);
    check = await runCheck();
  }
  return check;
}

export function expandBBox(b: BBox, d: number): BBox {
  const width = bboxWidth(b);
  if (width + 2 * d >= 360) return { west: -180, east: 180, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
  return { west: b.west - d, east: b.west + width + d, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
}
