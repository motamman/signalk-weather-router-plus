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
import {
  chooseRtofsProduct,
  extentOfField,
  finestFirst,
  loadRtofsExtents,
  loadRtofsSteps,
  noteRtofsExtent,
  readRtofsExtents,
  RTOFS_REGIONS,
  RtofsClient,
  RtofsCurrentSource,
  type RtofsRun,
  rtofsRunFor,
  rtofsSetForConfig,
  type SerializedRtofsSet,
  shareRtofsSteps,
} from '../../currents/rtofs';
import { type CurrentSourceLike } from '../../currents/types';
import { type BuilderCurrentsRef, harmonicFromDir, harmonicSignature, rtofsFromCache } from '../../currents/fromcache';
import {
  alignedSteps,
  loadResident,
  residentStale,
  SMOC_DEFAULT_BUDGET_BYTES,
  SmocClient,
  SmocCurrentSource,
  type SerializedSmoc,
  type SmocRun,
  type SmocSettings,
} from '../../currents/smoc';
import { isOffline, OfflineError } from '../../data/http';
import { releaseMemory } from '../../util/gc';
import { type ResolvedConfig } from '../config';
import { type CheckedSource, type CheckOutcome, type DataStatus, type QueryArgs } from '../protocol';
import { backgroundHold, requireInit } from './state';
import type { WorkerState } from './state';

/** Overlay / conditions queries wait at most this long for an on-demand SMOC load. */
const SMOC_QUERY_DEADLINE_MS = MINUTE_MS;

export function rebuildStack(st: WorkerState): void {
  const sources: CurrentSourceLike[] = [...st.harmonic];
  if (st.smoc) sources.push(st.smoc);
  sources.push(...st.rtofs);
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
    rtofsRuns: st.rtofs.map(s => `${s.product} ${new Date(s.runMs).toISOString().slice(0, 10)}`),
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
 * Route worker: a full GC once relayed shared memory has been replaced or dropped. V8 does not count a
 * SharedArrayBuffer received from another thread toward this thread's memory, so dropping one never prompts a
 * collection here, and between routes this thread allocates almost nothing: every SMOC resident area it was handed
 * (a new one at each step of the window, 3 h by default) stayed alive for hours, held by the old objects (issue #113).
 */
function releaseDropped(st: WorkerState, what: string): void {
  const ms = releaseMemory();
  st.log('debug', `${what}: full GC after dropping shared memory: ${ms === null ? 'not available' : `${ms} ms`}`);
}

/** Route worker: the data worker's SMOC run and resident area, relayed by the main thread (shared memory). */
export function adoptSmoc(st: WorkerState, s: SerializedSmoc | null): void {
  const cfg = requireInit(st).config;
  const dropped = !!st.smoc?.resident;
  if (!s || !cfg.currents.smocEnabled) st.smoc = null;
  else if (
    st.smoc &&
    st.smoc.run.key === s.run.key &&
    st.smoc.run.settled === s.run.settled &&
    JSON.stringify(st.smoc.settings) === JSON.stringify(s.settings)
  )
    st.smoc.setResident(s.resident, s.centre);
  else st.smoc = SmocCurrentSource.fromSerialized(s, st.smocClient, m => st.log('info', m));
  rebuildStack(st);
  sendCurrents(st);
  if (st.smoc)
    st.log(
      'debug',
      `smoc: adopted run ${st.smoc.run.key}${st.smoc.resident ? `, resident ${(st.smoc.memoryBytes() / 1e6).toFixed(1)} MB ${st.smoc.resident.u.buffer instanceof SharedArrayBuffer ? 'shared (no copy)' : 'copied'}` : ', nothing resident'}`
    );
  if (dropped) releaseDropped(st, 'smoc');
}

/** Route worker: the data worker's RTOFS products, relayed by the main thread (shared memory). */
export function adoptRtofs(st: WorkerState, rtofs: SerializedRtofsSet | null): void {
  const cur = requireInit(st).config.currents;
  const set = rtofsSetForConfig(rtofs, cur.rtofsEnabled, cur.rtofsExtra);
  const dropped = st.rtofs.length > 0;
  st.rtofs = set ? set.runs.map(r => RtofsCurrentSource.fromSerialized(r)) : [];
  rebuildStack(st);
  sendCurrents(st);
  if (dropped) releaseDropped(st, 'rtofs');
}

/**
 * A currents settings change: drop SMOC and / or RTOFS, to be loaded again (data worker) or relayed again (route
 * worker). In the route worker the dropped memory is collected now, as it may never be replaced (turned off).
 */
export function dropCurrents(st: WorkerState, cfg: ResolvedConfig, drop: { smoc: boolean; rtofs: boolean }): void {
  const dropped = st.role === 'route' && ((drop.rtofs && st.rtofs.length > 0) || (drop.smoc && !!st.smoc?.resident));
  if (drop.rtofs) {
    st.rtofsClients = new Map();
    st.rtofs = [];
  }
  if (drop.smoc) {
    st.smocClient = makeSmocClient(st, cfg);
    st.smoc = null;
  }
  rebuildStack(st);
  if (dropped) releaseDropped(st, 'currents');
}

/** Record what a source's check found (st.checks, reported in the data status). */
export function noteCheck(st: WorkerState, source: CheckedSource, outcome: CheckOutcome, reason: string | null): void {
  st.checks[source] = { outcome, at: new Date().toISOString(), reason };
}

/**
 * Data worker: check the store for a new daily run (cheap: .zmetadata +
 * STAC), load the resident area around the vessel for the current
 * window when the run, the window or the position changed, and prune
 * superseded cached runs. Offline, the newest cached run is used.
 * `offline`: this round already found no connection; the store is not asked.
 */
export async function refreshSmoc(st: WorkerState, offline: string | null = null): Promise<void> {
  const { config: cfg } = requireInit(st);
  if (!cfg.currents.smocEnabled || !st.smocClient) {
    delete st.checks.smoc;
    if (st.smoc) {
      st.smoc = null;
      rebuildStack(st);
      sendSmoc(st);
    }
    return;
  }
  const settings = smocSettings(cfg);
  let run: SmocRun | null;
  let checked: { outcome: CheckOutcome; reason: string | null };
  // A newer run Copernicus Marine is still writing, kept as the source's `pending` (status, freshness); undefined when
  // this round could not ask the store, which leaves it as it was.
  let pending: SmocCurrentSource['pending'] | undefined;
  // An update in progress while the store still holds the run in use (no newer run to name yet); undefined as `pending`.
  let updating: boolean | undefined;
  try {
    if (offline) throw new OfflineError(offline);
    const probed = await st.smocClient.probe(st.smoc?.run ?? null);
    pending = null;
    updating = false;
    if (probed.settled || !st.smoc) {
      run = probed;
      if (!probed.settled)
        st.log(
          'info',
          `smoc: the store update is still being written (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); using run ${probed.key} provisionally`
        );
    } else if (probed.key !== st.smoc.run.key) {
      st.log(
        'info',
        `smoc: store update in progress (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); keeping run ${st.smoc.run.key}`
      );
      run = st.smoc.run;
      pending = { key: probed.key, appearedAt: probed.metadataModified };
    } else {
      st.log(
        'info',
        `smoc: store update in progress (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); the store still holds run ${st.smoc.run.key}, kept`
      );
      run = st.smoc.run;
      updating = true;
    }
    // The reason names what was found: the run kept is settled, so built from it alone it said nothing.
    checked = {
      outcome: 'newest',
      reason: pending
        ? `a newer run appeared in the store ${pending.appearedAt ?? '(time not known)'} and Copernicus Marine is still writing it; the previous run stays in use until it is finished`
        : !run.settled
          ? `run ${run.key} is still being written by Copernicus Marine`
          : updating
            ? `Copernicus Marine has started an update; no newer run is in the store yet; run ${run.key} stays in use`
            : null,
    };
  } catch (err) {
    if (!offline) st.log('error', `smoc: cannot reach the Copernicus Marine store: ${(err as Error).message}`);
    run = st.smoc?.run ?? st.smocClient.cachedRuns()[0] ?? null;
    if (run && !st.smoc) st.log('info', `smoc: using cached run ${run.key} (offline)`);
    checked = { outcome: 'could-not-check', reason: (err as Error).message };
  }
  if (!run) {
    noteCheck(st, 'smoc', checked.outcome, checked.reason);
    return;
  }
  // A run first loaded while its update was still being written is
  // reloaded from scratch once the update has finished (its cached
  // chunks may predate the update).
  const provisionalReplaced = !!st.smoc && st.smoc.run.key === run.key && !st.smoc.run.settled && run.settled;
  const newRun = !st.smoc || st.smoc.run.key !== run.key || provisionalReplaced;
  const now = Date.now();
  const steps = alignedSteps(run, now, now + settings.horizonS * 1000, settings.stepS / HOUR_S);
  const src = newRun ? new SmocCurrentSource(run, settings, st.smocClient, m => st.log('info', m)) : st.smoc!;
  if (pending !== undefined) src.pending = pending;
  if (updating !== undefined) src.updating = updating;
  if (!newRun) src.expire(now);
  if (newRun) st.smocClient.saveRun(run);
  const pos = st.vesselPos;
  let changed = newRun;
  if (pos && (newRun || residentStale(src, pos, steps))) {
    // A background round loads no resident area while the internet state holds (its missing chunks would be
    // downloaded), and stops one under way between chunks once it starts holding (worker.ts 'internet-hold').
    let hold = backgroundHold(st);
    try {
      const t = Date.now();
      const res = hold
        ? null
        : await loadResident(st.smocClient, run, settings, pos, steps, {
            log: m => st.log('info', m),
            shouldCancel: () => backgroundHold(st) !== null,
          });
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
      hold = backgroundHold(st);
      if (!hold) {
        st.log('error', `smoc: resident area load failed: ${(err as Error).message}`);
        if (newRun && st.smoc) {
          // Keep serving the previous run; the new one is written (it failed to load), so nothing is pending or updating.
          st.smoc.pending = null;
          st.smoc.updating = false;
          noteCheck(st, 'smoc', isOffline(err) ? 'could-not-check' : 'failed', `run ${run.key}: ${(err as Error).message}`);
          return;
        }
      }
    }
    if (hold) {
      st.log('info', `smoc: run ${run.key}: the resident area is not loaded: ${hold}`);
      checked = { outcome: 'could-not-check', reason: `skipped: ${hold}` };
      // As after a failed load: the previous run keeps serving.
      if (newRun && st.smoc) {
        st.smoc.pending = null;
        st.smoc.updating = false;
        noteCheck(st, 'smoc', checked.outcome, checked.reason);
        return;
      }
    }
  } else if (newRun && !pos) {
    st.log('info', `smoc: run ${run.key}: no vessel position; nothing resident, areas load on demand`);
  }
  if (checked.outcome === 'newest' && newRun)
    checked = { outcome: 'new-run', reason: `run ${run.key}${run.settled ? '' : ' (still being written)'}` };
  noteCheck(st, 'smoc', checked.outcome, checked.reason);
  if (newRun) {
    st.smoc = src;
    // Also removes the provisional directory the settled run replaces: only
    // now, so a failed load above leaves the still-serving run its chunks.
    const removed = st.smocClient.pruneRuns([run]);
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
  st.harmonicErrors = [];
  if (!dir) return;
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.npz'))
      .sort();
  } catch (err) {
    st.log('error', `currents: cannot read harmonic directory ${dir}: ${(err as Error).message}`);
    st.harmonicErrors.push(`${dir}: ${(err as Error).message}`);
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
      st.harmonicErrors.push(`${f}: ${(err as Error).message}`);
    }
  }
}

/** The tidal-harmonic folder the tiles worker's sources were read from, and its signature then (adoptCurrentsRef); one per process. */
let harmonicFrom: string | null = null;
let harmonicSigFrom: string | null = null;
/** The horizon and step the tiles worker's RTOFS sources were read with (adoptCurrentsRef); null when none are. */
let rtofsReadWith: { horizonS: number; stepS: number } | null = null;
/** The RTOFS products and tidal-harmonic files the tiles worker could not read (adoptCurrentsRef). */
let rtofsUnread: string[] = [];
let harmonicUnread: string[] = [];

const sameSteps = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Tiles worker (a separate process): the data worker's currents read back from the disk caches it writes, from the
 * reference the main thread sends (currents/fromcache.ts) instead of copies of its shared memory. Each part is read
 * only when it differs from what is loaded. SMOC's resident area is loaded as the data worker loaded it (the same
 * region and steps, so the same chunks); RTOFS whole, as the data worker holds it.
 *
 * A source that cannot be read is not marked as read, so the next reference reads it again, and until then the
 * current layers' tiles are not kept (st.currentsUnread, buildTile). Their directory is named after the data worker's
 * sources (tiles.ts tileGenerationKeys): a tile built without one, or from the run before, would be saved there as
 * that run's and served until the next run.
 */
export async function adoptCurrentsRef(st: WorkerState, ref: BuilderCurrentsRef): Promise<void> {
  const { config: cfg } = requireInit(st);
  const s = ref.smoc;
  if (!s || !cfg.currents.smocEnabled || !st.smocClient) st.smoc = null;
  else if (
    !st.smoc ||
    st.smoc.run.key !== s.run.key ||
    st.smoc.run.settled !== s.run.settled ||
    JSON.stringify(st.smoc.settings) !== JSON.stringify(s.settings) ||
    JSON.stringify(st.smoc.residentCentre) !== JSON.stringify(s.centre) ||
    !sameSteps(st.smoc.resident?.stepMs ?? [], s.steps)
  ) {
    const src = new SmocCurrentSource(s.run, s.settings, st.smocClient, m => st.log('info', m));
    if (s.centre && s.steps.length) {
      try {
        const res = await loadResident(st.smocClient, s.run, s.settings, s.centre, s.steps);
        if (res) src.setResident(res.area, s.centre);
      } catch (err) {
        st.log('error', `smoc: resident area of run ${s.run.key} not read from the cache: ${(err as Error).message}`);
      }
    }
    st.smoc = src;
  }
  const runsKey = (runs: { product: string; runMs: number }[]): string => runs.map(r => `${r.product}@${r.runMs}`).join(',');
  const rtofs = cfg.currents.rtofsEnabled ? ref.rtofs : null;
  if (
    runsKey(st.rtofs) !== runsKey(rtofs?.runs ?? []) ||
    rtofs?.horizonS !== rtofsReadWith?.horizonS ||
    rtofs?.stepS !== rtofsReadWith?.stepS
  ) {
    rtofsReadWith = rtofs ? { horizonS: rtofs.horizonS, stepS: rtofs.stepS } : null;
    st.rtofs = [];
    rtofsUnread = [];
    // A product missing from st.rtofs differs from the reference's runs: the next reference reads it again.
    for (const r of rtofs ? await rtofsFromCache(rtofs, null) : []) {
      if (r.source) st.rtofs.push(r.source);
      else {
        rtofsUnread.push(`rtofs ${r.product}`);
        st.log('error', `rtofs ${r.product}: not read from the cache: ${r.error ?? 'no steps'}`);
      }
    }
  }
  // Read again when the folder or its files changed, and while a file of it could not be read.
  const dir = ref.harmonicDir;
  const sig = dir ? ref.harmonicSig : null;
  if (dir !== harmonicFrom || sig !== harmonicSigFrom || harmonicUnread.length) {
    harmonicFrom = dir;
    harmonicSigFrom = sig;
    st.harmonic = [];
    harmonicUnread = [];
    // The data worker read the folder once, at its start, and the tiles' generation is named after the files then. A
    // file added or replaced since would be read here and not there: its tiles would be saved as the old files'.
    if (dir && harmonicSignature(dir) !== sig) {
      harmonicUnread.push(`harmonic folder ${dir} (its files changed since the data worker read them; restart the plugin)`);
    } else
      for (const h of dir ? harmonicFromDir(dir) : []) {
        if (h.source) st.harmonic.push(h.source);
        else {
          harmonicUnread.push(`harmonic ${h.file ?? dir}`);
          st.log('error', `currents: harmonic ${h.file ?? dir} not read: ${h.error}`);
        }
      }
  }
  const unread = [...rtofsUnread, ...harmonicUnread];
  if (unread.length && unread.join() !== st.currentsUnread.join())
    st.log('error', `currents: tiles of the current layers are not kept until ${unread.join(', ')} can be read`);
  st.currentsUnread = unread;
  rebuildStack(st);
}

/** data worker → main → route worker: the RTOFS products (shared memory, no copy), with the setting they were loaded under. */
export function sendRtofs(st: WorkerState): void {
  if (st.role !== 'data') return;
  const cfg = st.config;
  st.send({
    type: 'rtofs',
    rtofs: cfg?.currents.rtofsEnabled ? { extra: [...cfg.currents.rtofsExtra], runs: st.rtofs.map(s => s.serialize()) } : null,
  });
}

/** The RTOFS cache directory: every product, read by every worker and the mesh process. */
export function rtofsCacheDir(st: WorkerState): string {
  return path.join(st.cacheRoot, 'rtofs');
}

function rtofsClientFor(st: WorkerState, product: string): RtofsClient {
  let c = st.rtofsClients.get(product);
  if (!c) {
    c = new RtofsClient({ cacheDir: rtofsCacheDir(st), region: product, log: m => st.log('debug', m) });
    st.rtofsClients.set(product, c);
  }
  return c;
}

/**
 * Data worker: load the RTOFS products wanted now into shared memory and
 * relay them. Wanted: the product that contains the vessel (the finest
 * where two overlap; none without a position or where none does) and the
 * extra products from the settings. Each one's newest run comes from the
 * network, else the disk cache; a product no longer wanted is dropped. The
 * route and tiles workers do not load RTOFS themselves: they adopt the
 * data worker's products ('rtofs' message). True when the products in use
 * changed (and were relayed).
 */
export async function refreshRtofs(st: WorkerState, networkAllowed: boolean, offline: string | null = null): Promise<boolean> {
  const { config: cfg } = requireInit(st);
  if (st.role !== 'data') return false;
  const dropChecks = (keep: ReadonlySet<string>): void => {
    for (const k of Object.keys(st.checks) as CheckedSource[]) if (k.startsWith('rtofs:') && !keep.has(k.slice(6))) delete st.checks[k];
  };
  if (!cfg.currents.rtofsEnabled) {
    dropChecks(new Set());
    st.rtofsChoice = null;
    if (st.rtofs.length) {
      st.rtofs = [];
      rebuildStack(st);
      sendRtofs(st);
      return true;
    }
    return false;
  }
  const cacheDir = rtofsCacheDir(st);
  let off = offline;
  let extents = readRtofsExtents(cacheDir);
  let unknown: string[] = RTOFS_REGIONS.filter(r => !extents[r]);
  if (unknown.length) {
    try {
      if (off) throw new OfflineError(off);
      ({ extents, unknown } = await loadRtofsExtents(cacheDir, { network: networkAllowed, log: m => st.log('info', m) }));
    } catch (err) {
      if (isOffline(err)) off = off ?? (err as Error).message;
      else st.log('error', `rtofs: the products' extents could not be read: ${(err as Error).message}`);
    }
  }
  const choice = chooseRtofsProduct(extents, st.vesselPos);
  if (choice.product !== (st.rtofsChoice?.auto ?? null) || choice.reason !== (st.rtofsChoice?.autoReason ?? null))
    st.log('info', choice.product ? `rtofs: the vessel is in product ${choice.product}` : `rtofs: ${choice.reason}`);
  st.rtofsChoice = { auto: choice.product, autoReason: choice.reason, unknownExtents: unknown };
  const wanted = finestFirst([...new Set([...(choice.product ? [choice.product] : []), ...cfg.currents.rtofsExtra])], extents);
  const loaded: RtofsCurrentSource[] = [];
  const keep: RtofsRun[] = [];
  let newRun = false;
  for (const product of wanted) {
    const r = await refreshRtofsProduct(st, product, st.rtofs.find(s => s.product === product) ?? null, off);
    if (r.src) loaded.push(r.src);
    keep.push(...r.keep);
    newRun ||= r.newRun;
  }
  dropChecks(new Set(wanted));
  const changed = loaded.length !== st.rtofs.length || loaded.some((s, i) => s !== st.rtofs[i]);
  if (changed) {
    st.rtofs = loaded;
    rebuildStack(st);
    sendRtofs(st);
  }
  // One prune for every product: the cache is kept by run date, a date directory holding each product's files.
  if (newRun) rtofsClientFor(st, wanted[0]).pruneCache(keep);
  return changed;
}

/**
 * One product: its newest run (today's when fully cached, else the newest
 * published, else the newest in the cache when NOMADS cannot be asked),
 * loaded when it is not the one in use. Returns the source to use (the
 * current one when nothing newer loads), the runs whose files are kept,
 * and whether a new run was loaded.
 */
async function refreshRtofsProduct(
  st: WorkerState,
  product: string,
  current: RtofsCurrentSource | null,
  offline: string | null
): Promise<{ src: RtofsCurrentSource | null; keep: RtofsRun[]; newRun: boolean }> {
  const { config: cfg } = requireInit(st);
  const client = rtofsClientFor(st, product);
  const key: CheckedSource = `rtofs:${product}`;
  const horizon = cfg.currents.rtofsHorizonS;
  let run: RtofsRun | null;
  let checked: { outcome: CheckOutcome; reason: string | null } = { outcome: 'newest', reason: null };
  const cachedRuns = client.cachedRuns().filter(r => client.runFullyCached(r, horizon));
  const inUse = current ? [rtofsRunFor(new Date(current.runMs))] : [];
  // Fresh enough already? The daily run appears during the morning;
  // if today's run is cached there is nothing to do.
  const today = rtofsRunFor(new Date());
  if (client.runFullyCached(today, horizon)) run = today;
  else {
    try {
      if (offline) throw new OfflineError(offline);
      run = await client.findLatestRun(horizon);
    } catch (err) {
      if (!offline) st.log('error', `rtofs ${product}: ${(err as Error).message}`);
      run = cachedRuns[0] ?? null;
      checked = { outcome: 'could-not-check', reason: (err as Error).message };
    }
  }
  if (!run) {
    if (current) st.log('info', `rtofs ${product}: keeping the resident run`);
    noteCheck(st, key, checked.outcome, checked.reason);
    return { src: current, keep: inUse, newRun: false };
  }
  if (current && current.runMs === run.time.getTime()) {
    noteCheck(st, key, checked.outcome, checked.reason);
    return { src: current, keep: [run, ...cachedRuns.slice(0, 1)], newRun: false };
  }
  try {
    const t = Date.now();
    // The whole product, uncropped.
    const steps = await loadRtofsSteps(client, run, null, horizon, cfg.currents.rtofsStepS, { log: m => st.log('debug', m) });
    if (steps.length === 0) throw new Error(`run ${run.yyyymmdd} has no steps in product ${product}`);
    const g = steps[0].u;
    const extent = extentOfField(g);
    if (noteRtofsExtent(rtofsCacheDir(st), product, { ...extent, dLon: g.dLon, dLat: g.dLat }))
      st.log('info', `rtofs: ${product}'s extent recorded from its run ${run.yyyymmdd}`);
    const src = new RtofsCurrentSource(product, run.time.getTime(), extent, shareRtofsSteps(steps));
    st.log(
      'info',
      `rtofs: ${product} run ${run.yyyymmdd}, ${steps.length} steps, ${(src.bytes() / 1e6).toFixed(1)} MB resident, ${((Date.now() - t) / 1000).toFixed(1)} s`
    );
    noteCheck(st, key, checked.outcome === 'newest' ? 'new-run' : checked.outcome, checked.reason ?? `run ${run.yyyymmdd}`);
    return { src, keep: [run, ...cachedRuns.slice(0, 1)], newRun: true };
  } catch (err) {
    st.log('error', `rtofs ${product}: load failed: ${(err as Error).message}`);
    noteCheck(st, key, isOffline(err) ? 'could-not-check' : 'failed', `run ${run.yyyymmdd}: ${(err as Error).message}`);
    return { src: current, keep: [...inUse, ...cachedRuns.slice(0, 1)], newRun: false };
  }
}
