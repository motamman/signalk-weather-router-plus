/**
 * The straight walk over the mesh, and passage widths along a mesh route.
 *
 * The walk (walkMesh) follows a ray from triangle to triangle across the edges it crosses, tile to tile on the paged
 * mesh. Every straight test on the mesh is this one walk: the land test of a move (land.ts legCrossesLandExact), the
 * triangles a move passes through (land.ts forEachTriangleAlong: the final depth check, opening bridges), the
 * passage widths below, and the triangle a route ends in (route.ts).
 *
 * Corners and edges (docs/drafts/mesh-no-gshhg-design.md, the corner fault, measured on brain 2026-10-12): a mesh
 * route turns only at corners of blocked water, where several triangles meet. The walk enters the triangle its
 * direction actually goes into: from a point on an edge, the triangle on the side the direction points to; from a
 * corner, or passing through one, the triangle whose angle at that corner holds the direction (found by turning
 * round the corner through the neighbour links). A direction running along an edge (within the walk's own tolerance,
 * U_TOL: a route's points come back from lon/lat a hair off) takes the usable triangle of the two: touching blocked
 * water is not crossing it. Before, the walk started in any triangle holding the point
 * and hopped round the corner into blocked water, so a mesh route's own segments failed the land test at 0 m.
 *
 * Passage width: at each point of the polyline, the distance to the first blocked (or missing) triangle to the left
 * and to the right of the track, up to MAX_SCAN_M (4 km).
 */

import type { PagedMesh, PagedTile } from './paged';

/** The scan stops here: water this wide on a side counts as open. */
export const MAX_SCAN_M = 4000;

const EPS = 1e-9;
/**
 * The walk's own tolerance, as a share of an edge's length: how close to an edge's end a crossing counts as through
 * its corner, how close to an edge a point or a direction counts as on or along it (and, in paged.ts, how close to a
 * triangle a point counts as inside it).
 */
export const U_TOL = 1e-7;

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/** The corner index of triangle l of T nearest (px, py), and that distance. */
function nearestCorner(T: PagedTile, l: number, px: number, py: number): { k: number; d: number } {
  let k = 0;
  let d = Infinity;
  for (let c = 0; c < 3; c++) {
    const dc = Math.hypot(T.x[l * 3 + c] - px, T.y[l * 3 + c] - py);
    if (dc < d) {
      d = dc;
      k = c;
    }
  }
  return { k, d };
}

/**
 * At corner (vx, vy) of global triangle t, the triangle round that corner whose angle there holds the direction
 * (dx, dy); with the direction along an edge between two of them, the usable one. Corners wind counter-clockwise:
 * for corner v with next corner p and previous q, the angle holds d when d is left of v→p and right of v→q.
 */
function enterAtCorner(pm: PagedMesh, t: number, cornerX: number, vy: number, dx: number, dy: number): number {
  // The corner where each triangle's tile is (paged.ts xIn): the triangles round a corner can lie in several tiles.
  const holds = (g: number): { yes: boolean; onEdge: boolean } => {
    const T = pm.tileOf(g);
    const l = g - T.first;
    const vx = pm.xIn(T, cornerX);
    const { k } = nearestCorner(T, l, vx, vy);
    const p = l * 3 + ((k + 1) % 3);
    const q = l * 3 + ((k + 2) % 3);
    // The direction's distance (per metre along it) from the edges v→p and v→q, against the walk's own tolerance: a
    // route's points come back from lon/lat, so a direction along an edge is a hair off it.
    const lp = Math.hypot(T.x[p] - vx, T.y[p] - vy);
    const lq = Math.hypot(T.x[q] - vx, T.y[q] - vy);
    const c1 = cross(T.x[p] - vx, T.y[p] - vy, dx, dy) / lp;
    const c2 = cross(dx, dy, T.x[q] - vx, T.y[q] - vy) / lq;
    const on1 = Math.abs(c1) <= U_TOL;
    const on2 = Math.abs(c2) <= U_TOL;
    return { yes: (c1 >= 0 || on1) && (c2 >= 0 || on2), onEdge: on1 || on2 };
  };
  // The triangles round the corner: turn one way through the edge leaving it, then the other way (each stops at the
  // mesh's edge or back at a triangle already met).
  const fan: number[] = [t];
  for (const side of [0, 2]) {
    let cur = t;
    for (;;) {
      const T = pm.tileOf(cur);
      const l = cur - T.first;
      const { k } = nearestCorner(T, l, pm.xIn(T, cornerX), vy);
      // Edge k runs from the corner to the next one, edge k + 2 from the previous one to the corner.
      const n = T.nb[l * 3 + ((k + side) % 3)];
      if (n < 0 || n === t || fan.includes(n)) break;
      fan.push(n);
      cur = n;
    }
  }
  let found = -1;
  for (const g of fan) {
    const h = holds(g);
    if (!h.yes) continue;
    if (!h.onEdge || !pm.isBlocked(g)) return g;
    if (found < 0) found = g;
  }
  // -1: no triangle round the corner holds the direction, so the ray leaves the mesh there.
  return found;
}

/**
 * The triangle a walk from (px, py) in direction (dx, dy) enters, given a triangle `t` holding the point: t itself
 * for a point inside it; for a point on one of its edges, t or its neighbour there, by the side the direction points
 * to (along the edge: the usable one); for a point on a corner, the triangle round that corner holding the direction.
 */
export function enterTriangle(pm: PagedMesh, t: number, pointX: number, py: number, dx: number, dy: number): number {
  const T = pm.tileOf(t);
  const l = t - T.first;
  // The point where the triangle's tile is (paged.ts xIn).
  const px = pm.xIn(T, pointX);
  let longest = 0;
  for (let k = 0; k < 3; k++) {
    const a = l * 3 + k;
    const b = l * 3 + ((k + 1) % 3);
    longest = Math.max(longest, Math.hypot(T.x[b] - T.x[a], T.y[b] - T.y[a]));
  }
  const c = nearestCorner(T, l, px, py);
  if (c.d <= U_TOL * longest) {
    const g = enterAtCorner(pm, t, T.x[l * 3 + c.k], T.y[l * 3 + c.k], dx, dy);
    // None holds it: the direction leaves the mesh at the corner; the walk from t finds that.
    return g >= 0 ? g : t;
  }
  for (let k = 0; k < 3; k++) {
    const a = l * 3 + k;
    const b = l * 3 + ((k + 1) % 3);
    const ex = T.x[b] - T.x[a];
    const ey = T.y[b] - T.y[a];
    const len = Math.hypot(ex, ey);
    if (!(len > 0)) continue;
    // Distance of the point from the edge's line (the triangle is to its left).
    if (Math.abs(cross(ex, ey, px - T.x[a], py - T.y[a])) / len > U_TOL * longest) continue;
    const n = T.nb[l * 3 + k];
    // The side the direction points to, per metre along it; along the edge within the walk's tolerance: the usable one.
    const side = cross(ex, ey, dx, dy) / len;
    if (Math.abs(side) <= U_TOL) return n >= 0 && pm.isBlocked(t) && !pm.isBlocked(n) ? n : t;
    if (side > 0 || n < 0) return t;
    return n;
  }
  return t;
}

/**
 * Walk the ray p + s·d (d a unit vector) from a triangle holding p (global id `tri`), entering the triangle the
 * direction goes into, until it leaves the mesh, meets a blocked triangle (unless `through`), or has gone `maxM`.
 * `fn` hears every triangle walked with the stretch of the ray inside it (metres from p, the exit capped at maxM).
 * Returns the distance gone and the triangle the ray is in when it stops (the last open one).
 */
export function walkMesh(
  pm: PagedMesh,
  tri: number,
  pointX: number,
  py: number,
  dx: number,
  dy: number,
  maxM: number,
  through = false,
  fn?: (tri: number, from: number, to: number) => void
): { dist: number; tri: number } {
  let cur = enterTriangle(pm, tri, pointX, py, dx, dy);
  if (!through && pm.isBlocked(cur)) return { dist: 0, tri: cur };
  let T = pm.tileOf(cur);
  // The ray's start where the tile walked in is (paged.ts xIn: the start lies in that tile), then carried across each
  // tile edge the walk crosses (xAcross), so the ray goes on unbroken however long it is: the distance along it is the
  // same wherever the tiles are.
  let px = pm.xIn(T, pointX);
  let entry = -1;
  let s = 0;
  // Degenerate geometry (slivers) can still make a walk circle at one point; the cap ends it rather than hang.
  for (let iter = 0; iter < 100000; iter++) {
    const l = cur - T.first;
    const { x, y } = T;
    let bestS = Infinity;
    let bestK = -1;
    let bestU = 0;
    for (let k = 0; k < 3; k++) {
      if (k === entry) continue;
      const a = l * 3 + k;
      const b = l * 3 + ((k + 1) % 3);
      const ex = x[b] - x[a];
      const ey = y[b] - y[a];
      // Corners wind counter-clockwise, so the inside is to the left of each edge: the ray can only leave through an
      // edge it points to the right of, and not through one it runs along (within the walk's tolerance, per metre).
      if (ex * dy - ey * dx >= -U_TOL * Math.hypot(ex, ey)) continue;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-18) continue; // parallel to the edge
      const wx = x[a] - px;
      const wy = y[a] - py;
      const sHit = (wx * ey - wy * ex) / den; // along the ray
      const u = (wx * dy - wy * dx) / den; // along the edge
      if (u < -U_TOL || u > 1 + U_TOL) continue;
      if (sHit < s - EPS) continue;
      if (sHit < bestS) {
        bestS = sHit;
        bestK = k;
        bestU = u;
      }
    }
    if (bestK < 0) {
      // A numerical dead end: the walk stops in this triangle.
      fn?.(cur, s, s);
      return { dist: s, tri: cur };
    }
    const exit = Math.min(Math.max(bestS, s), maxM);
    fn?.(cur, s, exit);
    if (bestS >= maxM) return { dist: maxM, tri: cur };
    // Out through a corner: the triangle round it holding the direction (none: the ray leaves the mesh there; the
    // edges at that corner are not skipped next, the side test keeps the walk from leaving back through them); else
    // the neighbour across the edge.
    let n: number;
    if (bestU <= U_TOL || bestU >= 1 - U_TOL) {
      const c = l * 3 + (bestU <= U_TOL ? bestK : (bestK + 1) % 3);
      n = enterAtCorner(pm, cur, x[c], y[c], dx, dy);
      entry = -1;
    } else {
      n = T.nb[l * 3 + bestK];
      entry = T.rev[l * 3 + bestK];
    }
    if (n < 0) return { dist: Math.max(bestS, 0), tri: cur };
    const N = n >= T.first && n < T.first + T.n ? T : pm.tileOf(n);
    if (!through && N.blocked[n - N.first]) return { dist: Math.max(bestS, 0), tri: cur };
    s = Math.max(bestS, s);
    cur = n;
    if (N !== T) px = pm.xAcross(T, N, px);
    T = N;
  }
  return { dist: s, tri: cur };
}

/** The walk without a listener (the land test, the widths, the triangle a route ends in). */
export function rayWalk(
  pm: PagedMesh,
  tri: number,
  px: number,
  py: number,
  dx: number,
  dy: number,
  maxM: number,
  through = false
): { dist: number; tri: number } {
  return walkMesh(pm, tri, px, py, dx, dy, maxM, through);
}

/**
 * For each point of a route through the mesh (metres frame, laid out unbroken: each point where the route reaches it,
 * as route.ts lays a route out, not brought back next to anything; `startTri` holds the first point): [left, right] distances
 * to the first blocked or missing triangle, perpendicular to the track there, capped at MAX_SCAN_M. The track's
 * direction at a point is towards the next point (the last point: from the previous one); a zero-length step keeps
 * the previous direction.
 */
export function passageWidths(pm: PagedMesh, pathXY: [number, number][], startTri: number): [number, number][] {
  const out: [number, number][] = [];
  let tri = startTri;
  let dirX = 0;
  let dirY = 1;
  for (let i = 0; i < pathXY.length; i++) {
    const [px, py] = pathXY[i];
    const nxt = i + 1 < pathXY.length ? pathXY[i + 1] : null;
    if (nxt) {
      const L = Math.hypot(nxt[0] - px, nxt[1] - py);
      if (L > 0) {
        dirX = (nxt[0] - px) / L;
        dirY = (nxt[1] - py) / L;
      }
    }
    const left = rayWalk(pm, tri, px, py, -dirY, dirX, MAX_SCAN_M).dist;
    const right = rayWalk(pm, tri, px, py, dirY, -dirX, MAX_SCAN_M).dist;
    out.push([left, right]);
    if (nxt) {
      // Carry the triangle to the next point along the route itself.
      const L = Math.hypot(nxt[0] - px, nxt[1] - py);
      if (L > 0) tri = rayWalk(pm, tri, px, py, dirX, dirY, L, true).tri;
    }
  }
  return out;
}
