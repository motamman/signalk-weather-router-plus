/**
 * The coastline when none is configured: GSHHG 2.3.7 full-resolution
 * levels 1–4 (land, lakes, islands in lakes, ponds), downloaded once from the
 * authors' site into the plugin data directory.
 *
 * Source: https://www.soest.hawaii.edu/pwessel/gshhg/ (Wessel & Smith;
 * LGPL), with an identical copy at router.zeddisplay.com/downloads/ as
 * the fallback. The shapefile archive is 149,157,845 bytes, SHA-256
 * 8dbbe7e0…15cf41 (both checked 2026-09-29; a copy from either source
 * must match);
 * GSHHS_shp/f/GSHHS_f_L1–L4.shp and their .shx/.prj are extracted.
 * The shipped global water grid was built from this same hierarchy,
 * so it matches and is not rebuilt.
 *
 * The archive is read with Node's zlib (a zip's central directory, then
 * each wanted entry inflated from its local header): no dependency.
 */

import * as crypto from 'node:crypto';
import { HOUR_MS } from '../geo/units';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

/** Sources tried in order: the authors' site, then a copy on router.zeddisplay.com. */
export const GSHHG_URLS = [
  'https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip',
  'https://router.zeddisplay.com/downloads/gshhg-shp-2.3.7.zip',
];
export const GSHHG_ZIP_BYTES = 149_157_845;
/** SHA-256 of the archive: a copy from any source must be this exact file. */
export const GSHHG_ZIP_SHA256 = '8dbbe7e071e77e9e75f2d639239099ebca8d5c16d6a07df8169729d49f15cf41';
/** Entries extracted (the .shp is what the plugin reads). */
export const GSHHG_ENTRIES = [1, 2, 3, 4].flatMap(level => ['shp', 'shx', 'prj'].map(ext => `GSHHS_shp/f/GSHHS_f_L${level}.${ext}`));

/** Where the downloaded coastline lives under the plugin data directory. */
export function gshhgDir(dataDir: string): string {
  return path.join(dataDir, 'coastline', 'gshhg-2.3.7');
}

/** Written after extraction: each extracted file and its size. */
const COMPLETE_MARKER = 'complete.json';

/** The .shp when a complete extraction is in place (every file present at the size recorded when extracted), else null. */
export function gshhgInstalled(dataDir: string): string | null {
  const dir = gshhgDir(dataDir);
  try {
    const sizes = JSON.parse(fs.readFileSync(path.join(dir, COMPLETE_MARKER), 'utf8')) as Record<string, number>;
    for (const e of GSHHG_ENTRIES) {
      const name = path.basename(e);
      if (fs.statSync(path.join(dir, name)).size !== sizes[name]) return null;
    }
  } catch {
    return null; // no marker (not extracted, or interrupted) or a file missing
  }
  return path.join(dir, 'GSHHS_f_L1.shp');
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** The central directory of a zip file (no zip64: the archive is 149 MB). */
export function readZipDirectory(file: string): ZipEntry[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      out.push({
        method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localOffset: cd.readUInt32LE(p + 42),
        name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Extract one entry (stored or deflated) to `dest`, checking its size. */
export async function extractZipEntry(file: string, e: ZipEntry, dest: string): Promise<void> {
  const fd = fs.openSync(file, 'r');
  let dataStart: number;
  try {
    const h = Buffer.alloc(30);
    fs.readSync(fd, h, 0, 30, e.localOffset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt zip local header for ${e.name}`);
    dataStart = e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
  if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name}: unsupported zip method ${e.method}`);
  const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const src =
    e.compressedSize > 0 ? fs.createReadStream(file, { start: dataStart, end: dataStart + e.compressedSize - 1 }) : Readable.from([]);
  if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(tmp));
  else await pipeline(src, fs.createWriteStream(tmp));
  const got = fs.statSync(tmp).size;
  if (got !== e.size) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${e.name}: extracted ${got} bytes, expected ${e.size}`);
  }
  fs.renameSync(tmp, dest);
}

export interface EnsureGshhgOptions {
  /** Cancels the download and extraction (plugin stopped). */
  signal?: AbortSignal;
  /** Sources, tried in order (default GSHHG_URLS). */
  urls?: string[];
  expectBytes?: number;
  /** null: size check only (tests). */
  expectSha256?: string | null;
}

/** Download `url` to `zip` (own temporary file, renamed when complete and checked). */
async function downloadOnce(
  url: string,
  zip: string,
  expectBytes: number,
  expectSha256: string | null,
  signal: AbortSignal | undefined,
  log: (msg: string) => void
): Promise<void> {
  // Quantities as unit tokens: the web app writes them in its user's units.
  log(`coastline: none configured; downloading GSHHG 2.3.7 ({dataSize:${expectBytes}}) from ${url}`);
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    // Node's fetch says only "fetch failed"; the reason (ENOTFOUND, ECONNREFUSED, …) is its cause.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`cannot reach ${new URL(url).host}: ${cause?.code ?? cause?.message ?? (err as Error).message}`, { cause: err });
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const tmp = `${zip}.part-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const hash = crypto.createHash('sha256');
  let done = 0;
  let nextPct = 10;
  const t0 = Date.now();
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      hash.update(chunk);
      while (nextPct <= 100 && (done / expectBytes) * 100 >= nextPct) {
        log(`coastline: downloaded {percentage:${nextPct / 100}} ({dataSize:${done}}, {time:${(Date.now() - t0) / 1000}})`);
        nextPct += 10;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), progress, fs.createWriteStream(tmp), { signal });
    const got = fs.statSync(tmp).size;
    if (got !== expectBytes) throw new Error(`incomplete from ${new URL(url).host}: ${got} of ${expectBytes} bytes`);
    const sha = hash.digest('hex');
    if (expectSha256 && sha !== expectSha256) throw new Error(`${new URL(url).host} sent a different file (SHA-256 ${sha})`);
    fs.renameSync(tmp, zip);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Partial downloads older than this are from a process that died; removed before a new download. */
const STALE_PART_MS = HOUR_MS;

/**
 * The coastline .shp, downloading and extracting GSHHG first when it is
 * not in place. `log` gets progress lines (every 10 %). Each download
 * writes its own temporary file and renames it when complete, so two
 * downloads never write the same file; `signal` cancels one.
 */
export async function ensureGshhg(dataDir: string, log: (msg: string) => void, opts: EnsureGshhgOptions = {}): Promise<string> {
  const { signal, urls = GSHHG_URLS, expectBytes = GSHHG_ZIP_BYTES, expectSha256 = GSHHG_ZIP_SHA256 } = opts;
  const have = gshhgInstalled(dataDir);
  if (have) return have;
  signal?.throwIfAborted();
  const dir = gshhgDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'gshhg-shp-2.3.7.zip');
  if (!fs.existsSync(zip) || fs.statSync(zip).size !== expectBytes) {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      if (n.includes('.part-') && Date.now() - fs.statSync(f).mtimeMs > STALE_PART_MS) fs.rmSync(f, { force: true });
    }
    const failures: string[] = [];
    for (const url of urls) {
      try {
        await downloadOnce(url, zip, expectBytes, expectSha256, signal, log);
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        failures.push((err as Error).message);
        log(`coastline: ${(err as Error).message}${url !== urls[urls.length - 1] ? '; trying the next source' : ''}`);
      }
    }
    if (!fs.existsSync(zip)) throw new Error(failures.join('; '));
  }
  const entries = readZipDirectory(zip);
  fs.rmSync(path.join(dir, COMPLETE_MARKER), { force: true });
  const sizes: Record<string, number> = {};
  for (const name of GSHHG_ENTRIES) {
    signal?.throwIfAborted();
    const e = entries.find(x => x.name === name);
    if (!e) throw new Error(`coastline archive has no ${name}`);
    await extractZipEntry(zip, e, path.join(dir, path.basename(name)));
    sizes[path.basename(name)] = e.size;
  }
  fs.writeFileSync(path.join(dir, COMPLETE_MARKER), JSON.stringify(sizes));
  fs.rmSync(zip, { force: true });
  const shp = gshhgInstalled(dataDir);
  if (!shp) throw new Error('coastline extraction incomplete');
  log(`coastline: GSHHG full-resolution levels 1–4 ready in ${path.dirname(shp)}`);
  return shp;
}

/** Configured coastline files that are missing or unreadable, with the reason. */
export function unreadableCoastlines(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try {
      if (!fs.statSync(p).isFile()) {
        out.push(`${p} (not a file)`);
        continue;
      }
      fs.accessSync(p, fs.constants.R_OK);
    } catch (err) {
      out.push(`${p} (${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : (err as Error).message})`);
    }
  }
  return out;
}
