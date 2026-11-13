/**
 * Where a leg from one district's chart mesh to another's changes meshes, where the two overlap
 * (docs/drafts/mesh-no-gshhg-design.md, part 5 step 2): the leg stays on the charts the whole way, no coastline.
 *
 * A transfer point is a triangle of the start's mesh (A), in a tile whose extent meets one of the end's mesh (B),
 * whose centre both meshes call usable for this boat under the leg's rules (B: a usable triangle holds it), and whose
 * water in B connects to the leg's end (B's rough cut, PieceGraph). Neighbouring districts' charts mostly agree in
 * their overlap, but not everywhere (measured 2026-10-12 on brain, 100 points per shared tile under the same rules:
 * 07CGD/08CGD 3.6% of points usable in one and blocked in the other, 01CGD/05CGD 3.2%, 05CGD/07CGD 0.1%), so a point
 * only one calls usable is never used.
 *
 * Whether a transfer point exists is answered first from the two rough cuts (coarse.ts PieceGraph), before any
 * search: only tiles of A holding water connected to the start that meet tiles of B holding water connected to the
 * end can hold one (known from the rough cuts without reading a tile); those are read once, and only A's water
 * connected to the start is tested, until one passes. A
 * search on A with no reachable goal would read every triangle connected to the start before saying no (measured on
 * brain, 2026-10-12, Miami towards an end on 0 m water: 289 s, 3.1 GB). When one exists, the mesh search on A goes
 * from the start to the cheapest transfer point, each costed as its route on A plus the straight run from it to the
 * end (which never overestimates the rest on B); the rough cut's "connected" is the search's, so it finds one. B's
 * tiles are dropped once no tile of A held meets them. The leg is then planned on A to that point and on B from it
 * (pipeline.ts); the final depth check walks both meshes, and a stretch either calls unusable fails the route
 * (check.ts).
 *
 * Where the two do not connect in their overlap (or do not overlap), the leg crosses the gap on the coastline search
 * (findMeshGap), with the part 5 exits from both sides: the coastline's water, outside both meshes, is flooded from
 * B's edge sides whose water connects to the end; A's exits are its edge sides on water connected to the start (A's
 * rough cut) that this water reaches, the cheapest towards the end chosen by the search on A; B's entry by the search
 * on B from the end towards the exit, among B's sides that the water from A's exit reaches. Each search runs only when
 * the rough cuts say its goals are connected to where it starts. The coastline part runs between them with both
 * meshes' water as land.
 */

import type { CellMask, LandMask } from '../../geo/landmask';
import { cellOf } from '../../geo/landmask';
import { DROP_EVERY, meshAstar } from './astar';
import { emptyMask, floodFree, forEachEdgeSide, isFree, markMeshWater } from './exit';
import { type CoarseMap, PieceGraph } from './coarse';
import { type BoundarySeeds, PagedMesh } from './paged';
import type { MeshRules } from './route';
import { type MeshStore, tileExtentsMeet as meets } from './store';

export interface TransferMesh {
  store: MeshStore;
  /** The rough cut's tile-boundary record for this boat (seeds the buffer across tile edges). */
  boundary: BoundarySeeds | null;
  /** The rough cut for the leg's rules (without the areas to avoid: PieceGraph applies them). */
  map: CoarseMap;
  /** For the messages. */
  name: string;
}

export type MeshTransferResult =
  | {
      ok: true;
      /** Where the leg changes meshes: the transfer triangle's centre, [lon, lat]. */
      point: [number, number];
      /**
       * Tiles of A whose extent meets one of B's; of those, the ones the rough cuts say can hold a transfer point;
       * triangles tested there; of those, transfer points.
       */
      sharedTiles: number;
      candidateTiles: number;
      tested: number;
      transfers: number;
      expanded: number;
    }
  | { ok: false; reason: string };

export function findMeshTransfer(
  from: TransferMesh,
  to: TransferMesh,
  rules: MeshRules,
  start: [number, number],
  end: [number, number],
  names: { start: string; end: string }
): MeshTransferResult {
  // One frame for both meshes (the leg's, laid out about its start: paged.ts centred), so a point of A is the same point of B.
  const cl = Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const pa = new PagedMesh(from.store, rules, cl, from.boundary).centred(start[0]);
  const pb = new PagedMesh(to.store, rules, cl, to.boundary).centred(start[0]);
  const wa = waterOf(pa, from.map);
  const wb = waterOf(pb, to.map);
  const ga = wa.groupOf;
  const gb = wb.groupOf;
  const [sx, sy] = pa.toXY(start[0], start[1]);
  const starts = pa.locateAll(sx, sy);
  if (!starts.length) return { ok: false, reason: `${names.start} is not on water this boat can use on ${from.name}` };
  const startGroups = groupsAt(ga, starts);
  const endGroups = endGroupsOn(pb, gb, end);
  if (!endGroups.length) return { ok: false, reason: `${to.name} has no water this boat can use` };
  const bBoxes = to.store.index.tiles.map(t => t.bbox);
  let sharedTiles = 0;
  for (let idx = 0; idx < pa.tileCount; idx++) {
    const a = pa.infoAt(idx)!.bbox;
    if (bBoxes.some(b => meets(a, b))) sharedTiles++;
  }
  if (!sharedTiles) return { ok: false, reason: `the chart meshes ${from.name} and ${to.name} do not overlap` };
  // The tiles that can hold a transfer point, from the rough cuts alone.
  const endBoxes = [...wb.graph.tilesOf(endGroups)].map(idx => pb.infoAt(idx)!.bbox);
  const shared = [...wa.graph.tilesOf(startGroups)].filter(idx => endBoxes.some(b => meets(pa.infoAt(idx)!.bbox, b)));
  const sharedSet = new Set(shared);
  const [ex, ey] = pb.toXY(end[0], end[1]);
  const memo = new Map<number, { x: number; y: number; restS: number } | null>();
  let tested = 0;
  let transfers = 0;
  /** B's tiles go once no tile of A held meets them. */
  const dropB = (): void => {
    const held = pa.heldTiles().map(i => pa.infoAt(i)!.bbox);
    for (const idx of pb.heldTiles()) if (!held.some(a => meets(a, pb.infoAt(idx)!.bbox))) pb.drop(idx);
  };
  const transferAt = {
    get: (t: number): { x: number; y: number; restS: number } | undefined => {
      const known = memo.get(t);
      if (known !== undefined) return known ?? undefined;
      let e: { x: number; y: number; restS: number } | null = null;
      const T = pa.tileOf(t);
      if (sharedSet.has(T.idx) && startGroups.includes(ga(t) ?? -1)) {
        const q = (t - T.first) * 3;
        const cx = (T.x[q] + T.x[q + 1] + T.x[q + 2]) / 3;
        const cy = (T.y[q] + T.y[q + 1] + T.y[q + 2]) / 3;
        const [lon, lat] = pa.fromXY(cx, cy);
        tested++;
        // Each leg part is planned on the mesh covering its ends (the runner's choice), so both must cover the point.
        if (from.store.covers(lon, lat) && to.store.covers(lon, lat) && pb.locateAll(cx, cy).some(g => endGroups.includes(gb(g) ?? -1))) {
          e = { x: cx, y: cy, restS: Math.hypot(ex - cx, ey - cy) / rules.motorSpeedMs };
          transfers++;
        }
        if (tested % DROP_EVERY === 0) dropB();
      }
      memo.set(t, e);
      return e ?? undefined;
    },
  };
  // Is there one at all? The shared tiles once, A's water connected to the start only, until one passes.
  let exists = false;
  for (const idx of shared) {
    const held = pa.isHeld(idx);
    const T = pa.tile(idx);
    for (let l = 0; l < T.n && !exists; l++) if (!T.blocked[l] && transferAt.get(T.first + l)) exists = true;
    if (!held) pa.drop(idx);
    dropB();
    if (exists) break;
  }
  if (!exists)
    return {
      ok: false,
      reason: `no water on ${from.name} connects ${names.start} to water that both ${from.name} and ${to.name} call usable for this boat and that connects on ${to.name} to ${names.end}`,
    };
  const res = meshAstar(pa, starts, [], sx, sy, ex, ey, rules.motorSpeedMs, transferAt);
  if (res.goalNode === -2 || res.goalTri < 0)
    return {
      ok: false,
      reason: `the rough cut of ${from.name} says water connects ${names.start} to where it meets ${to.name}, but the search found none; rebuild the rough cut in the plugin configuration`,
    };
  const e = memo.get(res.goalTri)!;
  return { ok: true, point: pa.fromXY(e.x, e.y), sharedTiles, candidateTiles: shared.length, tested, transfers, expanded: res.expanded };
}

/** A mesh's rough cut as the request sees it, and the connected group of a triangle on it (null: blocked). */
function waterOf(pm: PagedMesh, map: CoarseMap): { graph: PieceGraph; groupOf: (g: number) => number | null } {
  const graph = new PieceGraph(map, pm);
  return {
    graph,
    groupOf: g => {
      const p = graph.pieceOf(g);
      return p === null ? null : graph.component(p);
    },
  };
}

/** The groups of the given triangles. */
function groupsAt(groupOf: (g: number) => number | null, tris: number[]): number[] {
  return [...new Set(tris.map(groupOf))].filter((c): c is number => c !== null);
}

/**
 * The end's water on B: the groups its point touches, or that of the usable water nearest it (an approximate end on
 * water the boat cannot use); none when B has no usable water.
 */
function endGroupsOn(pb: PagedMesh, groupOf: (g: number) => number | null, end: [number, number]): number[] {
  const [ex, ey] = pb.toXY(end[0], end[1]);
  const endGroups = groupsAt(groupOf, pb.locateAll(ex, ey));
  if (!endGroups.length) {
    const nu = pb.nearestUsable(ex, ey);
    if (nu) endGroups.push(groupOf(nu.tri)!);
  }
  return endGroups;
}

export type MeshGapResult =
  | {
      ok: true;
      /** Where the leg leaves A and enters B: the middles of the sides crossed (on each mesh), [lon, lat]. */
      exit: [number, number];
      entry: [number, number];
      /** A's sides the coastline's water from B reaches; B's sides the water from the exit reaches. */
      exits: number;
      entries: number;
      /** Both meshes' water on the coastline raster (1 = a mesh triangle holds the cell's centre), the exit's and entry's cells cleared. */
      mask: CellMask;
    }
  | { ok: false; reason: string };

/** A leg from mesh A to mesh B across water neither charts (see the header): A's exit and B's entry. */
export function findMeshGap(
  from: TransferMesh,
  to: TransferMesh,
  rules: MeshRules,
  /** The coastline search's land for the leg's area (its raster, at its resolution, with its land buffer). */
  land: LandMask,
  start: [number, number],
  end: [number, number],
  names: { start: string; end: string }
): MeshGapResult {
  const cl = Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const pa = new PagedMesh(from.store, rules, cl, from.boundary).centred(start[0]);
  const pb = new PagedMesh(to.store, rules, cl, to.boundary).centred(start[0]);
  const wa = waterOf(pa, from.map);
  const wb = waterOf(pb, to.map);
  const ga = wa.groupOf;
  const groupOf = wb.groupOf;
  const [sx, sy] = pa.toXY(start[0], start[1]);
  const starts = pa.locateAll(sx, sy);
  if (!starts.length) return { ok: false, reason: `${names.start} is not on water this boat can use on ${from.name}` };
  const startGroups = groupsAt(ga, starts);
  const endGroups = endGroupsOn(pb, groupOf, end);
  if (!endGroups.length) return { ok: false, reason: `${to.name} has no water this boat can use` };
  const mask = emptyMask(land);
  markMeshWater(from.store, mask);
  markMeshWater(to.store, mask);
  // B's sides on water connected to the end whose outside is the coastline's water: the flood's seeds.
  const sides = new Map<number, { x: number; y: number; cell: number }>();
  forEachEdgeSide(
    pb,
    mask,
    (g, mx, my, c) => {
      if (c < 0 || !isFree(land, mask, c) || !endGroups.includes(groupOf(g) ?? -1)) return;
      if (!sides.has(g)) sides.set(g, { x: mx, y: my, cell: c });
    },
    wb.graph.tilesOf(endGroups)
  );
  if (!sides.size)
    return {
      ok: false,
      reason: `no water on ${to.name} that this boat can use and that connects to ${names.end} meets the coastline's water within the area`,
    };
  const reached = floodFree(
    land,
    mask,
    [...sides.values()].map(v => v.cell)
  );
  // A's exits: sides on water connected to the start whose outside that water reaches, each costed on to the end by
  // the straight run.
  const [ex, ey] = pa.toXY(end[0], end[1]);
  const exits = new Map<number, { x: number; y: number; restS: number; cell: number }>();
  forEachEdgeSide(
    pa,
    mask,
    (g, mx, my, c) => {
      if (c < 0 || !reached[c] || !startGroups.includes(ga(g) ?? -1)) return;
      const restS = Math.hypot(ex - mx, ey - my) / rules.motorSpeedMs;
      const prev = exits.get(g);
      if (!prev || restS < prev.restS) exits.set(g, { x: mx, y: my, restS, cell: c });
    },
    wa.graph.tilesOf(startGroups)
  );
  if (!exits.size)
    return {
      ok: false,
      reason: `the coastline's water from ${to.name}'s water that connects to ${names.end} meets no water on ${from.name} that connects to ${names.start}, within the area`,
    };
  const ra = meshAstar(pa, starts, [], sx, sy, ex, ey, rules.motorSpeedMs, exits);
  if (ra.goalNode === -2 || ra.goalTri < 0)
    return {
      ok: false,
      reason: `the rough cut of ${from.name} says water connects ${names.start} to where its charts meet the coastline's water, but the search found none; rebuild the rough cut in the plugin configuration`,
    };
  const x = exits.get(ra.goalTri)!;
  // B's entries: its sides on the end's water that the coastline's water from the exit reaches.
  const fromExit = floodFree(land, mask, [x.cell]);
  const entries = new Map<number, { x: number; y: number; restS: number }>();
  for (const [g, v] of sides)
    if (fromExit[v.cell]) entries.set(g, { x: v.x, y: v.y, restS: Math.hypot(v.x - x.x, v.y - x.y) / rules.motorSpeedMs });
  // The search on B from the end (its usable triangles, or the usable water nearest it on the end's water).
  const [bx, by] = pb.toXY(end[0], end[1]);
  let ends = pb.locateAll(bx, by).filter(g => endGroups.includes(groupOf(g) ?? -1));
  let [fx, fy] = [bx, by];
  if (!ends.length) {
    const nu = pb.nearestUsable(bx, by, g => endGroups.includes(groupOf(g) ?? -1))!;
    ends = [nu.tri];
    [fx, fy] = [nu.x, nu.y];
  }
  const rb = meshAstar(pb, ends, [], fx, fy, x.x, x.y, rules.motorSpeedMs, entries);
  if (rb.goalNode === -2 || rb.goalTri < 0)
    return {
      ok: false,
      reason: `the rough cut of ${to.name} says water connects ${names.end} to where its charts meet the coastline's water, but the search found none; rebuild the rough cut in the plugin configuration`,
    };
  const y = entries.get(rb.goalTri)!;
  const exit = pa.fromXY(x.x, x.y);
  const entry = pb.fromXY(y.x, y.y);
  // The cells the leg crosses in belong to the coastline search too (where it meets each mesh).
  for (const p of [exit, entry]) {
    const c = cellOf(mask, p[0], p[1]);
    if (c >= 0) mask.cells[c] = 0;
  }
  return { ok: true, exit, entry, exits: exits.size, entries: entries.size, mask };
}
