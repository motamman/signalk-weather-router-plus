/**
 * A* over the directed edges of a triangle mesh: a node is (triangle t,
 * edge k it was entered through), node id t*3+k; moving to a neighbour
 * costs the distance between the two edge midpoints times the
 * triangle's penalty multiplier, divided by the boat speed (seconds).
 * The heuristic is the straight-line time to the end point. Port of the
 * numba search in the experiment's mesh_route5.py (same expansion order:
 * heap.ts orders ties as that heap did).
 */

import { MinHeap } from '../heap';
import type { LoadedMesh } from './store';

export interface MeshSearchResult {
  /** The node the end triangle was reached through, -1 when start and end share a triangle, -2 when no route. */
  goalNode: number;
  /** Cost of the whole route, seconds. */
  goalG: number;
  expanded: number;
  /** For each node, the node it was reached from (-1 = from the start point). */
  came: Int32Array;
  /** For each node, t_from*3 + k_out: the directed edge crossed to reach it. */
  via: Int32Array;
}

/** The triangles' edge midpoints: mid of corner k and corner k+1. */
function midX(m: LoadedMesh, t: number, k: number): number {
  return (m.x[t * 3 + k] + m.x[t * 3 + ((k + 1) % 3)]) / 2;
}
function midY(m: LoadedMesh, t: number, k: number): number {
  return (m.y[t * 3 + k] + m.y[t * 3 + ((k + 1) % 3)]) / 2;
}

export function meshAstar(
  m: LoadedMesh,
  blocked: Uint8Array,
  st: number,
  et: number,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  speedMs: number
): MeshSearchResult {
  const nn = m.n * 3;
  const g = new Float64Array(nn).fill(Infinity);
  const came = new Int32Array(nn).fill(-1);
  const via = new Int32Array(nn).fill(-1);
  const closed = new Uint8Array(nn);
  const heap = new MinHeap();
  const { neighbours: NB, rev: REV, mult } = m;
  let goalG = Infinity;
  let goalNode = -2;
  if (st === et) {
    goalG = (Math.hypot(ex - sx, ey - sy) * mult[st]) / speedMs;
    goalNode = -1;
  }
  for (let k2 = 0; k2 < 3; k2++) {
    const n = NB[st * 3 + k2];
    if (n < 0 || blocked[n]) continue;
    const node = n * 3 + REV[st * 3 + k2];
    const mx = midX(m, st, k2);
    const my = midY(m, st, k2);
    const gc = (Math.hypot(mx - sx, my - sy) * mult[st]) / speedMs;
    if (gc < g[node]) {
      g[node] = gc;
      came[node] = -1;
      via[node] = st * 3 + k2;
      heap.push(gc + Math.hypot(mx - ex, my - ey) / speedMs, node);
    }
  }
  let expanded = 0;
  while (heap.size > 0) {
    const f = heap.peekKey();
    const node = heap.pop();
    if (f >= goalG) break;
    if (closed[node]) continue;
    closed[node] = 1;
    expanded++;
    const t = Math.floor(node / 3);
    const kin = node % 3;
    const hx = midX(m, t, kin);
    const hy = midY(m, t, kin);
    if (t === et) {
      const gg = g[node] + (Math.hypot(ex - hx, ey - hy) * mult[t]) / speedMs;
      if (gg < goalG) {
        goalG = gg;
        goalNode = node;
      }
    }
    for (let k2 = 0; k2 < 3; k2++) {
      if (k2 === kin) continue;
      const n = NB[t * 3 + k2];
      if (n < 0 || blocked[n]) continue;
      const nd = n * 3 + REV[t * 3 + k2];
      const mx = midX(m, t, k2);
      const my = midY(m, t, k2);
      const gc = g[node] + (Math.hypot(mx - hx, my - hy) * mult[t]) / speedMs;
      if (gc < g[nd]) {
        g[nd] = gc;
        came[nd] = node;
        via[nd] = t * 3 + k2;
        heap.push(gc + Math.hypot(mx - ex, my - ey) / speedMs, nd);
      }
    }
  }
  return { goalNode, goalG, expanded, came, via };
}
