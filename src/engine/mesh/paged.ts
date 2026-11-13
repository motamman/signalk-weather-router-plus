/**
 * The chart mesh read a tile at a time (docs/drafts/mesh-no-gshhg-design.md, part 4 revised): no area is chosen
 * before a search. Triangles keep their global ids (index.json `first` + position in the tile); a tile is read from
 * disk the first time one of its triangles is asked for, with its corners in the leg's metres frame (x = lon × cl ×
 * M_PER_DEG_MESH, y = lat × M_PER_DEG_MESH, cl the cosine of the leg's mid-latitude), its neighbours as global ids,
 * its blocked set under the leg's rules (route.ts blockedTriangles) and the buffer from unusable water grown inside
 * it (growBlocked, seeded across its edges from the rough cut's blocked boundary triangles). A tile can be dropped
 * and is read again when asked for; the search (astar.ts) drops a tile when no node of its frontier lies in it.
 *
 * Measured on brain (2026-10-12, 31 legs, read-only scripts): every leg routed with no area given, median 1.16 M
 * triangles read, and dropping tiles the frontier has left took the worst case from 2.8 GB to 1.1 GB for the same
 * route cost.
 *
 * The tests' in-memory meshes are one tile (fromLoaded), so the search, the land and the walks run the same code.
 *
 * A tile's blocked set (rules, then the buffer) is computed in the tile's own frame, not the leg's, so it is the
 * same for every leg and for the rough cut built from the same reads (coarse.ts): the rough cut's "connected" is
 * the search's.
 *
 * The date line (store.ts, the file's comment): the frame is flat, laid out about one longitude (`frameLon`: the middle
 * of the mesh, or the one given with centred() where several meshes share a frame). A point's longitude is taken next
 * to it, within half a turn (toXY), and a tile is placed whole, a whole number of turns from where it is stored, so
 * that its middle is next to it too (read): a mesh across the date line is one piece, and a tile is never torn. A
 * longitude within half a turn of the frame's middle is used as it is, so a mesh that does not cross the date line has
 * the numbers it always had. The frame is cut on the meridian opposite its middle: two tiles either side of that
 * meridian are a turn apart in it, half the earth away from the leg. Points come back as longitudes between -180 and
 * 180 (fromXY).
 */

import { unwrapLonNear } from '../../geo/angles';
import { type BBox, bboxUnion, wrapEdge } from '../../geo/geodesy';
import { blockedTriangles, growBlocked, type MeshRules } from './route';
import { type LoadedMesh, M_PER_DEG_MESH, type MeshStore, type MeshTileInfo, tileBBox } from './store';
import { U_TOL } from './width';

/** Index cell size, metres: a few triangles a cell on a chart mesh (triangles are tens of metres). */
export const TILE_INDEX_CELL_M = 250;

/** One tile in memory. Arrays are per local triangle (global id − first). */
export interface PagedTile {
  /** Position in the mesh's tile list (sorted by first id). */
  idx: number;
  first: number;
  n: number;
  /** Corner k of local triangle t at [t * 3 + k], metres in the leg's frame. */
  x: Float64Array;
  y: Float64Array;
  /** Global id of the neighbour across edge k of t (edge k runs from corner k to k + 1), -1 = none. */
  nb: Int32Array;
  /** Index of the shared edge on the neighbour's side. */
  rev: Int8Array;
  mult: Float32Array;
  depth: Float32Array;
  clear: Float32Array;
  hazv: Float32Array;
  flags: Uint8Array;
  /** Blocked by the rules themselves, and with the buffer grown (what the search avoids). */
  ruleBlocked: Uint8Array;
  blocked: Uint8Array;
  /** The tile's vertex extent, degrees [west, south, east, north]. */
  bbox: [number, number, number, number];
  /** Grid over the tile for point lookups (built on first use). */
  grid: { x0: number; y0: number; nx: number; ny: number; offsets: Int32Array; ids: Int32Array } | null;
}

/**
 * What the rough cut (coarse.ts) records of the triangles with an edge on another tile, for one boat: the ones
 * blocked under its draught and air draft (opening bridges as open), and the opening bridges. Global ids, sorted.
 */
export interface BoundarySeeds {
  blocked: Int32Array;
  bridges: Int32Array;
}

function sortedHas(a: Int32Array, g: number): boolean {
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m] === g) return true;
    if (a[m] < g) lo = m + 1;
    else hi = m - 1;
  }
  return false;
}

export interface PagedStats {
  /** Tile reads from disk, re-reads included; distinct tiles; their triangles. */
  reads: number;
  tiles: number;
  triangles: number;
  /** Most triangles held at once. */
  peakTriangles: number;
  /** Triangles blocked by the rules, and more by the buffer, over the distinct tiles read. */
  blocked: number;
  buffered: number;
  readMs: number;
  prepMs: number;
  bufferMs: number;
}

export class PagedMesh {
  private readonly firsts: number[];
  private readonly infos: (MeshTileInfo | null)[];
  private readonly held = new Map<number, PagedTile>();
  private readonly seen = new Set<number>();
  private heldTriangles = 0;
  private last: PagedTile | null = null;
  readonly stats: PagedStats = {
    reads: 0,
    tiles: 0,
    triangles: 0,
    peakTriangles: 0,
    blocked: 0,
    buffered: 0,
    readMs: 0,
    prepMs: 0,
    bufferMs: 0,
  };
  /** The box holding the extents of the tiles read, the short way round (geodesy.ts bboxUnion); null before the first. */
  private touched: BBox | null = null;
  /** The longitude the frame is laid out about (the file's comment); undefined for an in-memory mesh: longitudes as they are. */
  private ref: number | undefined;
  /** A tile that cannot be read again (an in-memory mesh) is never dropped. */
  private readonly droppable: boolean;

  /**
   * A mesh on disk for one leg: `cl` the cosine of the leg's mid-latitude; `boundary` the rough cut's record of the
   * tile-boundary triangles for this boat (coarse.ts), seeds of the buffer across tile edges (absent: the buffer is
   * grown inside each tile only).
   */
  constructor(
    private readonly store: MeshStore | null,
    readonly rules: MeshRules,
    readonly cl: number,
    private readonly boundary: BoundarySeeds | null = null,
    private readonly cellM = TILE_INDEX_CELL_M,
    inMemory?: PagedTile
  ) {
    if (inMemory) {
      this.firsts = [0];
      this.infos = [null];
      this.held.set(0, inMemory);
      this.seen.add(0);
      this.droppable = false;
      this.heldTriangles = inMemory.n;
      this.stats.tiles = 1;
      this.stats.triangles = inMemory.n;
      this.stats.peakTriangles = inMemory.n;
    } else {
      const infos = [...store!.index.tiles].sort((a, b) => a.first - b.first);
      this.firsts = infos.map(t => t.first);
      this.infos = infos;
      this.droppable = true;
      this.ref = store!.midLon;
    }
  }

  /** The longitude the frame is laid out about: the mesh's middle unless centred() set another; undefined in memory. */
  get frameLon(): number | undefined {
    return this.ref;
  }

  /**
   * Lay the frame out about `lon` instead of the mesh's middle, before anything is asked of the mesh: where several
   * meshes are used in one frame (a leg across the limits of the charts, the joins of two meshes), all are centred on
   * the same longitude, so a point has the same place in each. The tiles held, read in the old frame, are let go. An
   * in-memory mesh has no frame of its own and is left as it is.
   */
  centred(lon: number | undefined): this {
    if (!this.store || lon === undefined || lon === this.ref) return this;
    this.retain(() => false);
    this.touched = null;
    this.ref = lon;
    return this;
  }

  /** A longitude next to the frame's middle: the same meridian, within half a turn of it. */
  lonNear(lon: number): number {
    return this.ref === undefined ? lon : unwrapLonNear(lon, this.ref);
  }

  /**
   * How far a tile is turned in the frame from where it is stored (its extent `bbox`), degrees: the whole turns that
   * put its middle next to the frame's middle; 0 for a tile within half a turn of it. The tile's corners and its
   * extent are placed with it, whole, so a tile is never torn.
   */
  tileTurn(bbox: [number, number, number, number]): number {
    const mid = (bbox[0] + bbox[2]) / 2;
    return this.lonNear(mid) - mid;
  }

  /** An in-memory mesh (the tests' synthetic meshes) as one tile that is never dropped, with its blocked set as given. */
  static fromLoaded(m: LoadedMesh, blocked: Uint8Array, cellM = TILE_INDEX_CELL_M): PagedMesh {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let nn = -Infinity;
    for (let k = 0; k < m.n * 3; k++) {
      const lon = m.x[k] / (m.cl * M_PER_DEG_MESH);
      const lat = m.y[k] / M_PER_DEG_MESH;
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      nn = Math.max(nn, lat);
    }
    const tile: PagedTile = {
      idx: 0,
      first: 0,
      n: m.n,
      x: m.x,
      y: m.y,
      nb: m.neighbours,
      rev: m.rev,
      mult: m.mult,
      depth: m.depth,
      clear: m.clear,
      hazv: m.hazv,
      flags: m.flags,
      ruleBlocked: blocked,
      blocked,
      bbox: [w, s, e, nn],
      grid: null,
    };
    return new PagedMesh(null, { draughtM: 0, airDraftM: 0, motorSpeedMs: 1 }, m.cl, null, cellM, tile);
  }

  toXY(lon: number, lat: number): [number, number] {
    return [this.lonNear(lon) * this.cl * M_PER_DEG_MESH, lat * M_PER_DEG_MESH];
  }

  /** Back to degrees: a longitude between -180 and 180. */
  fromXY(x: number, y: number): [number, number] {
    return [wrapEdge(x / (this.cl * M_PER_DEG_MESH)), y / M_PER_DEG_MESH];
  }

  /** Position in the tile list of the tile holding a global id. */
  tileIndexOf(g: number): number {
    const f = this.firsts;
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (f[m] <= g) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** The tile holding a global triangle id, read when not held. */
  tileOf(g: number): PagedTile {
    const L = this.last;
    if (L && g >= L.first && g < L.first + L.n) return L;
    return (this.last = this.tile(this.tileIndexOf(g)));
  }

  /** The tile at a position of the tile list, read when not held. */
  tile(idx: number): PagedTile {
    const held = this.held.get(idx);
    if (held) return held;
    const T = this.read(idx);
    this.held.set(idx, T);
    this.heldTriangles += T.n;
    if (this.heldTriangles > this.stats.peakTriangles) this.stats.peakTriangles = this.heldTriangles;
    return T;
  }

  /** How many tiles the mesh has, and the index entry of one (by position in the tile list); null in memory. */
  get tileCount(): number {
    return this.firsts.length;
  }

  infoAt(idx: number): MeshTileInfo | null {
    return this.infos[idx];
  }

  isHeld(idx: number): boolean {
    return this.held.has(idx);
  }

  /** The positions of the tiles held now. */
  heldTiles(): number[] {
    return [...this.held.keys()];
  }

  /** Let a tile go (read again when asked for). An in-memory mesh keeps its tile. */
  drop(idx: number): void {
    if (!this.droppable) return;
    const T = this.held.get(idx);
    if (!T) return;
    this.held.delete(idx);
    this.heldTriangles -= T.n;
    if (this.last === T) this.last = null;
  }

  /** Keep only the tiles for which `keep` answers true. */
  retain(keep: (T: PagedTile) => boolean): void {
    for (const [idx, T] of [...this.held]) if (!keep(T)) this.drop(idx);
  }

  /**
   * The union of the extents of every tile read so far (the leg's area, for the currents read beside it); its west
   * greater than its east when the tiles read lie either side of the date line.
   */
  touchedBox(): BBox | null {
    return this.touched && { ...this.touched };
  }

  private read(idx: number): PagedTile {
    const info = this.infos[idx];
    if (!info || !this.store) throw new Error(`mesh tile ${idx}: not in memory and no store to read it from`);
    const t0 = Date.now();
    const a = this.store.readTileArrays(info);
    const n = a.n;
    const K = this.store.index.xScale;
    const x = new Float64Array(n * 3);
    const y = new Float64Array(n * 3);
    // The tile whole, turned from where it is stored (tileTurn; not at all for a tile within half a turn of the frame's
    // middle: its longitudes as stored).
    const turn = this.tileTurn(info.bbox);
    const lonOf = turn === 0 ? (q: number): number => a.corners[2 * q] / K : (q: number): number => a.corners[2 * q] / K + turn;
    for (let q = 0; q < n * 3; q++) {
      x[q] = lonOf(q) * this.cl * M_PER_DEG_MESH;
      y[q] = a.corners[2 * q + 1] * M_PER_DEG_MESH;
    }
    const t1 = Date.now();
    // The tile as a mesh of its own (neighbours local, -1 across its edges) for the rules and the buffer, in the
    // tile's own frame (the cosine of its mid-latitude): the blocked set, the buffer's metres and the areas to avoid
    // are then the same whatever leg reads the tile, so the rough cut (coarse.ts) built from these tiles answers
    // exactly for the search.
    const local = new Int32Array(n * 3);
    for (let q = 0; q < n * 3; q++) {
      const l = a.nb[q] - info.first;
      local[q] = a.nb[q] >= 0 && l >= 0 && l < n ? l : -1;
    }
    const clT = Math.cos(((info.bbox[1] + info.bbox[3]) / 2) * (Math.PI / 180));
    let xt = x;
    if (clT !== this.cl) {
      xt = new Float64Array(n * 3);
      for (let q = 0; q < n * 3; q++) xt[q] = lonOf(q) * clT * M_PER_DEG_MESH;
    }
    const m: LoadedMesh = {
      n,
      x: xt,
      y,
      cl: clT,
      ref: this.ref,
      neighbours: local,
      rev: a.rev,
      mult: a.mult,
      depth: a.depth,
      clear: a.clear,
      hazv: a.hazv,
      flags: a.flags,
      tiles: [{ info, offset: 0 }],
    };
    const ruleBlocked = blockedTriangles(m, this.rules);
    const blocked = ruleBlocked.slice();
    const t2 = Date.now();
    let buffered = 0;
    if ((this.rules.bufferM ?? 0) > 0) {
      // Seeds across the tile's edges: usable triangles whose neighbour in the next tile is blocked for this boat
      // (an opening bridge too under Drawbridges = Avoid). An area to avoid in the next tile is not known here:
      // its triangles are judged by their centroids, which only that tile's corners give.
      const outer: number[] = [];
      const B = this.boundary;
      const bridges = this.rules.openingBridges === 'avoid';
      if (B)
        for (let q = 0; q < n * 3; q++) {
          const g = a.nb[q];
          if (local[q] >= 0 || g < 0) continue;
          if (sortedHas(B.blocked, g) || (bridges && sortedHas(B.bridges, g))) outer.push(q);
        }
      buffered = growBlocked(m, blocked, this.rules.bufferM!, outer);
    }
    const t3 = Date.now();
    this.stats.reads++;
    this.stats.readMs += t1 - t0;
    this.stats.prepMs += t2 - t1;
    this.stats.bufferMs += t3 - t2;
    if (!this.seen.has(idx)) {
      this.seen.add(idx);
      this.stats.tiles++;
      this.stats.triangles += n;
      let b = 0;
      for (let t = 0; t < n; t++) b += ruleBlocked[t];
      this.stats.blocked += b;
      this.stats.buffered += buffered;
      // The box of the tiles read: the narrowest that holds the one so far and this tile's extent, round the earth (not
      // the least and greatest longitude in the frame, which for tiles either side of the frame's cut is a whole turn).
      this.touched = this.touched ? bboxUnion(this.touched, tileBBox(info.bbox)) : tileBBox(info.bbox);
    }
    return {
      idx,
      first: info.first,
      n,
      x,
      y,
      nb: a.nb,
      rev: a.rev,
      mult: a.mult,
      depth: a.depth,
      clear: a.clear,
      hazv: a.hazv,
      flags: a.flags,
      ruleBlocked,
      blocked,
      bbox: info.bbox,
      grid: null,
    };
  }

  /** The grid over a tile's triangles (each cell lists the triangles whose bounding box meets it). */
  private gridOf(T: PagedTile): NonNullable<PagedTile['grid']> {
    if (T.grid) return T.grid;
    const { x, y, n } = T;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < n * 3; k++) {
      if (x[k] < x0) x0 = x[k];
      if (x[k] > x1) x1 = x[k];
      if (y[k] < y0) y0 = y[k];
      if (y[k] > y1) y1 = y[k];
    }
    if (n === 0) x0 = y0 = x1 = y1 = 0;
    const c = this.cellM;
    const nx = Math.max(1, Math.ceil((x1 - x0) / c) + 1);
    const ny = Math.max(1, Math.ceil((y1 - y0) / c) + 1);
    const col = (px: number): number => Math.min(nx - 1, Math.max(0, Math.floor((px - x0) / c)));
    const row = (py: number): number => Math.min(ny - 1, Math.max(0, Math.floor((py - y0) / c)));
    const offsets = new Int32Array(nx * ny + 1);
    const span = (t: number): [number, number, number, number] => {
      const a = t * 3;
      return [
        col(Math.min(x[a], x[a + 1], x[a + 2])),
        col(Math.max(x[a], x[a + 1], x[a + 2])),
        row(Math.min(y[a], y[a + 1], y[a + 2])),
        row(Math.max(y[a], y[a + 1], y[a + 2])),
      ];
    };
    for (let t = 0; t < n; t++) {
      const [i0, i1, j0, j1] = span(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) offsets[j * nx + i + 1]++;
    }
    for (let k = 0; k < nx * ny; k++) offsets[k + 1] += offsets[k];
    const ids = new Int32Array(offsets[nx * ny]);
    const fill = new Int32Array(nx * ny);
    for (let t = 0; t < n; t++) {
      const [i0, i1, j0, j1] = span(t);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cc = j * nx + i;
          ids[offsets[cc] + fill[cc]++] = t;
        }
    }
    T.grid = { x0, y0, nx, ny, offsets, ids };
    return T.grid;
  }

  /** Bytes of the grids held (for the log). */
  indexBytes(): number {
    let b = 0;
    for (const T of this.held.values()) if (T.grid) b += T.grid.offsets.byteLength + T.grid.ids.byteLength;
    return b;
  }

  /** The triangle of a tile holding (px, py), local id or -1; with preferUsable a usable one wins over a blocked one. */
  private locateIn(T: PagedTile, px: number, py: number, preferUsable: boolean, all?: number[]): number {
    const G = this.gridOf(T);
    // Clamped to the grid: a point handed on as lon/lat can come back a hair outside the tile's vertex extent, west or
    // south of the grid's origin (an exit on a straight chart limit, through a frame with another cosine); the
    // triangle test below, with its tolerance, decides (PR #39 review: the cell was -1 and the point lost first).
    const i = Math.min(G.nx - 1, Math.max(0, Math.floor((px - G.x0) / this.cellM)));
    const j = Math.min(G.ny - 1, Math.max(0, Math.floor((py - G.y0) / this.cellM)));
    const c = j * G.nx + i;
    const { x, y } = T;
    let found = -1;
    for (let k = G.offsets[c]; k < G.offsets[c + 1]; k++) {
      const t = G.ids[k];
      const a = t * 3;
      const ax = x[a];
      const ay = y[a];
      const bx = x[a + 1];
      const by = y[a + 1];
      const cx = x[a + 2];
      const cy = y[a + 2];
      // Inside, or on its boundary within the walk's tolerance (width.ts U_TOL of its longest edge): a point handed on
      // as lon/lat (a snapped stop, a route corner) comes back a hair off the edge it lies on, and on an edge
      // between usable and blocked water it belongs to the usable side (preferUsable), as a walk along it does.
      const lab = Math.hypot(bx - ax, by - ay);
      const lbc = Math.hypot(cx - bx, cy - by);
      const lca = Math.hypot(ax - cx, ay - cy);
      const tol = U_TOL * Math.max(lab, lbc, lca);
      if (
        px < Math.min(ax, bx, cx) - tol ||
        px > Math.max(ax, bx, cx) + tol ||
        py < Math.min(ay, by, cy) - tol ||
        py > Math.max(ay, by, cy) + tol
      )
        continue;
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      // d1 is the point's distance from edge ab (positive inside) times the edge's length; likewise d2, d3.
      if (d1 >= -tol * lab && d2 >= -tol * lbc && d3 >= -tol * lca) {
        if (all) {
          all.push(t);
          continue;
        }
        if (!preferUsable || !T.blocked[t]) return t;
        if (found < 0) found = t;
      }
    }
    return found;
  }

  /** Per index cell, the tiles (positions in the tile list) whose vertex extent, within nearExtent's tolerance, meets it. */
  private cellTiles: Map<string, number[]> | null = null;

  /**
   * The tiles whose vertex extent holds a point (nearExtent), from the index alone: the point's own cell's tile first,
   * then its eight neighbours' in a fixed order, then any other in tile-list order. A tile's triangles reach past its
   * cell, offshore by tens of kilometres: 07CGD's tile (4, 42) holds a triangle about 40 km across that covers a point
   * in cell (2, 43), two cells away (measured on brain, 2026-10-13), which a search of the 3 x 3 cells round the point
   * never saw.
   */
  private tilesAt(lon: number, lat: number): number[] {
    const store = this.store!;
    if (!this.cellTiles) {
      const cells = new Map<string, number[]>();
      this.infos.forEach((info, idx) => {
        const b = info!.bbox;
        const tx = U_TOL * (b[2] - b[0]);
        const ty = U_TOL * (b[3] - b[1]);
        // The extent's columns as one run from its west (store.ts columnsOf); its rows from south to north.
        const [, j0] = store.tileIJ(b[0], b[1] - ty);
        const [, j1] = store.tileIJ(b[0], b[3] + ty);
        for (const i of store.columnsOf(b[0] - tx, b[2] - b[0] + 2 * tx))
          for (let j = j0; j <= j1; j++) {
            const k = `${i},${j}`;
            const list = cells.get(k);
            if (list) list.push(idx);
            else cells.set(k, [idx]);
          }
      });
      this.cellTiles = cells;
    }
    const [i, j] = store.tileIJ(lon, lat);
    const near = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    const rank = (idx: number): number => {
      const info = this.infos[idx]!;
      const k = near.findIndex(([di, dj]) => info.i === i + di && info.j === j + dj);
      return k >= 0 ? k : near.length + idx;
    };
    return (this.cellTiles.get(`${i},${j}`) ?? [])
      .filter(idx => nearExtent(this.infos[idx]!, this.lonNear(lon), lat, this.tileTurn(this.infos[idx]!.bbox)))
      .sort((a, b) => rank(a) - rank(b));
  }

  /**
   * The triangle holding a point of the metres frame, global id or -1, searched in every tile whose vertex extent
   * holds the point (tilesAt), the point's own tile first. Corners wind counter-clockwise; a point on a shared edge or
   * corner counts for the first triangle met, unless `preferUsable`: then a usable triangle holding the point wins
   * over a blocked one (a route corner on a depth contour belongs to the water the route uses).
   */
  locate(px: number, py: number, preferUsable = false): number {
    if (!this.store) {
      const T = this.held.get(0)!;
      const t = this.locateIn(T, px, py, preferUsable);
      return t < 0 ? -1 : t;
    }
    const [lon, lat] = this.fromXY(px, py);
    let fallback = -1;
    for (const idx of this.tilesAt(lon, lat)) {
      const T = this.tile(idx);
      const t = this.locateIn(T, px, py, preferUsable);
      if (t < 0) continue;
      if (!preferUsable || !T.blocked[t]) return T.first + t;
      if (fallback < 0) fallback = T.first + t;
    }
    return fallback;
  }

  /**
   * The usable water nearest a point of the metres frame (docs/drafts/mesh-no-gshhg-design.md, part 3): the triangle
   * not blocked for the search (rules and buffer), and accepted by `accept` (the rough cut: water connected to the
   * leg's start), whose nearest point is closest, that point, and its distance in metres; null when there is none.
   * The point's own triangle first; otherwise the tiles are read in order of the distance to their extent and the
   * scan stops at the first tile farther than the best found, so the answer is exact with no distance limit (the
   * mesh's edge is the limit).
   */
  nearestUsable(
    px: number,
    py: number,
    accept: (g: number) => boolean = () => true
  ): { tri: number; x: number; y: number; distM: number } | null {
    const own = this.locate(px, py, true);
    if (own >= 0 && !this.isBlocked(own) && accept(own)) return { tri: own, x: px, y: py, distM: 0 };
    const order: { idx: number; d: number }[] = [];
    if (!this.store) order.push({ idx: 0, d: 0 });
    else
      for (let idx = 0; idx < this.infos.length; idx++) {
        // The point of the tile's extent nearest the point, both next to the frame's middle (a tile east of the date
        // line is stored from -180).
        const b = this.infos[idx]!.bbox;
        const lon = px / (this.cl * M_PER_DEG_MESH);
        const lat = py / M_PER_DEG_MESH;
        const turn = this.tileTurn(b);
        const cx = Math.min(Math.max(lon, b[0] + turn), b[2] + turn) * this.cl * M_PER_DEG_MESH;
        const cy = Math.min(Math.max(lat, b[1]), b[3]) * M_PER_DEG_MESH;
        order.push({ idx, d: Math.hypot(cx - px, cy - py) });
      }
    order.sort((u, v) => u.d - v.d);
    let best: { tri: number; x: number; y: number; distM: number } | null = null;
    // The tiles this scan reads are let go once checked, but for the one holding the best answer so far (PR #39 review:
    // with a filter the nearest accepted water can be far or absent, and every tile read stayed held, up to the whole
    // mesh). Tiles held before the scan stay as they were.
    let bestTile = -1;
    for (const o of order) {
      if (best && o.d >= best.distM) break;
      const wasHeld = this.isHeld(o.idx);
      const T = this.tile(o.idx);
      let improved = false;
      for (let l = 0; l < T.n; l++) {
        if (T.blocked[l]) continue;
        const [qx, qy] = closestOnTriangle(px, py, T.x, T.y, l * 3);
        const d = Math.hypot(qx - px, qy - py);
        if ((!best || d < best.distM) && accept(T.first + l)) {
          best = { tri: T.first + l, x: qx, y: qy, distM: d };
          improved = true;
        }
      }
      if (improved) {
        if (bestTile >= 0 && bestTile !== o.idx) this.drop(bestTile);
        bestTile = wasHeld ? -1 : o.idx;
      } else if (!wasHeld) this.drop(o.idx);
    }
    return best;
  }

  /**
   * Every usable triangle holding a point of the metres frame (global ids, within the walk's tolerance), across every
   * tile whose vertex extent holds the point (tilesAt). A point on a corner or an edge belongs to each triangle it touches: a stop or a route corner
   * handed on as lon/lat may touch water of two connected groups at one corner (part 2: a snapped waypoint at
   * 41.3297, -70.4388 touched the route's water and a separate pocket), and the caller decides by the water it needs.
   */
  locateAll(px: number, py: number): number[] {
    const out: number[] = [];
    const collect = (T: PagedTile): void => {
      const local: number[] = [];
      this.locateIn(T, px, py, false, local);
      for (const l of local) if (!T.blocked[l] && !out.includes(T.first + l)) out.push(T.first + l);
    };
    if (!this.store) {
      collect(this.held.get(0)!);
      return out;
    }
    const [lon, lat] = this.fromXY(px, py);
    for (const idx of this.tilesAt(lon, lat)) collect(this.tile(idx));
    return out;
  }

  /** Blocked for the search (rules and buffer)? */
  isBlocked(g: number): boolean {
    const T = this.tileOf(g);
    return T.blocked[g - T.first] === 1;
  }
}

/** The point of triangle (x, y at a, a + 1, a + 2) nearest (px, py): inside it, or on its nearest side. */
function closestOnTriangle(px: number, py: number, x: Float64Array, y: Float64Array, a: number): [number, number] {
  const ax = x[a];
  const ay = y[a];
  const bx = x[a + 1];
  const by = y[a + 1];
  const cx = x[a + 2];
  const cy = y[a + 2];
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  if (d1 >= 0 && d2 >= 0 && d3 >= 0) return [px, py];
  let best: [number, number] = [ax, ay];
  let bd = Infinity;
  for (const [ux, uy, vx, vy] of [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay],
  ]) {
    const ex = vx - ux;
    const ey = vy - uy;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ux) * ex + (py - uy) * ey) / l2)) : 0;
    const qx = ux + t * ex;
    const qy = uy + t * ey;
    const d = (qx - px) * (qx - px) + (qy - py) * (qy - py);
    if (d < bd) {
      bd = d;
      best = [qx, qy];
    }
  }
  return best;
}

/**
 * Is the point inside a tile's vertex extent, within the walk's tolerance (width.ts U_TOL) of its size? A point on
 * the tile's outer edge comes back from the metres frame a hair outside it (3.0000000000000004 against 3). `lon` is
 * next to the frame's middle (PagedMesh.lonNear), and the tile's extent is taken `turn` on (PagedMesh.tileTurn): a tile
 * east of the date line is stored from -180, and a point on the date line is 180 or -180.
 */
function nearExtent(info: MeshTileInfo, lon: number, lat: number, turn: number): boolean {
  const b = info.bbox;
  const tx = U_TOL * (b[2] - b[0]);
  const ty = U_TOL * (b[3] - b[1]);
  return lon >= b[0] + turn - tx && lat >= b[1] - ty && lon <= b[2] + turn + tx && lat <= b[3] + ty;
}
