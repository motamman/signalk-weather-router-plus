/**
 * One leg on the navigation mesh: the tiles read as the search reaches them
 * (paged.ts), the triangles the boat cannot use marked in each, search
 * (astar.ts) and pull the string through the crossed edges (funnel.ts).
 * Motor only: the cost is distance with the mesh's shore and depth
 * penalties over the motor speed; no wind or current.
 *
 * Blocked triangles:
 *  - a charted vertical clearance under the air draft + 2 m (the overhead
 *    clearance setting; an opening
 *    bridge's open clearance; the bridge is blocked outright when the
 *    route's rule for opening bridges is 'avoid');
 *  - a charted depth under the draught + 0.5 m (the under-keel clearance
 *    setting), unless the triangle is in
 *    a fairway, dredged area or recommended track (is_navigable);
 *  - a rock, wreck or obstruction whose charted depth (VALSOU) is under
 *    the draught + 0.5 m, or not charted (hazv = -1e9 in the build);
 *  - a mark (20 m standoff in the build), except a channel mark inside a
 *    fairway or dredged area;
 *  - a structure (pier, bridge pier, …);
 *  - an area to avoid (Signal K notes): the triangle's centroid inside it.
 */

import { unwrapLonNear } from '../../geo/angles';
import { bboxUnion, haversineDistanceM, wrapEdge, type BBox } from '../../geo/geodesy';
import { DEFAULT_OVERHEAD_M, DEFAULT_UKC_M } from '../../vessel/vessel';
import type { LegPlan } from '../multileg';
import { MinHeap } from '../heap';
import { meshAstar } from './astar';
import { funnel, type XY } from './funnel';
import { type BoundarySeeds, PagedMesh } from './paged';
import { passageWidths, rayWalk } from './width';
import {
  FLAG_CHANNEL_MARK,
  FLAG_DREDGED,
  FLAG_FAIRWAY,
  FLAG_HAZARD,
  FLAG_MARK,
  FLAG_NAVIGABLE,
  FLAG_OPENING_BRIDGE,
  FLAG_STRUCTURE,
  type LoadedMesh,
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
  /** Water kept under the keel, m (absent: DEFAULT_UKC_M). */
  underKeelClearanceM?: number;
  /** Headroom kept above the mast, m (absent: DEFAULT_OVERHEAD_M). */
  overheadClearanceM?: number;
  motorSpeedMs: number;
  /** Opening bridges: 'open' (default) passes them under their open clearance; 'avoid' blocks every one. */
  openingBridges?: 'open' | 'avoid';
  /** Areas to avoid: triangles whose centroid lies within radiusM of the centre are blocked. */
  avoid?: { lon: number; lat: number; radiusM: number }[];
  /** Keep at least this far from every blocked triangle: usable triangles within it are blocked too (0 or absent: none). */
  bufferM?: number;
}

export interface MeshRouteStats {
  /** Distinct triangles and tiles the search read; tile reads, re-reads included; the most triangles held at once. */
  trianglesLoaded: number;
  tiles: number;
  tileReads: number;
  peakTriangles: number;
  /** Triangles blocked (rules and buffer) among those read. */
  blocked: number;
  expanded: number;
  readMs: number;
  prepMs: number;
  searchMs: number;
  funnelMs: number;
  /** The buffer applied (metres), the usable triangles it blocked, and its time. */
  bufferM: number;
  buffered: number;
  bufferMs: number;
}

/**
 * Where a leg aimed at an approximate waypoint actually went (part 3): the waypoint itself when the boat can use the
 * water there, else the nearest usable water (`movedM` from the waypoint, inside its circle or not).
 */
export interface MeshTarget {
  lon: number;
  lat: number;
  radiusM: number;
  movedM: number;
  /** The waypoint's name for messages (searchMeshRun). */
  name?: string;
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
      /** The triangle the route ends in (global id), carried along the route. */
      endTri?: number;
      /** An approximate end (searchMesh `approach`): where the leg aimed. */
      target?: MeshTarget;
      /**
       * The waypoint circles of a run (searchMeshRun), in order: the index of the path point where the route reached
       * each, what it aimed at, and the waypoint's name.
       */
      circles?: (MeshTarget & { pathIndex: number })[];
    }
  | { ok: false; reason: string; stats: MeshRouteStats };

/**
 * Degrees around a leg's ends the worker loads the forecast and currents
 * for (with the rough cut's reach added when it gives one, pipeline.ts):
 * the mesh process reads them from the worker's files only. The search
 * itself reads tiles on demand and has no box.
 */
export const MESH_BOX_PAD_MAX_DEG = 2.0;

/** Every point of the leg lies in the mesh (a tile exists and its extent holds the point). */
export function meshCovers(store: MeshStore, points: [number, number][]): boolean {
  return points.every(p => store.covers(p[0], p[1]));
}

export function blockedTriangles(m: LoadedMesh, rules: MeshRules): Uint8Array {
  const b = new Uint8Array(m.n);
  const minClear = rules.airDraftM + (rules.overheadClearanceM ?? DEFAULT_OVERHEAD_M);
  const minDepth = rules.draughtM + (rules.underKeelClearanceM ?? DEFAULT_UKC_M);
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
 *
 * `outerSeeds` (paged.ts, one tile at a time): edges t * 3 + k of usable
 * triangles of this mesh whose neighbour across k, in the next tile, is
 * blocked; they are boundary edges too, the flood starting in t itself.
 * Water within the buffer of a blocked triangle of the next tile that is
 * reached only through a usable triangle of that tile is not seen from
 * here: the known gap's one further case (docs/drafts/mesh-no-gshhg-design.md,
 * part 4 revised).
 */
export function growBlocked(m: LoadedMesh, blocked: Uint8Array, bufferM: number, outerSeeds: number[] = []): number {
  if (!(bufferM > 0)) return 0;
  const { x, y, neighbours: NB, n } = m;
  const original = blocked.slice();
  // The boundary edges, as t * 3 + k, and the usable triangle each floods from.
  const edges: number[] = [];
  const firsts: number[] = [];
  for (let t = 0; t < n; t++) {
    if (!original[t]) continue;
    for (let k = 0; k < 3; k++) {
      const v = NB[t * 3 + k];
      if (v >= 0 && !original[v]) {
        edges.push(t * 3 + k);
        firsts.push(v);
      }
    }
  }
  for (const e of outerSeeds) {
    const t = Math.floor(e / 3);
    if (original[t]) continue;
    edges.push(e);
    firsts.push(t);
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
    const first = firsts[i]; // the usable triangle at the edge: distance 0
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

/** The search's answer with the mesh it read, for the leg to be planned on (legrun.ts, land.ts). */
export interface MeshSearch {
  result: MeshRouteResult;
  /** The extent of the tiles the search read (degrees); around the ends when it read none past them. */
  box: BBox;
  /** The paged mesh the search ran on (its tiles read again on demand by the leg's land). */
  paged: PagedMesh;
}

export function meshRoute(
  store: MeshStore,
  start: [number, number],
  end: [number, number],
  rules: MeshRules,
  boundary: BoundarySeeds | null = null
): MeshRouteResult {
  return searchMesh(store, start, end, rules, boundary).result;
}

/**
 * The mesh search for a leg on the paged mesh (paged.ts): no area is chosen
 * before it; a tile is read when the search first reaches it, and dropped
 * when the search's frontier has left it (astar.ts). The frame is the
 * leg's: cl from the mid-latitude of its ends. `boundary` (the rough cut's
 * record of the tile-boundary triangles for this boat, coarse.ts) seeds the
 * buffer across tile edges.
 */
export function searchMesh(
  store: MeshStore,
  start: [number, number],
  end: [number, number],
  rules: MeshRules,
  boundary: BoundarySeeds | null = null,
  /**
   * The end is an approximate waypoint (part 3): the leg aims at it when the boat can use the water there, else at
   * the nearest usable water (the owner's choice, 2026-10-12: moved, with a warning, even outside the circle); with
   * `trim` the route stops where it enters the circle of `radiusM` round the waypoint (an inner waypoint of a run:
   * the next piece starts there). A start already inside the circle is not trimmed.
   */
  approach?: { radiusM: number; trim: boolean; aim?: { lon: number; lat: number; tri: number } },
  /**
   * The start's triangle when it is known (the next piece of a run starts where the last ended, often on a triangle
   * corner shared with a triangle of other water: the triangle the last piece's route ended in decides).
   */
  startTri?: number
): MeshSearch {
  const cl = Math.cos(((start[1] + end[1]) / 2) * (Math.PI / 180));
  const pm = new PagedMesh(store, rules, cl, boundary);
  // The box of the two ends, the short way round (a leg across the date line: its west greater than its east).
  const endLon = unwrapLonNear(end[0], start[0]);
  const ends: BBox = {
    west: wrapEdge(Math.min(start[0], endLon)),
    east: wrapEdge(Math.max(start[0], endLon)),
    south: Math.min(start[1], end[1]),
    north: Math.max(start[1], end[1]),
  };
  const stats = (): MeshRouteStats => ({
    trianglesLoaded: pm.stats.triangles,
    tiles: pm.stats.tiles,
    tileReads: pm.stats.reads,
    peakTriangles: pm.stats.peakTriangles,
    blocked: pm.stats.blocked + pm.stats.buffered,
    expanded,
    readMs: pm.stats.readMs,
    prepMs: pm.stats.prepMs,
    searchMs,
    funnelMs,
    bufferM: rules.bufferM ?? 0,
    buffered: pm.stats.buffered,
    bufferMs: pm.stats.bufferMs,
  });
  let expanded = 0;
  let searchMs = 0;
  let funnelMs = 0;
  const done = (result: MeshRouteResult): MeshSearch => ({ result, box: pm.touchedBox() ?? ends, paged: pm });
  const [sx, sy] = pm.toXY(start[0], start[1]);
  const [wx, wy] = pm.toXY(end[0], end[1]);
  // The start's triangles: every usable one the point touches (a corner or an edge between usable and blocked water,
  // or between two waters, belongs to each), or the one the last piece of a run ended in. None usable: the triangle
  // under it says why.
  const sAll = startTri !== undefined ? [startTri] : pm.locateAll(sx, sy);
  const st = sAll.length ? sAll[0] : pm.locate(sx, sy, true);
  if (st < 0) return done({ ok: false, reason: 'start point is not in a mesh triangle', stats: stats() });
  // The end: the point itself, or for an approximate waypoint the usable water nearest it.
  let ex = wx;
  let ey = wy;
  let et: number;
  let eAll: number[] = [];
  let target: MeshTarget | undefined;
  if (approach?.aim) {
    // Where the rough cut aimed the waypoint (water connected to the start, under the same blocked sets).
    [ex, ey] = pm.toXY(approach.aim.lon, approach.aim.lat);
    et = approach.aim.tri;
    if (pm.isBlocked(et))
      return done({
        ok: false,
        reason:
          'the water the rough cut chose for the waypoint is not usable on the mesh; rebuild the rough cut in the plugin configuration',
        stats: stats(),
      });
    target = { lon: approach.aim.lon, lat: approach.aim.lat, radiusM: approach.radiusM, movedM: Math.hypot(pm.near(ex, wx) - wx, ey - wy) };
  } else if (approach) {
    const nu = pm.nearestUsable(wx, wy);
    if (!nu) return done({ ok: false, reason: 'the mesh has no water the boat can use near the waypoint', stats: stats() });
    [ex, ey, et] = [nu.x, nu.y, nu.tri];
    const [lon, lat] = nu.distM > 0 ? pm.fromXY(ex, ey) : end;
    target = { lon, lat, radiusM: approach.radiusM, movedM: nu.distM };
  } else {
    eAll = pm.locateAll(ex, ey);
    et = eAll.length ? eAll[0] : pm.locate(ex, ey, true);
    if (et < 0) return done({ ok: false, reason: 'end point is not in a mesh triangle', stats: stats() });
  }
  if (!eAll.length) eAll = [et];
  // The ends against the rules themselves, before the buffer: inside a blocked triangle is one error, inside the buffer another.
  const S = pm.tileOf(st);
  const E = pm.tileOf(et);
  const endsBlocked = [S.ruleBlocked[st - S.first] === 1, E.ruleBlocked[et - E.first] === 1];
  if (endsBlocked[0] || endsBlocked[1])
    return done({ ok: false, reason: `${endsBlocked[0] ? 'start' : 'end'} point is in a blocked triangle`, stats: stats() });
  const inBuffer = [S.blocked[st - S.first] === 1, E.blocked[et - E.first] === 1];
  if (inBuffer[0] || inBuffer[1])
    return done({
      ok: false,
      reason: `${inBuffer[0] ? 'start' : 'end'} point is within the buffer ({length:${rules.bufferM}}) of unusable water`,
      stats: stats(),
    });
  const t0 = Date.now();
  const r = meshAstar(pm, sAll.length ? sAll : [st], eAll, sx, sy, ex, ey, rules.motorSpeedMs);
  searchMs = Date.now() - t0;
  expanded = r.expanded;
  if (r.goalNode === -2)
    return done({
      ok: false,
      reason: 'no route on the mesh between the start and the end for this boat (the search ran out of water it may use)',
      stats: stats(),
    });
  const t1 = Date.now();
  // The crossed edges from the start, each as [left corner, right corner] going forward.
  // One line of points for the funnel: each crossed edge next to the one before it, the first next to the start and the
  // end next to the last (paged.ts near), so the route is laid out unbroken wherever its tiles are in the frame.
  let lastX = sx;
  const portals: [XY, XY][] = r.crossings().map(([t, k]) => {
    const T = pm.tileOf(t);
    const l = t - T.first;
    const a = l * 3 + ((k + 1) % 3);
    const b = l * 3 + k;
    const shift = pm.near(T.x[a], lastX) - T.x[a];
    lastX = T.x[a] + shift;
    return [
      [T.x[a] + shift, T.y[a]],
      [T.x[b] + shift, T.y[b]],
    ];
  });
  let pathXY = funnel(portals, [sx, sy], [pm.near(ex, lastX), ey]);
  // An inner waypoint of a run: the route stops where it enters the circle (the water there being usable, or the
  // nearest usable water inside the circle; the route goes on to water moved outside it).
  if (approach?.trim && target!.movedM <= approach.radiusM)
    pathXY = trimAtCircle(pathXY, pm.near(wx, pathXY[pathXY.length - 1][0]), wy, approach.radiusM);
  const widths = passageWidths(pm, pathXY, r.startTri);
  funnelMs = Date.now() - t1;
  const path = pathXY.map(p => pm.fromXY(p[0], p[1]));
  let lengthM = 0;
  for (let i = 1; i < path.length; i++) lengthM += haversineDistanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  // The triangle the route ends in, carried along the route itself from the start's (as passageWidths does).
  let endTri = r.startTri;
  for (let i = 1; i < pathXY.length; i++) {
    const [ax, ay] = pathXY[i - 1];
    const L = Math.hypot(pathXY[i][0] - ax, pathXY[i][1] - ay);
    if (L > 0) endTri = rayWalk(pm, endTri, ax, ay, (pathXY[i][0] - ax) / L, (pathXY[i][1] - ay) / L, L, true).tri;
  }
  return done({ ok: true, path, widths, lengthM, costS: r.goalG, stats: stats(), endTri, ...(target ? { target } : {}) });
}

/**
 * The polyline cut where it first comes within `r` of (cx, cy) (metres frame): the points before, then the point
 * where that segment enters the circle. Unchanged when it starts inside the circle or never reaches it.
 */
export function trimAtCircle(path: XY[], cx: number, cy: number, r: number): XY[] {
  if (!path.length || Math.hypot(path[0][0] - cx, path[0][1] - cy) <= r) return path;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const dx = path[i][0] - ax;
    const dy = path[i][1] - ay;
    const L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) continue;
    // Does the segment come within r of the centre? Then it enters at the smaller root of |a + t d - c| = r.
    const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / L2));
    if (Math.hypot(ax + t * dx - cx, ay + t * dy - cy) > r) continue;
    const fx = ax - cx;
    const fy = ay - cy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const t0 = Math.max(0, Math.min(1, (-B - Math.sqrt(Math.max(0, B * B - 4 * L2 * C))) / (2 * L2)));
    return [...path.slice(0, i), [ax + t0 * dx, ay + t0 * dy]];
  }
  return path;
}

/** A point a run of mesh searches goes to: a waypoint circle (radiusM), or the exact end (no radius). */
export interface RunTarget {
  lon: number;
  lat: number;
  /** An approximate waypoint's circle, metres. */
  radiusM?: number;
  /** For the messages ("waypoint 2", "the destination"). */
  name: string;
  /**
   * An approximate waypoint: the point the rough cut aimed it at (coarse.ts PieceGraph: the waypoint, or the nearest
   * usable water connected to the leg's start) and the triangle it chose (the point can be a corner shared with a
   * triangle of other water, so the triangle, not the point, decides). Absent: the search's own nearest usable water.
   */
  aim?: { lon: number; lat: number; tri: number };
}

/**
 * A leg through waypoint circles on the mesh (docs/drafts/mesh-no-gshhg-design.md, part 3): one search per piece,
 * start → circle 1 → … → the end, each piece starting where the one before entered its circle (searchMesh with
 * `approach`, trimmed), joined into one route with its passage widths. The last target is the leg's end: exact, or
 * approximate (not trimmed: the leg's own planning stops on entering its circle). The land for planning the leg is the
 * last piece's paged mesh. Fails with the first piece that fails, naming its target.
 */
export function searchMeshRun(
  store: MeshStore,
  start: [number, number],
  targets: RunTarget[],
  rules: MeshRules,
  boundary: BoundarySeeds | null = null
): MeshSearch {
  const path: [number, number][] = [];
  const widths: [number, number][] = [];
  const circles: (MeshTarget & { pathIndex: number })[] = [];
  let lengthM = 0;
  let costS = 0;
  let stats: MeshRouteStats | null = null;
  let box: BBox | null = null;
  let from = start;
  let fromTri: number | undefined;
  let last: MeshSearch | null = null;
  for (let i = 0; i < targets.length; i++) {
    const tg = targets[i];
    const inner = i < targets.length - 1;
    const s = searchMesh(
      store,
      from,
      [tg.lon, tg.lat],
      rules,
      boundary,
      tg.radiusM !== undefined ? { radiusM: tg.radiusM, trim: inner, ...(tg.aim ? { aim: tg.aim } : {}) } : undefined,
      fromTri
    );
    const r = s.result;
    stats = stats ? addStats(stats, r.stats) : r.stats;
    box = box ? bboxUnion(box, s.box) : s.box;
    last = s;
    if (!r.ok)
      return { result: { ok: false, reason: targets.length > 1 ? `to ${tg.name}: ${r.reason}` : r.reason, stats }, box, paged: s.paged };
    // Joined at the point where the previous piece ended (dropped from this one).
    const skip = path.length ? 1 : 0;
    path.push(...r.path.slice(skip));
    widths.push(...r.widths.slice(skip));
    lengthM += r.lengthM;
    costS += r.costS;
    if (inner) circles.push({ ...r.target!, name: tg.name, pathIndex: path.length - 1 });
    from = r.path[r.path.length - 1];
    fromTri = r.endTri;
    if (inner) s.paged.retain(() => false);
  }
  const lt = last!.result.ok ? last!.result.target : undefined;
  const lastTarget = lt ? { ...lt, name: targets[targets.length - 1].name } : undefined;
  return {
    result: {
      ok: true,
      path,
      widths,
      lengthM,
      costS,
      stats: stats!,
      ...(lastTarget ? { target: lastTarget } : {}),
      ...(circles.length ? { circles } : {}),
    },
    box: box!,
    paged: last!.paged,
  };
}

/** Two pieces' stats as one: counts and times summed, the most held at once the larger. */
function addStats(a: MeshRouteStats, b: MeshRouteStats): MeshRouteStats {
  return {
    trianglesLoaded: a.trianglesLoaded + b.trianglesLoaded,
    tiles: a.tiles + b.tiles,
    tileReads: a.tileReads + b.tileReads,
    peakTriangles: Math.max(a.peakTriangles, b.peakTriangles),
    blocked: a.blocked + b.blocked,
    expanded: a.expanded + b.expanded,
    readMs: a.readMs + b.readMs,
    prepMs: a.prepMs + b.prepMs,
    searchMs: a.searchMs + b.searchMs,
    funnelMs: a.funnelMs + b.funnelMs,
    bufferM: a.bufferM,
    buffered: a.buffered + b.buffered,
    bufferMs: a.bufferMs + b.bufferMs,
  };
}

/**
 * A leg plan's targets for searchMeshRun: its waypoint circles in order (waypoint numbers as the route counts them),
 * then its end, approximate when the leg ends on entering its circle.
 */
export function runTargets(
  plan: Pick<LegPlan, 'index' | 'lastIndex' | 'count' | 'vias' | 'end' | 'snapToExact' | 'arrivalRadiusM'>
): RunTarget[] {
  const out: RunTarget[] = plan.vias.map((v, i) => ({
    lon: v.lon,
    lat: v.lat,
    radiusM: v.radiusM,
    name: `waypoint ${plan.index + i + 1}`,
  }));
  const last = plan.lastIndex + 1 < plan.count;
  out.push({
    lon: plan.end[0],
    lat: plan.end[1],
    ...(!plan.snapToExact && plan.arrivalRadiusM ? { radiusM: plan.arrivalRadiusM } : {}),
    name: last ? `waypoint ${plan.lastIndex + 1}` : 'the destination',
  });
  return out;
}
