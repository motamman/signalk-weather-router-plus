/**
 * The chart meshes' area as land for the coastline search over a search world (docs/drafts/mesh-no-gshhg-design.md
 * part 5: every mesh's water is land to the coastline search, wherever the search can reach): a LandMask whose base,
 * over the whole world, marks every cell whose centre a mesh's tile holds (the tiles' extents from the indexes, the
 * mesh's own rule for the points it covers, store.ts MeshStore.covers; cautious, as a tile holds its land too, which
 * is land anyway), and whose one patch is `exact`, the meshes' triangles over the leg's box as the waters plan marked
 * them (waters.ts markMeshWater), the finer answering first (landmask.ts fromCellMasks). Until 2026-11-07 the search
 * had the exact mask alone, over the leg's box (the chain plus a degree), while its world is wider by the heading
 * sweep's reach: the charts of a mesh further off were open water to it, judged by the coastline alone (PR #7 review).
 *
 * Why the extents and not the triangles over the world: measured on brain (2026-11-07, a script over the installed
 * meshes, not in the repo), marking every mesh's triangles over a 120° × 65° world took 54.6 s and over a 22° × 22°
 * world 27.7 s, against 3.8 s over a 3° × 3° leg box; the extents are in the indexes already. Where a tile holds open
 * water of the coastline's that no triangle covers, that water is land to the search outside the leg's box; inside it
 * the triangles decide.
 */

import type { BBox } from '../../geo/geodesy';
import { bboxWidth, wrapLon } from '../../geo/geodesy';
import { lonOffset } from '../../geo/angles';
import { type CellMask, LandMask } from '../../geo/landmask';

/** A tile's extent [west, south, east, north], as a mesh's index lists its tiles (store.ts MeshTileInfo.bbox). */
export type TileExtent = { bbox: [number, number, number, number] };

/** A grid of cells to mark: its west and south edges, its cell size and its size. */
interface Grid {
  west: number;
  south: number;
  res: number;
  nx: number;
  ny: number;
  cells: Uint8Array;
}

/** Mark every cell of `g` whose centre a tile's extent holds (a point on the extent's edge counts, as MeshStore.covers). */
function markTileExtents(g: Grid, tiles: readonly TileExtent[]): void {
  const widthDeg = g.nx * g.res;
  for (const t of tiles) {
    const [w, s, e, n] = t.bbox;
    const j0 = Math.max(0, Math.ceil((s - g.south) / g.res - 0.5));
    const j1 = Math.min(g.ny - 1, Math.floor((n - g.south) / g.res - 0.5));
    if (j1 < j0) continue;
    // The extent's columns, eastward from the grid's west edge; one that starts beyond the grid's east edge can still
    // reach into the grid from its west (round the globe).
    const o0 = lonOffset(w, g.west);
    const o1 = o0 + (e - w);
    const spans: [number, number][] = [[o0, o1]];
    if (o1 > 360) spans.push([0, o1 - 360]);
    for (const [a, b] of spans) {
      const i0 = Math.max(0, Math.ceil(a / g.res - 0.5));
      const i1 = Math.min(g.nx - 1, Math.floor(Math.min(b, widthDeg) / g.res - 0.5));
      if (i1 < i0) continue;
      for (let j = j0; j <= j1; j++) g.cells.fill(1, j * g.nx + i0, j * g.nx + i1 + 1);
    }
  }
}

/**
 * The meshes' area as land over `world` (see the file's comment): the base at the fewest cells within `maxCells` (the
 * land mask's own cell budget) at a whole multiple of `exact`'s cell size, starting on `exact`'s west and south edges,
 * so `exact` covers whole base cells; `exact` widened to whole base cells with the base's rule in the cells added.
 * `exact` lies inside `world` (the leg's box inside the search's world, pipeline.ts chartsLeg). `tiles`: every mesh's
 * tiles (those off the world mark nothing).
 */
export function meshAreaLand(tiles: readonly TileExtent[], world: BBox, exact: CellMask, maxCells: number): LandMask {
  const rp = exact.resolutionDeg;
  const w = bboxWidth(world);
  const h = world.north - world.south;
  // The world's edges as offsets from the exact mask's west and south edges, degrees in one frame: its west at or
  // west of the exact mask's (not positive), its east beyond, so a world across the date line, or as wide as the
  // globe, is counted as any other.
  const westOff = -lonOffset(exact.bbox.west, world.west);
  const eastOff = westOff + w;
  const southOff = world.south - exact.bbox.south;
  const northOff = world.north - exact.bbox.south;
  /** The base at `k` exact cells a side: whole cells west and south of the exact mask's edges to the world's, and from them to the world's east and north edges; at most one turn of the globe. */
  const dims = (k: number): Omit<Grid, 'cells'> => {
    const res = rp * k;
    const cW = Math.ceil(-westOff / res);
    const cS = Math.ceil(-southOff / res);
    return {
      west: wrapLon(exact.bbox.west - cW * res),
      south: exact.bbox.south - cS * res,
      res,
      nx: Math.min(Math.ceil(360 / res), cW + Math.ceil(eastOff / res)),
      ny: cS + Math.ceil(northOff / res),
    };
  };
  // The fewest cells a side within the budget: from what the world's area alone needs (a lower bound: the base holds
  // whole cells, so it can hold more), up to the first size whose base fits.
  let k = Math.max(1, Math.ceil(Math.sqrt((w * h) / (rp * rp * maxCells))));
  let d = dims(k);
  while (d.nx * d.ny > maxCells) d = dims(++k);
  const base: Grid = { ...d, cells: new Uint8Array(d.nx * d.ny) };
  markTileExtents(base, tiles);
  // The exact mask widened to whole base cells: the cells added take the base's rule at the exact mask's own size.
  const nxE = Math.ceil(exact.nx / k) * k;
  const nyE = Math.ceil(exact.ny / k) * k;
  const patch: Grid = { west: exact.bbox.west, south: exact.bbox.south, res: rp, nx: nxE, ny: nyE, cells: new Uint8Array(nxE * nyE) };
  markTileExtents(patch, tiles);
  for (let j = 0; j < exact.ny; j++) patch.cells.set(exact.cells.subarray(j * exact.nx, (j + 1) * exact.nx), j * nxE);
  const mask = (g: Grid): CellMask => ({
    bbox: { west: g.west, south: g.south, east: wrapLon(g.west + g.nx * g.res), north: g.south + g.ny * g.res },
    resolutionDeg: g.res,
    nx: g.nx,
    ny: g.ny,
    cells: g.cells,
  });
  return LandMask.fromCellMasks(mask(base), [mask(patch)]);
}
