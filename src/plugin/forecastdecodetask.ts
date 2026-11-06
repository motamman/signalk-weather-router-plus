/**
 * The ECMWF decode in a child process (childtask.ts task 'forecast-decode'):
 * one cycle downloaded where the GRIB cache lacks it and decoded straight to
 * disk, one step at a time (data/loader.ts decodeForecastToDisk), exactly as
 * the data worker did it before. In a child for two reasons:
 *  - the data worker stays free for map, conditions and Weather API queries
 *    while the decode runs (brain, 2026-10-19: during a 172 s decode an
 *    uncached map tile timed out at 120 s and the next waited 49.8 s; 15–27
 *    ms before);
 *  - the decode's buffers go back to the system when the child exits.
 * Progress goes to the worker as events; the answer is where the finished run
 * is. A decode that fails removes its unfinished directory here; one killed
 * (plugin stopped) leaves a `.tmp-*` directory for the next prune.
 */

import * as path from 'node:path';
import { cycleFor, type EcmwfMirror, ECMWF_MIRRORS, EcmwfClient, type EnsembleModelId } from '../data/ecmwf';
import { cycleName, DECODED_DIR, DecodedRunWriter } from '../data/decoded';
import { runEnsembleCycle, type EnsembleModelResult } from '../data/ensemble';
import { availableDisk, DISK_RESERVE_BYTES } from './memguard';
import { decodeForecastToDisk } from '../data/loader';

export interface ForecastDecodeTask {
  task: 'forecast-decode';
  /** Plugin data directory: the GRIB cache is `ecmwf/`, the decoded runs `forecast/` below it. */
  cacheRoot: string;
  mirror: EcmwfMirror;
  /** Cycle time, ISO. */
  cycle: string;
  horizonS: number;
  extraAtmParams: string[];
}

export interface ForecastDecodeResult {
  /** The finished run's directory. */
  dir: string;
  downloaded: number;
  stepBlockBytes: number;
  decodeMs: number;
}

/** `model`: the ensemble a step of an ensemble decode is of (absent for the forecast's own decode). */
export type ForecastDecodeEvent =
  { event: 'decode-step'; done: number; total: number; model?: EnsembleModelId } | { event: 'decode-log'; message: string };

/** The ensembles of one cycle downloaded and decoded (childtask.ts task 'ensemble-decode', data/ensemble.ts), in a child for the same reasons. */
export interface EnsembleDecodeTask {
  task: 'ensemble-decode';
  cacheRoot: string;
  mirror: EcmwfMirror;
  /** Cycle time, ISO: the main forecast's run in use. */
  cycle: string;
  horizonS: number;
  models: EnsembleModelId[];
  members: number;
}

/** The GRIB client a decode task downloads with: the configured mirror, the GRIB cache under the data directory, its log as events. */
function taskClient(cacheRoot: string, mirror: EcmwfMirror, emit: (e: ForecastDecodeEvent) => void): EcmwfClient {
  return new EcmwfClient({
    baseUrl: ECMWF_MIRRORS[mirror],
    cacheDir: path.join(cacheRoot, 'ecmwf'),
    log: message => emit({ event: 'decode-log', message: `ecmwf: ${message}` }),
  });
}

/**
 * The child's ensemble pass (data/ensemble.ts runEnsembleCycle) for the main forecast's cycle in use, its log lines
 * and progress steps sent as events; the answer is each model's result.
 */
export async function runEnsembleDecodeTask(
  t: EnsembleDecodeTask,
  emit: (e: ForecastDecodeEvent) => void,
  client: EcmwfClient = taskClient(t.cacheRoot, t.mirror, emit)
): Promise<EnsembleModelResult[]> {
  return runEnsembleCycle(client, {
    cacheRoot: t.cacheRoot,
    cycle: cycleFor(new Date(t.cycle)),
    horizonS: t.horizonS,
    models: t.models,
    members: t.members,
    log: message => emit({ event: 'decode-log', message }),
    onProgress: (done, total, model) => emit({ event: 'decode-step', done, total, model }),
    // The forecast's reserve stays free (memguard.ts DISK_RESERVE_BYTES); the sizes as the status writes them. The
    // ensembles are optional: free disk that could not be measured stops them, with why.
    diskCheck: bytes => {
      const free = availableDisk(t.cacheRoot);
      if ('problem' in free) return `it needs {dataSize:${bytes}} of disk and the ${free.problem}`;
      return bytes + DISK_RESERVE_BYTES > free.bytes
        ? `it needs {dataSize:${bytes}} of disk and {dataSize:${free.bytes}} is free ({dataSize:${DISK_RESERVE_BYTES}} must stay free); choose fewer members or ensembles, or free disk space`
        : null;
    },
  });
}

/**
 * The child's forecast pass: cycle `t.cycle` downloaded and decoded to disk as a run of its own, its log lines and
 * steps sent as events. A pass that fails removes its unfinished run and throws.
 */
export async function runForecastDecodeTask(
  t: ForecastDecodeTask,
  emit: (e: ForecastDecodeEvent) => void,
  client: EcmwfClient = taskClient(t.cacheRoot, t.mirror, emit)
): Promise<ForecastDecodeResult> {
  const cycle = cycleFor(new Date(t.cycle));
  const writer = new DecodedRunWriter(path.join(t.cacheRoot, DECODED_DIR), cycleName(cycle.time));
  try {
    const out = await decodeForecastToDisk(client, writer, {
      horizonS: t.horizonS,
      cycle,
      extraAtmParams: t.extraAtmParams,
      log: message => emit({ event: 'decode-log', message }),
      onStep: (done, total) => emit({ event: 'decode-step', done, total }),
    });
    return { dir: writer.finalDir, downloaded: out.downloaded, stepBlockBytes: out.stepBlockBytes, decodeMs: out.index.decodeMs };
  } catch (err) {
    writer.abort();
    throw err;
  }
}
