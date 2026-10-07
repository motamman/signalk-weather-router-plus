/**
 * Global water grid: a 0.02° (18000 × 9000 cell) navigability graph of
 * the world's coastline, used by the router to find a land-avoiding
 * corridor between any two points (the skeleton), independent of the
 * route's own bounding box.
 *
 * Per coarse cell three bits (row-major from the south-west corner,
 * row 0 = 90°S..89.98°S, column 0 = 180°W..179.98°W):
 *  - water: at least one fine (0.005°) water cell inside;
 *  - east:  the edge to the cell to the east (column + 1, wrapping at the
 *           antimeridian) is passable;
 *  - north: the edge to the cell to the north is passable (never at the
 *           north pole row).
 * An edge between neighbours A and B is passable when a 4-connected path
 * of fine water cells lying within A ∪ B crosses their shared edge, i.e.
 * when some fine row (or column) has water on both sides of it. Fine
 * cells are centre-sampled (water when the cell centre is outside every
 * polygon), so a channel narrower than a coarse cell that threads through
 * cells corner to corner stays open (the Bosphorus), while land wider
 * than a fine cell stays closed.
 *
 * Split cells: a coarse cell whose fine water forms two or more separate
 * 4-connected components that touch its border (both shores of an
 * isthmus thinner than a cell, a spit with water on either side) would
 * let the coarse graph leak from one component to the other. Such cells
 * (about 61 000 worldwide) are stored explicitly: the component label of
 * each of the 16 fine cells along the cell's four sides and, per side,
 * which fine rows / columns actually cross to the neighbour. Moves into,
 * out of and through a split cell follow its components, so coarse
 * connectivity equals fine 4-connectivity (neighbours() and nodes).
 *
 * Known canals (see CANALS in watergrid_canals.ts) are stored as lists of
 * the edges that cross them; they are open in the planes as built and are
 * closed at load time unless canals are allowed (setCanalsAllowed).
 *
 * Narrow passages found during the build (chokepoints: position of the
 * narrowest point, width, channel axis) are stored after the planes.
 *
 * File: gzip of
 *   magic "WRPWGRID" (8 bytes), u32 LE format version, u32 LE header length,
 *   header JSON (UTF-8), water plane, east plane, north plane
 *   (ceil(nx·ny / 8) bytes each, bit k of byte i = cell 8i + k),
 *   u32 LE chokepoint count, then per chokepoint:
 *   f32 lat, f32 lon, u16 width (m), u8 axis (degrees 0..179), u8 reserved;
 *   u32 LE split-cell count, then per split cell (ascending cell index):
 *   u32 cell index, 8 bytes of 4-bit labels (side order S, N, W, E; along
 *   each side west→east or south→north; 0 = land), u16 crossing masks
 *   (bits 0–3 east, 4–7 north, 8–11 west, 12–15 south).
 */

import { shorelinePaths } from './shapefile';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { wrapLon } from './geodesy';

export const WG_MAGIC = 'WRPWGRID';
export const WG_VERSION = 1;
export const WG_RES = 0.02;
export const WG_NX = 18000;
export const WG_NY = 9000;
/** Fine cells per coarse cell side. */
export const WG_FINE_PER_CELL = 4;
export const WG_FINE_RES = WG_RES / WG_FINE_PER_CELL;
/** File name of the grid (shipped under data/, rebuilt into the plugin data directory). */
export const WG_FILE_NAME = 'water-grid-0.02.bin.gz';
const CHOKE_RECORD_BYTES = 12;
const SPLIT_RECORD_BYTES = 14;

/** Sides of a cell, in split-record order. */
export const SIDE_S = 0;
export const SIDE_N = 1;
export const SIDE_W = 2;
export const SIDE_E = 3;

/** Identity of a coastline shapefile the grid was built from. */
export interface WaterGridSource {
  name: string;
  size: number;
  mtimeMs: number;
  /** sha256 of the size, the first and the last MiB of the file. */
  fingerprint: string;
}

export interface CanalRecord {
  name: string;
  /** Edge ids: cellIndex * 2 + (0 = east edge, 1 = north edge). Only edges passable as built. */
  edges: number[];
}

export interface WaterGridHeader {
  version: number;
  res: number;
  nx: number;
  ny: number;
  /** Fine raster the edges were derived from. */
  fineRes: number;
  fineRule: string;
  edgeRule: string;
  sources: WaterGridSource[];
  builtAt: string;
  buildSeconds?: number;
  canals: CanalRecord[];
  chokepointRule?: string;
  stats?: Record<string, number>;
}

/** Narrow passages, struct-of-arrays. */
export class Chokepoints {
  constructor(
    readonly lat: Float32Array,
    readonly lon: Float32Array,
    /** Width at the narrowest point, metres. */
    readonly widthM: Uint16Array,
    /** Channel axis, degrees 0..179 (clockwise from north). */
    readonly axisDeg: Uint8Array
  ) {}

  get length(): number {
    return this.lat.length;
  }

  private buckets: Map<number, number[]> | null = null;

  /** Indices of chokepoints within the lon/lat box (1° buckets; antimeridian-aware). */
  near(lon: number, lat: number, radiusDeg: number): number[] {
    if (!this.buckets) {
      const b = new Map<number, number[]>();
      for (let i = 0; i < this.length; i++) {
        const key = bucketKey(this.lon[i], this.lat[i]);
        let a = b.get(key);
        if (!a) b.set(key, (a = []));
        a.push(i);
      }
      this.buckets = b;
    }
    const out: number[] = [];
    const r = Math.ceil(radiusDeg / Math.max(0.05, Math.cos((Math.min(89, Math.abs(lat)) * Math.PI) / 180))) + 1;
    const la0 = Math.floor(lat);
    const lo0 = Math.floor(lon);
    const rLat = Math.ceil(radiusDeg) + 1;
    for (let dy = -rLat; dy <= rLat; dy++) {
      const la = la0 + dy;
      if (la < -90 || la >= 90) continue;
      for (let dx = -Math.min(r, 180); dx <= Math.min(r, 179); dx++) {
        const lo = wrapLon(lo0 + dx);
        const a = this.buckets.get(bucketKey(lo + 0.5, la + 0.5));
        if (a) out.push(...a);
      }
    }
    return [...new Set(out)];
  }
}

/**
 * Split cells, struct-of-arrays, ascending by cell index. `labels` holds
 * 16 labels per cell (one byte each in memory): side-major (S, N, W, E),
 * 4 positions per side. `cross` bit (4·side' + k) where side' is the
 * crossing-mask order E=0, N=1, W=2, S=3.
 */
export class SplitCells {
  private map: Map<number, number> | null = null;

  constructor(
    readonly cells: Uint32Array,
    readonly labels: Uint8Array,
    readonly cross: Uint16Array
  ) {
    if (labels.length !== cells.length * 16 || cross.length !== cells.length) throw new Error('SplitCells: array sizes disagree');
  }

  static empty(): SplitCells {
    return new SplitCells(new Uint32Array(0), new Uint8Array(0), new Uint16Array(0));
  }

  get length(): number {
    return this.cells.length;
  }

  /** Record index of a cell, or -1 when the cell is not split. */
  find(cell: number): number {
    if (!this.map) {
      const m = new Map<number, number>();
      for (let i = 0; i < this.cells.length; i++) m.set(this.cells[i], i);
      this.map = m;
    }
    const r = this.map.get(cell);
    return r === undefined ? -1 : r;
  }

  label(rec: number, side: number, k: number): number {
    return this.labels[rec * 16 + side * 4 + k];
  }

  /** Crossing mask (4 bits) of a side (SIDE_*). */
  crossMask(rec: number, side: number): number {
    const bit = side === SIDE_E ? 0 : side === SIDE_N ? 4 : side === SIDE_W ? 8 : 12;
    return (this.cross[rec] >> bit) & 0xf;
  }

  /** Distinct component labels (1..) of a split cell. */
  components(rec: number): number[] {
    const out = new Set<number>();
    for (let i = 0; i < 16; i++) {
      const l = this.labels[rec * 16 + i];
      if (l) out.add(l);
    }
    return [...out].sort((a, b) => a - b);
  }
}

function bucketKey(lon: number, lat: number): number {
  return (Math.floor(lat) + 90) * 360 + (Math.floor(wrapLon(lon)) + 180);
}

const bitGet = (plane: Uint8Array, idx: number): boolean => (plane[idx >> 3] & (1 << (idx & 7))) !== 0;

export class WaterGrid {
  readonly nx: number;
  readonly ny: number;
  readonly res: number;
  private canalsAllowed = true;

  constructor(
    readonly header: WaterGridHeader,
    readonly water: Uint8Array,
    readonly east: Uint8Array,
    readonly north: Uint8Array,
    readonly chokepoints: Chokepoints,
    readonly splits: SplitCells = SplitCells.empty()
  ) {
    this.nx = header.nx;
    this.ny = header.ny;
    this.res = header.res;
    const bytes = Math.ceil((this.nx * this.ny) / 8);
    for (const [n, p] of [
      ['water', water],
      ['east', east],
      ['north', north],
    ] as const) {
      if (p.length !== bytes) throw new Error(`water grid: ${n} plane has ${p.length} bytes, expected ${bytes}`);
    }
  }

  /** Blank grid (all land, no edges) of the given size; tests and the builder. */
  static empty(nx = WG_NX, ny = WG_NY, res = WG_RES): WaterGrid {
    const bytes = Math.ceil((nx * ny) / 8);
    const header: WaterGridHeader = {
      version: WG_VERSION,
      res,
      nx,
      ny,
      fineRes: res / WG_FINE_PER_CELL,
      fineRule: 'centre-sampled',
      edgeRule: 'fine 4-connected crossing',
      sources: [],
      builtAt: new Date(0).toISOString(),
      canals: [],
    };
    return new WaterGrid(
      header,
      new Uint8Array(bytes),
      new Uint8Array(bytes),
      new Uint8Array(bytes),
      new Chokepoints(new Float32Array(0), new Float32Array(0), new Uint16Array(0), new Uint8Array(0))
    );
  }

  /** Resident bytes (planes, chokepoints, split cells; excluding the split lookup map). */
  bytes(): number {
    return (
      this.water.length + this.east.length + this.north.length + this.chokepoints.length * CHOKE_RECORD_BYTES + this.splits.length * 22
    );
  }

  index(r: number, c: number): number {
    return r * this.nx + c;
  }

  /** Column wrapped into [0, nx). */
  wrapCol(c: number): number {
    return ((c % this.nx) + this.nx) % this.nx;
  }

  isWater(r: number, c: number): boolean {
    if (r < 0 || r >= this.ny) return false;
    return bitGet(this.water, r * this.nx + this.wrapCol(c));
  }

  eastOpen(r: number, c: number): boolean {
    if (r < 0 || r >= this.ny) return false;
    return bitGet(this.east, r * this.nx + this.wrapCol(c));
  }

  westOpen(r: number, c: number): boolean {
    return this.eastOpen(r, c - 1);
  }

  northOpen(r: number, c: number): boolean {
    if (r < 0 || r >= this.ny - 1) return false;
    return bitGet(this.north, r * this.nx + this.wrapCol(c));
  }

  southOpen(r: number, c: number): boolean {
    return this.northOpen(r - 1, c);
  }

  /** Is the move between 4-neighbours (dr, dc ∈ {-1,0,1}, |dr|+|dc| = 1) open? */
  orthOpen(r: number, c: number, dr: number, dc: number): boolean {
    if (dc === 1) return this.eastOpen(r, c);
    if (dc === -1) return this.eastOpen(r, c - 1);
    if (dr === 1) return this.northOpen(r, c);
    return this.northOpen(r - 1, c);
  }

  /** Diagonal move: both L-shaped 4-paths through the two side cells must be open. */
  diagOpen(r: number, c: number, dr: number, dc: number): boolean {
    // Through or out of a split cell only orthogonal moves follow its components.
    if (this.splits.length && (this.isSplit(r, c) || this.isSplit(r, c + dc) || this.isSplit(r + dr, c) || this.isSplit(r + dr, c + dc)))
      return false;
    return this.orthOpen(r, c, 0, dc) && this.orthOpen(r, c + dc, dr, 0) && this.orthOpen(r, c, dr, 0) && this.orthOpen(r + dr, c, 0, dc);
  }

  /**
   * Component nodes of a cell: [0] for an ordinary water cell, the labels
   * of a split cell, [] for land.
   */
  nodeComponents(r: number, c: number): number[] {
    if (!this.isWater(r, c)) return [];
    const rec = this.splits.find(r * this.nx + this.wrapCol(c));
    return rec < 0 ? [0] : this.splits.components(rec);
  }

  /** Is the cell split (stored with components)? */
  isSplit(r: number, c: number): boolean {
    if (r < 0 || r >= this.ny) return false;
    return this.splits.find(r * this.nx + this.wrapCol(c)) >= 0;
  }

  /**
   * 4-neighbour moves from component `comp` of cell (r, c): calls
   * fn(dr, dc, comp') for each open move, comp' being the component
   * entered (0 for an ordinary cell). Columns may be unwrapped.
   */
  neighbours(r: number, c: number, comp: number, fn: (dr: number, dc: number, comp2: number) => void): void {
    const nx = this.nx;
    const cw = this.wrapCol(c);
    const idx = r * nx + cw;
    const recA = this.splits.length ? this.splits.find(idx) : -1;
    for (let d = 0; d < 4; d++) {
      const dr = d === 1 ? 1 : d === 3 ? -1 : 0;
      const dc = d === 0 ? 1 : d === 2 ? -1 : 0;
      if (!this.orthOpen(r, cw, dr, dc)) continue;
      const r2 = r + dr;
      const c2 = this.wrapCol(cw + dc);
      const recB = this.splits.length ? this.splits.find(r2 * nx + c2) : -1;
      if (recA < 0 && recB < 0) {
        fn(dr, dc, 0);
        continue;
      }
      const sideA = d === 0 ? SIDE_E : d === 1 ? SIDE_N : d === 2 ? SIDE_W : SIDE_S;
      const sideB = d === 0 ? SIDE_W : d === 1 ? SIDE_S : d === 2 ? SIDE_E : SIDE_N;
      const mask = recA >= 0 ? this.splits.crossMask(recA, sideA) : this.splits.crossMask(recB, sideB);
      let seen = 0;
      for (let k = 0; k < 4; k++) {
        if (!(mask & (1 << k))) continue;
        if (recA >= 0 && this.splits.label(recA, sideA, k) !== comp) continue;
        const lb = recB >= 0 ? this.splits.label(recB, sideB, k) : 0;
        if (seen & (1 << lb)) continue;
        seen |= 1 << lb;
        fn(dr, dc, lb);
      }
    }
  }

  /** Cell (row, col) containing a position. */
  cellOf(lon: number, lat: number): [number, number] {
    let r = Math.floor((lat + 90) / this.res);
    if (r < 0) r = 0;
    if (r >= this.ny) r = this.ny - 1;
    const c = this.wrapCol(Math.floor((wrapLon(lon) + 180) / this.res));
    return [r, c];
  }

  /** Centre of a cell; the column may be unwrapped (any integer). */
  cellCentre(r: number, c: number): [number, number] {
    return [wrapLon(-180 + (c + 0.5) * this.res), -90 + (r + 0.5) * this.res];
  }

  get canalsAreAllowed(): boolean {
    return this.canalsAllowed;
  }

  /** Open (true) or close (false) the edges of every known canal. */
  setCanalsAllowed(allowed: boolean): void {
    if (allowed === this.canalsAllowed) return;
    for (const canal of this.header.canals) {
      for (const e of canal.edges) {
        const idx = Math.floor(e / 2);
        const plane = e % 2 === 0 ? this.east : this.north;
        if (allowed) plane[idx >> 3] |= 1 << (idx & 7);
        else plane[idx >> 3] &= ~(1 << (idx & 7));
      }
    }
    this.canalsAllowed = allowed;
  }

  /** Does the grid come from exactly these shapefiles (by content fingerprint)? */
  matchesSources(sources: WaterGridSource[]): boolean {
    const a = this.header.sources.map(s => s.fingerprint).sort();
    const b = sources.map(s => s.fingerprint).sort();
    return a.length === b.length && a.every((f, i) => f === b[i]);
  }

  /** Serialise (canals as built, i.e. open) and gzip. */
  toBuffer(): Buffer {
    const wasAllowed = this.canalsAllowed;
    this.setCanalsAllowed(true);
    try {
      const headerJson = Buffer.from(JSON.stringify(this.header), 'utf8');
      const pre = Buffer.alloc(16);
      pre.write(WG_MAGIC, 0, 'latin1');
      pre.writeUInt32LE(WG_VERSION, 8);
      pre.writeUInt32LE(headerJson.length, 12);
      const n = this.chokepoints.length;
      const cp = Buffer.alloc(4 + n * CHOKE_RECORD_BYTES);
      cp.writeUInt32LE(n, 0);
      for (let i = 0; i < n; i++) {
        const o = 4 + i * CHOKE_RECORD_BYTES;
        cp.writeFloatLE(this.chokepoints.lat[i], o);
        cp.writeFloatLE(this.chokepoints.lon[i], o + 4);
        cp.writeUInt16LE(this.chokepoints.widthM[i], o + 8);
        cp.writeUInt8(this.chokepoints.axisDeg[i], o + 10);
      }
      const ns = this.splits.length;
      const sp = Buffer.alloc(4 + ns * SPLIT_RECORD_BYTES);
      sp.writeUInt32LE(ns, 0);
      for (let i = 0; i < ns; i++) {
        const o = 4 + i * SPLIT_RECORD_BYTES;
        sp.writeUInt32LE(this.splits.cells[i], o);
        for (let b = 0; b < 8; b++)
          sp.writeUInt8((this.splits.labels[i * 16 + 2 * b] & 0xf) | ((this.splits.labels[i * 16 + 2 * b + 1] & 0xf) << 4), o + 4 + b);
        sp.writeUInt16LE(this.splits.cross[i], o + 12);
      }
      const raw = Buffer.concat([pre, headerJson, this.water, this.east, this.north, cp, sp]);
      return zlib.gzipSync(raw, { level: 9 });
    } finally {
      this.setCanalsAllowed(wasAllowed);
    }
  }

  /** Parse a gzip-compressed grid file. Canals come back open (as built). */
  static fromBuffer(gz: Buffer): WaterGrid {
    // The gzip trailer holds the uncompressed size: decompress into one
    // chunk of that size, so the 62 MB result is not assembled from pieces
    // (which briefly needs twice the memory).
    const isize = gz.length >= 4 ? gz.readUInt32LE(gz.length - 4) : 0;
    const raw = zlib.gunzipSync(gz, isize > 0 && isize < 2 ** 31 ? { chunkSize: Math.max(64 * 1024, isize + 1024) } : {});
    if (raw.length < 16 || raw.toString('latin1', 0, 8) !== WG_MAGIC) throw new Error('water grid: bad magic');
    const version = raw.readUInt32LE(8);
    if (version !== WG_VERSION) throw new Error(`water grid: format version ${version}, expected ${WG_VERSION}`);
    const hLen = raw.readUInt32LE(12);
    const header = JSON.parse(raw.toString('utf8', 16, 16 + hLen)) as WaterGridHeader;
    const bytes = Math.ceil((header.nx * header.ny) / 8);
    let o = 16 + hLen;
    if (raw.length < o + 3 * bytes + 4) throw new Error('water grid: truncated planes');
    // Views into the decompressed buffer (no copy).
    const view = (off: number, len: number): Uint8Array => new Uint8Array(raw.buffer, raw.byteOffset + off, len);
    const water = view(o, bytes);
    o += bytes;
    const east = view(o, bytes);
    o += bytes;
    const north = view(o, bytes);
    o += bytes;
    const n = raw.readUInt32LE(o);
    o += 4;
    if (raw.length < o + n * CHOKE_RECORD_BYTES) throw new Error('water grid: truncated chokepoints');
    const lat = new Float32Array(n);
    const lon = new Float32Array(n);
    const widthM = new Uint16Array(n);
    const axisDeg = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = o + i * CHOKE_RECORD_BYTES;
      lat[i] = raw.readFloatLE(p);
      lon[i] = raw.readFloatLE(p + 4);
      widthM[i] = raw.readUInt16LE(p + 8);
      axisDeg[i] = raw.readUInt8(p + 10);
    }
    o += n * CHOKE_RECORD_BYTES;
    if (raw.length < o + 4) throw new Error('water grid: truncated split cells');
    const ns = raw.readUInt32LE(o);
    o += 4;
    if (raw.length < o + ns * SPLIT_RECORD_BYTES) throw new Error('water grid: truncated split cells');
    const cells = new Uint32Array(ns);
    const labels = new Uint8Array(ns * 16);
    const cross = new Uint16Array(ns);
    for (let i = 0; i < ns; i++) {
      const p = o + i * SPLIT_RECORD_BYTES;
      cells[i] = raw.readUInt32LE(p);
      for (let b = 0; b < 8; b++) {
        const v = raw.readUInt8(p + 4 + b);
        labels[i * 16 + 2 * b] = v & 0xf;
        labels[i * 16 + 2 * b + 1] = v >> 4;
      }
      cross[i] = raw.readUInt16LE(p + 12);
    }
    return new WaterGrid(header, water, east, north, new Chokepoints(lat, lon, widthM, axisDeg), new SplitCells(cells, labels, cross));
  }

  static load(file: string): WaterGrid {
    return WaterGrid.fromBuffer(fs.readFileSync(file));
  }

  /** Write atomically (temp file + rename). */
  save(file: string): number {
    const buf = this.toBuffer();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Unique per writer (worker threads share a pid).
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    return buf.length;
  }
}

/** Content fingerprints of coastline shapefiles (reads 2 MiB per file). */
export function sourceFingerprints(paths: string[]): WaterGridSource[] {
  return shorelinePaths(paths).map(p => {
    const st = fs.statSync(p);
    const h = crypto.createHash('sha256');
    h.update(String(st.size));
    const fd = fs.openSync(p, 'r');
    try {
      const n = Math.min(st.size, 1 << 20);
      const head = Buffer.alloc(n);
      fs.readSync(fd, head, 0, n, 0);
      h.update(head);
      const tail = Buffer.alloc(n);
      fs.readSync(fd, tail, 0, n, Math.max(0, st.size - n));
      h.update(tail);
    } finally {
      fs.closeSync(fd);
    }
    return { name: path.basename(p), size: st.size, mtimeMs: st.mtimeMs, fingerprint: h.digest('hex') };
  });
}
