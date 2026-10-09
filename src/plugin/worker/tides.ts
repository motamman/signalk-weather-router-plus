/**
 * Tides: the Copernicus Marine sea level, its refresh, point series and the map area loaded on demand for a query.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import { HOUR_MS, MINUTE_MS } from '../../geo/units';
import * as path from 'node:path';

import { loadTideResident, SeaLevelClient, TIDE_DEFAULT_BUDGET_BYTES, type TideSettings, TideSource } from '../../tides/sealevel';
import { type ArcoRun } from '../../data/arco';
import { type ConditionsTide } from '../overlays';
import { type ResolvedConfig } from '../config';
import { type QueryArgs, type TideSeriesResult } from '../protocol';
import { requireInit } from './state';
import type { WorkerState } from './state';

/** Map / conditions queries wait at most this long for a tide download. */
const TIDE_QUERY_DEADLINE_MS = MINUTE_MS;

export function tideSettings(cfg: ResolvedConfig): TideSettings {
  return { halfWidthDeg: cfg.tides.halfWidthDeg, horizonS: cfg.tides.horizonS, budgetBytes: TIDE_DEFAULT_BUDGET_BYTES };
}

export function makeSeaLevelClient(st: WorkerState, cfg: ResolvedConfig): SeaLevelClient | null {
  if (st.role === 'route' || !cfg.tides.enabled) return null;
  return new SeaLevelClient({ cacheDir: path.join(st.cacheRoot, 'sealevel'), log: m => st.log('debug', m) });
}

/**
 * Data worker: check the sea-level store for a new daily run (same
 * pattern as SMOC: .zmetadata + STAC; a run still being written is used
 * provisionally only when there is nothing else), rebuild the resident
 * tide map area when the run, the 6-hour-aligned window or the vessel
 * position changed, prune superseded cached runs. Offline, the newest
 * cached run is used.
 */
export async function refreshTides(st: WorkerState): Promise<void> {
  const { config: cfg } = requireInit(st);
  if (!cfg.tides.enabled || !st.seaLevelClient) {
    st.tides = null;
    st.tidesError = null;
    return;
  }
  const settings = tideSettings(cfg);
  let run: ArcoRun | null;
  try {
    const probed = await st.seaLevelClient.probe(st.tides?.run ?? null);
    if (probed.settled || !st.tides) {
      run = probed;
      if (!probed.settled)
        st.log(
          'info',
          `tides: the store update is still being written (STAC updated ${probed.stacUpdated ?? '?'}); using run ${probed.key} provisionally`
        );
    } else {
      st.log('info', `tides: store update in progress (STAC updated ${probed.stacUpdated ?? '?'}); keeping run ${st.tides.run.key}`);
      run = st.tides.run;
    }
    st.tidesError = null;
  } catch (err) {
    st.tidesError = `cannot reach the Copernicus Marine sea-level store: ${(err as Error).message}`;
    st.log('error', `tides: ${st.tidesError}`);
    run = st.tides?.run ?? st.seaLevelClient.cachedRuns()[0] ?? null;
    if (run && !st.tides) st.log('info', `tides: using cached run ${run.key} (offline)`);
  }
  if (!run) return;
  const provisionalReplaced = !!st.tides && st.tides.run.key === run.key && !st.tides.run.settled && run.settled;
  const newRun = !st.tides || st.tides.run.key !== run.key || provisionalReplaced;
  const now = Date.now();
  const src = newRun ? new TideSource(run, settings, st.seaLevelClient, m => st.log('info', m)) : st.tides!;
  if (!newRun) src.expire(now);
  if (newRun) st.seaLevelClient.saveRun(run);
  const steps = src.windowSteps(now);
  const pos = st.vesselPos;
  if (pos && (newRun || src.residentStale(pos, steps))) {
    try {
      const t = Date.now();
      const res = await loadTideResident(st.seaLevelClient, run, settings, pos, steps, { log: m => st.log('info', m) });
      if (res) {
        src.setResident(res.area, pos);
        src.noteDownload('resident tide area', res.stats);
        st.log(
          'info',
          `tides: run ${run.key}: resident ${res.area.nRows}×${res.area.nCols} cells × ${steps.length} hourly steps, ${(src.memoryBytes() / 1e6).toFixed(1)} MB, downloaded ${(res.stats.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`
        );
      }
    } catch (err) {
      st.tidesError = `resident tide area load failed: ${(err as Error).message}`;
      st.log('error', `tides: ${st.tidesError}`);
      if (newRun && st.tides) return; // keep serving the previous run
    }
  } else if (newRun && !pos) {
    st.log('info', `tides: run ${run.key}: no vessel position; nothing resident, map areas load on demand`);
  }
  if (newRun) {
    st.tides = src;
    // Also removes the provisional directory the settled run replaces: only
    // now, so a failed load above leaves the still-serving run its chunks.
    const removed = st.seaLevelClient.pruneRuns([run]);
    if (removed.length) st.log('info', `tides: removed superseded cached run(s) ${removed.join(', ')}`);
  }
}

/**
 * Before a tide map query: load the view's hour on demand when not
 * resident (bounded wait). False when the answer will lack tide data it
 * should have (no run adopted yet, deadline passed or the load failed).
 */
export async function prepareTidesForQuery(st: WorkerState, kind: string, args: QueryArgs[keyof QueryArgs]): Promise<boolean> {
  if (kind !== 'field') return true;
  const a = args as QueryArgs['field'];
  if (a.layer !== 'tide') return true;
  if (!st.tides) return !st.config?.tides.enabled; // enabled but no run adopted yet: the answer lacks tide data
  const steps = st.tides.bracketSteps(a.timeMs);
  if (!steps.length) return true;
  let complete = true;
  try {
    await st.tides.ensure(a.bbox, steps, {
      reason: 'tide map query',
      deadlineMs: TIDE_QUERY_DEADLINE_MS,
      coarseOk: a.res >= 0.25,
      onIncomplete: () => (complete = false),
    });
  } catch (err) {
    st.log('error', (err as Error).message);
    complete = false;
  }
  return complete;
}

/** A promise with a deadline: rejects with `message` when it takes longer (the work itself continues). */
export function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const d = new Promise<never>((_r, rej) => {
    timer = setTimeout(() => rej(new Error(message)), ms);
  });
  return Promise.race([p, d]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Tide point series for a conditions query (null when tides are off). */
export async function conditionsTide(st: WorkerState, a: QueryArgs['conditions']): Promise<ConditionsTide | null> {
  if (!st.config?.tides.enabled) return null;
  if (!st.tides) return { series: null, error: st.tidesError ?? 'tide data not loaded yet' };
  try {
    const p = st.tides.pointSeries(a.lat, a.lon, a.fromMs, a.fromMs + a.hours * HOUR_MS, { reason: 'conditions query' });
    p.catch(() => undefined);
    const series = await withDeadline(p, TIDE_QUERY_DEADLINE_MS, 'tide series still downloading; try again shortly');
    return { series, error: series ? null : 'outside the sea-level grid or its time range' };
  } catch (err) {
    st.log('error', `tides: conditions query: ${(err as Error).message}`);
    return { series: null, error: (err as Error).message };
  }
}

/** Point series for the Weather API (structured-cloneable). */
export async function tideSeriesQuery(st: WorkerState, a: QueryArgs['tide_series']): Promise<TideSeriesResult> {
  const empty = (error: string): TideSeriesResult => ({
    run: null,
    t0Ms: 0,
    stepMs: HOUR_MS,
    waterLevel: new Float64Array(0),
    tide: new Float64Array(0),
    surge: new Float64Array(0),
    error,
  });
  if (!st.config?.tides.enabled) return empty('tides are turned off');
  if (!st.tides) return empty(st.tidesError ?? 'tide data not loaded yet');
  const p = st.tides.pointSeries(a.lat, a.lon, a.fromMs, a.fromMs + a.hours * HOUR_MS, { reason: 'Weather API' });
  p.catch(() => undefined);
  const s = await withDeadline(p, TIDE_QUERY_DEADLINE_MS, 'tide series still downloading; try again shortly');
  if (!s) return empty('outside the sea-level grid or its time range');
  return { run: s.run, t0Ms: s.t0Ms, stepMs: s.stepMs, waterLevel: s.waterLevel, tide: s.tide, surge: s.surge, error: null };
}
