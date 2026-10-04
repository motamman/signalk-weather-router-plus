/**
 * Fetch and decode the forecast fields, and decide which cycle to use
 * without touching the network when fresh data is already on disk.
 *
 *  - decodeForecastToDisk: the plugin's path. Streams a run to disk one
 *    step at a time through ONE reusable one-step block, so an update
 *    needs about one step of memory (≈46 MB with the extra fields), not
 *    the whole store (1.14 GB for 72 h).
 *  - loadForecastForBBox: a cropped in-memory store (the CLI and the
 *    route worker's fallback while no decoded run exists yet).
 *  - loadGlobalForecast: the whole global store in memory (tests and
 *    tools; the plugin no longer does this).
 * All three decode through the same step loop (decodeSteps), so a
 * streamed run holds exactly the values of the whole store.
 */

import type { BBox } from '../geo/geodesy';
import { HOUR_S } from '../geo/units';
import { parseGrib2Message, type DecodeScratch } from '../grib/grib2';
import { ATM_PARAMS, WAVE_PARAMS, availableSteps, latestExpectedCycle, type Cycle, type EcmwfClient, type IndexRecord } from './ecmwf';
import {
  buildStep,
  ForecastStore,
  GLOBAL_BBOX,
  applyAccumulated,
  type AccumPrev,
  type ForecastStep,
  FloatSlab,
  type NanFillScratch,
} from './forecast';
import { cycleName, type DecodedIndex, type DecodedRunWriter } from './decoded';

export interface LoadOptions {
  /** Forecast horizon, seconds (the ECMWF step ladder is in hours; converted once here). */
  horizonS: number;
  cycle?: Cycle;
  includeWaves?: boolean;
  /** Extra parameters from the atmosphere stream (e.g. '2t', 'tprate'). */
  extraAtmParams?: string[];
  log?: (msg: string) => void;
  shouldCancel?: () => boolean;
  /** Called after each step is decoded. */
  onStep?: (done: number, total: number) => void;
  /** Wave NaN fill radius in cells. */
  waveFillCells?: number;
}

export interface ResolvedCycle {
  cycle: Cycle;
  /** True when every needed message is already on disk (no network needed). */
  fromCache: boolean;
  /** Set when the network was unavailable and an older cached cycle was chosen. */
  fallback?: string;
}

/**
 * Choose the cycle to load, planner-style:
 *  1. the wall-clock expected cycle when it is fully cached → no network;
 *  2. otherwise ask the server for the newest complete cycle;
 *  3. if that fails, the newest fully cached cycle, if any.
 */
export async function resolveCycle(
  client: EcmwfClient,
  horizonS: number,
  opts: { now?: Date; includeWaves?: boolean; extraAtmParams?: string[]; log?: (m: string) => void } = {}
): Promise<ResolvedCycle> {
  const log = opts.log ?? (() => undefined);
  const atm = [...ATM_PARAMS, ...(opts.extraAtmParams ?? [])];
  const wave = opts.includeWaves === false ? [] : [...WAVE_PARAMS];
  const expected = latestExpectedCycle(opts.now ?? new Date(), horizonS);
  if (client.cycleFullyCached(expected, horizonS, atm, wave)) {
    log(`expected cycle ${expected.yyyymmdd} ${expected.hh}z is fully cached; no download needed`);
    return { cycle: expected, fromCache: true };
  }
  try {
    const cycle = await client.findLatestCycle(horizonS, { now: opts.now });
    return { cycle, fromCache: client.cycleFullyCached(cycle, horizonS, atm, wave) };
  } catch (err) {
    const cached = client.cachedCycles().find(c => client.cycleFullyCached(c, horizonS, atm, wave));
    if (cached) {
      const msg = `ECMWF unreachable (${(err as Error).message}); using cached cycle ${cached.yyyymmdd} ${cached.hh}z`;
      log(msg);
      return { cycle: cached, fromCache: true, fallback: msg };
    }
    throw err;
  }
}

/**
 * Load the whole globe (no crop) into a SharedArrayBuffer-backed store.
 * Fields already in the disk cache are read from it; the rest are
 * fetched. Messages are cached whole on disk either way, so a global
 * load downloads exactly what a cropped one did.
 */
export function loadGlobalForecast(client: EcmwfClient, opts: LoadOptions): Promise<ForecastStore> {
  return loadForecast(client, null, opts);
}

/** Load a bbox crop (the route worker's first-boot fallback and the CLI). */
export function loadForecastForBBox(client: EcmwfClient, bbox: BBox, opts: LoadOptions): Promise<ForecastStore> {
  return loadForecast(client, bbox, opts);
}

/** Cells in one 0.25° global field (1440 × 721). */
export const GLOBAL_CELLS = 1440 * 721;

/** The parameters a load asks for, in store order. */
export function requestedParams(opts: { includeWaves?: boolean; extraAtmParams?: string[] }): string[] {
  return [...ATM_PARAMS, ...(opts.extraAtmParams ?? []), ...(opts.includeWaves === false ? [] : WAVE_PARAMS)];
}

/**
 * Bytes the streaming decoder holds while it runs, besides the GRIB
 * messages of the step being decoded: the one-step block (every field of
 * one step, global Float32), the GRIB decode buffers (DecodeScratch: a
 * Uint32 and a Float64 array of one global field) and the wave fill's
 * temporaries (a Float32 copy and an Int32 count of one global field).
 */
export function streamingDecodeBytes(fieldsPerStep: number): number {
  return fieldsPerStep * GLOBAL_CELLS * 4 + GLOBAL_CELLS * (4 + 8) + GLOBAL_CELLS * (4 + 4);
}

interface DecodeLoopResult {
  cycle: Cycle;
  steps: number[];
  params: string[];
  downloaded: number;
}

/**
 * The one step loop behind every load: for each step, fetch (disk cache
 * first) and decode its messages, build the step with `slabFor(step)` as
 * its field memory (global loads) and hand it to `onStep`.
 */
async function decodeSteps(
  client: EcmwfClient,
  bbox: BBox | null,
  opts: LoadOptions,
  slabFor: (stepCount: number, fieldsPerStep: number) => FloatSlab | undefined,
  onStep: (step: ForecastStep) => void
): Promise<DecodeLoopResult> {
  const log = opts.log ?? (() => undefined);
  const includeWaves = opts.includeWaves ?? true;
  const atmParams = [...ATM_PARAMS, ...(opts.extraAtmParams ?? [])];
  const cycle = opts.cycle ?? (await resolveCycle(client, opts.horizonS, { includeWaves, extraAtmParams: opts.extraAtmParams, log })).cycle;
  const horizonHours = opts.horizonS / HOUR_S;
  const steps = availableSteps(cycle, horizonHours);
  // One set of decode buffers for every field (~12 MB for 0.25° global)
  // instead of fresh ones per field: a 72 h load decodes ~275 fields.
  const scratch: DecodeScratch = {};
  const fillScratch: NanFillScratch = {};
  // Previous step's raw accumulated fields, for the step-difference pass
  // (ACCUMULATED_PARAMS): five global fields, about 21 MB.
  const accumPrev = new Map<string, AccumPrev>();
  const fieldsPerStep = atmParams.length + (includeWaves ? WAVE_PARAMS.length : 0);
  const slab = slabFor(steps.length, fieldsPerStep);
  let done = 0;
  let downloaded = 0;
  for (const step of steps) {
    if (opts.shouldCancel?.()) throw new Error('forecast load cancelled');
    const named: { param: string; message: ReturnType<typeof parseGrib2Message> }[] = [];
    // The index is only needed for fields not already on disk.
    let atmIndex: IndexRecord[] | undefined;
    for (const p of atmParams) {
      if (!client.hasCached(cycle, cycle.atmStream, step, p)) {
        atmIndex = atmIndex ?? (await client.fetchIndex(cycle, cycle.atmStream, step));
        downloaded++;
      }
      const msg = await client.fetchField(cycle, cycle.atmStream, step, p, atmIndex);
      if (!msg) {
        if (p === '10u' || p === '10v') throw new Error(`cycle ${cycle.yyyymmdd}${cycle.hh} step +${step}h has no ${p}`);
        log(`step +${step}h: ${p} not in index, skipped`);
        continue;
      }
      named.push({ param: p, message: parseGrib2Message(msg) });
    }
    if (includeWaves) {
      let waveIndex: IndexRecord[] | undefined;
      for (const p of WAVE_PARAMS) {
        if (!client.hasCached(cycle, cycle.waveStream, step, p)) {
          waveIndex = waveIndex ?? (await client.fetchIndex(cycle, cycle.waveStream, step));
          downloaded++;
        }
        const msg = await client.fetchField(cycle, cycle.waveStream, step, p, waveIndex);
        if (!msg) {
          log(`step +${step}h: wave ${p} not in index, skipped`);
          continue;
        }
        named.push({ param: p, message: parseGrib2Message(msg) });
      }
    }
    const built = buildStep(named, bbox, opts.waveFillCells ?? 3, scratch, slab, fillScratch);
    applyAccumulated(built, accumPrev);
    onStep(built);
    done++;
    opts.onStep?.(done, steps.length);
    // Yield to the event loop between steps so a host process stays responsive.
    await new Promise(r => setImmediate(r));
  }
  log(`decoded ${done} steps for cycle ${cycle.yyyymmdd} ${cycle.hh}z (${downloaded} fields downloaded, rest from cache)`);
  return { cycle, steps, params: [...atmParams, ...(includeWaves ? WAVE_PARAMS : [])], downloaded };
}

async function loadForecast(client: EcmwfClient, bbox: BBox | null, opts: LoadOptions): Promise<ForecastStore> {
  const built: ForecastStep[] = [];
  // Global loads: every field-step in one shared block (see FloatSlab for
  // why), sized for the 0.25° grid; a field of another size gets its own.
  const r = await decodeSteps(
    client,
    bbox,
    opts,
    (n, fields) => (bbox ? undefined : new FloatSlab(n * fields * GLOBAL_CELLS)),
    s => built.push(s)
  );
  return new ForecastStore(built, {
    cycleTime: r.cycle.time,
    bbox: bbox ?? GLOBAL_BBOX,
    steps: r.steps,
    params: r.params,
    loadedAt: new Date(),
  });
}

export interface DiskDecodeResult {
  index: DecodedIndex;
  downloaded: number;
  /** Bytes of the reusable one-step block. */
  stepBlockBytes: number;
}

/**
 * Decode a run straight to disk: each step is decoded into the same
 * one-step block (reset per step), written by `writer`, and the block
 * reused for the next step. Nothing of the run stays in memory. The
 * writer is finished (renamed into place) on success; on failure the
 * caller aborts it.
 */
export async function decodeForecastToDisk(
  client: EcmwfClient,
  writer: DecodedRunWriter,
  opts: LoadOptions & { cycle: Cycle }
): Promise<DiskDecodeResult> {
  const t = Date.now();
  let slab: FloatSlab | undefined;
  const r = await decodeSteps(
    client,
    null,
    opts,
    (_n, fields) => (slab = new FloatSlab(fields * GLOBAL_CELLS)),
    step => {
      writer.writeStep(step);
      slab!.reset();
    }
  );
  if (cycleName(r.cycle.time) !== writer.cycle)
    throw new Error(`decoded cycle ${cycleName(r.cycle.time)} into a writer for ${writer.cycle}`);
  const index = writer.finish({
    cycleTimeMs: r.cycle.time.getTime(),
    request: { horizonHours: opts.horizonS / HOUR_S, params: r.params },
    stepHours: r.steps,
    decodeMs: Date.now() - t,
  });
  return { index, downloaded: r.downloaded, stepBlockBytes: slab ? slab.capacity * 4 : 0 };
}
