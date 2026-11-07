/**
 * The one HTTP retry policy of the data clients (ECMWF, Copernicus Marine
 * Zarr, RTOFS): a timeout per attempt, up to `retries` attempts,
 * exponential backoff 2, 4, 8, 16, 32 s capped at a minute with up to
 * 0.5 s of jitter, `Retry-After` honoured, retried only on 408 / 429 / 5xx
 * and network errors; 404 / 403 and other answers are returned as they are.
 * The timeout is for the server's answer: the timer stops when the headers
 * arrive. With `readBody` the body is then read inside the attempt, so a
 * body that fails is retried like a failed connection; a download that is
 * slow but arriving is read to its end, however long it takes, and one
 * that stops arriving is ended by fetch itself (undici's body timeout:
 * a body silent for 300 s, measured on the plugin's test box, a Pi 5,
 * node v24.22.1, 2026-11-07: UND_ERR_BODY_TIMEOUT after 300.7 s). Until
 * 2026-11-07 the timer ran until the body had been read, so a download
 * slower than the timeout (60 s for the ECMWF and Zarr clients) was cut
 * off and retried, and on a slow link could never finish.
 *
 * No connection at all (no name resolves, no route to any network, the
 * interface is down) is not retried: it throws an OfflineError at once,
 * which the callers report as "could not check" rather than as a failed
 * download. A refused connection, an unreachable host and a timeout are
 * retried: one server's failure, or a slow link at sea, which looks the
 * same as a dead one.
 */

import { MINUTE_MS } from '../geo/units';

/**
 * Network error codes that mean there is no connection at all: no name resolves, no route to any network, the
 * interface is down. Not ECONNREFUSED (a host answered) nor EHOSTUNREACH (usually one host or path): those are one
 * server's failure, retried and failed over to the next mirror like any other, so one bad server does not make the
 * whole round look offline.
 */
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN']);

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}

/** The offline code of a fetch failure (undici: TypeError with a `cause`, sometimes an AggregateError of attempts), or null. */
export function offlineCode(err: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (e: unknown): string | null => {
    if (!e || typeof e !== 'object' || seen.has(e)) return null;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && OFFLINE_CODES.has(code)) return code;
    for (const sub of (e as { errors?: unknown[] }).errors ?? []) {
      const c = walk(sub);
      if (c) return c;
    }
    return walk((e as { cause?: unknown }).cause);
  };
  return walk(err);
}

/** Is this error (or one it wraps, such as a child process's) "no connection"? */
export function isOffline(err: unknown): boolean {
  return err instanceof OfflineError || (err as Error | null)?.name === 'OfflineError';
}

/**
 * What the requests of this thread found about the connection: 'ok' when a
 * server answered (any status), 'offline' with the reason when there was no
 * connection. One listener per thread (the data worker's status).
 */
let networkObserver: ((state: 'ok' | 'offline', detail: string | null) => void) | null = null;
export function setNetworkObserver(fn: ((state: 'ok' | 'offline', detail: string | null) => void) | null): void {
  networkObserver = fn;
}

export interface RetryOptions {
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Log prefix (e.g. 'rtofs'). */
  tag?: string;
  /** The error class for a retriable HTTP status, when a client has its own. */
  makeError?: (message: string) => Error;
  /** Read the body inside the attempt (after the headers; a failed read is retried); false: the caller reads it. */
  readBody?: boolean;
}

export interface RetryResult {
  status: number;
  headers: Headers;
  /** The body when `readBody` was set, else null. */
  body: Uint8Array | null;
  response: Response;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds, or null. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

/** The body of an answer, read whole (inside the attempt, once its headers have arrived). */
const readAll = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());

/** A request with the retry policy above; its body read inside the attempt when `readBody` is set, else null. */
export function fetchWithRetry(url: string, init: RequestInit, o: RetryOptions): Promise<RetryResult> {
  return attempts(url, init, o, o.readBody ? readAll : async () => null);
}

/** fetchWithRetry with the body always read inside the attempt: every answer it returns carries its body, by its type. */
export function fetchBodyWithRetry(
  url: string,
  init: RequestInit,
  o: Omit<RetryOptions, 'readBody'>
): Promise<RetryResult & { body: Uint8Array }> {
  return attempts(url, init, o, readAll);
}

/** The attempts of one request (the policy above); `read` takes an answer's body inside its attempt. */
async function attempts<B extends Uint8Array | null>(
  url: string,
  init: RequestInit,
  o: Omit<RetryOptions, 'readBody'>,
  read: (res: Response) => Promise<B>
): Promise<RetryResult & { body: B }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleepImpl = o.sleepImpl ?? sleep;
  const log = o.log ?? (() => undefined);
  const makeError = o.makeError ?? ((m: string) => new Error(m));
  const prefix = o.tag ? `${o.tag}: ` : '';
  let lastErr: unknown;
  for (let attempt = 1; attempt <= o.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    let retryAfterMs: number | null = null;
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      // The server answered: the timeout is spent. The body takes as long as it arrives (the file comment).
      clearTimeout(timer);
      networkObserver?.('ok', null);
      const retriable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retriable) {
        return { status: res.status, headers: res.headers, body: await read(res), response: res };
      }
      retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      lastErr = makeError(`HTTP ${res.status} for ${url}`);
      // The answer's body is not wanted: the attempt ends it, so one that stops arriving cannot hold the retry back.
      ctrl.abort();
    } catch (err) {
      lastErr = err;
      const code = offlineCode(err);
      if (code) {
        const host = (() => {
          try {
            return new URL(url).host;
          } catch {
            return url;
          }
        })();
        const reason = `no internet connection (${code} for ${host})`;
        networkObserver?.('offline', reason);
        throw new OfflineError(reason);
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt === o.retries) break;
    let backoff = Math.min(MINUTE_MS, 2000 * 2 ** (attempt - 1));
    if (retryAfterMs !== null) backoff = Math.min(MINUTE_MS, Math.max(backoff, retryAfterMs));
    backoff += Math.random() * 500;
    log(`${prefix}retry ${attempt}/${o.retries - 1} for ${url} after ${(backoff / 1000).toFixed(1)} s: ${(lastErr as Error).message}`);
    await sleepImpl(backoff);
  }
  throw lastErr instanceof Error ? lastErr : makeError(`request failed: ${url}`);
}
