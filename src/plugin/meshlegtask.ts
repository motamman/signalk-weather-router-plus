/**
 * The mesh leg in the child process that holds the mesh (childtask.ts
 * task 'mesh-leg'): the mesh search, then the whole leg planned on it
 * (engine/mesh/legrun.ts) with every move tested against the mesh
 * (engine/mesh/land.ts). The wind, the currents and the polar come from
 * what the route worker has on disk; nothing is fetched here. Progress
 * and stage fronts are sent to the worker as they happen.
 */

import { harmonicFromDir, type RtofsCacheRef, rtofsFromCache } from '../currents/fromcache';
import { SmocClient, SmocCurrentSource, type SmocRun, type SmocSettings } from '../currents/smoc';
import type { ArcoLayout, ArcoResolution } from '../data/arco';
import { CurrentStack } from '../currents/stack';
import type { CurrentSourceLike } from '../currents/types';
import { openDecodedRun } from '../data/decoded';
import type { CurrentSource } from '../engine/environment';
import { NoCurrent } from '../engine/environment';
import { RouteError } from '../engine/errors';
import type { LegWind } from '../engine/horizon';
import { LayeredWind, type RegionalWind } from '../engine/layeredwind';
import type { LegArrival, SimOptions } from '../engine/legsim';
import { MeshLand } from '../engine/mesh/land';
import { isRefusal, type MeshLegArgs, type MeshRefusal } from '../engine/mesh/leg';
import { runMeshLeg } from '../engine/mesh/legrun';
import { type DrawbridgeChoice, type MeshRules, runTargets, searchMeshRun } from '../engine/mesh/route';
import { MeshStore } from '../engine/mesh/store';
import type { LegPlan } from '../engine/multileg';
import type { PropagatorOptions } from '../engine/propagator';
import type { Route, StageFront } from '../engine/route';
import type { RouterKind } from '../engine/router';
import { type BBox, bboxFromLonLat } from '../geo/geodesy';
import { PolarDiagram, type PolarArrays } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';
import { readBoundary } from './meshcoarse';
import { regionalRunsFor } from './worker/regionalwind';

/** Everything the child needs, serialisable (dates as ms, the polar as its arrays). */
export interface MeshLegTask {
  task: 'mesh-leg';
  /** The mesh folder. */
  dir: string;
  plan: LegPlan;
  legIndex: number;
  legStart: [number, number];
  legDepartureMs: number;
  tag: string;
  multi: boolean;
  rules: MeshRules;
  vessel: VesselParams;
  polar: PolarArrays | null;
  /** A polar set's sail plans, scaled and floored as `polar` is; absent: none. */
  sailPlans?: { name: string; polar: PolarArrays }[] | null;
  sim: SimOptions;
  router?: RouterKind;
  propagator: Omit<PropagatorOptions, 'stages'>;
  stages: number;
  simplifyM: number;
  smoother: boolean;
  smootherTolerance: number;
  /** The smoother's simulation step, metres (absent: sim.simStepM). */
  smootherSimStepM?: number;
  drawbridges: DrawbridgeChoice;
  bridgeWaitS: number;
  /** The rough cut's tile-boundary file for this mesh and boat (meshcoarse.ts): seeds of the buffer across tile edges. */
  boundaryFile?: string;
  /** Per target after the start (route.ts runTargets), the point the rough cut aimed an approximate waypoint at. */
  aims?: ({ lon: number; lat: number; tri: number; movedM: number } | null)[];
  /** How the boat arrives at the leg's start (the leg before's last move); null at the route's start. */
  arriving?: LegArrival | null;
  /** The decoded run and the area to read, or null for calm wind (motor, or no forecast). */
  forecast: { runDir: string; area: BBox; params: string[] } | null;
  /** Regional runs root and the global grid spacing, or null when regional wind is off. */
  regional: { root: string; globalDLon: number } | null;
  /** The currents the worker holds, as the child can rebuild them from disk; null for none. */
  currents: {
    /** SMOC: the run, and the area and steps the worker loaded (and so wrote to the cache) for this leg; the child asks for exactly these. */
    smoc: {
      cacheDir: string;
      run: SmocRun;
      settings: SmocSettings;
      area: BBox;
      steps: number[];
      /** The resolution and layout that answered the area in the worker (SmocCurrentSource.answering): the chunks on disk. */
      as: { res: ArcoResolution; layout: ArcoLayout } | null;
    } | null;
    /** The RTOFS products the worker holds (finest first), each read from the cache for the leg's box. */
    rtofs: RtofsCacheRef | null;
    harmonicDir: string | null;
  } | null;
}

export type MeshLegEvent = { event: 'progress'; stage: number; total: number; message: string } | { event: 'frontier'; front: StageFront };

/**
 * fatal: the leg cannot be made as asked (a RouteError: a stretch that cannot be sailed); the route fails with the
 * reason. Otherwise the mesh cannot take the leg, and `reason` says why (legrun.ts's refusal); the worker decides
 * what follows.
 */
export type MeshLegResult = { ok: true; route: Route } | { ok: false; reason: string; fatal?: boolean };

/** Degrees added around the leg's box for the currents read from complete files on disk (RTOFS, harmonics); SMOC uses the worker's area. */
const CURRENTS_MARGIN_DEG = 0.25;

export async function runMeshLegTask(t: MeshLegTask, emit: (e: MeshLegEvent) => void): Promise<MeshLegResult> {
  const progress = (stage: number, total: number, message: string): void => emit({ event: 'progress', stage, total, message });
  const store = MeshStore.open(t.dir);
  // The leg's end, through its waypoint circles when it is a run of approximate legs (part 3).
  const targets = runTargets(t.plan).map((g, i) => {
    const aim = t.aims?.[i];
    return aim ? { ...g, aim: { lon: aim.lon, lat: aim.lat, tri: aim.tri } } : g;
  });
  const search = searchMeshRun(store, t.legStart, targets, t.rules, t.boundaryFile ? readBoundary(t.boundaryFile) : null);
  const land = search.result.ok ? new MeshLand(search.paged) : null;
  if (land)
    progress(0, 0, `${t.tag}chart mesh: the search's every move is tested against the mesh, its tiles read as the moves reach them`);
  const departure = new Date(t.legDepartureMs);
  const wind = await loadWind(t, progress);
  const current = await loadCurrents(t, search.box, progress);
  const polar = t.polar ? PolarDiagram.fromArrays(t.polar) : null;
  const sailPlans = t.sailPlans?.map(p => ({ name: p.name, polar: PolarDiagram.fromArrays(p.polar) })) ?? null;
  const args: MeshLegArgs = {
    plan: t.plan,
    legIndex: t.legIndex,
    legStart: t.legStart,
    legDeparture: departure,
    tag: t.tag,
    multi: t.multi,
    rules: t.rules,
    vessel: t.vessel,
    polar,
    sailPlans,
    sim: t.sim,
    router: t.router,
    propagator: t.propagator,
    stages: t.stages,
    simplifyM: t.simplifyM,
    smoother: t.smoother,
    smootherTolerance: t.smootherTolerance,
    smootherSimStepM: t.smootherSimStepM,
    drawbridges: t.drawbridges,
    bridgeWaitS: t.bridgeWaitS,
    arriving: t.arriving ?? null,
    progress,
    shouldCancel: () => false, // cancel kills the process (childtask.ts)
  };
  let route: Route | MeshRefusal;
  try {
    route = runMeshLeg({
      result: search.result,
      land,
      ...args,
      wind,
      current,
      onFrontier: front => emit({ event: 'frontier', front }),
    });
  } catch (err) {
    if (err instanceof RouteError) return { ok: false, reason: err.message, fatal: true };
    throw err;
  }
  if (isRefusal(route)) return { ok: false, reason: route.refused };
  return { ok: true, route };
}

async function loadWind(t: MeshLegTask, progress: MeshLegArgs['progress']): Promise<LegWind | null> {
  if (!t.forecast) return null;
  const { run, problem } = openDecodedRun(t.forecast.runDir);
  if (!run) {
    progress(0, 0, `WARNING: ${t.tag}chart mesh: the decoded forecast run is not usable (${problem}); routing with calm wind`);
    return null;
  }
  const t0 = Date.now();
  const wind = await run.window({ bbox: t.forecast.area, params: t.forecast.params, marginCells: 1 });
  progress(
    0,
    0,
    `${t.tag}chart mesh: forecast window read in the mesh process: {dataSize:${wind.bytes()}} in {time:${(Date.now() - t0) / 1000}}`
  );
  if (!t.regional) return wind;
  const regional: RegionalWind[] = [];
  for (const r of regionalRunsFor(t.regional.root, t.forecast.area, t.legDepartureMs, t.regional.globalDLon)) {
    try {
      const store = await r.run.window({ bbox: t.forecast.area, params: ['10u', '10v'], marginCells: 1 });
      regional.push({ name: r.name, wind: store, grid: r.grid, firstMs: r.firstMs, lastMs: r.lastMs });
      progress(0, 0, `${t.tag}chart mesh: regional wind ${r.name} (run ${r.run.index.cycle}) read: {dataSize:${store.bytes()}}`);
    } catch (err) {
      progress(0, 0, `WARNING: ${t.tag}chart mesh: regional wind ${r.name} not read (${(err as Error).message})`);
    }
  }
  return regional.length ? new LayeredWind(wind, regional) : wind;
}

async function loadCurrents(t: MeshLegTask, box: BBox, progress: MeshLegArgs['progress']): Promise<CurrentSource> {
  if (!t.currents) return new NoCurrent();
  const area = bboxFromLonLat([box.west, box.east], [box.south, box.north], CURRENTS_MARGIN_DEG);
  const sources: CurrentSourceLike[] = [];
  if (t.currents.harmonicDir) {
    for (const h of harmonicFromDir(t.currents.harmonicDir)) {
      if (h.source) sources.push(h.source);
      else progress(0, 0, `WARNING: ${t.tag}chart mesh: harmonic currents ${h.file ? `${h.file} ` : ''}not read (${h.error})`);
    }
  }
  if (t.currents.smoc) {
    const c = t.currents.smoc;
    try {
      const client = new SmocClient({ cacheDir: c.cacheDir, network: false });
      const src = new SmocCurrentSource(c.run, c.settings, client);
      // The worker's area and steps, so the layout and the chunks are the ones it wrote.
      if (c.steps.length) {
        await src.ensure(c.area, c.steps, { reason: 'mesh leg', ...(c.as ? { as: c.as } : {}) });
        sources.push(src);
        progress(
          0,
          0,
          `${t.tag}chart mesh: CMEMS SMOC read from the cache (run ${c.run.key}${c.run.settled ? '' : ', provisional'}, ${c.steps.length} steps): {dataSize:${src.memoryBytes()}}`
        );
      }
    } catch (err) {
      progress(
        0,
        0,
        `WARNING: ${t.tag}chart mesh: CMEMS SMOC not read from the cache (${(err as Error).message}); lower-priority current sources are used`
      );
    }
  }
  for (const r of t.currents.rtofs ? await rtofsFromCache(t.currents.rtofs, area) : []) {
    if (r.source) {
      sources.push(r.source);
      progress(0, 0, `${t.tag}chart mesh: RTOFS ${r.product} read from the cache: {dataSize:${r.source.bytes()}}`);
    } else if (r.error) progress(0, 0, `WARNING: ${t.tag}chart mesh: RTOFS ${r.product} not read from the cache (${r.error})`);
  }
  return sources.length ? new CurrentStack(sources) : new NoCurrent();
}
