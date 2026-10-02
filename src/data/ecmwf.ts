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
import { fetchWithRetry, sleep } from './http';
import { MINUTE_MS, HOUR_MS, HOUR_S } from '../geo/units';
import * as path from 'node:path';

export const ECMWF_MIRRORS: Record<string, string> = {
  ecmwf: 'https://data.ecmwf.int/forecasts',
  aws: 'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com',
  google: 'https://storage.googleapis.com/ecmwf-open-data',
};

/** Parameters the router needs, by stream. */
export const ATM_PARAMS = ['10u', '10v', 'msl'] as const;
export const WAVE_PARAMS = ['swh', 'mwp', 'mwd'] as const;
export type EcmwfParam =
  (typeof ATM_PARAMS)[number] | (typeof WAVE_PARAMS)[number] | '2t' | 'tprate' | 'skt' | '2d' | 'ptype' | 'tcc' | '10fg';

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

/** Publication lag assumed for the wall-clock "expected cycle" rule (same as the planner). */
export const PUBLICATION_LAG_MINUTES = 400;

/**
 * The most recent cycle that should be published by `now`, given a
 * ~400 minute publication lag: cycles run at 00/06/12/18Z. When the
 * horizon exceeds what the 06z/18z cycles publish (144 h), only 00z/12z
 * cycles qualify.
 */
export function latestExpectedCycle(now: Date, horizonS: number): Cycle {
  const horizonHours = horizonS / HOUR_S;
  const t = new Date(now.getTime() - PUBLICATION_LAG_MINUTES * MINUTE_MS);
  let start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), Math.floor(t.getUTCHours() / 6) * 6));
  for (;;) {
    const c = cycleFor(start);
    const steps = availableSteps(c, horizonHours);
    if (steps[steps.length - 1] >= horizonHours || c.maxStep === MAIN_MAX_STEP) return c;
    start = new Date(start.getTime() - 6 * HOUR_MS);
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
   * HTTP request with the planner's retry policy: up to `retries`
   * attempts per mirror, exponential backoff 2, 4, 8, 16, 32 s (capped
   * at 60 s), `Retry-After` honoured, retried only on 408/429/5xx and
   * network errors. When a mirror is exhausted the next mirror takes
   * over for the rest of the session. 404/403 are returned as-is.
   */
  private async request(pathSuffix: string, init: RequestInit = {}): Promise<Response> {
    let lastErr: unknown;
    for (let m = 0; m < this.mirrors.length; m++) {
      const url = this.baseUrl + pathSuffix;
      try {
        const r = await fetchWithRetry(url, init, {
          timeoutMs: this.timeoutMs,
          retries: this.retries,
          fetchImpl: this.fetchImpl,
          sleepImpl: this.sleepImpl,
          log: this.log,
          makeError: msg => new EcmwfError(msg),
        });
        return r.response;
      } catch (err) {
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
   * cycle (now minus the publication lag) and walks back in 6 h cycles,
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

  async fetchIndex(cycle: Cycle, stream: string, step: number): Promise<IndexRecord[]> {
    const url = this.stepUrl(cycle, stream, step, 'index');
    const res = await this.request(this.stepPath(cycle, stream, step, 'index'));
    if (res.status !== 200) throw new EcmwfError(`HTTP ${res.status} fetching ${url}`);
    const text = await res.text();
    const out: IndexRecord[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const rec = JSON.parse(t) as IndexRecord;
      if (typeof rec._offset !== 'number' || typeof rec._length !== 'number' || typeof rec.param !== 'string') {
        throw new EcmwfError(`malformed index line in ${url}: ${t.slice(0, 120)}`);
      }
      out.push(rec);
    }
    return out;
  }

  cachePath(cycle: Cycle, stream: string, step: number, param: string): string {
    return path.join(this.cacheDir, `${cycle.yyyymmdd}${cycle.hh}`, `${stream}-${String(step).padStart(3, '0')}h-${param}.grib2`);
  }

  /** Is a cached message present and GRIB-headed? */
  hasCached(cycle: Cycle, stream: string, step: number, param: string): boolean {
    const p = this.cachePath(cycle, stream, step, param);
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const head = Buffer.alloc(4);
        return fs.readSync(fd, head, 0, 4, 0) === 4 && head.toString('latin1') === 'GRIB';
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
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
    if (fs.existsSync(cached)) {
      const buf = fs.readFileSync(cached);
      if (buf.length > 16 && buf.toString('latin1', 0, 4) === 'GRIB') return new Uint8Array(buf);
      fs.unlinkSync(cached);
    }
    const idx = index ?? (await this.fetchIndex(cycle, stream, step));
    const rec = idx.find(r => r.param === param && (r.levtype === undefined || r.levtype === 'sfc'));
    if (!rec) return null;
    const url = this.stepUrl(cycle, stream, step, 'grib2');
    const res = await this.request(this.stepPath(cycle, stream, step, 'grib2'), {
      headers: { Range: `bytes=${rec._offset}-${rec._offset + rec._length - 1}` },
    });
    if (res.status !== 206 && res.status !== 200) throw new EcmwfError(`HTTP ${res.status} fetching ${param} from ${url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    let msg = buf;
    if (res.status === 200) {
      // Server ignored the range: slice the whole file.
      msg = buf.subarray(rec._offset, rec._offset + rec._length);
    }
    if (msg.length !== rec._length) {
      throw new EcmwfError(`short read for ${param} step ${step}: got ${msg.length} of ${rec._length} bytes`);
    }
    if (!(msg[0] === 0x47 && msg[1] === 0x52 && msg[2] === 0x49 && msg[3] === 0x42)) {
      throw new EcmwfError(`fetched bytes for ${param} step ${step} do not start with GRIB`);
    }
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    // Unique per writer: the data worker and the route worker (first boot, no
    // decoded run yet) can fetch the same field at once, and threads share a pid.
    const tmp = `${cached}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, msg);
    try {
      fs.renameSync(tmp, cached);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      // Another writer put the same field in place meanwhile: that is the answer.
      if (!fs.existsSync(cached)) throw err;
    }
    return msg;
  }

  /** Delete cached cycles other than `keep`. */
  pruneCache(keep: Cycle[]): void {
    const keepNames = new Set(keep.map(c => `${c.yyyymmdd}${c.hh}`));
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (/^\d{10}$/.test(e) && !keepNames.has(e)) {
        fs.rmSync(path.join(this.cacheDir, e), { recursive: true, force: true });
        this.log(`pruned cached cycle ${e}`);
      }
    }
  }
}
