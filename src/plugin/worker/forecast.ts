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
import { availableSteps, type Cycle, cycleFor, EcmwfClient, ENSEMBLES, type EnsembleModelId, latestExpectedCycle } from '../../data/ecmwf';
import {
  ENSEMBLE_DECODED_DIR,
  ENSEMBLE_GRIB_DIR,
  ensembleMembers,
  memberComplete,
  pruneEnsembles,
  readEnsembleCurrent,
} from '../../data/ensemble';
import { ForecastStore } from '../../data/forecast';
import { isOffline } from '../../data/http';
import { requestedParams, resolveCycle, type ResolvedCycle } from '../../data/loader';
import {
  cycleName,
  DECODED_DIR,
  DecodedRun,
  dirBytes,
  listDecodedRuns,
  openDecodedRun,
  pruneDecodedRuns,
  type WindowOptions,
} from '../../data/decoded';
import { runChildTask } from '../childtask';
import { checkDecodeResources } from '../memguard';
import { type ResolvedConfig } from '../config';
import { noteNetwork, requireInit } from './state';
import type { WorkerState } from './state';
import type { ForecastLoading, SourceCheck } from '../protocol';

/** ECMWF open-data short names; 2 m dew point is `2d` in the index files, 10 m wind gust `10fg`, total cloud cover `tcc`. */
const EXTRA_ATM = ['2t', 'tprate', 'skt', '2d', 'ptype', 'tcc', '10fg'];

/** Energy-modelling fields (the forecast.energyFields setting, off by default): total precipitation, surface solar radiation, snowfall, surface thermal radiation down and net, most-unstable CAPE. tp/sf/ssrd/strd/str are accumulated since the forecast start; the decode turns them into per-interval values. */
const ENERGY_ATM = ['tp', 'ssrd', 'sf', 'strd', 'str', 'mucape'];

export function extraParams(cfg: ResolvedConfig): string[] {
  return [...(cfg.forecast.extraFields ? EXTRA_ATM : []), ...(cfg.forecast.energyFields ? ENERGY_ATM : [])];
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
 *     straight to disk, one step at a time, in a child process
 *     (forecastdecodetask.ts), then adopt it.
 * `force` skips 1 and 2: the run is decoded again from the GRIB cache.
 * The run in use keeps answering until the new one is complete. Every check
 * ends with what it found (SourceCheck), sent as 'forecast-check'.
 * `offline`: this refresh round already found no connection; the server is
 * not asked again (the reason is reported). `held`: why the internet state
 * holds this round now (internet.ts), or null: no forecast yet is then not
 * an error, so a route waiting for the first forecast keeps waiting
 * (index.ts asks for a round of the owner's for it), and a decode it stops
 * (worker.ts 'internet-hold') is skipped, not failed.
 */
export async function refreshForecast(
  st: WorkerState,
  force: boolean,
  offline: string | null = null,
  held: () => string | null = () => null
): Promise<void> {
  let check: SourceCheck;
  try {
    check = await refreshForecastInner(st, force, offline, held);
  } catch (err) {
    check = { outcome: isOffline(err) ? 'could-not-check' : 'failed', at: '', reason: (err as Error).message };
  } finally {
    // Done, unchanged or failed: nothing is loading any more.
    st.send({ type: 'forecast-loading', loading: null });
  }
  check.at = new Date().toISOString();
  st.checks.ecmwf = check;
  st.send({ type: 'forecast-check', check });
}

const newest = (reason: string | null = null): SourceCheck => ({ outcome: 'newest', at: '', reason });
const newRun = (reason: string): SourceCheck => ({ outcome: 'new-run', at: '', reason });

async function refreshForecastInner(
  st: WorkerState,
  force: boolean,
  offline: string | null,
  held: () => string | null
): Promise<SourceCheck> {
  const { config: cfg, client: cl } = requireInit(st);
  const startedAt = new Date().toISOString();
  // Why a decode would be needed, for the user waiting on it.
  const why: ForecastLoading['why'] = st.run ? 'update' : listDecodedRuns(decodedRoot(st)).length ? 'redecode' : 'first';
  const loading = (l: Omit<ForecastLoading, 'why' | 'startedAt'>): void =>
    st.send({ type: 'forecast-loading', loading: { ...l, why, startedAt } });
  const horizon = cfg.forecast.horizonS;
  const t = Date.now();
  const expected = latestExpectedCycle(new Date(), horizon);
  if (!force && runMatches(st, cfg, expected)) return newest(`cycle ${cycleName(expected.time)} is the newest published`);
  if (!force) {
    const onDisk = decodedRunOnDisk(st, cfg, expected);
    if (onDisk) {
      adoptRun(st, onDisk, 'disk', Date.now() - t, 0);
      pruneForecastCaches(st, cfg, cl, expected);
      return newRun(`cycle ${cycleName(expected.time)} from the decoded run on disk`);
    }
  }
  let resolved: ResolvedCycle;
  loading({ phase: 'checking', cycle: null, done: 0, total: null });
  try {
    resolved = await resolveCycle(cl, horizon, {
      extraAtmParams: extraParams(cfg),
      log: m => st.log('info', `forecast: ${m}`),
      offline: offline ?? undefined,
    });
  } catch (err) {
    const outcome: SourceCheck['outcome'] = isOffline(err) ? 'could-not-check' : 'failed';
    // Offline with no complete GRIB cycle: a decoded run on disk still serves.
    const fallback = !st.run ? newestDecodedRun(st, cfg) : null;
    if (fallback) {
      st.log('info', `forecast: ${(err as Error).message}; using the decoded run ${path.basename(fallback.dir)} on disk`);
      adoptRun(st, fallback, 'disk', Date.now() - t, 0);
      return { outcome, at: '', reason: `${(err as Error).message}; using the decoded run ${path.basename(fallback.dir)} on disk` };
    }
    // No run in use at all: the error the page shows instead of a forecast.
    if (!st.run && !held()) st.send({ type: 'refresh-error', message: (err as Error).message });
    return { outcome, at: '', reason: (err as Error).message };
  }
  const cycle = resolved.cycle;
  // The server could not be asked: the cached cycle is used, not known to be the newest.
  const notChecked = (): SourceCheck => ({ outcome: 'could-not-check', at: '', reason: resolved.fallback ?? null });
  if (!force && runMatches(st, cfg, cycle))
    return resolved.fallback ? notChecked() : newest(`cycle ${cycleName(cycle.time)} is the newest published`);
  if (!force && cycle.time.getTime() !== expected.time.getTime()) {
    const onDisk = decodedRunOnDisk(st, cfg, cycle);
    if (onDisk) {
      adoptRun(st, onDisk, 'disk', Date.now() - t, 0);
      pruneForecastCaches(st, cfg, cl, cycle);
      return resolved.fallback ? notChecked() : newRun(`cycle ${cycleName(cycle.time)} from the decoded run on disk`);
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
  const res = checkDecodeResources(
    horizon,
    cfg.forecast.extraFields,
    cfg.forecast.energyFields,
    cfg.forecast.memoryHeadroomBytes,
    decodedRoot(st)
  );
  if (!res.ok) {
    st.log('error', `forecast: ${res.message} [${res.source}]`);
    st.send({ type: 'refresh-error', message: res.message });
    return { outcome: 'failed', at: '', reason: res.message };
  }
  st.log('debug', `forecast: resource check ok: ${res.message} [${res.source}]`);
  // The interim run above (if any) serves meanwhile: then this is an update, not a wait.
  const cycleIso = cycle.time.toISOString();
  const decoding = (done: number, total: number | null): void =>
    st.send({
      type: 'forecast-loading',
      loading: { phase: 'decoding', why: st.run ? 'update' : why, cycle: cycleIso, done, total, startedAt },
    });
  decoding(0, null);
  st.decodeAbort = new AbortController();
  // A hold that began while the cycle was looked up found no decode to stop: stop it before it downloads (worker.ts
  // 'internet-hold'). A cycle fully in the GRIB cache decodes without the network and goes on.
  if (!resolved.fromCache && held()) st.decodeAbort.abort();
  try {
    // The one-step block lives in the child process; shown in the status while it runs.
    st.decodingBlockBytes = res.needBytes;
    const out = await runChildTask(
      {
        task: 'forecast-decode',
        cacheRoot: st.cacheRoot,
        mirror: cfg.forecast.mirror,
        cycle: cycleIso,
        horizonS: horizon,
        extraAtmParams: extraParams(cfg),
      },
      null,
      st.decodeAbort.signal,
      e => {
        if (e.event === 'decode-step') {
          decoding(e.done, e.total);
          if (e.done === 1 || e.done % 5 === 0 || e.done === e.total)
            st.log('debug', `forecast: decoded and wrote step ${e.done}/${e.total}`);
        } else if (e.event === 'decode-log') st.log('debug', `forecast: ${e.message}`);
      }
    );
    const opened = openDecodedRun(out.dir);
    if (!opened.run) throw new Error(`the decoded run just written is not usable: ${opened.problem}`);
    st.lastDecode = {
      at: new Date().toISOString(),
      cycle: opened.run.index.cycle,
      ms: out.decodeMs,
      stepBlockBytes: out.stepBlockBytes,
      writtenBytes: opened.run.index.bytes,
      downloaded: out.downloaded,
    };
    adoptRun(st, opened.run, 'grib', Date.now() - t, out.downloaded);
    pruneForecastCaches(st, cfg, cl, cycle);
    return resolved.fallback ? notChecked() : newRun(`cycle ${cycleName(cycle.time)} decoded (${out.downloaded} fields downloaded)`);
  } catch (err) {
    // Stopped by the internet state starting to hold (worker.ts 'internet-hold'): skipped, as the sources after it are.
    const h = held();
    if (h && st.decodeAbort?.signal.aborted) {
      st.log('info', `forecast: the decode of cycle ${cycleName(cycle.time)} stops: ${h}`);
      return { outcome: 'could-not-check', at: '', reason: `skipped: ${h}` };
    }
    const offlineNow = isOffline(err);
    // The child's requests are not this thread's: what it found about the connection is recorded here.
    if (offlineNow) noteNetwork(st, 'offline', (err as Error).message);
    // With a run in use, a download that lost the connection is "could not check", not an error to show.
    if (!offlineNow || !st.run) st.send({ type: 'refresh-error', message: (err as Error).message });
    return { outcome: offlineNow ? 'could-not-check' : 'failed', at: '', reason: (err as Error).message };
  } finally {
    st.decodingBlockBytes = null;
    st.decodeAbort = null;
  }
}

/** What stays of each chosen ensemble on disk (data/ensemble.ts pruneEnsembles): the members wanted, the cycle in use, `pending` cycles. */
function ensembleKeep(
  st: WorkerState,
  cfg: ResolvedConfig,
  pending: Partial<Record<EnsembleModelId, string>>
): Parameters<typeof pruneEnsembles>[1] {
  const keep: Parameters<typeof pruneEnsembles>[1] = {};
  for (const m of cfg.forecast.ensemble.models) {
    const cur = readEnsembleCurrent(st.cacheRoot, m);
    keep[m] = {
      members: [...new Set([...ensembleMembers(ENSEMBLES[m], cfg.forecast.ensemble.members), ...(cur ? cur.members : [])])],
      cycles: cur ? [cur.cycle] : [],
      pending: pending[m] ?? null,
    };
  }
  return keep;
}

/** An ensemble's decoded runs and GRIB cache, in bytes: a walk of every file in its folders. */
function ensembleDirBytes(st: WorkerState, model: EnsembleModelId): number {
  return dirBytes(path.join(st.cacheRoot, ENSEMBLE_DECODED_DIR, model)) + dirBytes(path.join(st.cacheRoot, ENSEMBLE_GRIB_DIR, model));
}

/** Each chosen ensemble's bytes on disk, measured now (st.ensembleBytes): after a pass or prune changed them. */
function measureEnsembles(st: WorkerState, models: EnsembleModelId[]): void {
  const out: Partial<Record<EnsembleModelId, number>> = {};
  for (const m of models) out[m] = ensembleDirBytes(st, m);
  st.ensembleBytes = out;
}

/**
 * An ensemble's bytes on disk for the status (query.ts dataStatus): as last measured, or measured once now when it has
 * not been (before the first pass, a model just chosen). Never a walk of its folders per status: the status follows
 * every map query.
 */
export function ensembleBytesOf(st: WorkerState, model: EnsembleModelId): number {
  const known = st.ensembleBytes?.[model];
  if (known !== undefined) return known;
  const b = ensembleDirBytes(st, model);
  st.ensembleBytes = { ...st.ensembleBytes, [model]: b };
  return b;
}

/**
 * Data worker, after the forecast (refresh): the chosen ensembles' members for the cycle of the run in use, downloaded
 * and decoded in a child process (forecastdecodetask.ts runEnsembleDecodeTask) when any is missing. Never touches the
 * main forecast: a failure, a hold or a lack of disk is recorded for the status (st.ensembles) and the ensemble in use
 * stays. Ensembles off: whatever an earlier setting left on disk is removed.
 */
export async function refreshEnsembles(
  st: WorkerState,
  offline: string | null,
  held: () => string | null,
  changed: () => void = () => undefined,
  /** Runs the ensemble-decode child (tests give one that answers without a child process). */
  runTask: typeof runChildTask = runChildTask
): Promise<void> {
  const { config: cfg } = requireInit(st);
  const e = cfg.forecast.ensemble;
  if (!e.models.length) {
    if (fs.existsSync(path.join(st.cacheRoot, ENSEMBLE_DECODED_DIR))) {
      const removed = pruneEnsembles(st.cacheRoot, {});
      if (removed.length) st.log('info', `ensembles: off; removed ${removed.join(', ')}`);
    }
    st.ensembles = {};
    st.ensembleBytes = {};
    return;
  }
  measureEnsembles(st, e.models);
  if (!st.run) return;
  const cycle = cycleName(st.run.cycleTime);
  const horizonHours = cfg.forecast.horizonS / HOUR_S;
  // Each wanted member's decoded run checked once a round (memberComplete reads its index and stats every field file):
  // the models with members still to get, and those members.
  const todo = e.models
    .map(m => ({
      m,
      members: ensembleMembers(ENSEMBLES[m], e.members).filter(n => !memberComplete(st.cacheRoot, m, n, cycle, horizonHours)),
    }))
    .filter(x => x.members.length > 0);
  const missing = todo.map(x => x.m);
  const pending = Object.fromEntries(missing.map(m => [m, cycle])) as Partial<Record<EnsembleModelId, string>>;
  const note = (m: EnsembleModelId, s: Partial<NonNullable<WorkerState['ensembles'][EnsembleModelId]>>): void => {
    // checkedAt last: this note's time, never the entry's earlier one.
    st.ensembles[m] = { loading: null, error: null, ...st.ensembles[m], ...s, checkedAt: new Date().toISOString() };
    changed();
  };
  for (const m of e.models) if (!missing.includes(m)) note(m, { loading: null, error: null });
  if (!missing.length) {
    if (pruneEnsembles(st.cacheRoot, ensembleKeep(st, cfg, {})).length) measureEnsembles(st, e.models);
    return;
  }
  const why = offline ?? held();
  if (why) {
    for (const m of missing) note(m, { loading: null, error: `cycle ${cycle} not downloaded: ${why}` });
    return;
  }
  // The disk is checked in the child, against the exact size of what each model's pass writes (data/ensemble.ts
  // downloadModel, forecastdecodetask.ts diskCheck).
  for (const m of missing) note(m, { loading: { cycle: st.run.cycleTime.toISOString(), done: 0, total: null }, error: null });
  st.ensembleAbort = new AbortController();
  try {
    const results = await runTask(
      {
        task: 'ensemble-decode',
        cacheRoot: st.cacheRoot,
        mirror: cfg.forecast.mirror,
        cycle: st.run.cycleTime.toISOString(),
        horizonS: cfg.forecast.horizonS,
        models: missing,
        members: e.members,
      },
      null,
      st.ensembleAbort.signal,
      ev => {
        // Each step is one model's: the child decodes the models one after the other.
        if (ev.event === 'decode-step' && ev.model)
          note(ev.model, { loading: { cycle: st.run!.cycleTime.toISOString(), done: ev.done, total: ev.total } });
        else if (ev.event === 'decode-log') st.log('info', `ensembles: ${ev.message}`);
      }
    );
    for (const r of results) {
      const failed = r.failed.map(f => `member ${f.member}: ${f.error}`);
      note(r.model, { loading: null, error: r.error ?? (failed.length ? failed.join('; ') : null) });
      if (!r.error && !failed.length) delete pending[r.model];
    }
  } catch (err) {
    const h = held();
    const text = h && st.ensembleAbort?.signal.aborted ? `stopped: ${h}` : (err as Error).message;
    for (const m of missing) note(m, { loading: null, error: `cycle ${cycle} not downloaded: ${text}` });
    st.log('info', `ensembles: cycle ${cycle} not downloaded (${text})`);
  } finally {
    st.ensembleAbort = null;
  }
  const removed = pruneEnsembles(st.cacheRoot, ensembleKeep(st, cfg, pending));
  if (removed.length) st.log('debug', `ensembles: removed ${removed.join(', ')}`);
  measureEnsembles(st, e.models);
  changed();
}

export function keepCycles(current: Cycle, n: number): Cycle[] {
  const out: Cycle[] = [];
  for (let i = 0; i < n; i++) out.push(cycleFor(new Date(current.time.getTime() - i * 6 * HOUR_MS)));
  return out;
}

/**
 * A window of the decoded run, and the run it was read from: a run replaced
 * (and pruned) between choosing it and reading it is retried once with the
 * run now current, so an answer's stamp must name the run actually read.
 */
export interface WindowRead {
  store: ForecastStore;
  run: DecodedRun;
}

/**
 * Read a window of the decoded run, noting the memory it holds while in
 * use. A run replaced (and pruned) between choosing it and reading it is
 * retried once with the run now current. Options that depend on the run
 * (its bracket indices) are computed from the run actually read: pass
 * them as a function of the run; static options as an object. With
 * `pinned`, that run is read and no other (a query reading several windows
 * must not mix two runs): a pruned one is an ENOENT for the caller.
 */
export async function readWindow(
  st: WorkerState,
  what: string,
  opts: WindowOptions | ((run: DecodedRun) => WindowOptions),
  pinned?: DecodedRun
): Promise<WindowRead> {
  const r = pinned ?? st.run;
  if (!r) throw new Error('no forecast loaded');
  const forRun = (run: DecodedRun): WindowOptions => (typeof opts === 'function' ? opts(run) : opts);
  const t = Date.now();
  let store: ForecastStore;
  let read = r;
  try {
    store = await r.window(forRun(r));
  } catch (err) {
    if (!pinned && (err as NodeJS.ErrnoException).code === 'ENOENT' && st.run && st.run !== r) {
      read = st.run;
      store = await st.run.window(forRun(st.run));
    } else throw err;
  }
  const bytes = store.bytes();
  st.forecastMemory.heldBytes += bytes;
  if (!st.forecastMemory.last || bytes >= st.forecastMemory.last.bytes || Date.now() - Date.parse(st.forecastMemory.last.at) > 600_000) {
    st.forecastMemory.last = { what, bytes, readMs: Date.now() - t, at: new Date().toISOString() };
  }
  return { store, run: read };
}

export function releaseWindow(st: WorkerState, store: ForecastStore | null): void {
  if (!store) return;
  st.forecastMemory.heldBytes = Math.max(0, st.forecastMemory.heldBytes - store.bytes());
}
