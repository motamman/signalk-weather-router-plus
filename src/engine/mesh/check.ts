/**
 * The final depth check (docs/drafts/mesh-no-gshhg-design.md, part 1): a
 * finished route walked through the chart meshes, every straight segment
 * triangle by triangle with the walk the routers test their moves with
 * (land.ts forEachTriangleAlong), not sampled, so a triangle of a square
 * metre is not stepped over. A triangle the boat cannot use under the
 * route's rules (route.ts blockedTriangles: depth, clearance, hazard,
 * mark, structure, opening bridge under Drawbridges = Avoid, area to
 * avoid; no buffer: the buffer is a margin, not a depth) is a violation;
 * the caller repairs the segment it is on (worker/route.ts
 * repairViolations) and fails the route on any left. Where no mesh triangle is, the
 * stretch is counted as outside the mesh and not judged: a mesh edge with
 * no neighbour is either land or the end of the charts, and the mesh does
 * not say which (part 5).
 *
 * Tiles are read as the walk reaches them (paged.ts) and dropped once it
 * has passed them (long segments are cut into pieces first, and only the
 * tiles meeting the piece walked are kept); the plugin runs it in a child
 * process (plugin/meshchecktask.ts).
 */

import { unwrapLonNear } from '../../geo/angles';
import { bboxFromLonLat, boxesMeet, haversineDistanceM, wrapEdge, type BBox } from '../../geo/geodesy';
import { DEFAULT_OVERHEAD_M, DEFAULT_UKC_M } from '../../vessel/vessel';
import type { LegDepth } from '../route';
import { MeshLand } from './land';
import { PagedMesh } from './paged';
import type { MeshRules } from './route';
import {
  FLAG_CHANNEL_MARK,
  FLAG_DREDGED,
  FLAG_FAIRWAY,
  FLAG_HAZARD,
  FLAG_MARK,
  FLAG_NAVIGABLE,
  FLAG_OPENING_BRIDGE,
  FLAG_STRUCTURE,
  type MeshStore,
  NO_VALUE,
  tileBBox,
} from './store';

/** The rules the route was planned with, as far as they decide what is blocked. */
export type CheckRules = Pick<
  MeshRules,
  'draughtM' | 'airDraftM' | 'openingBridges' | 'avoid' | 'underKeelClearanceM' | 'overheadClearanceM'
>;

export type ViolationKind = 'depth' | 'hazard' | 'clearance' | 'opening bridge' | 'mark' | 'structure' | 'area to avoid';

/** The first triangle of a run of blocked triangles along the route. */
export interface DepthViolation {
  leg: number;
  /** The route segment it is on: waypoint `segment` → `segment + 1` of the checked path (for the repair). */
  segment: number;
  lon: number;
  lat: number;
  kind: ViolationKind;
  /** The charted depth (depth), the hazard's charted depth (hazard; null when none is charted), the clearance (clearance); else null. */
  value: number | null;
}

export interface RouteDepthCheck {
  legs: LegDepth[];
  violations: DepthViolation[];
}

/** Longest piece a segment is cut into, metres: the tiles a piece meets are the ones held while it is walked. */
const PIECE_M = 5000;
/** Step along a piece where no triangle is, metres, looking for the mesh again. */
const GAP_STEP_M = 10;
/** Past the point a walk stopped at (a mesh edge), metres. */
const NUDGE_M = 0.5;

interface Piece {
  a: [number, number];
  b: [number, number];
  leg: number;
  /** The path segment the piece is cut from (path[seg] → path[seg + 1]). */
  seg: number;
  lengthM: number;
  /** Covered stretches as fractions of the piece [from, to), each with what covers it, in walking order per store. */
  covered: { f0: number; f1: number; tri: TriInfo }[];
}

interface TriInfo {
  depth: number;
  blocked: ViolationKind | null;
  value: number | null;
}

/** Why a blocked triangle is blocked, in the order blockedTriangles tests (route.ts). */
function blockedKind(flags: number, depth: number, clear: number, hazv: number, rules: CheckRules): ViolationKind {
  const minClear = rules.airDraftM + (rules.overheadClearanceM ?? DEFAULT_OVERHEAD_M);
  const minDepth = rules.draughtM + (rules.underKeelClearanceM ?? DEFAULT_UKC_M);
  if (rules.openingBridges === 'avoid' && flags & FLAG_OPENING_BRIDGE) return 'opening bridge';
  if (clear !== NO_VALUE && clear < minClear) return 'clearance';
  if (!(flags & FLAG_NAVIGABLE) && depth !== NO_VALUE && depth < minDepth) return 'depth';
  if (flags & FLAG_HAZARD && hazv < minDepth) return 'hazard';
  if (flags & FLAG_MARK && !(flags & FLAG_CHANNEL_MARK && flags & (FLAG_FAIRWAY | FLAG_DREDGED))) return 'mark';
  if (flags & FLAG_STRUCTURE) return 'structure';
  return 'area to avoid';
}

function cutPieces(path: [number, number][], legOf: number[]): Piece[] {
  const out: Piece[] = [];
  for (let k = 1; k < path.length; k++) {
    const [a, b] = [path[k - 1], path[k]];
    const len = haversineDistanceM(a[0], a[1], b[0], b[1]);
    if (!(len > 0)) continue;
    const n = Math.max(1, Math.ceil(len / PIECE_M));
    // The segment the short way round: its end's longitude next to its start's (a segment across the date line runs
    // from 179 to 181, not back through 0).
    const bLon = unwrapLonNear(b[0], a[0]);
    for (let i = 0; i < n; i++) {
      const p0: [number, number] = [wrapEdge(a[0] + ((bLon - a[0]) * i) / n), a[1] + ((b[1] - a[1]) * i) / n];
      const p1: [number, number] = [wrapEdge(a[0] + ((bLon - a[0]) * (i + 1)) / n), a[1] + ((b[1] - a[1]) * (i + 1)) / n];
      out.push({ a: p0, b: p1, leg: legOf[k - 1], seg: k - 1, lengthM: len / n, covered: [] });
    }
  }
  return out;
}

const boxOf = (p: Piece): BBox => bboxFromLonLat([p.a[0], p.b[0]], [p.a[1], p.b[1]], 0.01);

/**
 * Add [f0, f1) to the piece. Usable water fills only what no mesh covers yet; water a mesh blocks takes its stretch
 * whatever another mesh said there (part 5: where two districts' meshes overlap and their charts disagree, a stretch
 * either calls unusable fails the route).
 */
function cover(p: Piece, f0: number, f1: number, tri: TriInfo): void {
  // The stretches already recorded that this one does not replace: all of them for usable water, the blocked ones
  // for blocked water (a blocked stretch cuts the usable ones it overlaps).
  if (tri.blocked) {
    const kept: Piece['covered'] = [];
    for (const c of p.covered) {
      if (c.tri.blocked || c.f1 <= f0 || c.f0 >= f1) kept.push(c);
      else {
        if (c.f0 < f0) kept.push({ ...c, f1: f0 });
        if (c.f1 > f1) kept.push({ ...c, f0: f1 });
      }
    }
    p.covered = kept;
  }
  let parts: [number, number][] = [[f0, f1]];
  for (const c of p.covered) {
    const next: [number, number][] = [];
    for (const [u, v] of parts) {
      if (v <= c.f0 || u >= c.f1) next.push([u, v]);
      else {
        if (u < c.f0) next.push([u, c.f0]);
        if (v > c.f1) next.push([c.f1, v]);
      }
    }
    parts = next;
    if (!parts.length) return;
  }
  for (const [u, v] of parts) if (v > u) p.covered.push({ f0: u, f1: v, tri });
}

/** Walk one piece through one paged mesh (its tiles read as the walk reaches them). */
function walkPiece(land: MeshLand, p: Piece, rules: CheckRules): void {
  const pm = land.pm;
  const info = (t: number): TriInfo => {
    const T = pm.tileOf(t);
    const l = t - T.first;
    if (!T.ruleBlocked[l]) return { depth: T.depth[l], blocked: null, value: null };
    const kind = blockedKind(T.flags[l], T.depth[l], T.clear[l], T.hazv[l], rules);
    const value =
      kind === 'depth' ? T.depth[l] : kind === 'clearance' ? T.clear[l] : kind === 'hazard' ? (T.hazv[l] <= -1e8 ? null : T.hazv[l]) : null;
    return { depth: T.depth[l], blocked: kind, value };
  };
  const [ax, ay] = pm.toXY(p.a[0], p.a[1]);
  const [bx, by] = pm.toXY(p.b[0], p.b[1]);
  const len = Math.hypot(bx - ax, by - ay);
  if (!(len > 0)) return;
  const dx = (bx - ax) / len;
  const dy = (by - ay) / len;
  let s = 0;
  while (s < len) {
    const px = ax + dx * s;
    const py = ay + dy * s;
    const s0 = s;
    const walked = land.forEachTriangleAlong(px, py, bx, by, (t, from, to) => {
      const ti = info(t);
      if (to > from) cover(p, (s0 + from) / len, (s0 + to) / len, ti);
      else if (ti.blocked) cover(p, s0 / len, Math.min(len, s0 + NUDGE_M) / len, ti);
    });
    s = walked < 0 ? s + GAP_STEP_M : s + walked + NUDGE_M;
  }
}

/**
 * Walk the route (`path`, [lon, lat] in route order; `legOf[k]` the leg of
 * segment k → k + 1) through every mesh that meets it. `legCount` legs are
 * reported, each with what it crossed.
 */
export function checkRouteOnMeshes(
  stores: MeshStore[],
  path: [number, number][],
  legOf: number[],
  legCount: number,
  rules: CheckRules
): RouteDepthCheck {
  const pieces = cutPieces(path, legOf);
  const lats = path.map(p => p[1]);
  const cl = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  for (const store of stores) {
    const ix = store.index;
    const extent: BBox = { west: ix.west, east: ix.east, south: ix.south, north: ix.north };
    const land = new MeshLand(new PagedMesh(store, { ...rules, motorSpeedMs: 1 }, cl));
    for (const p of pieces) {
      const pb = boxOf(p);
      if (!boxesMeet(pb, extent)) continue;
      // The tiles the walk has passed go: only those meeting this piece stay.
      land.pm.retain(T => boxesMeet(tileBBox(T.bbox), pb));
      walkPiece(land, p, rules);
    }
    land.release();
  }
  const legs: LegDepth[] = Array.from({ length: legCount }, (_v, leg) => ({
    leg,
    onMeshM: 0,
    unknownDepthM: 0,
    outsideMeshM: 0,
    shallowestM: null,
    shallowestAt: null,
  }));
  const violations: DepthViolation[] = [];
  let inRun = false;
  for (const p of pieces) {
    const L = legs[Math.min(p.leg, legCount - 1)];
    p.covered.sort((x, y) => x.f0 - y.f0);
    let coveredF = 0;
    let lastEnd = 0;
    for (const c of p.covered) {
      const m = (c.f1 - c.f0) * p.lengthM;
      coveredF += c.f1 - c.f0;
      L.onMeshM += m;
      if (c.tri.depth === NO_VALUE) L.unknownDepthM += m;
      else if (L.shallowestM === null || c.tri.depth < L.shallowestM) {
        L.shallowestM = c.tri.depth;
        L.shallowestAt = at(p, c.f0);
      }
      // A run of blocked triangles reports its first; a gap of usable water or no mesh ends the run.
      if (c.tri.blocked) {
        if (!inRun || c.f0 > lastEnd + 1e-9) {
          const [lon, lat] = at(p, c.f0);
          violations.push({ leg: p.leg, segment: p.seg, lon, lat, kind: c.tri.blocked, value: c.tri.value });
        }
        inRun = true;
      } else inRun = false;
      lastEnd = c.f1;
    }
    if (lastEnd < 1 - 1e-9) inRun = false;
    L.outsideMeshM += Math.max(0, 1 - coveredF) * p.lengthM;
  }
  return { legs, violations };
}

function at(p: Piece, f: number): [number, number] {
  return [wrapEdge(p.a[0] + (unwrapLonNear(p.b[0], p.a[0]) - p.a[0]) * f), p.a[1] + (p.b[1] - p.a[1]) * f];
}
