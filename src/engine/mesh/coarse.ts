/**
 * The rough cut of a chart mesh for one boat (docs/drafts/mesh-no-gshhg-design.md, parts 3 and 4): the water the
 * boat can use, as pieces joined across tile edges. A piece is a set of usable triangles connected inside one 0.25°
 * tile; two pieces are linked where a usable triangle of one shares an edge with a usable triangle of the other in
 * the next tile.
 *
 * "Usable" is exactly what the mesh search uses: each tile is read through the paged mesh (paged.ts), so its blocked
 * set is the search's (route.ts blockedTriangles under the boat's draught, air draft and Drawbridges choice, then the
 * buffer from unusable water grown in the tile's own frame, seeded across its edges from the boundary record). The
 * rough cut's "connected" is therefore the search's: a search started on it has water to reach. Areas to avoid,
 * being per request, cannot be built in; they are applied exactly at the time of the request (PieceGraph: the tiles
 * an area touches are recomputed under the request's rules).
 *
 * What it is for:
 *  - whether water connects a leg's points for this boat, answered before the mesh search (which reads tiles as it
 *    reaches them and would otherwise read every tile it can reach before saying no);
 *  - for an approximate waypoint on water the boat cannot use, the nearest usable water connected to the leg's start;
 *  - the extent of that water (the reach), for the forecast and currents the worker loads before the mesh process;
 *  - the triangles with an edge on another tile that the rules block, and the opening bridges among them
 *    (BoundarySeeds): the buffer grown in a tile as it is read starts from them across its edges.
 *
 * Pieces are numbered tile by tile, in index order, and inside a tile in the order of their first triangle, so the
 * piece of a triangle is found again from its own tile alone.
 */

import { haversineDistanceM, type BBox } from '../../geo/geodesy';
import { MinHeap } from '../heap';
import type { BoundarySeeds, PagedMesh, PagedTile } from './paged';
import { blockedTriangles, type MeshRules } from './route';
import { FLAG_OPENING_BRIDGE, type MeshStore } from './store';

// 4: the rules carry the under-keel and overhead clearances.
// 5: the rules are to the centimetre (meshcoarse.ts coarseRulesOf), as the file name; a v4 file may hold more digits.
// 6: the boundary record uses the rules' clearances (boundarySeeds); v5 used the fixed 0.5 m / 1 m there.
// 7: tiles without chart data are left out of the mesh (store.ts MeshStore.open): the pieces, links, boundary record
//    and joins (named after the map) of a v6 cut include them.
export const COARSE_VERSION = 7;

/** The rules a rough cut is built for: the boat, the buffer from unusable water, and opening bridges open or avoided. */
export interface CoarseRules {
  draughtM: number;
  airDraftM: number;
  underKeelClearanceM: number;
  overheadClearanceM: number;
  bufferM: number;
  openingBridges: 'open' | 'avoid';
}

export interface CoarseMap {
  version: number;
  /** The rules it was built for. */
  draughtM: number;
  airDraftM: number;
  underKeelClearanceM: number;
  overheadClearanceM: number;
  bufferM: number;
  openingBridges: 'open' | 'avoid';
  /** The mesh index's triangle count, to tell a map of another build. */
  triangles: number;
  /** Per tile with pieces: [i, j, first piece, piece count]. */
  tiles: [number, number, number, number][];
  /** Per piece: [lon, lat] of its centre (mean of its triangles' centroids) and its triangle count. */
  pieces: [number, number, number][];
  /** Links between pieces, each once (a < b). */
  links: [number, number][];
}

/** The mesh search's rules for a rough cut's (motor speed plays no part in what is blocked). */
export function meshRulesOf(rules: CoarseRules, avoid?: MeshRules['avoid']): MeshRules {
  return {
    draughtM: rules.draughtM,
    airDraftM: rules.airDraftM,
    underKeelClearanceM: rules.underKeelClearanceM,
    overheadClearanceM: rules.overheadClearanceM,
    motorSpeedMs: 1,
    bufferM: rules.bufferM,
    openingBridges: rules.openingBridges,
    ...(avoid?.length ? { avoid } : {}),
  };
}

/** The usable triangles of a paged tile grouped into pieces: the piece of each (-1 = blocked), in first-triangle order. */
export function tilePieces(T: PagedTile): { pieceOf: Int32Array; count: number } {
  const n = T.n;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let a = 0; a < n; a++) {
    if (T.blocked[a]) continue;
    for (let k = 0; k < 3; k++) {
      const g = T.nb[a * 3 + k];
      const b = g - T.first;
      if (g < 0 || b < 0 || b >= n || T.blocked[b]) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const pieceOf = new Int32Array(n).fill(-1);
  const idOfRoot = new Map<number, number>();
  let count = 0;
  for (let a = 0; a < n; a++) {
    if (T.blocked[a]) continue;
    const r = find(a);
    let id = idOfRoot.get(r);
    if (id === undefined) {
      id = count++;
      idOfRoot.set(r, id);
    }
    pieceOf[a] = id;
  }
  return { pieceOf, count };
}

/**
 * The tile-boundary record for the rules: triangles with an edge on another tile that the rules block (opening
 * bridges as open, no areas to avoid, no buffer), and the opening bridges among them. Global ids, ascending.
 */
export function boundarySeeds(store: MeshStore, rules: CoarseRules): BoundarySeeds {
  const blocked: number[] = [];
  const bridges: number[] = [];
  for (const info of [...store.index.tiles].sort((a, b) => a.first - b.first)) {
    const t = store.readTileArrays(info);
    // The rough cut's rules, clearances included (before version 6 the fixed 0.5 m / 1 m were used here, so the
    // record disagreed with the map and its name for any other clearance); opening bridges as open.
    const b = blockedTriangles(
      { n: t.n, flags: t.flags, depth: t.depth, clear: t.clear, hazv: t.hazv } as Parameters<typeof blockedTriangles>[0],
      {
        draughtM: rules.draughtM,
        airDraftM: rules.airDraftM,
        underKeelClearanceM: rules.underKeelClearanceM,
        overheadClearanceM: rules.overheadClearanceM,
        motorSpeedMs: 1,
        openingBridges: 'open',
      }
    );
    for (let a = 0; a < t.n; a++) {
      let outer = false;
      for (let k = 0; k < 3 && !outer; k++) {
        const g = t.nb[a * 3 + k];
        const l = g - info.first;
        outer = g >= 0 && (l < 0 || l >= t.n);
      }
      if (!outer) continue;
      if (b[a]) blocked.push(info.first + a);
      if (t.flags[a] & FLAG_OPENING_BRIDGE) bridges.push(info.first + a);
    }
  }
  return { blocked: Int32Array.from(blocked), bridges: Int32Array.from(bridges) };
}

/** A tile's pieces' centres ([lon, lat]) and triangle counts. */
function pieceCentres(pm: PagedMesh, T: PagedTile, pieceOf: Int32Array, count: number): [number, number, number][] {
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const sn = new Int32Array(count);
  for (let a = 0; a < T.n; a++) {
    const p = pieceOf[a];
    if (p < 0) continue;
    sx[p] += (T.x[a * 3] + T.x[a * 3 + 1] + T.x[a * 3 + 2]) / 3;
    sy[p] += (T.y[a * 3] + T.y[a * 3 + 1] + T.y[a * 3 + 2]) / 3;
    sn[p]++;
  }
  const out: [number, number, number][] = [];
  for (let p = 0; p < count; p++) {
    const [lon, lat] = pm.fromXY(sx[p] / sn[p], sy[p] / sn[p]);
    out.push([lon, lat, sn[p]]);
  }
  return out;
}

/**
 * Build the rough cut of one mesh for the rules (`pm`: the mesh read through the paged mesh under meshRulesOf(rules)
 * with the boundary record). Reads every tile once, one at a time; holds one piece id per triangle of the mesh.
 */
export function buildCoarseMap(
  store: MeshStore,
  rules: CoarseRules,
  pm: PagedMesh,
  /** Each tile as it is read, with its pieces (local numbers), before it is let go (the joins to other meshes, joins.ts). */
  onTile?: (idx: number, T: PagedTile, pieceOf: Int32Array) => void
): CoarseMap {
  const ix = store.index;
  const total = ix.tiles.reduce((m, t) => Math.max(m, t.first + t.n), 0);
  const pieceOfGlobal = new Int32Array(total).fill(-1);
  const tiles: CoarseMap['tiles'] = [];
  const pieces: CoarseMap['pieces'] = [];
  // Edges that leave a tile from a usable triangle, as (global triangle, global neighbour), resolved at the end.
  let cross = new Int32Array(1 << 20);
  let nc = 0;
  for (let idx = 0; idx < pm.tileCount; idx++) {
    const info = pm.infoAt(idx)!;
    const T = pm.tile(idx);
    const { pieceOf, count } = tilePieces(T);
    if (count) {
      const base = pieces.length;
      tiles.push([info.i, info.j, base, count]);
      pieces.push(...pieceCentres(pm, T, pieceOf, count));
      for (let a = 0; a < T.n; a++) {
        if (pieceOf[a] < 0) continue;
        pieceOfGlobal[T.first + a] = base + pieceOf[a];
        for (let k = 0; k < 3; k++) {
          const g = T.nb[a * 3 + k];
          const b = g - T.first;
          if (g < 0 || (b >= 0 && b < T.n)) continue;
          if (nc + 2 > cross.length) {
            const grown = new Int32Array(cross.length * 2);
            grown.set(cross);
            cross = grown;
          }
          cross[nc++] = T.first + a;
          cross[nc++] = g;
        }
      }
    }
    onTile?.(idx, T, pieceOf);
    pm.drop(idx);
  }
  const seen = new Set<string>();
  const links: CoarseMap['links'] = [];
  for (let q = 0; q < nc; q += 2) {
    const a = pieceOfGlobal[cross[q]];
    const b = pieceOfGlobal[cross[q + 1]];
    if (a < 0 || b < 0 || a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo},${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([lo, hi]);
  }
  return {
    version: COARSE_VERSION,
    draughtM: rules.draughtM,
    airDraftM: rules.airDraftM,
    underKeelClearanceM: rules.underKeelClearanceM,
    overheadClearanceM: rules.overheadClearanceM,
    bufferM: rules.bufferM,
    openingBridges: rules.openingBridges,
    triangles: ix.triangles,
    tiles,
    pieces,
    links,
  };
}

/** The shortest chain of pieces from one to the other (A* on the distance between centres), or null when none. */
export function coarseRoute(g: { pieces: [number, number, number][]; adj: number[][] }, from: number, to: number): number[] | null {
  const n = g.pieces.length;
  const d = (a: number, b: number): number => haversineDistanceM(g.pieces[a][0], g.pieces[a][1], g.pieces[b][0], g.pieces[b][1]);
  const gs = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  gs[from] = 0;
  heap.push(d(from, to), from);
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === to) break;
    for (const nb of g.adj[c]) {
      const gg = gs[c] + d(c, nb);
      if (gg < gs[nb]) {
        gs[nb] = gg;
        came[nb] = c;
        heap.push(gg + d(nb, to), nb);
      }
    }
  }
  if (!Number.isFinite(gs[to])) return null;
  const chain: number[] = [];
  for (let c = to; c >= 0; c = came[c]) chain.push(c);
  return chain.reverse();
}

/** A leg's reach: the tiles of its chains of pieces, the box they span, the chains' length. */
export interface Reach {
  chainTiles: number;
  /** The box of the chains' tiles (their vertex extents). */
  box: BBox;
  /** The chains' length between piece centres, metres. */
  lengthM: number;
}

/**
 * The rough cut as one request sees it: the stored pieces, with the tiles an area to avoid touches recomputed under
 * the request's rules (`pm`: the paged mesh under meshRulesOf(the map's rules, the request's areas to avoid), with
 * the boundary record). Pieces of other tiles keep their stored numbers; a recomputed tile's pieces are numbered
 * after the stored ones. Every tile's pieces come from the same read as the search's, so "connected" here is
 * "connected" there.
 */
export class PieceGraph {
  readonly pieces: [number, number, number][];
  readonly adj: number[][];
  /** Per tile position: its first piece number (stored, or after the stored ones for a recomputed tile) and count. */
  private readonly base = new Map<number, [number, number]>();
  /** Per piece: the tile position it lies in. */
  private readonly tileOfPiece: number[] = [];
  /** Per tile position read: the piece of each of its triangles (-1 = blocked), local numbers. */
  private readonly local = new Map<number, Int32Array>();
  /** The tiles recomputed under the request's areas to avoid: their pieces are numbered anew, not as stored. */
  readonly recomputed = new Set<number>();
  private comp: Int32Array | null = null;

  constructor(
    map: CoarseMap,
    private readonly pm: PagedMesh
  ) {
    const stored = new Map(map.tiles.map(t => [`${t[0]},${t[1]}`, t]));
    for (let idx = 0; idx < pm.tileCount; idx++) {
      const info = pm.infoAt(idx)!;
      const e = stored.get(`${info.i},${info.j}`);
      if (!e) continue;
      this.base.set(idx, [e[2], e[3]]);
      for (let p = 0; p < e[3]; p++) this.tileOfPiece[e[2] + p] = idx;
    }
    this.pieces = map.pieces.map(p => [p[0], p[1], p[2]]);
    const links = new Map<string, [number, number]>(map.links.map(l => [`${l[0]},${l[1]}`, l]));
    // Tiles an area to avoid can touch: any whose extent comes within the area's radius of its centre.
    const avoid = pm.rules.avoid ?? [];
    const recomputed: number[] = [];
    for (let idx = 0; idx < pm.tileCount && avoid.length; idx++) {
      const b = pm.infoAt(idx)!.bbox;
      const touched = avoid.some(a => {
        const lon = Math.min(Math.max(a.lon, b[0]), b[2]);
        const lat = Math.min(Math.max(a.lat, b[1]), b[3]);
        return haversineDistanceM(a.lon, a.lat, lon, lat) <= a.radiusM;
      });
      if (!touched) continue;
      // Its stored pieces go with their links; its pieces under the request's rules are added after the others.
      const old = this.base.get(idx);
      if (old)
        for (const [k, l] of [...links])
          if ((l[0] >= old[0] && l[0] < old[0] + old[1]) || (l[1] >= old[0] && l[1] < old[0] + old[1])) links.delete(k);
      const T = pm.tile(idx);
      const { pieceOf, count } = tilePieces(T);
      const first = this.pieces.length;
      this.base.set(idx, [first, count]);
      this.local.set(idx, pieceOf);
      this.pieces.push(...pieceCentres(pm, T, pieceOf, count));
      for (let p = 0; p < count; p++) this.tileOfPiece[first + p] = idx;
      recomputed.push(idx);
      this.recomputed.add(idx);
    }
    // The recomputed tiles' links to their neighbours, from their own tile-edge triangles.
    for (const idx of recomputed) {
      const T = pm.tile(idx);
      for (let a = 0; a < T.n; a++) {
        if (T.blocked[a]) continue;
        for (let k = 0; k < 3; k++) {
          const g = T.nb[a * 3 + k];
          const l = g - T.first;
          if (g < 0 || (l >= 0 && l < T.n) || pm.isBlocked(g)) continue;
          const pa = this.pieceOf(T.first + a)!;
          const pb = this.pieceOf(g);
          if (pb === null || pa === pb) continue;
          const lo = Math.min(pa, pb);
          const hi = Math.max(pa, pb);
          links.set(`${lo},${hi}`, [lo, hi]);
        }
      }
    }
    this.adj = Array.from({ length: this.pieces.length }, () => []);
    for (const [a, b] of links.values()) {
      this.adj[a].push(b);
      this.adj[b].push(a);
    }
  }

  /** The piece of a triangle (global id), or null when it is blocked. */
  pieceOf(g: number): number | null {
    const T = this.pm.tileOf(g);
    let pieceOf = this.local.get(T.idx);
    if (!pieceOf) {
      const tp = tilePieces(T);
      // A tile read under the rules the rough cut was built for has its stored pieces: another count is a rough cut
      // of other rules or another build.
      if (tp.count !== (this.base.get(T.idx)?.[1] ?? 0))
        throw new Error('the rough cut on disk does not match the mesh under these rules; rebuild it in the plugin configuration');
      pieceOf = tp.pieceOf;
      this.local.set(T.idx, pieceOf);
    }
    const p = pieceOf[g - T.first];
    return p < 0 ? null : this.base.get(T.idx)![0] + p;
  }

  /**
   * The piece numbered `local` in a tile as stored (the build's numbering, as joins files record it), or null when the
   * tile has no stored pieces or was recomputed under the request's areas to avoid.
   */
  storedPiece(idx: number, local: number): number | null {
    if (this.recomputed.has(idx)) return null;
    const b = this.base.get(idx);
    return b && local >= 0 && local < b[1] ? b[0] + local : null;
  }

  /** The connected group of a piece (pieces linked directly or through others share one). */
  component(p: number): number {
    if (!this.comp) {
      const c = new Int32Array(this.pieces.length).fill(-1);
      let n = 0;
      for (let s = 0; s < c.length; s++) {
        if (c[s] >= 0) continue;
        const stack = [s];
        c[s] = n;
        while (stack.length) {
          const u = stack.pop()!;
          for (const v of this.adj[u])
            if (c[v] < 0) {
              c[v] = n;
              stack.push(v);
            }
        }
        n++;
      }
      this.comp = c;
    }
    return this.comp[p];
  }

  /** The tiles (positions in the mesh's tile list) holding a piece of any of these connected groups; no tile is read. */
  tilesOf(groups: number[]): Set<number> {
    const out = new Set<number>();
    for (let p = 0; p < this.pieces.length; p++) if (groups.includes(this.component(p))) out.add(this.tileOfPiece[p]);
    return out;
  }

  /** The reach of chains of pieces: their tiles, the box of those tiles' extents, their length. */
  reach(chains: number[][]): Reach {
    const tiles = new Set<number>();
    const box: BBox = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    let lengthM = 0;
    for (const chain of chains) {
      for (const p of chain) {
        const idx = this.tileOfPiece[p];
        if (tiles.has(idx)) continue;
        tiles.add(idx);
        const b = this.pm.infoAt(idx)!.bbox;
        box.west = Math.min(box.west, b[0]);
        box.south = Math.min(box.south, b[1]);
        box.east = Math.max(box.east, b[2]);
        box.north = Math.max(box.north, b[3]);
      }
      for (let k = 1; k < chain.length; k++) {
        const a = this.pieces[chain[k - 1]];
        const b = this.pieces[chain[k]];
        lengthM += haversineDistanceM(a[0], a[1], b[0], b[1]);
      }
    }
    return { chainTiles: tiles.size, box, lengthM };
  }
}
