/**
 * ECMWF ensemble members (ecmwf.ts ENSEMBLES) downloaded and decoded to disk, so a route can be computed on each
 * member's forecast (plugin/ensembles.ts sets, worker/route.ts memberRun).
 *
 * Each member is a decoded run of its own, in the main forecast's format (decoded.ts), so every reader, completeness
 * check and prune works on it unchanged:
 *
 *   ecmwf-ens/<model>/<cycle>/mNN/<stream>-<step>h-<param>.grib2   the raw messages (the GRIB cache)
 *   forecast-ens/<model>/mNN/<cycle>/                              the decoded run of member NN
 *
 * mNN is the member: m00 the control (where a model publishes one), m01–m50 the perturbed members.
 *
 * A step's file holds every member: each index is read once (the last step's first, so a cycle not finished yet costs
 * little), every chosen member's fields are fetched from the step files into the cache, and the decode goes member by
 * member from the cache alone. An interrupted download resumes from the cache; a member that fails to decode is left
 * out and reported, the others go on. Only the routing fields are kept (ENSEMBLE_PARAMS), at the main forecast's
 * horizon. The data worker records the cycle in use from what is on disk (recordEnsembleCycle).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseGrib2Message, type DecodeScratch } from '../grib/grib2';
import { HOUR_S } from '../geo/units';
import { cycleName, DecodedRunWriter, openDecodedRun, pruneDecodedRuns } from './decoded';
import {
  type Cycle,
  cycleFor,
  type EcmwfClient,
  ENSEMBLE_MEMBER_MAX,
  ENSEMBLE_OPTIONAL_PARAMS,
  ENSEMBLE_PARAMS,
  ENSEMBLES,
  type EnsembleModel,
  type EnsembleModelId,
  type IndexRecord,
  isGribFile,
} from './ecmwf';
import { buildStep, FloatSlab, type NanFillScratch } from './forecast';
import { GLOBAL_CELLS } from './loader';
import { loadJsonFiles, removeJson, saveJson } from '../util/jsonfiles';

/** The GRIB cache of the ensembles, and their decoded runs, below the plugin data directory. */
export const ENSEMBLE_GRIB_DIR = 'ecmwf-ens';
export const ENSEMBLE_DECODED_DIR = 'forecast-ens';

/** The required fields of a member, in the order they are stored (the optional ones are in each step's own list). */
export const ENSEMBLE_FIELDS: string[] = [...ENSEMBLE_PARAMS.enfo, ...ENSEMBLE_PARAMS.waef];
/** The streams of a member's fields, each with its required and its optional parameters. */
const ENSEMBLE_STREAMS = (Object.keys(ENSEMBLE_PARAMS) as (keyof typeof ENSEMBLE_PARAMS)[]).map(stream => ({
  stream,
  params: ENSEMBLE_PARAMS[stream] as readonly string[],
  optional: ENSEMBLE_OPTIONAL_PARAMS[stream] as readonly string[],
}));

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
 * what is missing or doubled; an `optional` field the index does not have is left out, not an error.
 */
export function memberRecords(
  idx: IndexRecord[],
  member: number,
  control: boolean,
  params: readonly string[],
  optional = false
): IndexRecord[] {
  const out: IndexRecord[] = [];
  for (const p of params) {
    const recs = idx.filter(
      r =>
        r.param === p &&
        (r.levtype === undefined || r.levtype === 'sfc') &&
        (control ? r.number === undefined : Number(r.number) === member)
    );
    if (recs.length === 0 && optional) continue;
    if (recs.length !== 1) throw new Error(`${control ? 'the control' : `member ${member}`}: ${recs.length} records of ${p} in the index`);
    out.push(recs[0]);
  }
  return out;
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
 * A model's ensemble in use: the cycle whose wanted members are all complete on disk, and those members (`current.json`
 * in its folder). Routes and the status read it, so a cycle still being decoded is never used, and the one before
 * stays until it is replaced. Only the data worker writes it (recordEnsembleCycle), from what is on disk.
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
/** The folder of a model's pins (pinEnsembleCycle), beside its members' folders. */
const PINS_DIR = 'pins';

/**
 * An ensemble set's hold on the runs it routes on: its id, the cycle (yyyymmddHH) and the members of that cycle. While
 * the file is there, the prune keeps those runs (pruneEnsembles) and a member route may read them
 * (worker/route.ts memberRun), also after the record of the cycle in use has moved on to a newer cycle.
 */
export interface EnsemblePin {
  id: string;
  cycle: string;
  members: number[];
}

function pinFile(cacheRoot: string, model: EnsembleModelId, setId: string): string {
  return path.join(cacheRoot, ENSEMBLE_DECODED_DIR, model, PINS_DIR, `${setId}.json`);
}

/**
 * Keep `cycle`'s runs of `members` on disk while ensemble set `setId` routes on them (plugin/ensembles.ts: written when
 * the set is made, removed once it has ended and none of its routes runs). Until 2026-11-07 a new cycle recorded while
 * a set ran had the set's cycle pruned under it, and its members not yet routed failed as "no longer on disk" (PR #7
 * review). Null when kept, else why not.
 */
export function pinEnsembleCycle(
  cacheRoot: string,
  model: EnsembleModelId,
  setId: string,
  cycle: string,
  members: number[]
): string | null {
  const file = pinFile(cacheRoot, model, setId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    return (err as Error).message;
  }
  const pin: EnsemblePin = { id: setId, cycle, members };
  return saveJson(file, pin);
}

/** The set's pin removed (none there is removed); null, else why it could not be. */
export function unpinEnsembleCycle(cacheRoot: string, model: EnsembleModelId, setId: string): string | null {
  return removeJson(pinFile(cacheRoot, model, setId));
}

/** The pins of a model; a pin file that cannot be read, or holds no pin, is reported through `log` and left. */
export function ensemblePins(cacheRoot: string, model: EnsembleModelId, log: (msg: string) => void): EnsemblePin[] {
  const dir = path.join(cacheRoot, ENSEMBLE_DECODED_DIR, model, PINS_DIR);
  // No folder: no set has pinned this model (existsSync never throws).
  if (!fs.existsSync(dir)) return [];
  const isPin = (v: unknown): v is EnsemblePin => {
    const p = v as Partial<EnsemblePin> | null;
    return (
      !!p &&
      typeof p === 'object' &&
      typeof p.id === 'string' &&
      typeof p.cycle === 'string' &&
      /^\d{10}$/.test(p.cycle) &&
      Array.isArray(p.members) &&
      p.members.every(m => Number.isInteger(m) && m >= 0)
    );
  };
  return loadJsonFiles(dir, { one: `${model} pin`, a: 'a pin', many: `${model} pins` }, isPin, log).records;
}

/** The members of `model` that sets pin on `cycle`, or null when no set pins it. */
export function pinnedMembers(cacheRoot: string, model: EnsembleModelId, cycle: string, log: (msg: string) => void): number[] | null {
  const pins = ensemblePins(cacheRoot, model, log).filter(p => p.cycle === cycle);
  return pins.length ? [...new Set(pins.flatMap(p => p.members))] : null;
}

/**
 * Remove every pin: at the plugin's start no set runs (a set running at a stop ends failed: plugin/jobseries.ts), so
 * none holds a cycle. The problems, each a folder that could not be removed.
 */
export function clearEnsemblePins(cacheRoot: string): string[] {
  const root = path.join(cacheRoot, ENSEMBLE_DECODED_DIR);
  if (!fs.existsSync(root)) return [];
  const problems: string[] = [];
  let models: string[];
  try {
    models = fs.readdirSync(root);
  } catch (err) {
    return [`${root} could not be read: ${(err as Error).message}`];
  }
  for (const model of models) {
    const dir = path.join(root, model, PINS_DIR);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      problems.push(`${dir} could not be removed: ${(err as Error).message}`);
    }
  }
  return problems;
}

/**
 * Why `c` is not a record of `model`'s cycle in use, or null: every field as recordEnsembleCycle writes it, so what
 * reads the record (the status, a member route: `new Date(cycleTimeMs)`, the members) never meets a value that is not
 * one. (Until 2026-11-07 only the model, the cycle and the members' list were checked; PR #7 review.)
 */
function currentRecordProblem(c: unknown, model: EnsembleModelId): string | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'not an object';
  const r = c as Partial<EnsembleCurrent>;
  if (r.model !== model) return `model ${String(r.model)}`;
  if (typeof r.cycle !== 'string' || !/^\d{10}$/.test(r.cycle)) return `cycle ${String(r.cycle)}`;
  if (typeof r.cycleTimeMs !== 'number' || !Number.isFinite(r.cycleTimeMs)) return `cycleTimeMs ${String(r.cycleTimeMs)}`;
  if (!Array.isArray(r.members) || !r.members.every(m => Number.isInteger(m) && m >= 0 && m <= ENSEMBLE_MEMBER_MAX))
    return `members ${JSON.stringify(r.members)}`;
  if (typeof r.horizonHours !== 'number' || !Number.isFinite(r.horizonHours)) return `horizonHours ${String(r.horizonHours)}`;
  if (typeof r.at !== 'string') return `at ${String(r.at)}`;
  return null;
}

/**
 * A model's record of its ensemble in use (current.json in its folder): the record, or null with no problem when there
 * is none yet, or null with the problem when the file is there but cannot be read or is not that model's record (the
 * data worker reports it each round until it records the cycle again: worker/forecast.ts refreshEnsembles).
 */
export function ensembleCurrentFile(
  cacheRoot: string,
  model: EnsembleModelId
): { current: EnsembleCurrent | null; problem: string | null } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cacheRoot, ENSEMBLE_DECODED_DIR, model, CURRENT_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { current: null, problem: null };
    return { current: null, problem: `${CURRENT_FILE} cannot be read: ${(err as Error).message}` };
  }
  let c: unknown;
  try {
    c = JSON.parse(text);
  } catch (err) {
    return { current: null, problem: `${CURRENT_FILE} is not JSON: ${(err as Error).message}` };
  }
  const problem = currentRecordProblem(c, model);
  if (problem) return { current: null, problem: `${CURRENT_FILE} is not a record of ${model}'s cycle in use (${problem})` };
  return { current: c as EnsembleCurrent, problem: null };
}

/** A model's ensemble in use, or null when there is none to use (no record, or one that cannot be read: ensembleCurrentFile). */
export function readEnsembleCurrent(cacheRoot: string, model: EnsembleModelId): EnsembleCurrent | null {
  return ensembleCurrentFile(cacheRoot, model).current;
}

/**
 * Which members of a model are on disk to route on now, as its record says at this moment: the cycle in use (ISO) and
 * its members; null when there is no record; or what is wrong with the record. The one answer for the main thread
 * (index.ts: a route's forecast_member, a set's members), as the member routes read the same record
 * (worker/route.ts memberRun). Never the data worker's last status, which is behind the record between a new
 * cycle's recording and the next status (PR #7 review).
 */
export function ensembleInUse(
  cacheRoot: string,
  model: EnsembleModelId
): { cycle: string; members: number[] } | { problem: string } | null {
  const { current, problem } = ensembleCurrentFile(cacheRoot, model);
  if (problem) return { problem };
  return current ? { cycle: new Date(current.cycleTimeMs).toISOString(), members: [...current.members] } : null;
}

/**
 * Record `cycleTime`'s run as the model's ensemble in use, its `wanted` members being complete on disk (the caller has
 * checked them: worker/forecast.ts refreshEnsembles, each round and after each pass), so what is in use follows what is
 * on disk whatever stopped the pass that decoded it. Written only when it changes the record: another cycle or
 * horizon, or a wanted member the record lacks. Members recorded beyond those wanted stay until the next cycle
 * replaces the record: sets started on this cycle may still be routing on them. Null when recorded (or already so),
 * else why the record could not be written: the cycle is then not in use, and the caller says so.
 */
export function recordEnsembleCycle(
  cacheRoot: string,
  model: EnsembleModelId,
  cycleTime: Date,
  wanted: number[],
  horizonHours: number
): string | null {
  const cycle = cycleName(cycleTime);
  const cur = readEnsembleCurrent(cacheRoot, model);
  if (cur && cur.cycle === cycle && cur.horizonHours === horizonHours && wanted.every(n => cur.members.includes(n))) return null;
  const record: EnsembleCurrent = {
    model,
    cycle,
    cycleTimeMs: cycleTime.getTime(),
    members: wanted,
    horizonHours,
    at: new Date().toISOString(),
  };
  // The model's folder holds its members' runs: there whenever a member is complete.
  const why = saveJson(path.join(cacheRoot, ENSEMBLE_DECODED_DIR, model, CURRENT_FILE), record);
  return why ? `${CURRENT_FILE} could not be written: ${why}` : null;
}

export interface EnsembleCycleOptions {
  cacheRoot: string;
  cycle: Cycle;
  horizonS: number;
  models: EnsembleModelId[];
  /** Members 1 to this of each model (and the control where there is one). */
  members: number;
  log: (message: string) => void;
  /** After each step downloaded or member decoded: done of total for that model, for the status. */
  onProgress?: (done: number, total: number, model: EnsembleModelId) => void;
  /**
   * Before a model's download: given the bytes its pass will write (its GRIB messages not cached yet, by the indexes'
   * own lengths, and the decoded runs of its members to decode), why the disk cannot take it, or null.
   */
  diskCheck: (bytes: number) => string | null;
}

/**
 * Download and decode every chosen member of every chosen model for one cycle, skipping members already complete on
 * disk. A model whose first step is not published fails as a whole (nothing of it is decoded); a member that fails is
 * reported and the others go on.
 */
export async function runEnsembleCycle(client: EcmwfClient, o: EnsembleCycleOptions): Promise<EnsembleModelResult[]> {
  const log = o.log;
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
    // What is on disk now; the data worker records the cycle in use from it (recordEnsembleCycle).
    r.members = want.filter(m => memberComplete(o.cacheRoot, id, m, name, horizonHours));
    log(
      `${model.name} ${name}: ${r.members.length} of ${want.length} members on disk (${todo.length - r.failed.length} decoded now, ${r.downloaded} fields downloaded, ${r.failed.length} failed)`
    );
    out.push(r);
  }
  return out;
}

/**
 * Every field of `members` for the ladder into the cache. The last step's indexes are read first, then every step's: a
 * step the server does not have is not published yet (ensembleSteps), and the model's pass stops with an error before
 * anything is fetched (what is cached stays for the next round; nothing is decoded short). A cycle not finished yet
 * costs one index request per stream and file each round, not the whole ladder's. The indexes give the exact length
 * of every message still to fetch: with the members' decoded runs, that is what the disk check (o.diskCheck) is asked
 * about. Then the messages are fetched step by step. The optional fields (ENSEMBLE_OPTIONAL_PARAMS) are fetched for
 * a member when the index has them, and counted in what the pass writes only then.
 */
async function downloadModel(
  client: EcmwfClient,
  o: EnsembleCycleOptions,
  model: EnsembleModel,
  name: string,
  members: number[],
  ladder: number[]
): Promise<{ steps: number[]; downloaded: number; bytes: number }> {
  /**
   * The members a step file holds that still have a message to fetch from it (none: every required and optional field
   * is cached, isGribFile; whether an optional one exists is the index's to say, so it is read).
   */
  const toGet = (file: EnsembleModel['files'][number], stream: string, params: readonly string[], step: number): number[] => {
    const inFile = members.filter(m => (m === 0) === file.control);
    const cachedAll = inFile.every(m => params.every(p => isGribFile(ensembleGribPath(o.cacheRoot, model.id, name, m, stream, step, p))));
    return cachedAll ? [] : inFile;
  };
  // The ladder's last step first, one index per stream and file: a cycle the server has not finished publishing stops
  // here, without reading every index before it. The indexes read here serve the full read below.
  const read = new Map<string, IndexRecord[]>();
  const last = ladder[ladder.length - 1];
  for (const { stream, params, optional } of ENSEMBLE_STREAMS) {
    for (const file of model.files) {
      if (!toGet(file, stream, [...params, ...optional], last).length) continue;
      const idx = await client.fetchEnsembleIndex(o.cycle, model, stream, file.kind, last);
      if (!idx)
        throw new Error(
          last === ladder[0]
            ? `${model.name} ${name}: the first step (+${last} h) is not published`
            : `${model.name} ${name}: +${last} h ${stream}, the last step, is not published yet; retried next round`
        );
      read.set(`${stream}/${file.kind}/${last}`, idx);
    }
  }
  // Then every step's index: a step not published yet stops the pass before anything is fetched, and the indexes give
  // the exact size of what is still to fetch, for the disk check.
  const plan: { step: number; stream: string; kind: string; recs: { rec: IndexRecord; path: string }[] }[] = [];
  let toFetch = 0;
  // The optional fields the indexes have: a member's decoded run holds them too (what the pass writes).
  const optionalPresent = new Set<string>();
  for (const step of ladder) {
    for (const { stream, params, optional } of ENSEMBLE_STREAMS) {
      for (const file of model.files) {
        const inFile = toGet(file, stream, [...params, ...optional], step);
        if (!inFile.length) continue;
        const known = read.get(`${stream}/${file.kind}/${step}`);
        const idx = known !== undefined ? known : await client.fetchEnsembleIndex(o.cycle, model, stream, file.kind, step);
        if (!idx) {
          const before = ladder[ladder.indexOf(step) - 1];
          throw new Error(
            step === ladder[0]
              ? `${model.name} ${name}: the first step (+${step} h) is not published`
              : `${model.name} ${name}: +${step} h ${stream} is not published yet (to +${before} h so far); retried next round`
          );
        }
        const all = inFile.flatMap(m =>
          [...memberRecords(idx, m, file.control, params), ...memberRecords(idx, m, file.control, optional, true)].map(rec => ({
            rec,
            path: ensembleGribPath(o.cacheRoot, model.id, name, m, stream, step, rec.param),
          }))
        );
        for (const r of all) if (optional.includes(r.rec.param)) optionalPresent.add(r.rec.param);
        const recs = all.filter(r => !isGribFile(r.path));
        for (const r of recs) toFetch += r.rec._length;
        plan.push({ step, stream, kind: file.kind, recs });
      }
    }
  }
  // What the pass writes: the messages to fetch, and each member's decoded run (a global float32 per field and step,
  // the optional fields the indexes have included).
  const decoded = members.length * (ENSEMBLE_FIELDS.length + optionalPresent.size) * ladder.length * GLOBAL_CELLS * 4;
  const short = o.diskCheck(toFetch + decoded);
  if (short) throw new Error(`${model.name} ${name}: not downloaded: ${short}`);
  let downloaded = 0;
  let bytes = 0;
  let done = 0;
  for (const step of ladder) {
    for (const part of plan.filter(x => x.step === step)) {
      for (const { rec, path: p } of part.recs) {
        if (isGribFile(p)) continue;
        const msg = await client.fetchEnsembleField(o.cycle, model, part.stream, part.kind, step, rec, p);
        downloaded++;
        bytes += msg.length;
      }
    }
    o.onProgress?.(++done, ladder.length + members.length, model.id);
  }
  return { steps: ladder, downloaded, bytes };
}

/**
 * One member decoded from the cache into its decoded run, one step at a time through one reused step block, as the
 * main forecast's streaming decode (loader.ts decodeForecastToDisk). Every message must be that member's
 * (grib2.ts product.ensemble), or the member is refused. An optional field (ENSEMBLE_OPTIONAL_PARAMS) is built into
 * the step on its own, from its cached message when there is one, so nothing wrong with it stops the member: it is
 * left out of that step and reported.
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
  const optionalCount = ENSEMBLE_STREAMS.reduce((n, s) => n + s.optional.length, 0);
  const slab = new FloatSlab((ENSEMBLE_FIELDS.length + optionalCount) * GLOBAL_CELLS);
  const scratch: DecodeScratch = {};
  const fillScratch: NanFillScratch = {};
  /** The cached message of `param` at `step`, checked to be this member's. */
  const message = (stream: string, step: number, param: string): { param: string; message: ReturnType<typeof parseGrib2Message> } => {
    const parsed = parseGrib2Message(
      new Uint8Array(fs.readFileSync(ensembleGribPath(o.cacheRoot, model.id, name, member, stream, step, param)))
    );
    const got = parsed.product.ensemble?.member;
    if (got !== member)
      throw new Error(
        `${param} +${step} h is ${got === undefined ? 'not an ensemble member' : `member ${got}`}, expected member ${member}`
      );
    return { param, message: parsed };
  };
  try {
    for (const step of steps) {
      const named = ENSEMBLE_STREAMS.flatMap(({ stream, params }) => params.map(param => message(stream, step, param)));
      const built = buildStep(named, null, 3, scratch, slab, fillScratch);
      for (const { stream, optional } of ENSEMBLE_STREAMS) {
        for (const param of optional) {
          if (!isGribFile(ensembleGribPath(o.cacheRoot, model.id, name, member, stream, step, param))) continue;
          try {
            const extra = buildStep([message(stream, step, param)], null, 3, scratch, slab, fillScratch);
            if (extra.validMs !== built.validMs) throw new Error('its valid time differs from the step');
            for (const [k, f] of extra.fields) built.fields.set(k, f);
          } catch (err) {
            o.log(`${model.name} ${memberDir(member)} +${step} h: ${param} not decoded (${(err as Error).message}), left out`);
          }
        }
      }
      writer.writeStep(built);
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
 * completed, the cycle it is decoding (`pending`: its decoded members and its GRIB cache, so the next pass resumes);
 * and the cycles and members running ensemble sets pin (pinEnsembleCycle), with their pins. Everything else goes: other
 * members, other cycles, a completed cycle's GRIB cache, models no longer chosen (their pins with them).
 * Returns what was removed, and each folder that could not be read or removed (left as it is; the caller reports it).
 */
export function pruneEnsembles(
  cacheRoot: string,
  keep: Partial<Record<EnsembleModelId, { members: number[]; cycles: string[]; pending: string | null }>>
): { removed: string[]; problems: string[] } {
  const removed: string[] = [];
  const problems: string[] = [];
  const rm = (p: string, label: string): void => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(label);
    } catch (err) {
      problems.push(`${p} could not be removed: ${(err as Error).message}`);
    }
  };
  /** A folder's entries; none when it is missing, none and a problem when it cannot be read. */
  const list = (p: string): string[] => {
    try {
      return fs.readdirSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`${p} could not be read: ${(err as Error).message}`);
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
    // What running sets hold (pinEnsembleCycle): their cycles and members, kept whatever else changed.
    const pins = ensemblePins(cacheRoot, model as EnsembleModelId, m => problems.push(m));
    const cycles = [...k.cycles, ...(k.pending ? [k.pending] : []), ...pins.map(p => p.cycle)];
    const members = [...k.members, ...pins.flatMap(p => p.members)];
    for (const m of list(path.join(decodedRoot, model))) {
      if (m === CURRENT_FILE || m === PINS_DIR || m.startsWith('.')) continue;
      const root = path.join(decodedRoot, model, m);
      if (!members.some(x => memberDir(x) === m)) rm(root, `${model} ${m}`);
      else
        try {
          for (const c of pruneDecodedRuns(root, cycles)) removed.push(`${model} ${m} ${c}`);
        } catch (err) {
          problems.push(`${root}: ${(err as Error).message}`);
        }
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
  return { removed, problems };
}
