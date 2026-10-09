/**
 * The mesh leg in the child process that holds the mesh (childtask.ts
 * task 'mesh-leg'): the mesh search, then the whole leg planned on it
 * (engine/mesh/legrun.ts) with every move tested against the mesh
 * (engine/mesh/land.ts). The wind, the currents and the polar come from
 * what the route worker has on disk; nothing is fetched here. Progress
 * and stage fronts are sent to the worker as they happen.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarmonicCurrentSource } from '../currents/harmonic';
import { loadRtofsSteps, RtofsClient, RtofsCurrentSource, rtofsRunFor } from '../currents/rtofs';
import { SmocClient, SmocCurrentSource, type SmocRun, type SmocSettings } from '../currents/smoc';
import { CurrentStack } from '../currents/stack';
import type { CurrentSourceLike } from '../currents/types';
import { openDecodedRun } from '../data/decoded';
import type { CurrentSource } from '../engine/environment';
import { NoCurrent } from '../engine/environment';
import { RouteError } from '../engine/errors';
import type { LegWind } from '../engine/horizon';
import { LayeredWind, type RegionalWind } from '../engine/layeredwind';
import type { SimOptions } from '../engine/legsim';
import { MeshLand } from '../engine/mesh/land';
import type { MeshLegArgs } from '../engine/mesh/leg';
import { runMeshLeg } from '../engine/mesh/legrun';
import { type DrawbridgeChoice, type MeshRules, searchMesh } from '../engine/mesh/route';
import { MeshStore } from '../engine/mesh/store';
import type { LegPlan } from '../engine/multileg';
import type { PropagatorOptions } from '../engine/propagator';
import type { Route, StageFront } from '../engine/route';
import type { RouterKind } from '../engine/router';
import { type BBox, bboxFromLonLat } from '../geo/geodesy';
import { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';
import { regionalRunsFor } from './worker/regionalwind';

/** Everything the child needs, serialisable (dates as ms, the polar as its three arrays). */
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
  polar: { twa: number[]; tws: number[]; speeds: number[] } | null;
  sim: SimOptions;
  router?: RouterKind;
  propagator: Omit<PropagatorOptions, 'stages'>;
  stages: number;
  simplifyM: number;
  smoother: boolean;
  smootherTolerance: number;
  drawbridges: DrawbridgeChoice;
  bridgeWaitS: number;
  /** The decoded run and the area to read, or null for calm wind (motor, or no forecast). */
  forecast: { runDir: string; area: BBox; params: string[] } | null;
  /** Regional runs root and the global grid spacing, or null when regional wind is off. */
  regional: { root: string; globalDLon: number } | null;
  /** The currents the worker holds, as the child can rebuild them from disk; null for none. */
  currents: {
    smoc: { cacheDir: string; run: SmocRun; settings: SmocSettings } | null;
    rtofs: { cacheDir: string; region: string; runMs: number; horizonS: number; stepS: number } | null;
    harmonicDir: string | null;
  } | null;
}

export type MeshLegEvent = { event: 'progress'; stage: number; total: number; message: string } | { event: 'frontier'; front: StageFront };

/** fatal: the leg cannot be made as asked (a RouteError: a stretch that cannot be sailed); the route fails with the reason. Otherwise the mesh cannot take the leg and the coastline search does. */
export type MeshLegResult = { ok: true; route: Route } | { ok: false; reason: string; fatal?: boolean };

/** Degrees added around the leg's box for the currents read (the box the mesh search read plus a margin). */
const CURRENTS_MARGIN_DEG = 0.25;

export async function runMeshLegTask(t: MeshLegTask, emit: (e: MeshLegEvent) => void): Promise<MeshLegResult> {
  const progress = (stage: number, total: number, message: string): void => emit({ event: 'progress', stage, total, message });
  const store = MeshStore.open(t.dir);
  const search = searchMesh(store, t.legStart, t.plan.end, t.rules);
  const land = search.result.ok && search.mesh ? new MeshLand(search.mesh.m, search.mesh.blocked) : null;
  if (land)
    progress(0, 0, `${t.tag}chart mesh: the search's every move is tested against the mesh (index {dataSize:${land.indexBytes()}})`);
  const departure = new Date(t.legDepartureMs);
  const wind = await loadWind(t, progress);
  const current = await loadCurrents(t, search.box, progress);
  const polar = t.polar ? new PolarDiagram(t.polar.twa, t.polar.tws, t.polar.speeds) : null;
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
    sim: t.sim,
    router: t.router,
    propagator: t.propagator,
    stages: t.stages,
    simplifyM: t.simplifyM,
    smoother: t.smoother,
    smootherTolerance: t.smootherTolerance,
    drawbridges: t.drawbridges,
    bridgeWaitS: t.bridgeWaitS,
    progress,
    shouldCancel: () => false, // cancel kills the process (childtask.ts)
  };
  let route: Route | null;
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
  if (!route) return { ok: false, reason: 'the mesh cannot take the leg (see the log)' };
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
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(t.currents.harmonicDir)
        .filter(f => f.toLowerCase().endsWith('.npz'))
        .sort();
    } catch (err) {
      progress(0, 0, `WARNING: ${t.tag}chart mesh: harmonic currents not read (${(err as Error).message})`);
    }
    for (const f of files) {
      try {
        sources.push(new HarmonicCurrentSource(path.join(t.currents.harmonicDir, f)));
      } catch (err) {
        progress(0, 0, `WARNING: ${t.tag}chart mesh: harmonic currents ${f} not read (${(err as Error).message})`);
      }
    }
  }
  if (t.currents.smoc) {
    const c = t.currents.smoc;
    try {
      const client = new SmocClient({ cacheDir: c.cacheDir, network: false });
      const src = new SmocCurrentSource(c.run, c.settings, client);
      const steps = src.stepsBetween(t.legDepartureMs, Math.max(t.legDepartureMs, Date.now() + c.settings.horizonS * 1000));
      if (steps.length) {
        await src.ensure(area, steps, { reason: 'mesh leg' });
        sources.push(src);
        progress(0, 0, `${t.tag}chart mesh: CMEMS SMOC read from the cache: {dataSize:${src.memoryBytes()}}`);
      }
    } catch (err) {
      progress(
        0,
        0,
        `WARNING: ${t.tag}chart mesh: CMEMS SMOC not read from the cache (${(err as Error).message}); lower-priority current sources are used`
      );
    }
  }
  if (t.currents.rtofs) {
    const c = t.currents.rtofs;
    try {
      const client = new RtofsClient({
        cacheDir: c.cacheDir,
        region: c.region,
        fetchImpl: () => Promise.reject(new Error('the mesh process never uses the network')),
      });
      const steps = await loadRtofsSteps(client, rtofsRunFor(new Date(c.runMs)), area, c.horizonS, c.stepS);
      if (steps.length) {
        const g = steps[0].u;
        const extent = { south: g.lat0, west: g.lon0, north: g.lat0 + (g.nLat - 1) * g.dLat, east: g.lon0 + (g.nLon - 1) * g.dLon };
        const src = new RtofsCurrentSource(`RTOFS-${c.region}`, c.runMs, extent, steps);
        sources.push(src);
        progress(0, 0, `${t.tag}chart mesh: RTOFS read from the cache: {dataSize:${src.bytes()}}`);
      }
    } catch (err) {
      progress(0, 0, `WARNING: ${t.tag}chart mesh: RTOFS not read from the cache (${(err as Error).message})`);
    }
  }
  return sources.length ? new CurrentStack(sources) : new NoCurrent();
}
