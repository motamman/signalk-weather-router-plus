/**
 * ECMWF ensemble members (ecmwf.ts ENSEMBLES) downloaded and decoded to disk, for checking a route against each
 * member's weather (engine/ensemble.ts).
 *
 * Each member is a decoded run of its own, in the main forecast's format (decoded.ts), so every reader, completeness
 * check and prune works on it unchanged:
 *
 *   ecmwf-ens/<model>/<cycle>/mNN/<stream>-<step>h-<param>.grib2   the raw messages (the GRIB cache)
 *   forecast-ens/<model>/mNN/<cycle>/                              the decoded run of member NN
 *
 * mNN is the member: m00 the control (where a model publishes one), m01–m50 the perturbed members.
 *
 * A step's file holds every member, so the download goes step by step (each index read once, every chosen member's
 * fields fetched from it into the cache), and the decode member by member from the cache alone. An interrupted
 * download resumes from the cache; a member that fails to decode is left out and reported, the others go on. Only the
 * routing fields are kept (ENSEMBLE_PARAMS), at the main forecast's horizon.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseGrib2Message, type DecodeScratch } from '../grib/grib2';
import { HOUR_S } from '../geo/units';
import { cycleName, DecodedRunWriter, dirBytes, openDecodedRun, pruneDecodedRuns } from './decoded';
import {
  type Cycle,
  cycleFor,
  type EcmwfClient,
  ENSEMBLE_PARAMS,
  ENSEMBLES,
  type EnsembleModel,
  type EnsembleModelId,
  type IndexRecord,
  isGribFile,
} from './ecmwf';
import { buildStep, FloatSlab, type NanFillScratch } from './forecast';
import { GLOBAL_CELLS } from './loader';

/** The GRIB cache of the ensembles, and their decoded runs, below the plugin data directory. */
export const ENSEMBLE_GRIB_DIR = 'ecmwf-ens';
export const ENSEMBLE_DECODED_DIR = 'forecast-ens';

/** The fields of a member, in the order they are stored. */
export const ENSEMBLE_FIELDS: string[] = [...ENSEMBLE_PARAMS.enfo, ...ENSEMBLE_PARAMS.waef];

/** A member's folder: m00 the control, m01–m50 the perturbed members. */
export function memberDir(member: number): string {
  return `m${String(member).padStart(2, '0')}`;
}

/** The members to take of a model: its control first where it publishes one, then members 1 to `n`. */
export function ensembleMembers(model: EnsembleModel, n: number): number[] {
  const out = model.files.some(f => f.control) ? [0] : [];
  for (let m = 1; m <= n; m++) out.push(m);
  return out;
}

/**
 * The steps of a model's cycle up to the horizon: every `model.stepHours` to 144 h, every 6 h after it, and never past
 * the cycle's last step. Each ensemble publishes every one of them: IFS ENS to 144 h at 06/18Z and to 360 h at 00/12Z,
 * AIFS ENS to 360 h at every cycle (data.ecmwf.int listings of 2026-11-04 and 2026-11-05), never short of the main
 * forecast's last step (ecmwf.ts cycleFor). A step missing from the server is one not published yet (downloadModel).
 */
export function ensembleSteps(model: EnsembleModel, cycle: Pick<Cycle, 'maxStep'>, horizonHours: number): number[] {
  const out: number[] = [];
  const last = Math.min(horizonHours, cycle.maxStep);
  for (let s = 0; s <= last; s += s < 144 ? model.stepHours : 6) out.push(s);
  return out;
}

/**
 * The index records of one member's fields in a step file: by parameter and member number; the control file's records
 * carry no number (ecmwf.ts ENSEMBLES), so a control is any record there. One record per field, or an error naming
 * what is missing or doubled.
 */
export function memberRecords(idx: IndexRecord[], member: number, control: boolean, params: readonly string[]): IndexRecord[] {
  return params.map(p => {
    const recs = idx.filter(
      r =>
        r.param === p &&
        (r.levtype === undefined || r.levtype === 'sfc') &&
        (control ? r.number === undefined : Number(r.number) === member)
    );
    if (recs.length !== 1) throw new Error(`${control ? 'the control' : `member ${member}`}: ${recs.length} records of ${p} in the index`);
    return recs[0];
  });
}

/** Where member `member`'s `param` at `step` is cached. */
export function ensembleGribPath(
  cacheRoot: string,
  model: EnsembleModelId,
  cycle: string,
  member: number,
  stream: string,
  step: number,
  param: string
): string {
  return path.join(
    cacheRoot,
    ENSEMBLE_GRIB_DIR,
    model,
    cycle,
    memberDir(member),
    `${stream}-${String(step).padStart(3, '0')}h-${param}.grib2`
  );
}

/** Where member `member`'s decoded run of `cycle` is (written or not). */
export function memberRunDir(cacheRoot: string, model: EnsembleModelId, member: number, cycle: string): string {
  return path.join(cacheRoot, ENSEMBLE_DECODED_DIR, model, memberDir(member), cycle);
}

/**
 * Member `member`'s run of `cycle` is on disk and complete: made for this horizon, with every field and every step
 * of the cycle's ladder (ensembleSteps).
 */
export function memberComplete(cacheRoot: string, model: EnsembleModelId, member: number, cycle: string, horizonHours: number): boolean {
  const { run } = openDecodedRun(memberRunDir(cacheRoot, model, member, cycle));
  if (!run || run.index.request.horizonHours !== horizonHours || !ENSEMBLE_FIELDS.every(p => run.has(p))) return false;
  // Every step of the cycle's ladder: a run without them all is not complete, and is decoded again.
  const ladder = ensembleSteps(ENSEMBLES[model], cycleFor(new Date(run.index.cycleTimeMs)), horizonHours);
  const have = run.index.stepHours;
  return have.length === ladder.length && ladder.every((s, i) => have[i] === s);
}

export interface EnsembleModelResult {
  model: EnsembleModelId;
  cycle: string;
  /** Members whose decoded run is complete, after this pass. */
  members: number[];
  /** Members that could not be had this pass, and why. */
  failed: { member: number; error: string }[];
  /** The steps decoded: the cycle's whole ladder, or none (a step not published yet stops the model's pass). */
  steps: number[];
  downloaded: number;
  downloadedBytes: number;
  decodeMs: number;
  /** Why nothing of this model could be had this pass (its first step not published, the connection lost), or absent. */
  error?: string;
}

/**
 * A model's ensemble in use: the cycle and members of its last complete pass (`current.json` in its folder). Routes and
 * the status read it, so a cycle still being decoded is never used, and the one before stays until it is replaced.
 */
export interface EnsembleCurrent {
  model: EnsembleModelId;
  /** yyyymmddHH */
  cycle: string;
  cycleTimeMs: number;
  members: number[];
  horizonHours: number;
  at: string;
}

const CURRENT_FILE = 'current.json';

/** A model's ensemble in use (current.json in its folder), or null: none yet, unreadable, or not that model's. */
export function readEnsembleCurrent(cacheRoot: string, model: EnsembleModelId): EnsembleCurrent | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(cacheRoot, ENSEMBLE_DECODED_DIR, model, CURRENT_FILE), 'utf8')) as EnsembleCurrent;
    return c.model === model && Array.isArray(c.members) ? c : null;
  } catch {
    return null;
  }
}

function writeEnsembleCurrent(cacheRoot: string, c: EnsembleCurrent): void {
  const dir = path.join(cacheRoot, ENSEMBLE_DECODED_DIR, c.model);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${CURRENT_FILE}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, path.join(dir, CURRENT_FILE));
}

export interface EnsembleCycleOptions {
  cacheRoot: string;
  cycle: Cycle;
  horizonS: number;
  models: EnsembleModelId[];
  /** Members 1 to this of each model (and the control where there is one). */
  members: number;
  log?: (message: string) => void;
  /** After each step downloaded or member decoded: done of total for that model, for the status. */
  onProgress?: (done: number, total: number, model: EnsembleModelId) => void;
}

/**
 * Download and decode every chosen member of every chosen model for one cycle, skipping members already complete on
 * disk. A model whose first step is not published fails as a whole (nothing of it is decoded); a member that fails is
 * reported and the others go on.
 */
export async function runEnsembleCycle(client: EcmwfClient, o: EnsembleCycleOptions): Promise<EnsembleModelResult[]> {
  const log = o.log ?? (() => undefined);
  const name = cycleName(o.cycle.time);
  const horizonHours = o.horizonS / HOUR_S;
  const out: EnsembleModelResult[] = [];
  for (const id of o.models) {
    const model = ENSEMBLES[id];
    const want = ensembleMembers(model, o.members);
    const todo = want.filter(m => !memberComplete(o.cacheRoot, id, m, name, horizonHours));
    const r: EnsembleModelResult = {
      model: id,
      cycle: name,
      members: [],
      failed: [],
      steps: [],
      downloaded: 0,
      downloadedBytes: 0,
      decodeMs: 0,
    };
    if (todo.length) {
      try {
        const ladder = ensembleSteps(model, o.cycle, horizonHours);
        const dl = await downloadModel(client, o, model, name, todo, ladder);
        r.steps = dl.steps;
        r.downloaded = dl.downloaded;
        r.downloadedBytes = dl.bytes;
        const t = Date.now();
        for (const [k, m] of todo.entries()) {
          try {
            decodeMember(o, model, name, m, dl.steps, horizonHours);
          } catch (err) {
            r.failed.push({ member: m, error: (err as Error).message });
            log(`${model.name} ${memberDir(m)}: not decoded (${(err as Error).message})`);
          }
          // After the steps downloaded (downloadModel counts those), each member decoded.
          o.onProgress?.(dl.steps.length + k + 1, ladder.length + todo.length, id);
        }
        r.decodeMs = Date.now() - t;
      } catch (err) {
        // Nothing of this model this pass (the download stopped); its ensemble in use stays. The other models go on.
        r.error = (err as Error).message;
        log(`${model.name} ${name}: not downloaded (${r.error})`);
      }
    }
    r.members = want.filter(m => memberComplete(o.cacheRoot, id, m, name, horizonHours));
    // Complete for this model when every member wanted is on disk: that cycle becomes the one in use.
    if (r.members.length === want.length)
      writeEnsembleCurrent(o.cacheRoot, {
        model: id,
        cycle: name,
        cycleTimeMs: o.cycle.time.getTime(),
        members: r.members,
        horizonHours,
        at: new Date().toISOString(),
      });
    log(
      `${model.name} ${name}: ${r.members.length} of ${want.length} members on disk (${todo.length - r.failed.length} decoded now, ${r.downloaded} fields downloaded, ${r.failed.length} failed)`
    );
    out.push(r);
  }
  return out;
}

/**
 * Every field of `members` for the ladder into the cache, step by step. A step whose index the server does not have
 * is not published yet (ensembleSteps): the model's pass stops with an error, what is cached stays for the next round,
 * and nothing is decoded short.
 */
async function downloadModel(
  client: EcmwfClient,
  o: EnsembleCycleOptions,
  model: EnsembleModel,
  name: string,
  members: number[],
  ladder: number[]
): Promise<{ steps: number[]; downloaded: number; bytes: number }> {
  const steps: number[] = [];
  let downloaded = 0;
  let bytes = 0;
  let done = 0;
  for (const step of ladder) {
    for (const [stream, params] of Object.entries(ENSEMBLE_PARAMS)) {
      for (const file of model.files) {
        const inFile = members.filter(m => (m === 0) === file.control);
        if (!inFile.length) continue;
        const paths = inFile.flatMap(m => params.map(p => ensembleGribPath(o.cacheRoot, model.id, name, m, stream, step, p)));
        if (paths.every(isGribFile)) continue;
        const idx = await client.fetchEnsembleIndex(o.cycle, model, stream, file.kind, step);
        if (!idx)
          throw new Error(
            step === ladder[0]
              ? `${model.name} ${name}: the first step (+${step} h) is not published`
              : `${model.name} ${name}: +${step} h ${stream} is not published yet (to +${steps[steps.length - 1]} h so far); retried next round`
          );
        for (const m of inFile) {
          const recs = memberRecords(idx, m, file.control, params);
          for (const rec of recs) {
            const p = ensembleGribPath(o.cacheRoot, model.id, name, m, stream, step, rec.param);
            if (isGribFile(p)) continue;
            const msg = await client.fetchEnsembleField(o.cycle, model, stream, file.kind, step, rec, p);
            downloaded++;
            bytes += msg.length;
          }
        }
      }
    }
    steps.push(step);
    o.onProgress?.(++done, ladder.length + members.length, model.id);
  }
  return { steps, downloaded, bytes };
}

/**
 * One member decoded from the cache into its decoded run, one step at a time through one reused step block, as the
 * main forecast's streaming decode (loader.ts decodeForecastToDisk). Every message must be that member's
 * (grib2.ts product.ensemble), or the member is refused.
 */
function decodeMember(
  o: EnsembleCycleOptions,
  model: EnsembleModel,
  name: string,
  member: number,
  steps: number[],
  horizonHours: number
): void {
  if (!steps.length) throw new Error('no steps downloaded');
  const t = Date.now();
  const writer = new DecodedRunWriter(path.join(o.cacheRoot, ENSEMBLE_DECODED_DIR, model.id, memberDir(member)), name);
  const slab = new FloatSlab(ENSEMBLE_FIELDS.length * GLOBAL_CELLS);
  const scratch: DecodeScratch = {};
  const fillScratch: NanFillScratch = {};
  try {
    for (const step of steps) {
      const named = Object.entries(ENSEMBLE_PARAMS).flatMap(([stream, params]) =>
        params.map(param => {
          const message = parseGrib2Message(
            new Uint8Array(fs.readFileSync(ensembleGribPath(o.cacheRoot, model.id, name, member, stream, step, param)))
          );
          const got = message.product.ensemble?.member;
          if (got !== member)
            throw new Error(
              `${param} +${step} h is ${got === undefined ? 'not an ensemble member' : `member ${got}`}, expected member ${member}`
            );
          return { param, message };
        })
      );
      writer.writeStep(buildStep(named, null, 3, scratch, slab, fillScratch));
      slab.reset();
    }
    writer.finish({
      cycleTimeMs: o.cycle.time.getTime(),
      request: { horizonHours, params: ENSEMBLE_FIELDS },
      stepHours: steps,
      decodeMs: Date.now() - t,
    });
  } catch (err) {
    writer.abort();
    throw err;
  }
}

/**
 * What stays of each chosen model: the members wanted, in the cycle in use (current.json) and, while a pass has not
 * completed, the cycle it is decoding (`pending`: its decoded members and its GRIB cache, so the next pass resumes).
 * Everything else goes: other members, other cycles, a completed cycle's GRIB cache, models no longer chosen.
 * Returns what was removed.
 */
export function pruneEnsembles(
  cacheRoot: string,
  keep: Partial<Record<EnsembleModelId, { members: number[]; cycles: string[]; pending: string | null }>>
): string[] {
  const removed: string[] = [];
  const rm = (p: string, label: string): void => {
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(label);
  };
  /** A folder's entries; none when it is missing. */
  const list = (p: string): string[] => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  };
  const decodedRoot = path.join(cacheRoot, ENSEMBLE_DECODED_DIR);
  const gribRoot = path.join(cacheRoot, ENSEMBLE_GRIB_DIR);
  for (const model of list(decodedRoot)) {
    const k = keep[model as EnsembleModelId];
    if (!k) {
      rm(path.join(decodedRoot, model), `${model} (decoded)`);
      continue;
    }
    const cycles = k.pending ? [...k.cycles, k.pending] : k.cycles;
    for (const m of list(path.join(decodedRoot, model))) {
      if (m === CURRENT_FILE || m.startsWith('.')) continue;
      const root = path.join(decodedRoot, model, m);
      if (!k.members.some(x => memberDir(x) === m)) rm(root, `${model} ${m}`);
      else for (const c of pruneDecodedRuns(root, cycles)) removed.push(`${model} ${m} ${c}`);
    }
  }
  for (const model of list(gribRoot)) {
    const k = keep[model as EnsembleModelId];
    if (!k) {
      rm(path.join(gribRoot, model), `${model} (GRIB)`);
      continue;
    }
    for (const c of list(path.join(gribRoot, model))) if (c !== k.pending) rm(path.join(gribRoot, model, c), `${model} GRIB ${c}`);
  }
  return removed;
}

/** Bytes of the ensembles on disk (decoded runs and GRIB cache). */
export function ensembleDiskBytes(cacheRoot: string): number {
  return dirBytes(path.join(cacheRoot, ENSEMBLE_DECODED_DIR)) + dirBytes(path.join(cacheRoot, ENSEMBLE_GRIB_DIR));
}
