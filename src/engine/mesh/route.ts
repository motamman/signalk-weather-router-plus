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
 *  - a charted vertical clearance under the air draft + 1 m;
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
  FLAG_STRUCTURE,
  fromMeshXY,
  type LoadedMesh,
  locate,
  type MeshStore,
  NO_VALUE,
  toMeshXY,
} from './store';

export interface MeshRules {
  draughtM: number;
  airDraftM: number;
  motorSpeedMs: number;
  /** Areas to avoid: triangles whose centroid lies within radiusM of the centre are blocked. */
  avoid?: { lon: number; lat: number; radiusM: number }[];
}

export interface MeshRouteStats {
  trianglesLoaded: number;
  blocked: number;
  expanded: number;
  readMs: number;
  prepMs: number;
  searchMs: number;
  funnelMs: number;
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

/** Degrees added around the leg's ends for the tiles read (mesh_route5.py). */
export const MESH_BOX_PAD_DEG = 0.5;

/** Every point of the leg lies in the mesh (a tile exists and its extent holds the point). */
export function meshCovers(store: MeshStore, points: [number, number][]): boolean {
  return points.every(p => store.covers(p[0], p[1]));
}

export function blockedTriangles(m: LoadedMesh, rules: MeshRules): Uint8Array {
  const b = new Uint8Array(m.n);
  const minClear = rules.airDraftM + 1;
  const minDepth = rules.draughtM + 0.5;
  const { flags, depth, clear, hazv } = m;
  for (let t = 0; t < m.n; t++) {
    const f = flags[t];
    if (clear[t] !== NO_VALUE && clear[t] < minClear) b[t] = 1;
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

export function meshRoute(store: MeshStore, start: [number, number], end: [number, number], rules: MeshRules): MeshRouteResult {
  const box: BBox = {
    west: Math.min(start[0], end[0]) - MESH_BOX_PAD_DEG,
    east: Math.max(start[0], end[0]) + MESH_BOX_PAD_DEG,
    south: Math.min(start[1], end[1]) - MESH_BOX_PAD_DEG,
    north: Math.max(start[1], end[1]) + MESH_BOX_PAD_DEG,
  };
  const t0 = Date.now();
  const m = store.load(box);
  const t1 = Date.now();
  const blocked = blockedTriangles(m, rules);
  let nBlocked = 0;
  for (let t = 0; t < m.n; t++) nBlocked += blocked[t];
  const [sx, sy] = toMeshXY(m, start[0], start[1]);
  const [ex, ey] = toMeshXY(m, end[0], end[1]);
  const st = locateTile(store, m, start[0], start[1], sx, sy);
  const et = locateTile(store, m, end[0], end[1], ex, ey);
  const t2 = Date.now();
  const stats: MeshRouteStats = {
    trianglesLoaded: m.n,
    blocked: nBlocked,
    expanded: 0,
    readMs: t1 - t0,
    prepMs: t2 - t1,
    searchMs: 0,
    funnelMs: 0,
  };
  if (st < 0 || et < 0) return { ok: false, reason: `${st < 0 ? 'start' : 'end'} point is not in a mesh triangle`, stats };
  if (blocked[st] || blocked[et]) return { ok: false, reason: `${blocked[st] ? 'start' : 'end'} point is in a blocked triangle`, stats };
  const r = meshAstar(m, blocked, st, et, sx, sy, ex, ey, rules.motorSpeedMs);
  const t3 = Date.now();
  stats.expanded = r.expanded;
  stats.searchMs = t3 - t2;
  if (r.goalNode === -2) return { ok: false, reason: 'no route on the mesh', stats };
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
  return { ok: true, path, widths, lengthM, costS: r.goalG, stats };
}
