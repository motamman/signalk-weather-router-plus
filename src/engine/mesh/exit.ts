/**
 * Where a leg leaves the chart mesh (docs/drafts/mesh-no-gshhg-design.md, part 5): the exits, and the one the leg
 * takes.
 *
 * The mesh decides wherever it has triangles; the coastline data (GSHHG) decides only where it has none. A mesh edge
 * (a triangle side with no neighbour) is the same whether the charts end there or the land begins, so the exits are
 * found from the other side: the coastline's water is flooded from the leg's far end (outside every mesh), on the
 * coastline search's own raster for the leg (its resolution, its land buffer), never entering a cell whose centre a
 * mesh triangle holds (the mesh's water, which the coastline search must not enter). An exit is a side of water the
 * boat can use on the mesh, with no neighbour, whose outside (half a raster cell out: the raster's own resolution)
 * the flood reaches. A shoreline's outside is land to the coastline data, or a sliver of its water that connects to
 * nothing outside the mesh, so it is no exit.
 *
 * The leg's exit: the mesh search from the stop inside the mesh to any exit, each costed as its mesh route plus the
 * straight run from it to the far end (which never overestimates the rest), so the cheapest way out towards the far
 * end. Only sides on water the rough cut (coarse.ts PieceGraph) connects to the stop count, looked for only in the
 * tiles holding that water; when there are none the leg fails before any search (a search with no reachable exit
 * would read every triangle connected to the stop first; the same fault took 289 s and 3.1 GB on the two-mesh search,
 * transfer.ts). The coastline part starts there, with the mesh's water as land (the cell mask returned; the exit's own cell is
 * left to the coastline search, where the two meet).
 *
 * Measured first (2026-10-12, a read-only experiment on brain, Lake Superior, 09CGD): 11,726 exits of 42,265 sides of
 * usable mesh water at its edge, none on charted depth of 2 m or less; the Marquette harbour stop reached the exit
 * nearest the trips' end (Canadian water) in 86.0 nm on the mesh.
 */

import { unwrapLonNear } from '../../geo/angles';
import { bboxWidth, boxesMeet, haversineDistanceM } from '../../geo/geodesy';
import { cellOf, type CellMask, type LandMask } from '../../geo/landmask';
import { meshAstar } from './astar';
import { type CoarseMap, PieceGraph } from './coarse';
import { type BoundarySeeds, PagedMesh } from './paged';
import type { MeshRules } from './route';
import { M_PER_DEG_MESH, type MeshStore, tileBBox } from './store';

export type MeshExitResult =
  | {
      ok: true;
      /** Where the leg crosses: the middle of the exit side (on the mesh), [lon, lat]. */
      exit: [number, number];
      /** How many exits the flood found in the area. */
      exits: number;
      /** The mesh's water on the coastline raster (1 = a mesh triangle holds the cell's centre), the exit's cell cleared. */
      mask: CellMask;
    }
  | { ok: false; reason: string };

export function findMeshExit(
  store: MeshStore,
  rules: MeshRules,
  boundary: BoundarySeeds | null,
  /** The mesh's rough cut for the leg's rules (without the areas to avoid: PieceGraph applies them). */
  map: CoarseMap,
  /** The coastline search's land for the leg's area (its raster, at its resolution, with its land buffer). */
  land: LandMask,
  /** The leg's end inside the mesh, and its end outside every mesh. */
  inside: [number, number],
  outside: [number, number],
  names: { inside: string; outside: string }
): MeshExitResult {
  const cl = Math.cos((((inside[1] + outside[1]) / 2) * Math.PI) / 180);
  const pm = new PagedMesh(store, rules, cl, boundary);
  // The stop's water on the rough cut, and the tiles holding it.
  const [sx, sy] = pm.toXY(inside[0], inside[1]);
  const starts = pm.locateAll(sx, sy);
  if (!starts.length) return { ok: false, reason: `${names.inside} is not on water this boat can use on the chart mesh` };
  const graph = new PieceGraph(map, pm);
  const groupOf = (g: number): number | null => {
    const p = graph.pieceOf(g);
    return p === null ? null : graph.component(p);
  };
  const startGroups = [...new Set(starts.map(groupOf))].filter((c): c is number => c !== null);
  const mask = emptyMask(land);
  markMeshWater(store, mask);
  // The coastline's water outside the mesh, flooded from the far end.
  const start = cellOf(mask, outside[0], outside[1]);
  if (start < 0 || !isFree(land, mask, start))
    return { ok: false, reason: `${names.outside} is not on open water to the coastline data outside the chart mesh` };
  const reached = floodFree(land, mask, [start]);
  // The exits: sides of mesh water connected to the stop with no neighbour whose outside the flood reached.
  const [ox, oy] = pm.toXY(outside[0], outside[1]);
  const exits = new Map<number, { x: number; y: number; restS: number }>();
  forEachEdgeSide(
    pm,
    mask,
    (g, mx, my, c) => {
      if (c < 0 || !reached[c] || !startGroups.includes(groupOf(g) ?? -1)) return;
      const [mLon, mLat] = pm.fromXY(mx, my);
      const restS = haversineDistanceM(mLon, mLat, outside[0], outside[1]) / rules.motorSpeedMs;
      const prev = exits.get(g);
      if (!prev || restS < prev.restS) exits.set(g, { x: mx, y: my, restS });
    },
    graph.tilesOf(startGroups)
  );
  if (!exits.size)
    return {
      ok: false,
      reason: `no water on the chart mesh connects ${names.inside} to where the charts meet the water that reaches ${names.outside}, within the area`,
    };
  // The mesh search from the stop to the cheapest exit towards the far end.
  const res = meshAstar(pm, starts, [], sx, sy, ox, oy, rules.motorSpeedMs, exits);
  if (res.goalNode === -2 || res.goalTri < 0)
    return {
      ok: false,
      reason: `the rough cut says water connects ${names.inside} to where the charts meet the water that reaches ${names.outside}, but the search found none; rebuild the rough cut in the plugin configuration`,
    };
  const e = exits.get(res.goalTri)!;
  const exit = pm.fromXY(e.x, e.y);
  // The cell the leg crosses in belongs to the coastline search too (where the two meet).
  const ec = cellOf(mask, exit[0], exit[1]);
  if (ec >= 0) mask.cells[ec] = 0;
  return { ok: true, exit, exits: exits.size, mask };
}

/** An empty cell mask on the coastline search's raster. */
export function emptyMask(land: LandMask): CellMask {
  return { bbox: land.bbox, resolutionDeg: land.resolutionDeg, nx: land.nx, ny: land.ny, cells: new Uint8Array(land.nx * land.ny) };
}

/**
 * A mesh's water on the raster: every cell whose centre a triangle of the mesh holds is set in the mask. The raster's
 * box may cross the date line (its west greater than its east) and so may the mesh: the triangles' longitudes are taken
 * next to the raster's middle, so they and the cells' centres (counted east from the raster's west edge) are one run
 * of numbers; in a raster and a mesh that do not cross, the longitudes as they are.
 */
export function markMeshWater(store: MeshStore, mask: CellMask): void {
  const box = mask.bbox;
  const r = mask.resolutionDeg;
  const { nx, ny } = mask;
  const K = store.index.xScale;
  const mid = box.west + bboxWidth(box) / 2;
  const tiles = store.index.tiles.filter(t => boxesMeet(tileBBox(t.bbox), box));
  for (const info of tiles) {
    const t = store.readTileArrays(info);
    for (let a = 0; a < t.n; a++) {
      const c = a * 6;
      const xs = [unwrapLonNear(t.corners[c] / K, mid), unwrapLonNear(t.corners[c + 2] / K, mid), unwrapLonNear(t.corners[c + 4] / K, mid)];
      const ys = [t.corners[c + 1], t.corners[c + 3], t.corners[c + 5]];
      const i0 = Math.max(0, Math.floor((Math.min(...xs) - box.west) / r));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(...xs) - box.west) / r));
      const j0 = Math.max(0, Math.floor((Math.min(...ys) - box.south) / r));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(...ys) - box.south) / r));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const px = box.west + (i + 0.5) * r;
          const py = box.south + (j + 0.5) * r;
          const d1 = (xs[1] - xs[0]) * (py - ys[0]) - (ys[1] - ys[0]) * (px - xs[0]);
          const d2 = (xs[2] - xs[1]) * (py - ys[1]) - (ys[2] - ys[1]) * (px - xs[1]);
          const d3 = (xs[0] - xs[2]) * (py - ys[2]) - (ys[0] - ys[2]) * (px - xs[2]);
          if (d1 >= 0 && d2 >= 0 && d3 >= 0) mask.cells[j * nx + i] = 1;
        }
    }
  }
}

/** The coastline's water outside the meshes: not land to it, and not mesh water. */
export function isFree(land: LandMask, mask: CellMask, c: number): boolean {
  return land.raster[c] === 0 && mask.cells[c] === 0;
}

/** The coastline's water outside the meshes reached from the seed cells (4-connected). */
export function floodFree(land: LandMask, mask: CellMask, seeds: number[]): Uint8Array {
  const { nx, ny } = mask;
  const reached = new Uint8Array(nx * ny);
  const queue = new Int32Array(nx * ny);
  let qh = 0;
  let qt = 0;
  const visit = (n: number): void => {
    if (reached[n] || !isFree(land, mask, n)) return;
    reached[n] = 1;
    queue[qt++] = n;
  };
  for (const s of seeds) visit(s);
  while (qh < qt) {
    const c = queue[qh++];
    const i = c % nx;
    const j = (c - i) / nx;
    if (i > 0) visit(c - 1);
    if (i < nx - 1) visit(c + 1);
    if (j > 0) visit(c - nx);
    if (j < ny - 1) visit(c + nx);
  }
  return reached;
}

/**
 * Every side of usable mesh water with no neighbour, in the tiles meeting the mask's box: its triangle (global id),
 * the side's middle (the mesh's frame), and the raster cell half a cell outside it (-1 off the raster; half a cell is
 * the raster's own resolution, the narrower east-west way). Each tile is let go once scanned.
 */
export function forEachEdgeSide(
  pm: PagedMesh,
  mask: CellMask,
  fn: (g: number, mx: number, my: number, cell: number) => void,
  /** Only these tiles (positions in the tile list), when given. */
  only?: Set<number>
): void {
  const box = mask.bbox;
  const half = (mask.resolutionDeg / 2) * M_PER_DEG_MESH * pm.cl;
  for (let idx = 0; idx < pm.tileCount; idx++) {
    if (only && !only.has(idx)) continue;
    const info = pm.infoAt(idx)!;
    if (!boxesMeet(tileBBox(info.bbox), box)) continue;
    const held = pm.isHeld(idx);
    const T = pm.tile(idx);
    for (let l = 0; l < T.n; l++) {
      if (T.blocked[l]) continue;
      for (let k = 0; k < 3; k++) {
        if (T.nb[l * 3 + k] >= 0) continue;
        const a = l * 3 + k;
        const b = l * 3 + ((k + 1) % 3);
        const dx = T.x[b] - T.x[a];
        const dy = T.y[b] - T.y[a];
        const L = Math.hypot(dx, dy);
        if (!(L > 0)) continue;
        const mx = (T.x[a] + T.x[b]) / 2;
        const my = (T.y[a] + T.y[b]) / 2;
        // Corners wind counter-clockwise: the outside is to the right of the side.
        const [lon, lat] = pm.fromXY(mx + (dy / L) * half, my - (dx / L) * half);
        fn(T.first + l, mx, my, cellOf(mask, lon, lat));
      }
    }
    if (!held) pm.drop(idx);
  }
}
