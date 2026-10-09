/**
 * One leg on the navigation mesh: read the tiles of the box around the
 * leg, mark the triangles the boat cannot use, search (astar.ts) and pull
 * the string through the crossed edges (funnel.ts). Motor only: the cost
 * is distance with the mesh's shore and depth penalties over the motor
 * speed; no wind or current. The experiment's mesh_route5.py with
 * RULES=full, ported; the parity test against its saved results is in
 * the experiment folder (not this repo).
 *
 * Blocked triangles (the parent planner's rules, plus the three the grid
 * planner does not check before routing):
 *  - a charted vertical clearance under the air draft + 1 m (an opening
 *    bridge's open clearance; the bridge is blocked outright when the
 *    route's rule for opening bridges is 'avoid');
 *  - a charted depth under the draught + 0.5 m, unless the triangle is in
 *    a fairway, dredged area or recommended track (is_navigable);
 *  - a rock, wreck or obstruction whose charted depth (VALSOU) is under
 *    the draught + 0.5 m, or not charted (hazv = -1e9 in the build);
 *  - a mark (20 m standoff in the build), except a channel mark inside a
 *    fairway or dredged area;
 *  - a structure (pier, bridge pier, …);
 *  - an area to avoid (Signal K notes): the triangle's centroid inside it.
 */

import { haversineDistanceM, type BBox } from '../../geo/geodesy';
import { MinHeap } from '../heap';
import { meshAstar } from './astar';
import { funnel, type XY } from './funnel';
import { passageWidths } from './width';
import {
  FLAG_CHANNEL_MARK,
  FLAG_DREDGED,
  FLAG_FAIRWAY,
  FLAG_HAZARD,
  FLAG_MARK,
  FLAG_NAVIGABLE,
  FLAG_OPENING_BRIDGE,
  FLAG_STRUCTURE,
  fromMeshXY,
  type LoadedMesh,
  locate,
  type MeshStore,
  NO_VALUE,
  toMeshXY,
} from './store';

/** How a route treats opening bridges: ask (plan as open, report the ones crossed), open, or avoid them. */
export const DRAWBRIDGE_CHOICES = ['ask', 'open', 'avoid'] as const;
export type DrawbridgeChoice = (typeof DRAWBRIDGE_CHOICES)[number];

export interface MeshRules {
  draughtM: number;
  airDraftM: number;
  motorSpeedMs: number;
  /** Opening bridges: 'open' (default) passes them under their open clearance; 'avoid' blocks every one. */
  openingBridges?: 'open' | 'avoid';
  /** Areas to avoid: triangles whose centroid lies within radiusM of the centre are blocked. */
  avoid?: { lon: number; lat: number; radiusM: number }[];
  /** The most triangles a widened box may read (default MESH_MAX_TRIANGLES). */
  maxTriangles?: number;
  /** Keep at least this far from every blocked triangle: usable triangles within it are blocked too (0 or absent: none). */
  bufferM?: number;
}

export interface MeshRouteStats {
  /** Of the last box read. */
  trianglesLoaded: number;
  blocked: number;
  expanded: number;
  /** Summed over the boxes tried. */
  readMs: number;
  prepMs: number;
  searchMs: number;
  funnelMs: number;
  /** The pad around the leg's ends of the last box tried, degrees, and how many boxes were tried. */
  padDeg: number;
  attempts: number;
  /** The buffer applied (metres), the usable triangles it blocked, and its time. */
  bufferM: number;
  buffered: number;
  bufferMs: number;
}

export type MeshRouteResult =
  | {
      ok: true;
      path: [number, number][];
      /** Per path point: water to the left and to the right of the track, metres, capped at width.ts MAX_SCAN_M. */
      widths: [number, number][];
      lengthM: number;
      costS: number;
      stats: MeshRouteStats;
    }
  | { ok: false; reason: string; stats: MeshRouteStats };

/**
 * Degrees added around the leg's ends for the tiles read: the first is the
 * experiment's (mesh_route5.py, the parent's pad_lon); when the search
 * finds no route the box is widened to the next and searched again, as a
 * route that must swing further out than the box around its ends is
 * otherwise a silent "no route" (2026-10-08, job aeedeb52: Block Island
 * to the canal's east end, the way round Nauset at 69.91°W just outside
 * a box ending at 69.96°W). Widening stops before a box that would read
 * more than MESH_MAX_TRIANGLES.
 */
export const MESH_BOX_PADS_DEG = [0.5, 1.0, 2.0];
export const MESH_BOX_PAD_DEG = MESH_BOX_PADS_DEG[0];
/** The widest box the mesh search can use: what the worker loads currents for before the mesh process starts. */
export const MESH_BOX_PAD_MAX_DEG = MESH_BOX_PADS_DEG[MESH_BOX_PADS_DEG.length - 1];
/**
 * Cap on the triangles one box may read. Arithmetic from the arrays
 * (store.ts 80 bytes a triangle, astar.ts 51): about 135 bytes each, so
 * 16 M triangles is about 2.2 GB in the child process; the first box of
 * the job above read 8.2 M, its 1° box would read 11.8 M and its 2° box
 * 21.8 M (counted from the District 1 index).
 */
export const MESH_MAX_TRIANGLES = 16_000_000;

/** Every point of the leg lies in the mesh (a tile exists and its extent holds the point). */
export function meshCovers(store: MeshStore, points: [number, number][]): boolean {
  return points.every(p => store.covers(p[0], p[1]));
}

export function blockedTriangles(m: LoadedMesh, rules: MeshRules): Uint8Array {
  const b = new Uint8Array(m.n);
  const minClear = rules.airDraftM + 1;
  const minDepth = rules.draughtM + 0.5;
  const { flags, depth, clear, hazv } = m;
  const avoidOpening = rules.openingBridges === 'avoid';
  for (let t = 0; t < m.n; t++) {
    const f = flags[t];
    if (avoidOpening && f & FLAG_OPENING_BRIDGE) b[t] = 1;
    else if (clear[t] !== NO_VALUE && clear[t] < minClear) b[t] = 1;
    else if (!(f & FLAG_NAVIGABLE) && depth[t] !== NO_VALUE && depth[t] < minDepth) b[t] = 1;
    else if (f & FLAG_HAZARD && hazv[t] < minDepth) b[t] = 1;
    else if (f & FLAG_MARK && !(f & FLAG_CHANNEL_MARK && f & (FLAG_FAIRWAY | FLAG_DREDGED))) b[t] = 1;
    else if (f & FLAG_STRUCTURE) b[t] = 1;
  }
  if (rules.avoid?.length) {
    for (const a of rules.avoid) {
      const [ax, ay] = toMeshXY(m, a.lon, a.lat);
      const r2 = a.radiusM * a.radiusM;
      for (let t = 0; t < m.n; t++) {
        if (b[t]) continue;
        const cx = (m.x[t * 3] + m.x[t * 3 + 1] + m.x[t * 3 + 2]) / 3;
        const cy = (m.y[t * 3] + m.y[t * 3 + 1] + m.y[t * 3 + 2]) / 3;
        if ((cx - ax) * (cx - ax) + (cy - ay) * (cy - ay) <= r2) b[t] = 1;
      }
    }
  }
  return b;
}

/** Distance from point p to segment ab (metres frame). */
function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Grow the blocked set by a distance: every usable triangle whose nearest
 * point lies within `bufferM` of an edge between a blocked triangle and a
 * usable one becomes blocked too (in place). Exact: the distance between
 * a segment and a triangle is attained at a corner of one of them, so the
 * corners of the triangle against the edge and the edge's ends against
 * the triangle's sides are tested.
 *
 * One flood from every boundary edge at once, nearest first: each
 * triangle keeps the nearest boundary edge it has been handed and hands
 * it on to its neighbours with their exact distance to that edge, so a
 * triangle is relaxed a handful of times, not once per edge near it.
 *
 * KNOWN GAP, left on purpose (the owner's decision, 2026-10-08): this is
 * not exact. A triangle hands on only its own nearest edge, so a triangle
 * whose only path from its nearest edge runs through a neighbour nearer
 * to a different edge is never reached. Measured on brain, Block Island
 * to the canal, against the exact walk from every edge separately: 6,517
 * triangles missed of 1,281,634 at 50 m (0.5%), 4,743 of 1,564,288 at
 * 100 m, 3,155 of 2,234,947 at 300 m; the routes came out the same
 * length. The exact alternative is that walk: from each boundary edge,
 * walk outward across shared edges while the triangle's exact distance
 * to that edge is within the buffer (a stamp per edge against revisits).
 * Its cost on the same leg: 26 s at 50 m, 53 s at 100 m, 207 s at 300 m,
 * against 8 s, 11 s and 17 s here (a spatial query per edge before either
 * took 104 s and 312 s). To restore exactness, replace the loop below with
 * that walk; the tests in mesh.test.ts hold for both.
 *
 * Labels spread through adjacent triangles only, so water within the
 * distance only across land (no triangles) or across the blocked region
 * itself is not reached: that is the land buffer's business. Returns how
 * many triangles it blocked. The mesh's own edge (no neighbour) is not a
 * boundary here (docs/plans/buffers-and-tacks.md, item 4).
 */
export function growBlocked(m: LoadedMesh, blocked: Uint8Array, bufferM: number): number {
  if (!(bufferM > 0)) return 0;
  const { x, y, neighbours: NB, n } = m;
  const original = blocked.slice();
  // The boundary edges, as t * 3 + k.
  const edges: number[] = [];
  for (let t = 0; t < n; t++) {
    if (!original[t]) continue;
    for (let k = 0; k < 3; k++) {
      const v = NB[t * 3 + k];
      if (v >= 0 && !original[v]) edges.push(t * 3 + k);
    }
  }
  const dist = new Float64Array(n).fill(Infinity);
  const nearest = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  const toEdge = (u: number, e: number): number => {
    const t = Math.floor(e / 3);
    const k = e % 3;
    const ax = x[t * 3 + k];
    const ay = y[t * 3 + k];
    const bx = x[t * 3 + ((k + 1) % 3)];
    const by = y[t * 3 + ((k + 1) % 3)];
    let d = Infinity;
    for (let c = 0; c < 3; c++) {
      const cx = x[u * 3 + c];
      const cy = y[u * 3 + c];
      const dx = x[u * 3 + ((c + 1) % 3)];
      const dy = y[u * 3 + ((c + 1) % 3)];
      d = Math.min(
        d,
        pointSegmentDistance(cx, cy, ax, ay, bx, by),
        pointSegmentDistance(ax, ay, cx, cy, dx, dy),
        pointSegmentDistance(bx, by, cx, cy, dx, dy)
      );
    }
    return d;
  };
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const first = NB[e]; // the usable triangle across the edge: distance 0
    if (dist[first] > 0) {
      dist[first] = 0;
      nearest[first] = i;
      heap.push(0, first);
    }
  }
  let added = 0;
  while (heap.size > 0) {
    const d = heap.peekKey();
    const u = heap.pop();
    if (d > dist[u]) continue; // a stale entry
    if (!blocked[u]) {
      blocked[u] = 1;
      added++;
    }
    const e = edges[nearest[u]];
    for (let c = 0; c < 3; c++) {
      const v = NB[u * 3 + c];
      if (v < 0 || original[v]) continue;
      const dv = toEdge(v, e);
      if (dv <= bufferM && dv < dist[v]) {
        dist[v] = dv;
        nearest[v] = nearest[u];
        heap.push(dv, v);
      }
    }
  }
  return added;
}

/** The triangle holding the point: the point's own tile first, then the ring of tiles around it. */
function locateTile(store: MeshStore, m: LoadedMesh, lon: number, lat: number, px: number, py: number): number {
  const [ti, tj] = store.tileIJ(lon, lat);
  for (const ring of [0, 1]) {
    const tiles = m.tiles.filter(t => Math.max(Math.abs(t.info.i - ti), Math.abs(t.info.j - tj)) === ring);
    if (!tiles.length) continue;
    const r = locate(m, tiles, px, py);
    if (r >= 0) return r;
  }
  return -1;
}

/** The search's answer with the mesh it read, for the leg to be planned on (legrun.ts, land.ts). */
export interface MeshSearch {
  result: MeshRouteResult;
  /** The box read (the last one tried). */
  box: BBox;
  /** The mesh of that box and its blocked triangles; null when nothing was read. */
  mesh: { m: LoadedMesh; blocked: Uint8Array } | null;
}

export function meshRoute(store: MeshStore, start: [number, number], end: [number, number], rules: MeshRules): MeshRouteResult {
  return searchMesh(store, start, end, rules).result;
}

export function searchMesh(store: MeshStore, start: [number, number], end: [number, number], rules: MeshRules): MeshSearch {
  const maxTriangles = rules.maxTriangles ?? MESH_MAX_TRIANGLES;
  const boxFor = (pad: number): BBox => ({
    west: Math.min(start[0], end[0]) - pad,
    east: Math.max(start[0], end[0]) + pad,
    south: Math.min(start[1], end[1]) - pad,
    north: Math.max(start[1], end[1]) + pad,
  });
  const stats: MeshRouteStats = {
    trianglesLoaded: 0,
    blocked: 0,
    expanded: 0,
    readMs: 0,
    prepMs: 0,
    searchMs: 0,
    funnelMs: 0,
    padDeg: MESH_BOX_PADS_DEG[0],
    attempts: 0,
    bufferM: rules.bufferM ?? 0,
    buffered: 0,
    bufferMs: 0,
  };
  let box: BBox = boxFor(MESH_BOX_PADS_DEG[0]);
  let m: LoadedMesh | null = null;
  let blocked: Uint8Array | null = null;
  let st = -1;
  let sx = 0;
  let sy = 0;
  let ex = 0;
  let ey = 0;
  let r: ReturnType<typeof meshAstar> | null = null;
  for (let attempt = 0; attempt < MESH_BOX_PADS_DEG.length; attempt++) {
    const pad = MESH_BOX_PADS_DEG[attempt];
    box = boxFor(pad);
    if (attempt > 0) {
      const would = store.countTriangles(box);
      if (would > maxTriangles)
        return {
          result: {
            ok: false,
            reason: `no route on the mesh within {angle:${(stats.padDeg * Math.PI) / 180}} of the leg's ends; a box {angle:${(pad * Math.PI) / 180}} around them would read ${would} triangles, over the ${maxTriangles} cap`,
            stats,
          },
          box,
          mesh: m && blocked ? { m, blocked } : null,
        };
      // The previous box's arrays go before the next one's are read.
      m = null;
    }
    stats.padDeg = pad;
    stats.attempts = attempt + 1;
    const t0 = Date.now();
    m = store.load(box);
    const t1 = Date.now();
    blocked = blockedTriangles(m, rules);
    [sx, sy] = toMeshXY(m, start[0], start[1]);
    [ex, ey] = toMeshXY(m, end[0], end[1]);
    st = locateTile(store, m, start[0], start[1], sx, sy);
    const et = locateTile(store, m, end[0], end[1], ex, ey);
    // The ends against the rules themselves, before the buffer: inside a blocked triangle is one error, inside the buffer another.
    const endsBlocked = [st >= 0 && blocked[st] === 1, et >= 0 && blocked[et] === 1];
    const tb = Date.now();
    stats.buffered = growBlocked(m, blocked, rules.bufferM ?? 0);
    const bufMs = Date.now() - tb;
    stats.bufferMs += bufMs;
    let nBlocked = 0;
    for (let t = 0; t < m.n; t++) nBlocked += blocked[t];
    const t2 = Date.now();
    stats.trianglesLoaded = m.n;
    stats.blocked = nBlocked;
    stats.readMs += t1 - t0;
    stats.prepMs += t2 - t1 - bufMs;
    if (st < 0 || et < 0)
      return {
        result: { ok: false, reason: `${st < 0 ? 'start' : 'end'} point is not in a mesh triangle`, stats },
        box,
        mesh: { m, blocked },
      };
    if (endsBlocked[0] || endsBlocked[1])
      return {
        result: { ok: false, reason: `${endsBlocked[0] ? 'start' : 'end'} point is in a blocked triangle`, stats },
        box,
        mesh: { m, blocked },
      };
    if (blocked[st] || blocked[et])
      return {
        result: {
          ok: false,
          reason: `${blocked[st] ? 'start' : 'end'} point is within the buffer ({length:${rules.bufferM}}) of unusable water`,
          stats,
        },
        box,
        mesh: { m, blocked },
      };
    r = meshAstar(m, blocked, st, et, sx, sy, ex, ey, rules.motorSpeedMs);
    const t3 = Date.now();
    stats.expanded = r.expanded;
    stats.searchMs += t3 - t2;
    if (r.goalNode !== -2) break;
  }
  if (!m || !blocked || !r || r.goalNode === -2)
    return {
      result: { ok: false, reason: `no route on the mesh within {angle:${(stats.padDeg * Math.PI) / 180}} of the leg's ends`, stats },
      box,
      mesh: m && blocked ? { m, blocked } : null,
    };
  const t3 = Date.now();
  // The crossed edges from the start, each as [left corner, right corner] going forward.
  const crossings: [number, number][] = [];
  for (let node = r.goalNode; node >= 0; node = r.came[node]) {
    const v = r.via[node];
    crossings.push([Math.floor(v / 3), v % 3]);
  }
  crossings.reverse();
  const portals: [XY, XY][] = crossings.map(([t, k]) => {
    const a = t * 3 + ((k + 1) % 3);
    const b = t * 3 + k;
    return [
      [m.x[a], m.y[a]],
      [m.x[b], m.y[b]],
    ];
  });
  const pathXY = funnel(portals, [sx, sy], [ex, ey]);
  const widths = passageWidths(m, blocked, pathXY, st);
  stats.funnelMs = Date.now() - t3;
  const path = pathXY.map(p => fromMeshXY(m, p[0], p[1]));
  let lengthM = 0;
  for (let i = 1; i < path.length; i++) lengthM += haversineDistanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  return { result: { ok: true, path, widths, lengthM, costS: r.goalG, stats }, box, mesh: { m, blocked } };
}
