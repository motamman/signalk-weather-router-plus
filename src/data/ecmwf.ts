/**
 * ECMWF open-data client: finds the newest published forecast cycle,
 * reads each step's `.index` file, and fetches only the requested
 * fields by HTTP Range request. Fetched messages are cached on disk
 * (one GRIB2 message per file) before anything decodes them, so a
 * failed decode never forces a re-download.
 *
 * URL layout (verified against data.ecmwf.int and the reference
 * `ecmwf-opendata` client):
 *   {base}/{yyyymmdd}/{HH}z/ifs/0p25/{stream}/{yyyymmddHH0000}-{step}h-{stream}-fc.grib2
 *   {base}/{yyyymmdd}/{HH}z/ifs/0p25/{stream}/{yyyymmddHH0000}-{step}h-{stream}-fc.index
 * Streams: every cycle uses `oper` (atmosphere) and `wave`. 00z/12z publish
 * 0–144 h every 3 h then 150–360 h every 6 h (85 steps); 06z/18z publish
 * 0–144 h every 3 h (49 steps). Checked on data.ecmwf.int 2026-09-29
 * (20260929/00z and 20260928/06z directory listings); the former
 * `scda`/`scwv` directories for 06z/18z are empty.
 */

import * as fs from 'node:fs';
import { fetchBodyWithRetry, isOffline, sleep } from './http';
import { MINUTE_MS, HOUR_MS, HOUR_S } from '../geo/units';
import * as path from 'node:path';

/** The open-data mirrors, by the name the configuration chooses one with: the one list of them. */
export const ECMWF_MIRRORS = {
  ecmwf: 'https://data.ecmwf.int/forecasts',
  aws: 'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com',
  google: 'https://storage.googleapis.com/ecmwf-open-data',
} as const;
export type EcmwfMirror = keyof typeof ECMWF_MIRRORS;

/** Each mirror's name for people (the configuration panel shows these). */
export const ECMWF_MIRROR_LABELS: Record<EcmwfMirror, string> = {
  ecmwf: 'ECMWF (data.ecmwf.int)',
  aws: 'Amazon (AWS Open Data)',
  google: 'Google Cloud',
};

/** True when `name` is a mirror's name (ECMWF_MIRRORS). */
export function isEcmwfMirror(name: string): name is EcmwfMirror {
  return Object.hasOwn(ECMWF_MIRRORS, name);
}

/** Parameters the router needs, by stream: a cycle or a decoded run without one of these is incomplete. */
export const ATM_PARAMS = ['10u', '10v', 'msl'] as const;
export const WAVE_PARAMS = ['swh', 'mwp', 'mwd'] as const;
/**
 * Wave fields fetched and decoded when they can be, never required:
 *  - mp2, the mean zero-crossing period Tm02: the period a polar's wave-correction table is read with
 *    (vessel/wavecorrection.ts). ECMWF's mwp is the energy mean period Tm−1,0, longer than Tm01 or Tm02; open data has
 *    no Tm01, so mp2 is the nearest to TimeZero's tables (SignalK/sailsconfiguration#13, 2026-11-04).
 *  - pp1d, the peak period, kept for tables made for it (not read yet).
 * A cycle cached, or a run decoded, without them is complete, so an update never makes a boat that is offline throw
 * away the forecast it has.
 */
export const OPTIONAL_WAVE_PARAMS = ['mp2', 'pp1d'] as const;

/**
 * The ECMWF ensembles the plugin can download, each on the same open-data server, grid (0.25°) and `.index` byte-range
 * scheme as the main forecast (checked on data.ecmwf.int, 2026-11-05):
 *  - IFS ENS (`ifs/0p25`): one `ef` file per stream and step holds the 50 perturbed members (index `type` pf, `number`
 *    1–50); open data has no control member. Steps every 3 h to 144 h, then every 6 h, as the main forecast.
 *  - AIFS ENS (`aifs-ens/0p25`, ECMWF's machine-learning ensemble): `pf` files hold members 1–50 and a `cf` file the
 *    control, whose index records carry no `number` (member 0 here). Steps every 6 h.
 * Both put the wind (`10u`, `10v`) in the `enfo` stream and the waves (`swh`, `mwp`, `mwd`) in `waef`. Every message is
 * product definition template 4.1 (grib2.ts), which names its member.
 */
export const ENSEMBLE_MODELS = ['ifs-ens', 'aifs-ens'] as const;
export type EnsembleModelId = (typeof ENSEMBLE_MODELS)[number];

export interface EnsembleModel {
  id: EnsembleModelId;
  /** For people: settings, the page, the log. */
  name: string;
  /** Path below the cycle's directory, before the stream. */
  path: string;
  /** The files of a step: kind (the file name's suffix) and whether it holds the control (member 0) or the members. */
  files: { kind: string; control: boolean }[];
  /** Hours between steps up to 144 h (6 h after it for every model). */
  stepHours: number;
  /** The members besides the control (numbered 1 to this): what a setting and a set may ask for at most. */
  members: number;
}

export const ENSEMBLES: Record<EnsembleModelId, EnsembleModel> = {
  'ifs-ens': { id: 'ifs-ens', name: 'ECMWF IFS ENS', path: 'ifs/0p25', files: [{ kind: 'ef', control: false }], stepHours: 3, members: 50 },
  'aifs-ens': {
    id: 'aifs-ens',
    name: 'ECMWF AIFS ENS',
    path: 'aifs-ens/0p25',
    files: [
      { kind: 'cf', control: true },
      { kind: 'pf', control: false },
    ],
    stepHours: 6,
    members: 50,
  },
};

/** The routing fields an ensemble member holds, by stream (the main forecast's base fields less the pressure): required. */
export const ENSEMBLE_PARAMS = { enfo: ['10u', '10v'], waef: ['swh', 'mwp', 'mwd'] } as const;

/**
 * The optional field an ensemble member holds when its index has it, never required, as the main forecast's
 * OPTIONAL_WAVE_PARAMS: mp2, the mean zero-crossing period Tm02 the wave correction reads. IFS ENS publishes it, AIFS
 * ENS does not (data.ecmwf.int, 2026-11-06, the 00z run's +24 h wave indexes); a member without it routes its waves
 * uncorrected (engine/smoother.ts waves_no_period). pp1d is not read by the router, so not fetched for every member.
 */
export const ENSEMBLE_OPTIONAL_PARAMS = { enfo: [], waef: ['mp2'] } as const;

/** The highest member number of any ensemble (its members are numbered 1 to this, 0 is the control): ENSEMBLES. */
export const ENSEMBLE_MEMBER_MAX = Math.max(...Object.values(ENSEMBLES).map(m => m.members));

/** The number of members a setting may ask for: in fives, up to the fewest members a model has (ENSEMBLES). */
export const ENSEMBLE_MEMBER_CHOICES: readonly number[] = Array.from(
  { length: Math.floor(Math.min(...Object.values(ENSEMBLES).map(m => m.members)) / 5) },
  (_, i) => 5 * (i + 1)
);

export type EcmwfParam =
  | (typeof ATM_PARAMS)[number]
  | (typeof WAVE_PARAMS)[number]
  | (typeof OPTIONAL_WAVE_PARAMS)[number]
  | '2t'
  | 'tprate'
  | 'skt'
  | '2d'
  | 'ptype'
  | 'tcc'
  | '10fg'
  | 'tp'
  | 'ssrd'
  | 'sf'
  | 'strd'
  | 'str'
  | 'mucape';

export interface IndexRecord {
  param: string;
  step: string;
  levtype?: string;
  _offset: number;
  _length: number;
  [k: string]: unknown;
}

export interface Cycle {
  /** Cycle reference time (UTC). */
  time: Date;
  yyyymmdd: string;
  hh: string;
  atmStream: 'oper';
  waveStream: 'wave';
  /** Last published step, hours: 360 for 00z/12z, 144 for 06z/18z. */
  maxStep: number;
}

export interface EcmwfClientOptions {
  /** Primary mirror base URL (see ECMWF_MIRRORS). */
  baseUrl?: string;
  /**
   * Further mirrors tried in order when the current one keeps
   * answering 429/5xx or is unreachable. Default: the other two
   * public mirrors.
   */
  fallbackUrls?: string[];
  /** Directory for cached GRIB2 messages. */
  cacheDir: string;
  timeoutMs?: number;
  /** Attempts per mirror (default 6: backoff 2, 4, 8, 16, 32 s). */
  retries?: number;
  log?: (msg: string) => void;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Minutes from a cycle's nominal time to its publication on the open-data
 * server: every file of the cycle appears at once. Measured from the
 * Last-Modified of the +108 h index files on data.ecmwf.int for every
 * cycle from 2026-10-16 00z to 2026-10-19 00z (14 cycles, both streams):
 * 00z/12z at 07:34/19:34 UTC, 06z/18z at 12:27/00:27 UTC, to the minute
 * every time.
 */
export const MAIN_PUBLICATION_LAG_MINUTES = 454;
export const SHORT_PUBLICATION_LAG_MINUTES = 387;

/** When a cycle is published on the open-data server. */
export function publishedAt(c: Pick<Cycle, 'time' | 'maxStep'>): Date {
  const lag = c.maxStep === MAIN_MAX_STEP ? MAIN_PUBLICATION_LAG_MINUTES : SHORT_PUBLICATION_LAG_MINUTES;
  return new Date(c.time.getTime() + lag * MINUTE_MS);
}

/** Does a cycle run at least as far as the horizon (06z/18z stop at 144 h)? */
function coversHorizon(c: Cycle, horizonHours: number): boolean {
  return c.maxStep >= horizonHours || c.maxStep === MAIN_MAX_STEP;
}

/**
 * The most recent cycle published by `now` (publishedAt): cycles run at
 * 00/06/12/18Z. When the horizon exceeds what the 06z/18z cycles publish
 * (144 h), only 00z/12z cycles qualify. A cycle qualifies when it runs at
 * least as far as the horizon (the same test as findLatestCycle), not when
 * one of its 3-hourly steps lands exactly on it: with a 110 h horizon the
 * last step is 108 h, and the old test rejected every 06z/18z run (brain,
 * 2026-10-06: the 00z run stayed in use all day while the 06z run had been
 * published for hours).
 */
export function latestExpectedCycle(now: Date, horizonS: number): Cycle {
  const horizonHours = horizonS / HOUR_S;
  let start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(now.getUTCHours() / 6) * 6));
  for (;;) {
    const c = cycleFor(start);
    if (coversHorizon(c, horizonHours) && publishedAt(c).getTime() <= now.getTime()) return c;
    start = new Date(start.getTime() - 6 * HOUR_MS);
  }
}

/** The cycle after `c` that the horizon can use (6 h later, or 12 h when only 00z/12z qualify). */
export function nextCycle(c: Pick<Cycle, 'time'>, horizonS: number): Cycle {
  const horizonHours = horizonS / HOUR_S;
  let t = c.time.getTime() + 6 * HOUR_MS;
  for (;;) {
    const n = cycleFor(new Date(t));
    if (coversHorizon(n, horizonHours)) return n;
    t += 6 * HOUR_MS;
  }
}

export { parseRetryAfterMs } from './http';

export class EcmwfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcmwfError';
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function cycleFor(time: Date): Cycle {
  const hh = pad2(time.getUTCHours());
  const yyyymmdd = `${time.getUTCFullYear()}${pad2(time.getUTCMonth() + 1)}${pad2(time.getUTCDate())}`;
  const main = hh === '00' || hh === '12';
  return { time, yyyymmdd, hh, atmStream: 'oper', waveStream: 'wave', maxStep: main ? MAIN_MAX_STEP : SHORT_MAX_STEP };
}

/** Last step of the 00z/12z and the 06z/18z cycles, hours. */
export const MAIN_MAX_STEP = 360;
export const SHORT_MAX_STEP = 144;

/**
 * Steps a cycle publishes up to the horizon (atmosphere and waves alike):
 * every 3 h to 144 h, then every 6 h to the cycle's last step.
 */
export function availableSteps(cycle: Pick<Cycle, 'maxStep'>, horizonHours: number): number[] {
  const steps: number[] = [];
  for (let s = 0; s <= Math.min(horizonHours, cycle.maxStep); s += s < 144 ? 3 : 6) steps.push(s);
  return steps;
}

/** An index file's records (one JSON object per line), each checked to carry its offset, length and parameter. */
function parseIndex(text: string, url: string): IndexRecord[] {
  const out: IndexRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const rec = JSON.parse(t) as IndexRecord;
    if (typeof rec._offset !== 'number' || typeof rec._length !== 'number' || typeof rec.param !== 'string')
      throw new EcmwfError(`malformed index line in ${url}: ${t.slice(0, 120)}`);
    out.push(rec);
  }
  return out;
}

/**
 * A cached message is there: the file is a whole GRIB2 message by its own indicator section (octets 1–16: GRIB,
 * edition 2, and the message's total length in octets 9–16), that is, it starts so and is exactly the length it
 * states. The one rule wherever a message is taken from the cache or skipped as cached, for the main forecast
 * (hasCached, the loader's gate, and fetchField) and the ensembles (the pass's plan and fetchEnsembleField), and it
 * needs no index: a cycle cached whole is still read with no network, and a message cut short on disk is fetched
 * again on both paths (until 2026-11-07 the loader's gate and the ensemble pass read the header alone and only the
 * fetch checked the index record's length, which the loader never reached, as it reads a step's index only for a
 * field its gate finds not cached: a file cut short was never fetched again, and its step or member failed to decode
 * every round; PR #7 review). False when there is no such file; a file that is there but cannot be read throws (a
 * failing disk is reported, never taken for a message to fetch again).
 */
export function isGribFile(p: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(p, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  try {
    const indicator = Buffer.alloc(16);
    if (fs.readSync(fd, indicator, 0, 16, 0) !== 16) return false;
    if (indicator.toString('latin1', 0, 4) !== 'GRIB' || indicator[7] !== 2) return false;
    return indicator.readBigUInt64BE(8) === BigInt(fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A fetched message into the GRIB cache at `cached`, through a temporary file renamed into place. The temporary name
 * is unique per writer: the data worker and the route worker (first boot, no decoded run yet) can fetch the same field
 * at once, and threads share a pid. A rename that fails takes its temporary file with it; one that fails because
 * another writer put the same message in place meanwhile has that as its answer.
 */
function writeCached(cached: string, msg: Uint8Array): void {
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  const tmp = `${cached}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, msg);
  try {
    fs.renameSync(tmp, cached);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    // Another writer's whole message there meanwhile is this one's answer; anything else (none, or a message cut short
    // that the rename should have replaced) is the failure (until 2026-11-07 any file there was taken for an answer, so
    // a cut-short one stayed in the cache unsaid).
    if (!isGribFile(cached)) throw err;
  }
}

export class EcmwfClient {
  /** Mirrors in order; index 0 is the one currently in use. */
  private mirrors: string[];
  readonly cacheDir: string;
  readonly timeoutMs: number;
  readonly retries: number;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: EcmwfClientOptions) {
    const primary = (opts.baseUrl ?? ECMWF_MIRRORS.ecmwf).replace(/\/$/, '');
    const fallbacks = (opts.fallbackUrls ?? Object.values(ECMWF_MIRRORS)).map(u => u.replace(/\/$/, '')).filter(u => u !== primary);
    this.mirrors = [primary, ...fallbacks];
    this.cacheDir = opts.cacheDir;
    this.timeoutMs = opts.timeoutMs ?? MINUTE_MS;
    this.retries = opts.retries ?? 6;
    this.log = opts.log ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /** Base URL of the mirror currently in use. */
  get baseUrl(): string {
    return this.mirrors[0];
  }

  /** Path of a step file below any mirror's base URL. */
  stepPath(cycle: Cycle, stream: string, step: number, ext: 'grib2' | 'index'): string {
    return `/${cycle.yyyymmdd}/${cycle.hh}z/ifs/0p25/${stream}/${cycle.yyyymmdd}${cycle.hh}0000-${step}h-${stream}-fc.${ext}`;
  }

  stepUrl(cycle: Cycle, stream: string, step: number, ext: 'grib2' | 'index'): string {
    return this.baseUrl + this.stepPath(cycle, stream, step, ext);
  }

  /**
   * HTTP request with the shared retry policy (http.ts): up to `retries`
   * attempts per mirror, exponential backoff 2, 4, 8, 16, 32 s (capped
   * at 60 s), `Retry-After` honoured, retried only on 408/429/5xx and
   * network errors. When a mirror is exhausted the next mirror takes
   * over for the rest of the session. 404/403 are returned as-is. No
   * connection at all (OfflineError) is thrown at once, mirrors untried.
   * The body is read inside the attempt, under its timeout (http.ts
   * fetchBodyWithRetry): a download that stalls is a timed-out attempt, retried and
   * failed over like a dead connection, so no request of this client
   * waits without end (until 2026-11-07 the callers read the body after
   * the attempt had returned, outside any timeout, and the ensemble
   * child, which has no deadline of its own, could hang on one stalled
   * message).
   */
  private async request(pathSuffix: string, init: RequestInit = {}): Promise<{ status: number; body: Uint8Array }> {
    let lastErr: unknown;
    for (let m = 0; m < this.mirrors.length; m++) {
      const url = this.baseUrl + pathSuffix;
      try {
        const r = await fetchBodyWithRetry(url, init, {
          timeoutMs: this.timeoutMs,
          retries: this.retries,
          fetchImpl: this.fetchImpl,
          sleepImpl: this.sleepImpl,
          log: this.log,
          makeError: msg => new EcmwfError(msg),
        });
        return { status: r.status, body: r.body };
      } catch (err) {
        // No connection at all: another mirror is no more reachable.
        if (isOffline(err)) throw err;
        lastErr = err;
      }
      if (m + 1 < this.mirrors.length) {
        this.log(`mirror ${this.baseUrl} exhausted (${(lastErr as Error).message}); switching to ${this.mirrors[1]}`);
        this.mirrors.push(this.mirrors.shift()!);
      }
    }
    throw lastErr instanceof Error ? lastErr : new EcmwfError(`request failed: ${pathSuffix}`);
  }

  /** Does the index for this step exist on the server? */
  async stepPublished(cycle: Cycle, stream: string, step: number): Promise<boolean> {
    const res = await this.request(this.stepPath(cycle, stream, step, 'index'), { method: 'HEAD' });
    if (res.status === 200) return true;
    if (res.status === 404 || res.status === 403) return false;
    throw new EcmwfError(`unexpected HTTP ${res.status} probing ${this.stepUrl(cycle, stream, step, 'index')}`);
  }

  /**
   * Newest cycle whose atmosphere and wave streams both have the
   * requested final step published. Starts from the wall-clock expected
   * cycle (the newest whose publication time has passed) and walks back in 6 h cycles,
   * up to `maxAgeHours`, so the usual case costs two HEAD requests.
   */
  async findLatestCycle(horizonS: number, opts: { mainCyclesOnly?: boolean; maxAgeHours?: number; now?: Date } = {}): Promise<Cycle> {
    const horizonHours = horizonS / HOUR_S;
    const now = opts.now ?? new Date();
    const maxAge = opts.maxAgeHours ?? 48;
    const start = latestExpectedCycle(now, horizonS).time;
    for (let ageH = 0; ageH <= maxAge; ageH += 6) {
      const c = cycleFor(new Date(start.getTime() - ageH * HOUR_MS));
      if (opts.mainCyclesOnly && c.maxStep !== MAIN_MAX_STEP) continue;
      const steps = availableSteps(c, horizonHours);
      const last = steps[steps.length - 1];
      if (last < horizonHours && c.maxStep < horizonHours) continue; // 06z/18z cannot cover the horizon
      const [a, w] = await Promise.all([this.stepPublished(c, c.atmStream, last), this.stepPublished(c, c.waveStream, last)]);
      if (a && w) {
        this.log(`latest complete cycle: ${c.yyyymmdd} ${c.hh}z (${c.atmStream}/${c.waveStream}) to +${last} h`);
        return c;
      }
    }
    throw new EcmwfError(`no ECMWF cycle in the last ${maxAge} h has +${horizonHours} h published`);
  }

  /** A step file's `.index` from the mirror, parsed into its records (one per message); any answer but 200 throws. */
  async fetchIndex(cycle: Cycle, stream: string, step: number): Promise<IndexRecord[]> {
    const url = this.stepUrl(cycle, stream, step, 'index');
    const res = await this.request(this.stepPath(cycle, stream, step, 'index'));
    if (res.status !== 200) throw new EcmwfError(`HTTP ${res.status} fetching ${url}`);
    return parseIndex(new TextDecoder().decode(res.body), url);
  }

  cachePath(cycle: Cycle, stream: string, step: number, param: string): string {
    return path.join(this.cacheDir, `${cycle.yyyymmdd}${cycle.hh}`, `${stream}-${String(step).padStart(3, '0')}h-${param}.grib2`);
  }

  /**
   * Is the message cached (isGribFile)? The loader's gate (loader.ts decodeSteps): a step's index is read only for a
   * field this says no to, so the rule it applies must stand on the file alone.
   */
  hasCached(cycle: Cycle, stream: string, step: number, param: string): boolean {
    return isGribFile(this.cachePath(cycle, stream, step, param));
  }

  /**
   * True when every (stream, step, param) the loader will ask for is
   * already cached, so a load needs no network at all.
   */
  cycleFullyCached(cycle: Cycle, horizonS: number, atmParams: readonly string[], waveParams: readonly string[]): boolean {
    const horizonHours = horizonS / HOUR_S;
    for (const step of availableSteps(cycle, horizonHours)) {
      for (const p of atmParams) if (!this.hasCached(cycle, cycle.atmStream, step, p)) return false;
    }
    if (waveParams.length) {
      for (const step of availableSteps(cycle, horizonHours)) {
        for (const p of waveParams) if (!this.hasCached(cycle, cycle.waveStream, step, p)) return false;
      }
    }
    return true;
  }

  /** Cycles present in the cache directory, newest first. */
  cachedCycles(): Cycle[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch {
      return [];
    }
    return entries
      .filter(e => /^\d{10}$/.test(e))
      .sort()
      .reverse()
      .map(e => cycleFor(new Date(Date.UTC(+e.slice(0, 4), +e.slice(4, 6) - 1, +e.slice(6, 8), +e.slice(8, 10)))));
  }

  /**
   * Fetch one field of one step as a raw GRIB2 message (from cache when
   * present). Returns null when the index has no such parameter.
   */
  async fetchField(cycle: Cycle, stream: string, step: number, param: string, index?: IndexRecord[]): Promise<Uint8Array | null> {
    const cached = this.cachePath(cycle, stream, step, param);
    // From the cache when it holds the message (isGribFile); a file that is not one is written over (writeCached
    // renames the fetched message into its place).
    if (isGribFile(cached)) return new Uint8Array(fs.readFileSync(cached));
    const idx = index ?? (await this.fetchIndex(cycle, stream, step));
    const rec = idx.find(r => r.param === param && (r.levtype === undefined || r.levtype === 'sfc'));
    if (!rec) return null;
    const msg = await this.fetchMessage(this.stepPath(cycle, stream, step, 'grib2'), rec, step);
    writeCached(cached, msg);
    return msg;
  }

  /**
   * One index record of a step file as its raw GRIB2 message, by HTTP Range (a server that ignores the range sends the
   * whole file, which is sliced), checked to be the record's length and to start with GRIB.
   */
  private async fetchMessage(pathSuffix: string, rec: IndexRecord, step: number): Promise<Uint8Array> {
    const res = await this.request(pathSuffix, { headers: { Range: `bytes=${rec._offset}-${rec._offset + rec._length - 1}` } });
    if (res.status !== 206 && res.status !== 200)
      throw new EcmwfError(`HTTP ${res.status} fetching ${rec.param} from ${this.baseUrl}${pathSuffix}`);
    const buf = res.body;
    const msg = res.status === 200 ? buf.subarray(rec._offset, rec._offset + rec._length) : buf;
    if (msg.length !== rec._length)
      throw new EcmwfError(`short read for ${rec.param} step ${step}: got ${msg.length} of ${rec._length} bytes`);
    if (!(msg[0] === 0x47 && msg[1] === 0x52 && msg[2] === 0x49 && msg[3] === 0x42))
      throw new EcmwfError(`fetched bytes for ${rec.param} step ${step} do not start with GRIB`);
    return msg;
  }

  /** Path of an ensemble step file below any mirror's base URL. */
  ensembleStepPath(cycle: Cycle, model: EnsembleModel, stream: string, kind: string, step: number, ext: 'grib2' | 'index'): string {
    return `/${cycle.yyyymmdd}/${cycle.hh}z/${model.path}/${stream}/${cycle.yyyymmdd}${cycle.hh}0000-${step}h-${stream}-${kind}.${ext}`;
  }

  /**
   * An ensemble step file's index, or null when the cycle has no such step (404/403: past the end of this cycle's
   * ladder, or not published yet).
   */
  async fetchEnsembleIndex(cycle: Cycle, model: EnsembleModel, stream: string, kind: string, step: number): Promise<IndexRecord[] | null> {
    const p = this.ensembleStepPath(cycle, model, stream, kind, step, 'index');
    const res = await this.request(p);
    if (res.status === 404 || res.status === 403) return null;
    if (res.status !== 200) throw new EcmwfError(`HTTP ${res.status} fetching ${this.baseUrl}${p}`);
    return parseIndex(new TextDecoder().decode(res.body), this.baseUrl + p);
  }

  /**
   * One record of an ensemble step file as a raw GRIB2 message, written to `cachePath` (one message per file, as the
   * main forecast's cache); from the cache when it holds the message (isGribFile), a file that is not one written over.
   */
  async fetchEnsembleField(
    cycle: Cycle,
    model: EnsembleModel,
    stream: string,
    kind: string,
    step: number,
    rec: IndexRecord,
    cachePath: string
  ): Promise<Uint8Array> {
    if (isGribFile(cachePath)) return new Uint8Array(fs.readFileSync(cachePath));
    const msg = await this.fetchMessage(this.ensembleStepPath(cycle, model, stream, kind, step, 'grib2'), rec, step);
    writeCached(cachePath, msg);
    return msg;
  }

  /** Delete cached cycles other than `keep`. No cache folder yet: nothing to delete; one that cannot be read throws. */
  pruneCache(keep: Cycle[]): void {
    const keepNames = new Set(keep.map(c => `${c.yyyymmdd}${c.hh}`));
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (/^\d{10}$/.test(e) && !keepNames.has(e)) {
        fs.rmSync(path.join(this.cacheDir, e), { recursive: true, force: true });
        this.log(`pruned cached cycle ${e}`);
      }
    }
  }
}
