/**
 * Minimal Zarr v2 reader over HTTP(S): consolidated metadata
 * (`.zmetadata`), per-array `.zarray` / `.zattrs`, coordinate arrays and
 * individual chunks by key. Chunks are decompressed with the pure-TS
 * Blosc1 decoder (blosc.ts) or taken as is (compressor null), and
 * decoded to Float32Array / Float64Array in C order with the fill value
 * mapped to NaN.
 *
 * HTTP follows the plugin's other clients: per-request timeout for the
 * server's answer (data/http.ts), up to `retries` attempts with
 * exponential backoff 2, 4, 8 … s (capped at 60 s), `Retry-After`
 * honoured on 429/503, retries only on 408/429/5xx and network errors;
 * 404/403 are returned to the caller (a missing chunk is legal in Zarr:
 * it means "all fill value").
 */

import { bloscDecompress } from './blosc';
import { MINUTE_MS } from '../geo/units';
import { fetchBodyWithRetry } from './http';

export interface ZarrArrayMeta {
  shape: number[];
  chunks: number[];
  /** numpy dtype string, e.g. '<f4'. */
  dtype: string;
  /** Fill value as a number (NaN for "NaN" / null). */
  fillValue: number;
  order: 'C' | 'F';
  compressor: { id: string; [k: string]: unknown } | null;
  filters: unknown[] | null;
  dimensionSeparator: '.' | '/';
  attrs: Record<string, unknown>;
}

export class ZarrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZarrError';
  }
}

/** Parse a `.zarray` object (plus its `.zattrs`) into ZarrArrayMeta, validating what this reader supports. */
export function parseArrayMeta(zarray: Record<string, unknown>, zattrs: Record<string, unknown> = {}, name = 'array'): ZarrArrayMeta {
  if (zarray.zarr_format !== 2) throw new ZarrError(`${name}: zarr_format ${String(zarray.zarr_format)} is not 2`);
  const shape = zarray.shape as number[];
  const chunks = zarray.chunks as number[];
  if (!Array.isArray(shape) || !Array.isArray(chunks) || shape.length !== chunks.length)
    throw new ZarrError(`${name}: shape / chunks missing or of different rank`);
  const dtype = String(zarray.dtype);
  dtypeInfo(dtype, name);
  const order = zarray.order === 'F' ? 'F' : 'C';
  if (order !== 'C') throw new ZarrError(`${name}: Fortran order is not supported`);
  const filters = (zarray.filters as unknown[] | null) ?? null;
  if (filters && filters.length) throw new ZarrError(`${name}: filters are not supported`);
  const compressor = (zarray.compressor as ZarrArrayMeta['compressor']) ?? null;
  if (compressor && compressor.id !== 'blosc') throw new ZarrError(`${name}: compressor ${compressor.id} is not supported (blosc only)`);
  const fv = zarray.fill_value;
  let fillValue: number;
  if (fv === null || fv === undefined || fv === 'NaN') fillValue = NaN;
  else if (fv === 'Infinity') fillValue = Infinity;
  else if (fv === '-Infinity') fillValue = -Infinity;
  else if (typeof fv === 'number') fillValue = fv;
  else throw new ZarrError(`${name}: unsupported fill_value ${JSON.stringify(fv)}`);
  const sep = zarray.dimension_separator === '/' ? '/' : '.';
  return { shape, chunks, dtype, fillValue, order, compressor, filters, dimensionSeparator: sep, attrs: zattrs };
}

interface DtypeInfo {
  size: number;
  little: boolean;
  kind: 'f' | 'i' | 'u';
}

function dtypeInfo(dtype: string, name = 'array'): DtypeInfo {
  const m = /^([<>|])([fiu])(\d)$/.exec(dtype);
  if (!m) throw new ZarrError(`${name}: dtype ${dtype} is not supported`);
  const size = Number(m[3]);
  const kind = m[2] as DtypeInfo['kind'];
  const ok = kind === 'f' ? size === 4 || size === 8 : [1, 2, 4].includes(size);
  if (!ok) throw new ZarrError(`${name}: dtype ${dtype} is not supported`);
  return { size, little: m[1] !== '>', kind };
}

/** Number of chunks along each dimension. */
export function chunkGrid(meta: ZarrArrayMeta): number[] {
  return meta.shape.map((s, i) => Math.ceil(s / meta.chunks[i]));
}

/** Chunk key for chunk indices, e.g. [51780, 0, 3, 2] → '51780.0.3.2'. */
export function chunkKey(meta: ZarrArrayMeta, idx: number[]): string {
  return idx.join(meta.dimensionSeparator);
}

/** Elements in one (full-size, padded) chunk. */
export function chunkLength(meta: ZarrArrayMeta): number {
  return meta.chunks.reduce((a, b) => a * b, 1);
}

/**
 * Buffers a caller lends to decodeChunk so consecutive chunks reuse the same
 * memory (the decompressed bytes and the decoded values) instead of
 * allocating two chunk-sized arrays per chunk. The returned view is only
 * valid until the next call with the same scratch, so the caller must have
 * copied what it needs before decoding another chunk. One per thread
 * (data/arco.ts loadRegion); without one, decodeChunk allocates as before.
 */
export interface ChunkScratch {
  raw: Uint8Array | null;
  out: Float32Array | Float64Array | null;
}

/**
 * Decode one chunk's stored bytes (null = chunk absent = all fill) into
 * a Float32Array (float32 and the small integer types) or Float64Array
 * (float64), full padded chunk size, C order, fill value → NaN.
 */
export function decodeChunk(meta: ZarrArrayMeta, stored: Uint8Array | null, scratch?: ChunkScratch): Float32Array | Float64Array {
  const n = chunkLength(meta);
  const info = dtypeInfo(meta.dtype);
  const f64 = info.kind === 'f' && info.size === 8;
  let out: Float32Array | Float64Array;
  if (!scratch) out = f64 ? new Float64Array(n) : new Float32Array(n);
  else {
    const have = scratch.out;
    if (!have || have.length < n || have instanceof Float64Array !== f64) scratch.out = f64 ? new Float64Array(n) : new Float32Array(n);
    out = scratch.out!.subarray(0, n);
  }
  if (stored === null) {
    out.fill(NaN);
    return out;
  }
  let raw: Uint8Array;
  if (!meta.compressor) raw = stored;
  else if (!scratch) raw = bloscDecompress(stored);
  else {
    const need = n * info.size;
    if (!scratch.raw || scratch.raw.length < need) scratch.raw = new Uint8Array(need);
    raw = bloscDecompress(stored, scratch.raw);
  }
  if (raw.length !== n * info.size) throw new ZarrError(`chunk decoded to ${raw.length} bytes, want ${n * info.size}`);
  const fill = meta.fillValue;
  const fillIsNaN = Number.isNaN(fill);
  if (info.kind === 'f' && info.size === 4 && info.little && raw.byteOffset % 4 === 0) {
    const f = new Float32Array(raw.buffer, raw.byteOffset, n);
    const fill32 = Math.fround(fill);
    for (let i = 0; i < n; i++) {
      const v = f[i];
      out[i] = !fillIsNaN && v === fill32 ? NaN : v;
    }
    return out;
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const fillCmp = info.kind === 'f' && info.size === 4 ? Math.fround(fill) : fill;
  for (let i = 0; i < n; i++) {
    const o = i * info.size;
    let v: number;
    if (info.kind === 'f') v = info.size === 4 ? dv.getFloat32(o, info.little) : dv.getFloat64(o, info.little);
    else if (info.kind === 'i')
      v = info.size === 1 ? dv.getInt8(o) : info.size === 2 ? dv.getInt16(o, info.little) : dv.getInt32(o, info.little);
    else v = info.size === 1 ? dv.getUint8(o) : info.size === 2 ? dv.getUint16(o, info.little) : dv.getUint32(o, info.little);
    out[i] = !fillIsNaN && v === fillCmp ? NaN : v;
  }
  return out;
}

/**
 * CF time units ("hours since 1950-01-01", "seconds since 1970-01-01
 * 00:00:00", …) → [milliseconds per unit, epoch ms]. Gregorian /
 * standard / proleptic_gregorian calendars only.
 */
export function parseCfTimeUnits(units: string, calendar?: string): { unitMs: number; epochMs: number } {
  if (calendar && !['gregorian', 'standard', 'proleptic_gregorian'].includes(calendar.toLowerCase())) {
    throw new ZarrError(`time calendar ${calendar} is not supported`);
  }
  const m =
    /^\s*(\w+)\s+since\s+(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?\s*$/i.exec(
      units
    );
  if (!m) throw new ZarrError(`time units "${units}" not understood`);
  const unit = m[1].toLowerCase();
  const perUnit: Record<string, number> = {
    days: 86_400_000,
    day: 86_400_000,
    d: 86_400_000,
    hours: 3_600_000,
    hour: 3_600_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    minutes: MINUTE_MS,
    minute: MINUTE_MS,
    min: MINUTE_MS,
    mins: MINUTE_MS,
    seconds: 1000,
    second: 1000,
    s: 1000,
    sec: 1000,
    secs: 1000,
    milliseconds: 1,
    millisecond: 1,
    ms: 1,
  };
  const unitMs = perUnit[unit];
  if (unitMs === undefined) throw new ZarrError(`time unit "${m[1]}" not understood`);
  let epochMs = Date.UTC(+m[2], +m[3] - 1, +m[4], m[5] ? +m[5] : 0, m[6] ? +m[6] : 0, 0) + (m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0);
  const tz = m[8];
  if (tz && tz !== 'Z' && tz.toUpperCase() !== 'UTC') {
    const t = /^([+-])(\d{2}):?(\d{2})$/.exec(tz)!;
    epochMs -= (t[1] === '-' ? -1 : 1) * (+t[2] * 60 + +t[3]) * MINUTE_MS;
  }
  return { unitMs, epochMs };
}

export interface HttpResult {
  status: number;
  body: Uint8Array;
  headers: Headers;
}

export interface ZarrHttpOptions {
  timeoutMs?: number;
  retries?: number;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Log prefix. */
  tag?: string;
}

/** GET with timeout, retries, backoff and Retry-After (data/http.ts). */
export async function httpGet(url: string, opts: ZarrHttpOptions = {}): Promise<HttpResult> {
  const r = await fetchBodyWithRetry(
    url,
    {},
    {
      timeoutMs: opts.timeoutMs ?? MINUTE_MS,
      retries: opts.retries ?? 6,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      log: opts.log,
      tag: opts.tag ?? 'zarr',
      makeError: msg => new ZarrError(msg),
    }
  );
  return { status: r.status, body: r.body, headers: r.headers };
}

export interface ConsolidatedStore {
  /** Array name → metadata. */
  arrays: Map<string, ZarrArrayMeta>;
  /** Root `.zattrs`. */
  attrs: Record<string, unknown>;
  /** HTTP Last-Modified of `.zmetadata`, ms (null when absent). */
  lastModifiedMs: number | null;
  etag: string | null;
}

/** Parse a `.zmetadata` document. */
export function parseConsolidated(doc: unknown): { arrays: Map<string, ZarrArrayMeta>; attrs: Record<string, unknown> } {
  const md = (doc as { metadata?: Record<string, unknown> })?.metadata;
  if (!md || typeof md !== 'object') throw new ZarrError('.zmetadata has no "metadata" object');
  const arrays = new Map<string, ZarrArrayMeta>();
  for (const [k, v] of Object.entries(md)) {
    if (!k.endsWith('/.zarray')) continue;
    const name = k.slice(0, -'/.zarray'.length);
    arrays.set(name, parseArrayMeta(v as Record<string, unknown>, (md[`${name}/.zattrs`] as Record<string, unknown>) ?? {}, name));
  }
  return { arrays, attrs: (md['.zattrs'] as Record<string, unknown>) ?? {} };
}

/** A Zarr v2 store below an HTTP(S) base URL. */
export class ZarrHttpStore {
  readonly baseUrl: string;
  private readonly http: ZarrHttpOptions;

  constructor(baseUrl: string, http: ZarrHttpOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = http;
  }

  url(key: string): string {
    return `${this.baseUrl}/${key}`;
  }

  private async getJson(key: string): Promise<{ doc: unknown; headers: Headers }> {
    const res = await httpGet(this.url(key), this.http);
    if (res.status !== 200) throw new ZarrError(`HTTP ${res.status} for ${this.url(key)}`);
    try {
      return { doc: JSON.parse(Buffer.from(res.body).toString('utf8')), headers: res.headers };
    } catch {
      throw new ZarrError(`${this.url(key)} is not JSON`);
    }
  }

  /** Consolidated metadata (always fetched fresh). */
  async consolidated(): Promise<ConsolidatedStore> {
    const { doc, headers } = await this.getJson('.zmetadata');
    const { arrays, attrs } = parseConsolidated(doc);
    const lm = headers.get('last-modified');
    const lmMs = lm ? Date.parse(lm) : NaN;
    return { arrays, attrs, lastModifiedMs: Number.isNaN(lmMs) ? null : lmMs, etag: headers.get('etag') };
  }

  /** One array's metadata from `.zarray` + `.zattrs` (for unconsolidated stores). */
  async arrayMeta(name: string): Promise<ZarrArrayMeta> {
    const za = (await this.getJson(`${name}/.zarray`)).doc as Record<string, unknown>;
    let attrs: Record<string, unknown>;
    try {
      attrs = (await this.getJson(`${name}/.zattrs`)).doc as Record<string, unknown>;
    } catch {
      attrs = {};
    }
    return parseArrayMeta(za, attrs, name);
  }

  /**
   * Stored (compressed) bytes of one chunk, or null when the chunk does not
   * exist (404/403 = all fill). 403 counts as missing because the only Zarr
   * source, the Copernicus Marine ARCO store, is S3 without list permission:
   * S3 answers 403, not 404, for an object that does not exist (absent land
   * chunks in the SMOC geo layout; see smoc.test.ts). Only a metadata
   * failure surfaces: metadata is read with getJson, which throws on any
   * non-200, before any chunk is requested (ArcoClient reads the
   * consolidated .zmetadata; arrayMeta reads .zarray, while .zattrs is
   * optional and may fail quietly). A 403 on a chunk, whatever its cause,
   * is treated as missing and decodes to an all-NaN chunk.
   */
  async chunkBytes(name: string, meta: ZarrArrayMeta, idx: number[]): Promise<Uint8Array | null> {
    const url = this.url(`${name}/${chunkKey(meta, idx)}`);
    const res = await httpGet(url, this.http);
    if (res.status === 200) return res.body;
    if (res.status === 404 || res.status === 403) return null;
    throw new ZarrError(`HTTP ${res.status} for ${url}`);
  }

  /** A whole 1-D array (a coordinate), trimmed to its shape. */
  async read1d(name: string, meta: ZarrArrayMeta): Promise<Float64Array> {
    if (meta.shape.length !== 1) throw new ZarrError(`${name}: not 1-D`);
    const n = meta.shape[0];
    const cl = meta.chunks[0];
    const out = new Float64Array(n);
    const nChunks = Math.ceil(n / cl);
    for (let i = 0; i < nChunks; i++) {
      const vals = decodeChunk(meta, await this.chunkBytes(name, meta, [i]));
      const start = i * cl;
      const len = Math.min(cl, n - start);
      for (let k = 0; k < len; k++) out[start + k] = vals[k];
    }
    return out;
  }
}
