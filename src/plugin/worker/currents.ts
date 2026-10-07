/**
 * Currents: the stack of sources (tidal harmonics, CMEMS SMOC, RTOFS), their refresh, and SMOC loaded on demand for a query.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import { HOUR_MS, HOUR_S, MINUTE_MS } from '../../geo/units';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BBox } from '../../geo/geodesy';
import { HarmonicCurrentSource } from '../../currents/harmonic';
import { CurrentStack } from '../../currents/stack';
import { loadRtofsSteps, RtofsCurrentSource, type RtofsRun, rtofsRunFor, shareRtofsSteps } from '../../currents/rtofs';
import { type CurrentSourceLike } from '../../currents/types';
import {
  alignedSteps,
  loadResident,
  residentStale,
  SMOC_DEFAULT_BUDGET_BYTES,
  SmocClient,
  SmocCurrentSource,
  type SmocRun,
  type SmocSettings,
} from '../../currents/smoc';
import { type ResolvedConfig } from '../config';
import { type DataStatus, type QueryArgs } from '../protocol';
import { requireInit } from './state';
import type { WorkerState } from './state';

/** Overlay / conditions queries wait at most this long for an on-demand SMOC load. */
const SMOC_QUERY_DEADLINE_MS = MINUTE_MS;

export function rebuildStack(st: WorkerState): void {
  const sources: CurrentSourceLike[] = [...st.harmonic];
  if (st.smoc) sources.push(st.smoc);
  if (st.rtofs) sources.push(st.rtofs);
  st.stack = new CurrentStack(sources);
}

export function currentsStatus(st: WorkerState): DataStatus['currents'] {
  return st.stack.sources.map(s => {
    if (s instanceof SmocCurrentSource) {
      const st = s.status();
      return {
        name: s.name,
        priority: s.priority,
        resolutionM: s.resolutionM,
        bbox: st.resident ? st.resident.bbox : s.bbox,
        validFrom: st.resident?.valid_from ?? undefined,
        validTo: st.resident?.valid_to ?? undefined,
        smoc: st,
      };
    }
    return {
      name: s.name,
      priority: s.priority,
      resolutionM: s.resolutionM,
      bbox: s.bbox,
      validFrom: s instanceof RtofsCurrentSource ? s.validRange[0].toISOString() : undefined,
      validTo: s instanceof RtofsCurrentSource ? s.validRange[1].toISOString() : undefined,
    };
  });
}

export function sendCurrents(st: WorkerState): void {
  st.send({
    type: 'currents',
    status: currentsStatus(st),
    rtofsRun: st.rtofs ? new Date(st.rtofs.runMs).toISOString().slice(0, 10) : null,
  });
}

export function smocSettings(cfg: ResolvedConfig): SmocSettings {
  return {
    stepS: cfg.currents.smocStepS,
    horizonS: cfg.currents.smocHorizonS,
    halfWidthDeg: cfg.currents.smocHalfWidthDeg,
    budgetBytes: SMOC_DEFAULT_BUDGET_BYTES,
  };
}

export function makeSmocClient(st: WorkerState, cfg: ResolvedConfig): SmocClient | null {
  if (!cfg.currents.smocEnabled) return null;
  return new SmocClient({ cacheDir: path.join(st.cacheRoot, 'smoc'), log: m => st.log('debug', m) });
}

/** data worker → main → route worker: the run and the resident area (shared memory). */
export function sendSmoc(st: WorkerState): void {
  if (st.role === 'data') st.send({ type: 'smoc', smoc: st.smoc ? st.smoc.serialize() : null });
}

/**
 * Data worker: check the store for a new daily run (cheap: .zmetadata +
 * STAC), load the resident area around the vessel for the current
 * window when the run, the window or the position changed, and prune
 * superseded cached runs. Offline, the newest cached run is used.
 */
export async function refreshSmoc(st: WorkerState): Promise<void> {
  const { config: cfg } = requireInit(st);
  if (!cfg.currents.smocEnabled || !st.smocClient) {
    if (st.smoc) {
      st.smoc = null;
      rebuildStack(st);
      sendSmoc(st);
    }
    return;
  }
  const settings = smocSettings(cfg);
  let run: SmocRun | null;
  try {
    const probed = await st.smocClient.probe(st.smoc?.run ?? null);
    if (probed.settled || !st.smoc) {
      run = probed;
      if (!probed.settled)
        st.log(
          'info',
          `smoc: the store update is still being written (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); using run ${probed.key} provisionally`
        );
    } else {
      st.log(
        'info',
        `smoc: store update in progress (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); keeping run ${st.smoc.run.key}`
      );
      run = st.smoc.run;
    }
  } catch (err) {
    st.log('error', `smoc: cannot reach the Copernicus Marine store: ${(err as Error).message}`);
    run = st.smoc?.run ?? st.smocClient.cachedRuns()[0] ?? null;
    if (run && !st.smoc) st.log('info', `smoc: using cached run ${run.key} (offline)`);
  }
  if (!run) return;
  // A run first loaded while its update was still being written is
  // reloaded from scratch once the update has finished (its cached
  // chunks may predate the update).
  const provisionalReplaced = !!st.smoc && st.smoc.run.key === run.key && !st.smoc.run.settled && run.settled;
  const newRun = !st.smoc || st.smoc.run.key !== run.key || provisionalReplaced;
  const now = Date.now();
  const steps = alignedSteps(run, now, now + settings.horizonS * 1000, settings.stepS / HOUR_S);
  const src = newRun ? new SmocCurrentSource(run, settings, st.smocClient, m => st.log('info', m)) : st.smoc!;
  if (!newRun) src.expire(now);
  if (provisionalReplaced) st.smocClient.dropRun(run.key);
  if (newRun) st.smocClient.saveRun(run);
  const pos = st.vesselPos;
  let changed = newRun;
  if (pos && (newRun || residentStale(src, pos, steps))) {
    try {
      const t = Date.now();
      const res = await loadResident(st.smocClient, run, settings, pos, steps, { log: m => st.log('info', m) });
      if (res) {
        src.setResident(res.area, pos);
        src.noteDownload('resident area', res.stats);
        changed = true;
        st.log(
          'info',
          `smoc: run ${run.key}: resident ${res.area.nRows}×${res.area.nCols} cells × ${steps.length} steps, ${(src.memoryBytes() / 1e6).toFixed(1)} MB resident, downloaded ${(res.stats.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`
        );
      }
    } catch (err) {
      st.log('error', `smoc: resident area load failed: ${(err as Error).message}`);
      if (newRun && st.smoc) return; // keep serving the previous run
    }
  } else if (newRun && !pos) {
    st.log('info', `smoc: run ${run.key}: no vessel position; nothing resident, areas load on demand`);
  }
  if (newRun) {
    st.smoc = src;
    const removed = st.smocClient.pruneRuns([run.key]);
    if (removed.length) st.log('info', `smoc: removed superseded cached run(s) ${removed.join(', ')}`);
  }
  if (changed || newRun) {
    rebuildStack(st);
    sendSmoc(st);
  }
}

/**
 * Before an overlay / conditions query: load SMOC for the query box on
 * demand when it is not resident (bounded wait; see ensure()). False
 * when the answer will lack SMOC data it should have.
 */
export async function prepareSmocForQuery(st: WorkerState, kind: string, args: QueryArgs[keyof QueryArgs]): Promise<boolean> {
  if (!st.smoc || !st.config?.currents.smocEnabled) return true;
  const src = st.smoc;
  let bbox: BBox | null;
  let steps: number[];
  let coarseOk = false;
  switch (kind) {
    case 'field': {
      const a = args as QueryArgs['field'];
      if (a.layer !== 'current' && a.layer !== 'sea_state') return true;
      bbox = a.bbox;
      steps = src.bracketSteps(a.timeMs);
      coarseOk = a.res >= 0.25;
      break;
    }
    case 'currents':
    case 'sea_points': {
      const a = args as QueryArgs['currents'];
      bbox = a.bbox;
      steps = src.bracketSteps(a.timeMs);
      coarseOk = a.res >= 0.25;
      break;
    }
    case 'conditions': {
      const a = args as QueryArgs['conditions'];
      bbox = { west: a.lon - 0.05, east: a.lon + 0.05, south: a.lat - 0.05, north: a.lat + 0.05 };
      const end = Math.min(a.fromMs + a.hours * HOUR_MS, Date.now() + src.settings.horizonS * 1000);
      steps = src.stepsBetween(a.fromMs, Math.max(a.fromMs, end));
      break;
    }
    default:
      return true;
  }
  if (!bbox || steps.length === 0) return true;
  let complete = true;
  try {
    await src.ensure(bbox, steps, {
      reason: `${kind} query`,
      deadlineMs: SMOC_QUERY_DEADLINE_MS,
      coarseOk,
      onIncomplete: () => (complete = false),
    });
  } catch (err) {
    st.log('error', (err as Error).message);
    complete = false;
  }
  return complete;
}

export function loadHarmonic(st: WorkerState, dir: string | null): void {
  st.harmonic = [];
  if (!dir) return;
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.npz'))
      .sort();
  } catch (err) {
    st.log('error', `currents: cannot read harmonic directory ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const t = Date.now();
      const s = new HarmonicCurrentSource(p);
      st.harmonic.push(s);
      st.log(
        'info',
        `currents: ${s.name}: ${s.constituents.length} constituents${s.dropped.length ? ` (dropped ${s.dropped.join(', ')})` : ''}, ${s.lats.length}×${s.lons.length} grid, priority ${s.priority}, ${(s.blockBytes() / 1e6).toFixed(1)} MB shared, ${Date.now() - t} ms`
      );
    } catch (err) {
      st.log('error', `currents: failed to load ${p}: ${(err as Error).message}`);
    }
  }
}

/** data worker → main → route and tiles workers: the RTOFS run (shared memory, no copy). */
export function sendRtofs(st: WorkerState): void {
  if (st.role === 'data') st.send({ type: 'rtofs', rtofs: st.rtofs ? st.rtofs.serialize() : null });
}

/**
 * Data worker: load the newest RTOFS run (network, else the disk cache) into
 * shared memory and relay it. The route and tiles workers do not load RTOFS
 * themselves: they adopt the data worker's run ('rtofs' message).
 */
export async function refreshRtofs(st: WorkerState, networkAllowed: boolean): Promise<void> {
  const { config: cfg } = requireInit(st);
  if (st.role !== 'data') return;
  if (!cfg.currents.rtofsEnabled || !st.rtofsClient) return;
  const horizon = cfg.currents.rtofsHorizonS;
  let run: RtofsRun | null;
  const cachedRuns = st.rtofsClient.cachedRuns().filter(r => st.rtofsClient!.runFullyCached(r, horizon));
  if (networkAllowed) {
    // Fresh enough already? The daily run appears during the morning;
    // if today's run is cached there is nothing to do.
    const today = rtofsRunFor(new Date());
    if (st.rtofsClient.runFullyCached(today, horizon)) run = today;
    else {
      try {
        run = await st.rtofsClient.findLatestRun(horizon);
      } catch (err) {
        st.log('error', `rtofs: ${(err as Error).message}`);
        run = cachedRuns[0] ?? null;
      }
    }
  } else {
    run = cachedRuns[0] ?? null;
  }
  if (!run) {
    if (st.rtofs) st.log('info', 'rtofs: keeping the resident run');
    return;
  }
  if (st.rtofs && st.rtofs.runMs === run.time.getTime()) return;
  try {
    const t = Date.now();
    // The whole configured RTOFS product (cfg.currents.rtofsRegion), uncropped.
    const steps = await loadRtofsSteps(st.rtofsClient, run, null, horizon, cfg.currents.rtofsStepS, { log: m => st.log('debug', m) });
    if (steps.length === 0) throw new Error(`run ${run.yyyymmdd} has no steps in product ${st.rtofsClient.region}`);
    const g = steps[0].u;
    const extent = { south: g.lat0, west: g.lon0, north: g.lat0 + (g.nLat - 1) * g.dLat, east: g.lon0 + (g.nLon - 1) * g.dLon };
    st.rtofs = new RtofsCurrentSource(`RTOFS-${st.rtofsClient.region}`, run.time.getTime(), extent, shareRtofsSteps(steps));
    rebuildStack(st);
    sendRtofs(st);
    st.log(
      'info',
      `rtofs: run ${run.yyyymmdd}, ${steps.length} steps, ${(st.rtofs.bytes() / 1e6).toFixed(1)} MB resident, ${((Date.now() - t) / 1000).toFixed(1)} s`
    );
    if (networkAllowed) st.rtofsClient.pruneCache([run, ...cachedRuns.slice(0, 1)]);
  } catch (err) {
    st.log('error', `rtofs: load failed: ${(err as Error).message}`);
  }
}
