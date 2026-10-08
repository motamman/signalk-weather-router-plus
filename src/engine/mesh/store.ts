/**
 * The navigation mesh on disk: one folder of flat binary tiles (0.25°)
 * plus index.json, written by the experiment's converter
 * (~/mesh-experiment/scripts/mesh_to_bin.py; not part of this repo).
 * Nothing is held between routes: a leg reads the tiles in its box into
 * one set of typed arrays and drops them when the leg is done.
 *
 * Tile file (little-endian): 32-byte header (magic 'WRPMESH1', uint32 n,
 * float64 originLon, float64 originLat, 4 bytes pad), then
 *   corners    float64[n*6]  (x0, y0, x1, y1, x2, y2): x = lon × xScale (the
 *                            build's cos(mid-latitude)), y = lat; the build's own
 *                            values, so a seam vertex is identical in both tiles
 *   neighbours int32[n*3]    global triangle ids (contiguous per tile), -1 = none
 *   mult       float32[n]    shore penalty × depth penalty
 *   depth      float32[n]    charted depth, -999 = unknown
 *   clear      float32[n]    vertical clearance, -999 = none
 *   hazv       float32[n]    a hazard's charted depth (VALSOU); -1e9 = a hazard
 *                            with none charted, 1e9 = no hazard
 *   rev        int8[n*3]     index of the shared edge on the neighbour's side
 *   flags      uint8[n]      see FLAG_*
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bboxContains, type BBox } from '../../geo/geodesy';

export const FLAG_NAVIGABLE = 1;
export const FLAG_HAZARD = 2;
export const FLAG_MARK = 4;
export const FLAG_CHANNEL_MARK = 8;
export const FLAG_STRUCTURE = 16;
export const FLAG_FAIRWAY = 32;
export const FLAG_DREDGED = 64;

/** Marker for "no value" in the depth and clearance columns. */
export const NO_VALUE = -999;
/** hazv of a triangle with no hazard (the build's default). */
export const NO_HAZARD = 1e9;
/** hazv of a hazard whose charted depth is unknown: blocked for any draught. */
export const HAZARD_DEPTH_UNKNOWN = -1e9;

const MAGIC = 'WRPMESH1';
const HEADER_BYTES = 32;
/** Metres per degree the experiment's router projects with (mesh_route5.py); kept for parity. */
export const M_PER_DEG_MESH = 111320;

export interface MeshTileInfo {
  i: number;
  j: number;
  file: string;
  /** Global id of the tile's first triangle (its triangles are first … first + n - 1). */
  first: number;
  n: number;
  /** Extent of the tile's vertices [west, south, east, north] (the tile plus its build overlap). */
  bbox: [number, number, number, number];
}

export interface MeshIndex {
  version: number;
  west: number;
  south: number;
  east: number;
  north: number;
  tileDeg: number;
  /** The build's x scaling: a stored x is lon × xScale. */
  xScale: number;
  triangles: number;
  tiles: MeshTileInfo[];
}

/** The tiles of a leg's box joined into one mesh, in a local metres frame. */
export interface LoadedMesh {
  n: number;
  /** Corner k of triangle t: x[t*3+k], y[t*3+k], metres (lon × cl × M_PER_DEG_MESH, lat × M_PER_DEG_MESH). */
  x: Float64Array;
  y: Float64Array;
  /** cos(latitude) the x axis was scaled with. */
  cl: number;
  /** Local index of the neighbour across edge k of t (edge k runs from corner k to corner k+1), -1 = none or not loaded. */
  neighbours: Int32Array;
  rev: Int8Array;
  mult: Float32Array;
  depth: Float32Array;
  clear: Float32Array;
  hazv: Float32Array;
  flags: Uint8Array;
  /** The loaded tiles and where each one's triangles start in the local arrays. */
  tiles: { info: MeshTileInfo; offset: number }[];
}

export class MeshStore {
  private readonly byIJ = new Map<string, MeshTileInfo>();

  private constructor(
    readonly dir: string,
    readonly index: MeshIndex
  ) {
    for (const t of index.tiles) this.byIJ.set(`${t.i},${t.j}`, t);
  }

  /** Open a mesh folder; throws when index.json is missing or not a version this code reads. */
  static open(dir: string): MeshStore {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as MeshIndex;
    if (index.version !== 1) throw new Error(`mesh ${dir}: index version ${index.version}, this plugin reads version 1`);
    return new MeshStore(dir, index);
  }

  tileIJ(lon: number, lat: number): [number, number] {
    return [Math.floor((lon - this.index.west) / this.index.tileDeg), Math.floor((lat - this.index.south) / this.index.tileDeg)];
  }

  tile(i: number, j: number): MeshTileInfo | undefined {
    return this.byIJ.get(`${i},${j}`);
  }

  /** The point lies in a tile the mesh has, inside the tile's vertex extent. */
  covers(lon: number, lat: number): boolean {
    const [i, j] = this.tileIJ(lon, lat);
    const t = this.tile(i, j);
    if (!t) return false;
    return bboxContains({ west: t.bbox[0], south: t.bbox[1], east: t.bbox[2], north: t.bbox[3] }, lon, lat);
  }

  /** Read every tile whose cell meets the box into one mesh (metres frame about the box's mid-latitude). */
  load(box: BBox): LoadedMesh {
    const [i0, j0] = this.tileIJ(box.west, box.south);
    const [i1, j1] = this.tileIJ(box.east, box.north);
    const infos: MeshTileInfo[] = [];
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const t = this.tile(i, j);
        if (t) infos.push(t);
      }
    // Sorted by first id so neighbours can be remapped by binary search.
    infos.sort((a, b) => a.first - b.first);
    let n = 0;
    const tiles = infos.map(info => {
      const t = { info, offset: n };
      n += info.n;
      return t;
    });
    // math.cos(math.radians(mid)) as the experiment's router computes it.
    const cl = Math.cos(((box.south + box.north) / 2) * (Math.PI / 180));
    const m: LoadedMesh = {
      n,
      x: new Float64Array(n * 3),
      y: new Float64Array(n * 3),
      cl,
      neighbours: new Int32Array(n * 3),
      rev: new Int8Array(n * 3),
      mult: new Float32Array(n),
      depth: new Float32Array(n),
      clear: new Float32Array(n),
      hazv: new Float32Array(n),
      flags: new Uint8Array(n),
      tiles,
    };
    const firsts = infos.map(t => t.first);
    const toLocal = (g: number): number => {
      // The tile holding global id g, or -1 when it is not loaded.
      let lo = 0;
      let hi = firsts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (firsts[mid] <= g) lo = mid;
        else hi = mid - 1;
      }
      const t = tiles[lo];
      return g >= t.info.first && g < t.info.first + t.info.n ? g - t.info.first + t.offset : -1;
    };
    for (const t of tiles) this.readTile(t.info, m, t.offset, toLocal);
    return m;
  }

  private readTile(info: MeshTileInfo, m: LoadedMesh, offset: number, toLocal: (g: number) => number): void {
    let buf: Buffer = fs.readFileSync(path.join(this.dir, info.file));
    if (buf.toString('latin1', 0, 8) !== MAGIC) throw new Error(`mesh tile ${info.file}: bad magic`);
    const n = buf.readUInt32LE(8);
    if (n !== info.n) throw new Error(`mesh tile ${info.file}: ${n} triangles, index says ${info.n}`);
    // Typed-array views need 8-byte alignment; a small file may come from Node's shared pool.
    if ((buf.byteOffset + HEADER_BYTES) % 8 !== 0) buf = Buffer.from(buf);
    let at = buf.byteOffset + HEADER_BYTES;
    const f32 = (len: number): Float32Array => {
      const a = new Float32Array(buf.buffer, at, len);
      at += len * 4;
      return a;
    };
    const corners = new Float64Array(buf.buffer, at, n * 6);
    at += n * 48;
    const nb = new Int32Array(buf.buffer, at, n * 3);
    at += n * 12;
    const mult = f32(n);
    const depth = f32(n);
    const clear = f32(n);
    const hazv = f32(n);
    const rev = new Int8Array(buf.buffer, at, n * 3);
    at += n * 3;
    const flags = new Uint8Array(buf.buffer, at, n);
    at += n;
    if (at - buf.byteOffset !== buf.length) throw new Error(`mesh tile ${info.file}: ${buf.length} bytes, expected ${at - buf.byteOffset}`);
    // The same expression, in the same order, as the experiment's router (parity to the bit).
    const K = this.index.xScale;
    for (let k = 0; k < n * 3; k++) {
      m.x[offset * 3 + k] = (corners[2 * k] / K) * m.cl * M_PER_DEG_MESH;
      m.y[offset * 3 + k] = corners[2 * k + 1] * M_PER_DEG_MESH;
      const g = nb[k];
      m.neighbours[offset * 3 + k] = g < 0 ? -1 : toLocal(g);
    }
    m.rev.set(rev, offset * 3);
    m.mult.set(mult, offset);
    m.depth.set(depth, offset);
    m.clear.set(clear, offset);
    m.hazv.set(hazv, offset);
    m.flags.set(flags, offset);
  }
}

/** Project a point into a loaded mesh's metres frame (mesh_route5.py's expression order). */
export function toMeshXY(m: LoadedMesh, lon: number, lat: number): [number, number] {
  return [lon * m.cl * M_PER_DEG_MESH, lat * M_PER_DEG_MESH];
}

/** Back from the metres frame to degrees. */
export function fromMeshXY(m: LoadedMesh, x: number, y: number): [number, number] {
  return [x / (m.cl * M_PER_DEG_MESH), y / M_PER_DEG_MESH];
}

/**
 * The triangle containing the point (metres frame) among the triangles of
 * the given tiles, or -1. Corners wind counter-clockwise, as the build
 * wrote them; a point on an edge counts for the first triangle met.
 */
export function locate(m: LoadedMesh, tiles: { info: MeshTileInfo; offset: number }[], px: number, py: number): number {
  const { x, y } = m;
  for (const t of tiles) {
    const end = t.offset + t.info.n;
    for (let tri = t.offset; tri < end; tri++) {
      const a = tri * 3;
      const ax = x[a];
      const ay = y[a];
      const bx = x[a + 1];
      const by = y[a + 1];
      const cx = x[a + 2];
      const cy = y[a + 2];
      if (px < Math.min(ax, bx, cx) || px > Math.max(ax, bx, cx) || py < Math.min(ay, by, cy) || py > Math.max(ay, by, cy)) continue;
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (d1 >= 0 && d2 >= 0 && d3 >= 0) return tri;
    }
  }
  return -1;
}
