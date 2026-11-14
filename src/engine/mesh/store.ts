/**
 * The navigation mesh on disk: one folder of flat binary tiles (0.25°)
 * plus index.json, written by the mesh build (not part of this repo).
 * Nothing is held between routes: a leg reads its tiles one at a time as
 * the search reaches them (paged.ts) and drops them as it goes; the tests
 * also read a box of tiles into one set of typed arrays (load).
 *
 * A tile without chart data is not part of the mesh as read here. The build
 * meshes every 0.25° tile of a district's rectangle, and a tile no chart
 * covers (water outside the district's charts, e.g. off Nova Scotia in
 * 01CGD) comes out as open water of unknown depth in every triangle. As mesh
 * water it was a wall for the coastline search along the rectangle's straight
 * edge, and the joining points between the two lay in the sliver it left
 * against the coast (brain, 2026-10-30: a leg from Greenland to Block Island
 * aimed at a point at the top of a channel one raster cell wide off Cape
 * Sable and stalled 25 km out). Such a tile is left out of the index, and a
 * side facing it is an outer edge (neighbour -1): the coastline search has
 * that water, and the mesh begins where the charts do. Measured on brain
 * (2026-10-30): 190 of 01CGD's 538 tiles, 2,670 of 07CGD Gulf's 3,111. The
 * set is found from the depth column alone and kept beside index.json
 * (NOCHART_FILE), so a mesh opened per leg does not read it again.
 *
 * Tile file (little-endian): 32-byte header (magic 'WRPMESH1', uint32 n,
 * float64 originLon, float64 originLat, 4 bytes pad), then
 *   corners    float64[n*6]  (x0, y0, x1, y1, x2, y2): x = lon × xScale (the
 *                            build's cos(mid-latitude)), y = lat; the build's own
 *                            values, so a seam vertex is identical in both tiles
 *                            (but on the date line, below)
 *   neighbours int32[n*3]    global triangle ids (contiguous per tile), -1 = none
 *   mult       float32[n]    shore penalty × depth penalty
 *   depth      float32[n]    charted depth, -999 = unknown
 *   clear      float32[n]    vertical clearance, -999 = none: a fixed span's charted
 *                            clearance; an opening bridge's (flags bit 7) OPEN
 *                            clearance, -999 when none is charted (the mesh build of
 *                            2026-10-08); the lowest where overhead cables, pipelines
 *                            or conveyors share the triangle
 *   hazv       float32[n]    a hazard's charted depth (VALSOU); -1e9 = a hazard
 *                            with none charted, 1e9 = no hazard
 *   rev        int8[n*3]     index of the shared edge on the neighbour's side
 *   flags      uint8[n]      see FLAG_*
 *
 * The date line. A mesh's longitudes are the router's (geo/geodesy.ts): between -180 and 180, and a box whose west is
 * greater than its east crosses the date line. The date line is a tile edge, so no tile lies across it: a tile's
 * corners and its extent are plain numbers, and only the index's own box (west, east) may cross (171.5 to -67 is
 * 171.5°E eastwards to 67°W). A vertex on the date line is 180 in the tile west of it and -180 in the tile east of
 * it. Whatever needs the mesh in one piece takes a longitude next to the mesh's middle (lonNear): the tile a point is
 * in (tileIJ), and the corners in a frame of metres (loadTiles here, the leg's frame in paged.ts). For a mesh that
 * does not cross the date line and a point within half a turn of its middle that is the longitude itself, unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { unwrapLonNear } from '../../geo/angles';
import { bboxContains, bboxWidth, boxesMeet, wrapEdge, type BBox } from '../../geo/geodesy';

export const FLAG_NAVIGABLE = 1;
export const FLAG_HAZARD = 2;
export const FLAG_MARK = 4;
export const FLAG_CHANNEL_MARK = 8;
export const FLAG_STRUCTURE = 16;
export const FLAG_FAIRWAY = 32;
export const FLAG_DREDGED = 64;
/** An opening bridge (bascule, swing, lift, draw, transporter): `clear` is its open clearance (the mesh build of 2026-10-08; older tiles never set it). */
export const FLAG_OPENING_BRIDGE = 128;

/** Marker for "no value" in the depth and clearance columns. */
export const NO_VALUE = -999;
/** hazv of a triangle with no hazard (the build's default). */
export const NO_HAZARD = 1e9;
/** hazv of a hazard whose charted depth is unknown: blocked for any draught. */
export const HAZARD_DEPTH_UNKNOWN = -1e9;

const MAGIC = 'WRPMESH1';
const HEADER_BYTES = 32;
/** The tiles without chart data, kept in the mesh folder: { version, indexSize, indexMtimeMs, files }. */
export const NOCHART_FILE = '.wrp-nochart.json';
const NOCHART_VERSION = 1;

/** The tile files of a mesh folder in which every triangle has no depth (no chart data), from each tile's depth column alone. */
export function scanNoChartTiles(dir: string, index: MeshIndex): string[] {
  const out: string[] = [];
  for (const t of index.tiles) {
    const fd = fs.openSync(path.join(dir, t.file), 'r');
    try {
      const buf = Buffer.alloc(t.n * 4);
      // The depth column follows the header, the corners, the neighbours and the multipliers.
      fs.readSync(fd, buf, 0, buf.length, HEADER_BYTES + t.n * (48 + 12 + 4));
      let none = t.n > 0;
      for (let a = 0; a < t.n && none; a++) none = buf.readFloatLE(a * 4) === NO_VALUE;
      if (none) out.push(t.file);
    } finally {
      fs.closeSync(fd);
    }
  }
  return out;
}

/** This process's answers, per mesh folder and index.json state. */
const noChartSeen = new Map<string, { size: number; mtimeMs: number; files: Set<string> }>();

/**
 * The tiles without chart data of a mesh folder: from this process's last answer, else the folder's NOCHART_FILE when
 * it was written for this index.json (size and date), else scanned (scanNoChartTiles) and written there; a folder
 * that cannot be written is scanned each time a process opens it.
 */
function noChartTiles(dir: string, index: MeshIndex): Set<string> {
  const st = fs.statSync(path.join(dir, 'index.json'));
  const seen = noChartSeen.get(dir);
  if (seen && seen.size === st.size && seen.mtimeMs === st.mtimeMs) return seen.files;
  let files: string[] | null = null;
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(dir, NOCHART_FILE), 'utf8'));
    if (kept.version === NOCHART_VERSION && kept.indexSize === st.size && kept.indexMtimeMs === st.mtimeMs && Array.isArray(kept.files))
      files = kept.files;
  } catch {
    /* none yet, or unreadable: scanned below */
  }
  if (!files) {
    files = scanNoChartTiles(dir, index);
    try {
      const tmp = path.join(dir, `${NOCHART_FILE}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ version: NOCHART_VERSION, indexSize: st.size, indexMtimeMs: st.mtimeMs, files }));
      fs.renameSync(tmp, path.join(dir, NOCHART_FILE));
    } catch {
      /* a folder that cannot be written: scanned again next time */
    }
  }
  const set = new Set(files);
  noChartSeen.set(dir, { size: st.size, mtimeMs: st.mtimeMs, files: set });
  return set;
}
/** Metres per degree of the mesh's metres frame. */
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

/** A tile's vertex extent (MeshTileInfo.bbox) as a box. */
export function tileBBox(b: [number, number, number, number]): BBox {
  return { west: b[0], south: b[1], east: b[2], north: b[3] };
}

/**
 * Do two tiles' vertex extents share at least a point (of one mesh or of two)? The one test of it (geodesy.ts
 * boxesMeet): longitude goes round, so a tile that ends on the date line at 180 and one that starts on it at -180 meet
 * there, as two tiles that share an edge anywhere else do.
 */
export function tileExtentsMeet(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return boxesMeet(tileBBox(a), tileBBox(b));
}

/**
 * How far a point lies from a tile's vertex extent, degrees [east, north] from the point to the extent's nearest point
 * ([0, 0] inside it). The point's longitude is taken next to the extent's middle, as the tile is stored: the short way
 * round (a tile east of the date line is stored from -180, and a point on the date line is 180 or -180). The one
 * place a point and a tile's extent are compared; no frame comes into it, the question is the earth's.
 */
export function toTileExtent(bbox: [number, number, number, number], lon: number, lat: number): [number, number] {
  const l = unwrapLonNear(lon, (bbox[0] + bbox[2]) / 2);
  // East to the extent or west to it, whichever is less: a point more than half a turn from the extent's near side
  // is nearer its far side the other way round.
  const east = Math.min(Math.max(l, bbox[0]), bbox[2]) - l;
  const other = l <= bbox[0] ? bbox[2] - (l + 360) : l >= bbox[2] ? bbox[0] - (l - 360) : 0;
  return [Math.abs(other) < Math.abs(east) ? other : east, Math.min(Math.max(lat, bbox[1]), bbox[3]) - lat];
}

export interface MeshIndex {
  version: number;
  /** The mesh's box; `west` greater than `east` when the mesh crosses the date line (see the file's comment). */
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
  /**
   * The longitude the frame is laid out about: a longitude is taken next to it (within half a turn) before it is
   * scaled, so a mesh across the date line is in one piece. Absent (the tests' own meshes): a longitude as it is.
   */
  ref?: number;
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

/** One tile as stored on disk (store.ts header); neighbours are global triangle ids. */
export interface TileArrays {
  n: number;
  corners: Float64Array;
  nb: Int32Array;
  mult: Float32Array;
  depth: Float32Array;
  clear: Float32Array;
  hazv: Float32Array;
  rev: Int8Array;
  flags: Uint8Array;
}

export class MeshStore {
  private readonly byIJ = new Map<string, MeshTileInfo>();
  /** The global id ranges [first, end) of the tiles left out (no chart data), ascending by first. */
  private readonly gaps: [number, number][];

  /** The longitude of the middle of the mesh's box, counted east from its west edge (past 180 when the box crosses the date line). */
  readonly midLon: number;

  private constructor(
    readonly dir: string,
    /** The index with the tiles without chart data left out (the triangle count as built). */
    readonly index: MeshIndex,
    gaps: [number, number][] = []
  ) {
    for (const t of index.tiles) this.byIJ.set(`${t.i},${t.j}`, t);
    this.gaps = gaps.sort((a, b) => a[0] - b[0]);
    this.midLon = index.west + bboxWidth(index) / 2;
  }

  /**
   * A longitude next to the mesh: the same meridian, within half a turn of the mesh's middle, so every point of the
   * mesh and round it lies in one run of numbers from its west edge eastwards (190 for 170°W in a mesh that starts at
   * 171.5°E). A longitude already within half a turn of the middle is returned as it is.
   */
  lonNear(lon: number): number {
    return unwrapLonNear(lon, this.midLon);
  }

  /** Open a mesh folder; throws when index.json is missing or not a version this code reads. Tiles without chart data are left out. */
  static open(dir: string): MeshStore {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as MeshIndex;
    if (index.version !== 1) throw new Error(`mesh ${dir}: index version ${index.version}, this plugin reads version 1`);
    const none = noChartTiles(dir, index);
    if (!none.size) return new MeshStore(dir, index);
    const left = index.tiles.filter(t => none.has(t.file));
    return new MeshStore(
      dir,
      { ...index, tiles: index.tiles.filter(t => !none.has(t.file)) },
      left.map(t => [t.first, t.first + t.n])
    );
  }

  /** How many tiles were left out for having no chart data. */
  get tilesWithoutCharts(): number {
    return this.gaps.length;
  }

  /** A global id in a tile left out (no chart data)? */
  private inGap(g: number): boolean {
    const G = this.gaps;
    let lo = 0;
    let hi = G.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (g < G[m][0]) hi = m - 1;
      else if (g >= G[m][1]) lo = m + 1;
      else return true;
    }
    return false;
  }

  /**
   * The column of a longitude counted on from the mesh's west edge (`x`: next to the mesh, lonNear, or further on along
   * a run), named within one turn of the earth: the column a whole turn on is the same column. So a point and the run
   * of a tile's extent name a column alike wherever they are taken, in a mesh all the way round too, where the column
   * east of the last is the first.
   */
  private column(x: number): number {
    const turn = Math.round(360 / this.index.tileDeg);
    const c = Math.floor((x - this.index.west) / this.index.tileDeg);
    return ((c % turn) + turn) % turn;
  }

  /** The tile column and row of a point: columns count east from the mesh's west edge, across the date line when the mesh crosses it. */
  tileIJ(lon: number, lat: number): [number, number] {
    return [this.column(this.lonNear(lon)), Math.floor((lat - this.index.south) / this.index.tileDeg)];
  }

  /**
   * The columns a run of longitude meets, from `west` eastwards over `width` degrees, in order, each named as tileIJ
   * names a point's: one run, counted on from its west end, so a run across the far side of the earth from the mesh's
   * middle (a tile on the date line in a mesh all the way round) is its columns in a row and never an empty range
   * between two ends named apart.
   */
  columnsOf(west: number, width: number): number[] {
    const from = this.lonNear(west);
    const { west: meshWest, tileDeg } = this.index;
    const out: number[] = [];
    for (let i = Math.floor((from - meshWest) / tileDeg); i <= Math.floor((from + width - meshWest) / tileDeg); i++)
      out.push(this.column(meshWest + i * tileDeg + tileDeg / 2));
    return out;
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

  /**
   * The tiles whose cells meet the box, sorted by first id. The box is its whole run of longitude, from its west
   * eastwards to its east (across the date line when its west is the greater, all the way round for -180 to 180): the
   * run starts at the box's west taken next to the mesh (lonNear) and may go on past the far side of the earth from
   * the mesh's middle, where it is a turn on from the mesh's own columns, so the columns are those of the run and of
   * the run a turn back. A run nearly all the way round comes back over the mesh, and the two runs then name a column
   * twice: a tile is in the answer once.
   */
  private tilesIn(box: BBox): MeshTileInfo[] {
    const { west: meshWest, south: meshSouth, tileDeg } = this.index;
    const j0 = Math.floor((box.south - meshSouth) / tileDeg);
    const j1 = Math.floor((box.north - meshSouth) / tileDeg);
    const found = new Set<MeshTileInfo>();
    if (bboxWidth(box) >= 360) {
      for (const t of this.index.tiles) if (t.j >= j0 && t.j <= j1) found.add(t);
    } else {
      const west = this.lonNear(box.west);
      // The box's east counted on from that west: the same turns on as the west, and one more across the date line.
      const east = box.east + (west - box.west) + (box.west <= box.east ? 0 : 360);
      for (const turn of [0, -360]) {
        const i0 = Math.floor((west + turn - meshWest) / tileDeg);
        const i1 = Math.floor((east + turn - meshWest) / tileDeg);
        for (let i = i0; i <= i1; i++)
          for (let j = j0; j <= j1; j++) {
            const t = this.tile(i, j);
            if (t) found.add(t);
          }
      }
    }
    // Sorted by first id so neighbours can be remapped by binary search.
    return [...found].sort((a, b) => a.first - b.first);
  }

  /** How many triangles load(box) would read, from the index alone. */
  countTriangles(box: BBox): number {
    let n = 0;
    for (const t of this.tilesIn(box)) n += t.n;
    return n;
  }

  /** Read every tile whose cell meets the box into one mesh (metres frame about the box's mid-latitude). */
  load(box: BBox): LoadedMesh {
    return this.loadTiles(this.tilesIn(box), box);
  }

  /**
   * Read exactly these tiles into one mesh, in the metres frame about the
   * box's mid-latitude. A neighbour in a tile not read is -1, as at the
   * edge of a box.
   */
  loadTiles(tileInfos: MeshTileInfo[], box: BBox): LoadedMesh {
    const infos = [...tileInfos].sort((a, b) => a.first - b.first);
    let n = 0;
    const tiles = infos.map(info => {
      const t = { info, offset: n };
      n += info.n;
      return t;
    });
    // cos of the box's mid-latitude.
    const cl = Math.cos(((box.south + box.north) / 2) * (Math.PI / 180));
    const m: LoadedMesh = {
      n,
      x: new Float64Array(n * 3),
      y: new Float64Array(n * 3),
      cl,
      ref: this.midLon,
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

  /**
   * One tile's arrays as stored: corners (the build's x = lon × xScale, y =
   * lat), neighbours as global triangle ids (-1 = none), and the per-triangle
   * fields. Views over one buffer read from disk.
   */
  readTileArrays(info: MeshTileInfo): TileArrays {
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
    // A neighbour in a tile left out (no chart data): the side is the mesh's outer edge.
    if (this.gaps.length)
      for (let q = 0; q < n * 3; q++) {
        const g = nb[q];
        if (g >= 0 && (g < info.first || g >= info.first + n) && this.inGap(g)) nb[q] = -1;
      }
    const mult = f32(n);
    const depth = f32(n);
    const clear = f32(n);
    const hazv = f32(n);
    const rev = new Int8Array(buf.buffer, at, n * 3);
    at += n * 3;
    const flags = new Uint8Array(buf.buffer, at, n);
    at += n;
    if (at - buf.byteOffset !== buf.length) throw new Error(`mesh tile ${info.file}: ${buf.length} bytes, expected ${at - buf.byteOffset}`);
    return { n, corners, nb, mult, depth, clear, hazv, rev, flags };
  }

  private readTile(info: MeshTileInfo, m: LoadedMesh, offset: number, toLocal: (g: number) => number): void {
    const { n, corners, nb, mult, depth, clear, hazv, rev, flags } = this.readTileArrays(info);
    // The same expression, in the same order, as toMeshXY.
    const K = this.index.xScale;
    for (let k = 0; k < n * 3; k++) {
      m.x[offset * 3 + k] = this.lonNear(corners[2 * k] / K) * m.cl * M_PER_DEG_MESH;
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

/** Project a point into a loaded mesh's metres frame (the same expression order as readTile). */
export function toMeshXY(m: LoadedMesh, lon: number, lat: number): [number, number] {
  return [(m.ref === undefined ? lon : unwrapLonNear(lon, m.ref)) * m.cl * M_PER_DEG_MESH, lat * M_PER_DEG_MESH];
}

/** Back from the metres frame to degrees (a longitude between -180 and 180). */
export function fromMeshXY(m: LoadedMesh, x: number, y: number): [number, number] {
  return [wrapEdge(x / (m.cl * M_PER_DEG_MESH)), y / M_PER_DEG_MESH];
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
