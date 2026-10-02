/**
 * Forecast: the decoded run in use, its refresh (adopt from disk or decode from the GRIB cache), windows read from it.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import { HOUR_MS, HOUR_S } from '../../geo/units';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { availableSteps, type Cycle, cycleFor, EcmwfClient, latestExpectedCycle } from '../../data/ecmwf';
import { ForecastStore } from '../../data/forecast';
import { decodeForecastToDisk, requestedParams, resolveCycle, type ResolvedCycle } from '../../data/loader';
import {
  cycleName,
  DECODED_DIR,
  DecodedRun,
  DecodedRunWriter,
  dirBytes,
  listDecodedRuns,
  openDecodedRun,
  pruneDecodedRuns,
  type WindowOptions,
} from '../../data/decoded';
import { checkDecodeResources } from '../memguard';
import { releaseMemory } from '../../util/gc';
import { type ResolvedConfig } from '../config';
import { requireInit } from './state';
import type { WorkerState } from './state';

/** ECMWF open-data short names; 2 m dew point is `2d` in the index files, 10 m wind gust `10fg`, total cloud cover `tcc`. */
const EXTRA_ATM = ['2t', 'tprate', 'skt', '2d', 'ptype', 'tcc', '10fg'];

export function extraParams(cfg: ResolvedConfig): string[] {
  return cfg.forecast.extraFields ? EXTRA_ATM : [];
}

/** Parameters the configured forecast holds (atmosphere + waves), in store order. */
export function wantedParams(cfg: ResolvedConfig): string[] {
  return requestedParams({ extraAtmParams: extraParams(cfg) });
}

/** Was this decoded run made for the configured horizon and field set? */
export function runFitsConfig(r: DecodedRun, cfg: ResolvedConfig): boolean {
  const want = wantedParams(cfg);
  const have = r.index.request.params;
  const steps = availableSteps(cycleFor(r.cycleTime), cfg.forecast.horizonS / HOUR_S);
  return (
    want.length === have.length &&
    want.every((p, i) => p === have[i]) &&
    steps.length === r.index.stepHours.length &&
    steps.every((h, i) => h === r.index.stepHours[i])
  );
}

/** Is the run in use this cycle (or newer) and made for the current settings? */
export function runMatches(st: WorkerState, cfg: ResolvedConfig, c: Cycle): boolean {
  return !!st.run && st.run.index.cycleTimeMs >= c.time.getTime() && runFitsConfig(st.run, cfg);
}

export function decodedRoot(st: WorkerState): string {
  return path.join(st.cacheRoot, DECODED_DIR);
}

/** A complete decoded run of `c` on disk made for the current settings, or null. */
export function decodedRunOnDisk(st: WorkerState, cfg: ResolvedConfig, c: Cycle): DecodedRun | null {
  const dir = path.join(decodedRoot(st), cycleName(c.time));
  if (!fs.existsSync(dir)) return null;
  const { run: r, problem } = openDecodedRun(dir);
  if (!r) {
    st.log('info', `forecast: decoded run ${dir} not usable (${problem}); decoding again`);
    return null;
  }
  if (!runFitsConfig(r, cfg)) {
    st.log(
      'info',
      `forecast: decoded run ${path.basename(dir)} was made for other settings (${r.index.request.horizonHours} h, ${r.index.request.params.join('/')}); decoding again`
    );
    return null;
  }
  return r;
}

/** Newest complete decoded run on disk for the current settings (offline fallback), or null. */
export function newestDecodedRun(st: WorkerState, cfg: ResolvedConfig): DecodedRun | null {
  for (const name of listDecodedRuns(decodedRoot(st))) {
    const { run: r } = openDecodedRun(path.join(decodedRoot(st), name));
    if (r && runFitsConfig(r, cfg)) return r;
  }
  return null;
}

export function refreshDiskBytes(st: WorkerState): void {
  st.diskBytes = { decoded: dirBytes(decodedRoot(st)), grib: st.client ? dirBytes(st.client.cacheDir) : 0 };
}

/** Make `r` the run in use and tell the main thread (which relays it to the route worker). */
export function adoptRun(st: WorkerState, r: DecodedRun, source: 'disk' | 'grib', readyMs: number, downloaded: number): void {
  st.run = r;
  st.runInfo = { dir: r.dir, index: r.index, loadedAtMs: Date.now(), source, readyMs, downloaded };
  const c = r.cycleTime;
  st.log(
    'info',
    `forecast global: cycle ${c.toISOString().slice(0, 10).replace(/-/g, '')} ${c.toISOString().slice(11, 13)}z${source === 'disk' ? ' (decoded run on disk)' : downloaded === 0 ? ' (from disk cache)' : ''}, ${r.index.steps.length} steps, ${r.index.request.params.join('/')}, ${(r.index.bytes / 1e6).toFixed(1)} MB decoded on disk, 0 MB resident, ${(readyMs / 1000).toFixed(1)} s`
  );
  st.send({ type: 'forecast', run: st.runInfo });
}

export function pruneForecastCaches(st: WorkerState, cfg: ResolvedConfig, cl: EcmwfClient, current: Cycle): void {
  const keep = keepCycles(current, cfg.forecast.keepCycles);
  try {
    cl.pruneCache(keep);
  } catch (err) {
    st.log('error', `cache prune failed: ${(err as Error).message}`);
  }
  try {
    const names = keep.map(c => cycleName(c.time));
    if (st.run) names.push(path.basename(st.run.dir));
    const removed = pruneDecodedRuns(decodedRoot(st), names);
    if (removed.length) st.log('info', `forecast: removed decoded run(s) ${removed.join(', ')}`);
  } catch (err) {
    st.log('error', `decoded run prune failed: ${(err as Error).message}`);
  }
  refreshDiskBytes(st);
}

/**
 * Data worker: make the newest cycle's decoded run current.
 *  1. The run in use already is that cycle (for the current settings): nothing to do.
 *  2. A complete decoded run of that cycle is on disk (a restart): adopt it, no decode.
 *  3. Otherwise decode it from the GRIB cache (downloading what is missing)
 *     straight to disk, one step at a time, then adopt it.
 * `force` skips 1 and 2: the run is decoded again from the GRIB cache.
 * The run in use keeps answering until the new one is complete; memory
 * during the decode is one step (streamingDecodeBytes), not a store.
 */
export async function refreshForecast(st: WorkerState, force: boolean): Promise<void> {
  const { config: cfg, client: cl } = requireInit(st);
  const horizon = cfg.forecast.horizonS;
  const t = Date.now();
  const expected = latestExpectedCycle(new Date(), horizon);
  if (!force && runMatches(st, cfg, expected)) {
    st.send({ type: 'forecast-unchanged', cycleTimeMs: st.run!.index.cycleTimeMs });
    return;
  }
  if (!force) {
    const onDisk = decodedRunOnDisk(st, cfg, expected);
    if (onDisk) {
      adoptRun(st, onDisk, 'disk', Date.now() - t, 0);
      pruneForecastCaches(st, cfg, cl, expected);
      return;
    }
  }
  let resolved: ResolvedCycle;
  try {
    resolved = await resolveCycle(cl, horizon, { extraAtmParams: extraParams(cfg), log: m => st.log('info', `forecast: ${m}`) });
  } catch (err) {
    // Offline with no complete GRIB cycle: a decoded run on disk still serves.
    const fallback = !st.run ? newestDecodedRun(st, cfg) : null;
    if (fallback) {
      st.log('info', `forecast: ${(err as Error).message}; using the decoded run ${path.basename(fallback.dir)} on disk`);
      adoptRun(st, fallback, 'disk', Date.now() - t, 0);
      return;
    }
    st.send({ type: 'refresh-error', message: (err as Error).message });
    return;
  }
  const cycle = resolved.cycle;
  if (!force && runMatches(st, cfg, cycle)) {
    st.send({ type: 'forecast-unchanged', cycleTimeMs: st.run!.index.cycleTimeMs });
    return;
  }
  if (!force && cycle.time.getTime() !== expected.time.getTime()) {
    const onDisk = decodedRunOnDisk(st, cfg, cycle);
    if (onDisk) {
      adoptRun(st, onDisk, 'disk', Date.now() - t, 0);
      pruneForecastCaches(st, cfg, cl, cycle);
      return;
    }
  }
  // Nothing in use yet (a start with a newer cycle out): serve the newest
  // complete decoded run on disk while this cycle decodes, so the overlays,
  // the Weather API and routes do not wait minutes for the download.
  if (!st.run) {
    const interim = newestDecodedRun(st, cfg);
    if (interim) {
      st.log(
        'info',
        `forecast: serving the decoded run ${path.basename(interim.dir)} on disk while cycle ${cycleName(cycle.time)} decodes`
      );
      adoptRun(st, interim, 'disk', Date.now() - t, 0);
    }
  }
  // Guard: memory for one step of decoding, disk for the whole run.
  fs.mkdirSync(decodedRoot(st), { recursive: true });
  const res = checkDecodeResources(horizon, cfg.forecast.extraFields, cfg.forecast.memoryHeadroomBytes, decodedRoot(st));
  if (!res.ok) {
    st.log('error', `forecast: ${res.message} [${res.source}]`);
    st.send({ type: 'refresh-error', message: res.message });
    return;
  }
  st.log('debug', `forecast: resource check ok: ${res.message} [${res.source}]`);
  let writer: DecodedRunWriter | null = null;
  try {
    writer = new DecodedRunWriter(decodedRoot(st), cycleName(cycle.time));
    st.decodingBlockBytes = res.needBytes;
    const out = await decodeForecastToDisk(cl, writer, {
      horizonS: horizon,
      cycle,
      extraAtmParams: extraParams(cfg),
      log: m => st.log('debug', `forecast: ${m}`),
      onStep: (done, total) => {
        if (done === 1 || done % 5 === 0 || done === total) st.log('debug', `forecast: decoded and wrote step ${done}/${total}`);
      },
    });
    const opened = openDecodedRun(writer.finalDir);
    if (!opened.run) throw new Error(`the decoded run just written is not usable: ${opened.problem}`);
    st.lastDecode = {
      at: new Date().toISOString(),
      cycle: out.index.cycle,
      ms: out.index.decodeMs,
      stepBlockBytes: out.stepBlockBytes,
      writtenBytes: out.index.bytes,
      downloaded: out.downloaded,
    };
    st.decodingBlockBytes = null;
    // Let the one-step block and the decode buffers go now.
    releaseMemory();
    adoptRun(st, opened.run, 'grib', Date.now() - t, out.downloaded);
    pruneForecastCaches(st, cfg, cl, cycle);
  } catch (err) {
    st.decodingBlockBytes = null;
    writer?.abort();
    releaseMemory();
    st.send({ type: 'refresh-error', message: (err as Error).message });
  }
}

export function keepCycles(current: Cycle, n: number): Cycle[] {
  const out: Cycle[] = [];
  for (let i = 0; i < n; i++) out.push(cycleFor(new Date(current.time.getTime() - i * 6 * HOUR_MS)));
  return out;
}

/**
 * Read a window of the decoded run, noting the memory it holds while in
 * use. A run replaced (and pruned) between choosing it and reading it is
 * retried once with the run now current.
 */
export async function readWindow(st: WorkerState, what: string, opts: WindowOptions): Promise<ForecastStore> {
  const r = st.run;
  if (!r) throw new Error('no forecast loaded');
  const t = Date.now();
  let store: ForecastStore;
  try {
    store = await r.window(opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && st.run && st.run !== r) store = await st.run.window(opts);
    else throw err;
  }
  const bytes = store.bytes();
  st.forecastMemory.heldBytes += bytes;
  if (!st.forecastMemory.last || bytes >= st.forecastMemory.last.bytes || Date.now() - Date.parse(st.forecastMemory.last.at) > 600_000) {
    st.forecastMemory.last = { what, bytes, readMs: Date.now() - t, at: new Date().toISOString() };
  }
  return store;
}

export function releaseWindow(st: WorkerState, store: ForecastStore | null): void {
  if (!store) return;
  st.forecastMemory.heldBytes = Math.max(0, st.forecastMemory.heldBytes - store.bytes());
}
