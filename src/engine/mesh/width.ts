/**
 * Passage width along a mesh route: at each point of the polyline, the
 * distance to the first blocked (or missing) triangle to the left and to
 * the right of the track, up to MAX_SCAN_M. The parent planner's
 * measure_passage_width on its grid (scan at bearing ∓ 90° to the first
 * impassable cell, 4 km cap), done here by walking the ray from triangle
 * to triangle across the edges it crosses.
 */

import type { LoadedMesh } from './store';

/** The scan stops here: water this wide on a side counts as open (the parent's max_scan_m). */
export const MAX_SCAN_M = 4000;

const EPS = 1e-9;

/**
 * Walk the ray p + s·d from inside (or on the boundary of) triangle `tri`
 * until it leaves the mesh, meets a blocked triangle, or has gone
 * `maxM`. Returns the distance gone and the triangle the ray is in when
 * it stops (the last open one). With `through` the ray ignores blocked
 * triangles (used to carry the current triangle along the route).
 */
export function rayWalk(
  m: LoadedMesh,
  blocked: Uint8Array,
  tri: number,
  px: number,
  py: number,
  dx: number,
  dy: number,
  maxM: number,
  through = false
): { dist: number; tri: number } {
  const { x, y, neighbours: NB } = m;
  let cur = tri;
  let entry = -1;
  let s = 0;
  // A ray from a corner can hop round the fan of triangles at that
  // corner with s = 0 before it finds the one it runs into; the cap ends
  // a degenerate case rather than hang.
  for (let iter = 0; iter < 100000; iter++) {
    let bestS = Infinity;
    let bestK = -1;
    for (let k = 0; k < 3; k++) {
      if (k === entry) continue;
      const a = cur * 3 + k;
      const b = cur * 3 + ((k + 1) % 3);
      const ex = x[b] - x[a];
      const ey = y[b] - y[a];
      // Corners wind counter-clockwise, so the inside is to the left of
      // each edge: the ray can only leave through an edge it points to the
      // right of (a start on an edge or corner must not go back out
      // through it).
      if (ex * dy - ey * dx >= 0) continue;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-18) continue; // parallel to the edge
      const wx = x[a] - px;
      const wy = y[a] - py;
      const sHit = (wx * ey - wy * ex) / den; // along the ray
      const u = (wx * dy - wy * dx) / den; // along the edge
      if (u < -1e-7 || u > 1 + 1e-7) continue;
      if (sHit < s - EPS) continue;
      if (sHit < bestS) {
        bestS = sHit;
        bestK = k;
      }
    }
    if (bestK < 0) return { dist: s, tri: cur }; // numerical dead end: stop here
    if (bestS >= maxM) return { dist: maxM, tri: cur };
    const n = NB[cur * 3 + bestK];
    if (n < 0 || (!through && blocked[n])) return { dist: Math.max(bestS, 0), tri: cur };
    s = Math.max(bestS, s);
    entry = m.rev[cur * 3 + bestK];
    cur = n;
  }
  return { dist: s, tri: cur };
}

/**
 * For each point of a route through the mesh (metres frame; `startTri`
 * holds the first point): [left, right] distances to the first blocked
 * or missing triangle, perpendicular to the track there, capped at
 * MAX_SCAN_M. The track's direction at a point is towards the next
 * point (the last point: from the previous one); a zero-length step
 * keeps the previous direction.
 */
export function passageWidths(m: LoadedMesh, blocked: Uint8Array, pathXY: [number, number][], startTri: number): [number, number][] {
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
    const left = rayWalk(m, blocked, tri, px, py, -dirY, dirX, MAX_SCAN_M).dist;
    const right = rayWalk(m, blocked, tri, px, py, dirY, -dirX, MAX_SCAN_M).dist;
    out.push([left, right]);
    if (nxt) {
      // Carry the triangle to the next point along the route itself.
      const L = Math.hypot(nxt[0] - px, nxt[1] - py);
      if (L > 0) tri = rayWalk(m, blocked, tri, px, py, dirX, dirY, L, true).tri;
    }
  }
  return out;
}
