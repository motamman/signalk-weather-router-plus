/**
 * The decoded forecast on disk.
 *
 * ECMWF publishes a new run a few times a day, but the plugin used to
 * decode the whole global forecast (72 h with the extra fields: 275
 * global fields, 1.14 GB of Float32) at every start and keep it in
 * memory for the life of the process. Now each run is decoded once, when
 * it arrives, and the DECODED values are kept on disk until the next run
 * replaces them; requests read only what they need (decoded.ts readers
 * below), for as long as they need it.
 *
 * Layout, one directory per cycle under the plugin data directory:
 *
 *   forecast/<yyyymmddHH>/index.json        metadata (DecodedIndex)
 *   forecast/<yyyymmddHH>/<step>-<param>.f32 one global field, one step
 *
 * Each .f32 file is exactly the in-memory layout of a global FieldGrid:
 * little-endian Float32 (the byte order of every platform Node runs on
 * here; the index records it), rows from the south, `nLon` columns from
 * `lon0` eastwards, `nLat × nLon` values, NaN preserved (the wave fields'
 * land cells after the limited fill), no header. Reading a row range is
 * one pread at offset `row × nLon × 4`.
 *
 * Atomicity: a run is written into `forecast/.tmp-<cycle>-<pid>-<t>/`,
 * every file fsync'd, index.json (with `complete: true`) written last and
 * fsync'd, then the directory is renamed to `forecast/<cycle>/` and the
 * parent directory fsync'd. A crash at any point leaves at most a
 * `.tmp-*` directory (removed at the next prune), never a directory that
 * looks complete. `openDecodedRun` also checks every file's size.
 */

import * as fs from 'node:fs';
import { lonOffset } from '../geo/angles';
import * as path from 'node:path';
import type { BBox } from '../geo/geodesy';
import { bboxWidth } from '../geo/geodesy';
import { ForecastStore, GLOBAL_BBOX, type FieldGrid, type ForecastStep } from './forecast';

export const DECODED_FORMAT = 'wrp-decoded-forecast';
export const DECODED_VERSION = 1;
export const INDEX_FILE = 'index.json';
/** Directory of the decoded runs below the plugin data directory. */
export const DECODED_DIR = 'forecast';

export interface DecodedGrid {
  lat0: number;
  lon0: number;
  dLat: number;
  dLon: number;
  nLat: number;
  nLon: number;
  wrapLon: boolean;
}

export interface DecodedStepMeta {
  stepHours: number;
  validMs: number;
  /** Parameters present in this step (a parameter missing from a cycle's index is absent). */
  params: string[];
  /**
   * Interval length in hours per interval field (ACCUMULATED_PARAMS),
   * end time = validMs. Written only for steps that hold interval fields
   * (3 h to 144 h, 6 h past it); step 0 has none.
   */
  intervals?: [string, number][];
}

export interface DecodedIndex {
  format: typeof DECODED_FORMAT;
  version: number;
  byteOrder: 'LE';
  /** yyyymmddHH */
  cycle: string;
  cycleTimeMs: number;
  /** What the run was decoded for: it is reused only for the same horizon and parameter list. */
  request: { horizonHours: number; params: string[] };
  /** Step hours the configuration asked for (ForecastStore meta.steps). */
  stepHours: number[];
  grid: DecodedGrid;
  steps: DecodedStepMeta[];
  /** Bytes of all .f32 files. */
  bytes: number;
  decodedAt: string;
  decodeMs: number;
  complete: true;
}

const pad3 = (n: number): string => String(n).padStart(3, '0');

/** File name of one field-step. */
export function fieldFile(stepHours: number, param: string): string {
  return `${pad3(stepHours)}-${param}.f32`;
}

/** yyyymmddHH of a cycle time. */
export function cycleName(t: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}`;
}

function fsyncPath(p: string, flags = 'r'): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, flags);
    fs.fsyncSync(fd);
  } catch {
    /* directories cannot be fsync'd on every platform */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function writeFileDurable(file: string, data: Uint8Array): void {
  const fd = fs.openSync(file, 'w');
  try {
    let off = 0;
    while (off < data.byteLength) off += fs.writeSync(fd, data, off, data.byteLength - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes one run, one step at a time (the streaming decoder hands over
 * each step as soon as it is decoded), into a temporary directory that
 * becomes the run directory only when complete.
 */
export class DecodedRunWriter {
  readonly tmpDir: string;
  readonly finalDir: string;
  private steps: DecodedStepMeta[] = [];
  private bytes = 0;
  private grid: DecodedGrid | null = null;
  private done = false;

  constructor(
    readonly root: string,
    readonly cycle: string
  ) {
    fs.mkdirSync(root, { recursive: true });
    this.finalDir = path.join(root, cycle);
    this.tmpDir = path.join(root, `.tmp-${cycle}-${process.pid}-${Date.now().toString(36)}`);
    fs.mkdirSync(this.tmpDir);
  }

  /** Bytes written so far. */
  get writtenBytes(): number {
    return this.bytes;
  }

  /** Write every field of a step (whole global fields only). */
  writeStep(step: ForecastStep): void {
    if (this.done) throw new Error('decoded run already finished');
    const params: string[] = [];
    for (const [param, f] of step.fields) {
      if (f.win) throw new Error(`decoded run: ${param} +${step.stepHours}h is a window, not a whole field`);
      const g: DecodedGrid = { lat0: f.lat0, lon0: f.lon0, dLat: f.dLat, dLon: f.dLon, nLat: f.nLat, nLon: f.nLon, wrapLon: !!f.wrapLon };
      if (!this.grid) this.grid = g;
      else if (JSON.stringify(g) !== JSON.stringify(this.grid))
        throw new Error(`decoded run: ${param} +${step.stepHours}h has a different grid`);
      if (f.values.length !== g.nLat * g.nLon)
        throw new Error(`decoded run: ${param} +${step.stepHours}h has ${f.values.length} values for ${g.nLat}×${g.nLon}`);
      writeFileDurable(
        path.join(this.tmpDir, fieldFile(step.stepHours, param)),
        new Uint8Array(f.values.buffer, f.values.byteOffset, f.values.byteLength)
      );
      this.bytes += f.values.byteLength;
      params.push(param);
    }
    this.steps.push({
      stepHours: step.stepHours,
      validMs: step.validMs,
      params,
      intervals: step.intervals ? [...step.intervals.entries()] : undefined,
    });
  }

  /** Write index.json and move the run into place (replacing an older copy of the same cycle). */
  finish(meta: {
    cycleTimeMs: number;
    request: { horizonHours: number; params: string[] };
    stepHours: number[];
    decodeMs: number;
  }): DecodedIndex {
    if (!this.grid || this.steps.length === 0) throw new Error('decoded run: no steps written');
    const index: DecodedIndex = {
      format: DECODED_FORMAT,
      version: DECODED_VERSION,
      byteOrder: 'LE',
      cycle: this.cycle,
      cycleTimeMs: meta.cycleTimeMs,
      request: meta.request,
      stepHours: meta.stepHours,
      grid: this.grid,
      steps: [...this.steps].sort((a, b) => a.validMs - b.validMs),
      bytes: this.bytes,
      decodedAt: new Date().toISOString(),
      decodeMs: meta.decodeMs,
      complete: true,
    };
    writeFileDurable(path.join(this.tmpDir, INDEX_FILE), Buffer.from(JSON.stringify(index)));
    fsyncPath(this.tmpDir);
    let old: string | null = null;
    if (fs.existsSync(this.finalDir)) {
      old = path.join(this.root, `.old-${this.cycle}-${process.pid}-${Date.now().toString(36)}`);
      fs.renameSync(this.finalDir, old);
    }
    fs.renameSync(this.tmpDir, this.finalDir);
    fsyncPath(this.root);
    if (old) fs.rmSync(old, { recursive: true, force: true });
    this.done = true;
    return index;
  }

  /** Remove the temporary directory (decode failed or was cancelled). */
  abort(): void {
    if (this.done) return;
    this.done = true;
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

/** Why a directory is not a usable run, or the run. */
export function openDecodedRun(dir: string): { run: DecodedRun | null; problem: string | null } {
  let index: DecodedIndex;
  try {
    index = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8')) as DecodedIndex;
  } catch (err) {
    return { run: null, problem: `no readable ${INDEX_FILE} (${(err as Error).message})` };
  }
  if (index.format !== DECODED_FORMAT || index.version !== DECODED_VERSION)
    return { run: null, problem: `format ${index.format} v${index.version}, expected ${DECODED_FORMAT} v${DECODED_VERSION}` };
  if (index.complete !== true) return { run: null, problem: 'not marked complete' };
  if (index.byteOrder !== 'LE' || !isLittleEndian()) return { run: null, problem: 'byte order differs from this machine' };
  const want = index.grid.nLat * index.grid.nLon * 4;
  for (const s of index.steps) {
    for (const p of s.params) {
      const f = path.join(dir, fieldFile(s.stepHours, p));
      let size = -1;
      try {
        size = fs.statSync(f).size;
      } catch {
        /* missing */
      }
      if (size !== want) return { run: null, problem: `${path.basename(f)} is ${size < 0 ? 'missing' : `${size} B, expected ${want}`}` };
    }
  }
  return { run: new DecodedRun(dir, index), problem: null };
}

function isLittleEndian(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

/** Complete runs under `root`, newest cycle first. */
export function listDecodedRuns(root: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter(e => /^\d{10}$/.test(e))
    .sort()
    .reverse();
}

/**
 * Delete decoded runs other than `keep` (cycle names), and leftovers of
 * interrupted writes (`.tmp-*`, `.old-*`) except `activeTmp`. Returns the
 * names removed.
 */
export function pruneDecodedRuns(root: string, keep: string[], activeTmp: string | null = null): string[] {
  const keepSet = new Set(keep);
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const e of entries) {
    const full = path.join(root, e);
    const stale = (/^\d{10}$/.test(e) && !keepSet.has(e)) || ((e.startsWith('.tmp-') || e.startsWith('.old-')) && full !== activeTmp);
    if (!stale) continue;
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(e);
  }
  return removed;
}

/** Bytes of all files below a directory (du, apparent size). */
export function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

/** Rows and columns of the global grid a window covers. */
export interface WindowGeometry {
  r0: number;
  nr: number;
  c0: number;
  nc: number;
}

export interface WindowOptions {
  /** Area to read (null: the whole globe). */
  bbox: BBox | null;
  /** Parameters to read (those a step lacks are skipped). */
  params: readonly string[];
  /** Indices into index.steps (default: every step). */
  steps?: number[];
  /** Extra grid cells around the bbox (default 2). */
  marginCells?: number;
  /** Store label. */
  loadedAt?: Date;
}

/** How many read requests run at once when a window spans many files. */
const READ_CONCURRENCY = 4;

/**
 * A complete decoded run on disk. Holds only its index; every read goes
 * to the files.
 */
export class DecodedRun {
  constructor(
    readonly dir: string,
    readonly index: DecodedIndex
  ) {}

  get cycleTime(): Date {
    return new Date(this.index.cycleTimeMs);
  }

  get validRange(): [Date, Date] {
    const s = this.index.steps;
    return [new Date(s[0].validMs), new Date(s[s.length - 1].validMs)];
  }

  /** Is this parameter present in every step? */
  has(param: string): boolean {
    return this.index.steps.every(s => s.params.includes(param));
  }

  get hasWaves(): boolean {
    return this.has('swh') && this.has('mwp') && this.has('mwd');
  }

  fieldPath(stepHours: number, param: string): string {
    return path.join(this.dir, fieldFile(stepHours, param));
  }

  /**
   * Indices of the steps bracketing a time (one index when the time is
   * at or outside the ends): the same choice ForecastStore.timeBlend
   * makes over all steps, so a store of just these steps interpolates
   * exactly like the whole run.
   */
  bracket(timeMs: number): number[] {
    const s = this.index.steps;
    const n = s.length;
    if (n === 1 || timeMs <= s[0].validMs) return [0];
    if (timeMs >= s[n - 1].validMs) return [n - 1];
    let i = 1;
    while (i < n && s[i].validMs <= timeMs) i++;
    return [i - 1, i];
  }

  /** Grid rows and columns covering `bbox` plus `margin` cells (the whole grid for null). */
  geometry(bbox: BBox | null, margin = 2): WindowGeometry {
    const g = this.index.grid;
    if (!bbox) return { r0: 0, nr: g.nLat, c0: 0, nc: g.nLon };
    const south = Math.max(-90, Math.min(bbox.south, bbox.north));
    const north = Math.min(90, Math.max(bbox.south, bbox.north));
    const r0 = Math.max(0, Math.floor((south - g.lat0) / g.dLat) - margin);
    const r1 = Math.min(g.nLat - 1, Math.ceil((north - g.lat0) / g.dLat) + margin);
    const width = bboxWidth(bbox);
    if (!g.wrapLon) {
      const xw = (bbox.west - g.lon0) / g.dLon;
      const c0 = Math.max(0, Math.floor(xw) - margin);
      const c1 = Math.min(g.nLon - 1, Math.ceil(xw + width / g.dLon) + margin);
      return { r0, nr: r1 - r0 + 1, c0, nc: c1 - c0 + 1 };
    }
    const xw = lonOffset(bbox.west, g.lon0) / g.dLon;
    const cStart = Math.floor(xw) - margin;
    const cEnd = Math.ceil(xw + width / g.dLon) + margin;
    const nc = cEnd - cStart + 1;
    if (nc >= g.nLon) return { r0, nr: r1 - r0 + 1, c0: 0, nc: g.nLon };
    return { r0, nr: r1 - r0 + 1, c0: ((cStart % g.nLon) + g.nLon) % g.nLon, nc };
  }

  /** Bytes a window would hold in memory. */
  windowBytes(opts: WindowOptions): number {
    const geo = this.geometry(opts.bbox, opts.marginCells ?? 2);
    return geo.nr * geo.nc * 4 * this.fieldSteps(opts).length;
  }

  private fieldSteps(opts: WindowOptions): { stepIdx: number; param: string }[] {
    const idx = opts.steps ?? this.index.steps.map((_, i) => i);
    const out: { stepIdx: number; param: string }[] = [];
    for (const i of idx) {
      const s = this.index.steps[i];
      for (const p of opts.params) if (s.params.includes(p)) out.push({ stepIdx: i, param: p });
    }
    return out;
  }

  /**
   * Read a window (rows × columns of the global grid, some parameters,
   * some steps) into ONE block of memory and wrap it as a ForecastStore.
   * Each field-step is one pread of its row range (whole rows, so one
   * contiguous request); the columns are then copied out. The store's
   * samplers give, inside the window, exactly the values of the whole
   * global store (FieldGrid.win).
   */
  async window(opts: WindowOptions): Promise<ForecastStore> {
    const g = this.index.grid;
    const geo = this.geometry(opts.bbox, opts.marginCells ?? 2);
    const list = this.fieldSteps(opts);
    if (list.length === 0) throw new Error(`the decoded run has none of ${opts.params.join('/')} for the requested steps`);
    const cells = geo.nr * geo.nc;
    const block = new Float32Array(cells * list.length);
    const full = geo.nc === g.nLon;
    const rowBytes = g.nLon * 4;
    const spanBytes = geo.nr * rowBytes;
    const fileOffset = geo.r0 * rowBytes;
    let next = 0;
    const worker = async (): Promise<void> => {
      // Whole rows land here first when the window is narrower than the grid.
      const tmp = full ? null : new Float32Array(geo.nr * g.nLon);
      for (;;) {
        const k = next++;
        if (k >= list.length) return;
        const { stepIdx, param } = list[k];
        const file = this.fieldPath(this.index.steps[stepIdx].stepHours, param);
        const dest = block.subarray(k * cells, (k + 1) * cells);
        const target = tmp ?? dest;
        const bytes = new Uint8Array(target.buffer, target.byteOffset, spanBytes);
        const fh = await fs.promises.open(file, 'r');
        try {
          let got = 0;
          while (got < spanBytes) {
            const { bytesRead } = await fh.read(bytes, got, spanBytes - got, fileOffset + got);
            if (bytesRead === 0) throw new Error(`${file}: short read (${got} of ${spanBytes} B)`);
            got += bytesRead;
          }
        } finally {
          await fh.close();
        }
        if (tmp) {
          const first = Math.min(geo.nc, g.nLon - geo.c0);
          for (let r = 0; r < geo.nr; r++) {
            const src = r * g.nLon;
            const dst = r * geo.nc;
            dest.set(tmp.subarray(src + geo.c0, src + geo.c0 + first), dst);
            if (first < geo.nc) dest.set(tmp.subarray(src, src + geo.nc - first), dst + first);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, list.length) }, worker));
    const byStep = new Map<number, Map<string, FieldGrid>>();
    list.forEach(({ stepIdx, param }, k) => {
      const m = byStep.get(stepIdx) ?? new Map<string, FieldGrid>();
      m.set(param, {
        lat0: g.lat0,
        lon0: g.lon0,
        dLat: g.dLat,
        dLon: g.dLon,
        nLat: g.nLat,
        nLon: g.nLon,
        wrapLon: g.wrapLon,
        values: block.subarray(k * cells, (k + 1) * cells),
        win: { r0: geo.r0, c0: geo.c0, nr: geo.nr, nc: geo.nc },
      });
      byStep.set(stepIdx, m);
    });
    const steps: ForecastStep[] = [...byStep.entries()].map(([i, fields]) => ({
      validMs: this.index.steps[i].validMs,
      stepHours: this.index.steps[i].stepHours,
      fields,
      intervals: this.index.steps[i].intervals ? new Map(this.index.steps[i].intervals) : undefined,
    }));
    return new ForecastStore(
      steps,
      {
        cycleTime: this.cycleTime,
        bbox: opts.bbox ?? GLOBAL_BBOX,
        steps: this.index.stepHours,
        params: [...new Set(list.map(x => x.param))],
        loadedAt: opts.loadedAt ?? new Date(this.index.decodedAt),
      },
      { requireWind: false }
    );
  }
}
