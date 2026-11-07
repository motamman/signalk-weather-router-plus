/**
 * The meshes' area as land over a search world (area.ts meshAreaLand): the tiles' extents everywhere in the world, the
 * exact mask where it covers, finest first; the exact mask widened to whole base cells with the extents' rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CellMask } from '../../geo/landmask';
import { meshAreaLand, type TileExtent } from './area';

/** A cell mask over a box at `res`, every cell 0. */
function emptyMask(west: number, south: number, nx: number, ny: number, res: number): CellMask {
  return {
    bbox: { west, south, east: west + nx * res, north: south + ny * res },
    resolutionDeg: res,
    nx,
    ny,
    cells: new Uint8Array(nx * ny),
  };
}

test('the extents are land everywhere in the world, the exact mask decides where it covers, and outside the world is land', () => {
  // Mesh A's two tiles, far west of the leg's box; mesh B's tile inside it, with triangles over its west half only;
  // mesh C's tile across the exact mask's east edge.
  const tiles: TileExtent[] = [
    { bbox: [-72, 41, -71.75, 41.25] },
    { bbox: [-71.75, 41, -71.5, 41.25] },
    { bbox: [-70.2, 41.2, -69.95, 41.45] },
    { bbox: [-69.6, 41.5, -69.3, 41.75] },
  ];
  // The leg's box: 101 × 100 cells of 0.01° (the width not a multiple of the base's 2 cells: one column is added).
  const exact = emptyMask(-70.5, 41, 101, 100, 0.01);
  for (let j = 0; j < exact.ny; j++)
    for (let i = 0; i < exact.nx; i++) {
      const lon = exact.bbox.west + (i + 0.5) * 0.01;
      const lat = exact.bbox.south + (j + 0.5) * 0.01;
      if (lon > -70.2 && lon < -70.075 && lat > 41.2 && lat < 41.45) exact.cells[j * exact.nx + i] = 1;
    }
  const world = { west: -73, south: 40, east: -69, north: 43 };
  const land = meshAreaLand(tiles, world, exact, 100_000);
  // 4° × 3° at 0.01° is 120,000 cells: merged 2 × 2 (the fewest within the budget), the base starting on the exact
  // mask's edges.
  assert.equal(land.resolutionDeg, 0.02);
  assert.equal(land.patches.length, 1);
  assert.equal(land.patches[0].resolutionDeg, 0.01);
  assert.equal(land.patches[0].bbox.west, exact.bbox.west);
  assert.equal(land.patches[0].bbox.south, exact.bbox.south);
  assert.equal(land.patches[0].nx, 102, 'widened to whole base cells');
  assert.ok(land.bbox.west <= world.west && land.bbox.south <= world.south, 'the base covers the world');
  // Mesh A, far off the leg's box: land by its extents.
  assert.equal(land.isLand(-71.9, 41.1), true);
  assert.equal(land.isLand(-71.6, 41.2), true);
  // Open water off every mesh, in the world: not land.
  assert.equal(land.isLand(-72.5, 40.5), false);
  assert.equal(land.isLand(-70.4, 42.5), false);
  // Mesh B, inside the leg's box: the triangles decide, not the extent.
  assert.equal(land.isLand(-70.15, 41.3), true, 'a triangle');
  assert.equal(land.isLand(-70.0, 41.3), false, "the extent's water with no triangle, inside the leg's box");
  // The column added east of the exact mask (-69.49 to -69.48): the extents' rule (mesh C holds it).
  assert.equal(land.isLand(-69.485, 41.6), true);
  assert.equal(land.isLand(-69.495, 41.6), false, "the exact mask's last column, no triangle marked");
  // Outside the world: land.
  assert.equal(land.isLand(-74, 41), true);
  assert.equal(land.isLand(-70, 44), true);
  // Moves: across mesh A's extent refused; along open water not; through mesh B's triangles refused.
  assert.equal(land.legCrossesRaster(-72.2, 41.1, -71.3, 41.1), true);
  assert.equal(land.legCrossesRaster(-72.5, 40.5, -70.4, 40.5), false);
  assert.equal(land.legCrossesRaster(-70.3, 41.3, -70.05, 41.3), true);
});

test('a world across the date line: an extent beyond the base’s east edge marks from its west', () => {
  const tiles: TileExtent[] = [{ bbox: [-179.9, 0, -179.6, 0.25] }];
  const exact = emptyMask(178, -1, 100, 100, 0.01);
  const world = { west: 177, south: -2, east: -178, north: 2 };
  const land = meshAreaLand(tiles, world, exact, 1_000_000);
  assert.equal(land.isLand(-179.75, 0.1), true);
  assert.equal(land.isLand(179.5, 0.1), false);
  assert.equal(land.isLand(-178.5, 0.1), false);
});

test('a world as wide as the globe: the base goes round once, and a tile on the far side is land', () => {
  const tiles: TileExtent[] = [{ bbox: [179.5, 5, 179.75, 5.25] }];
  const exact = emptyMask(0, 0, 100, 100, 0.01);
  const world = { west: -180, south: -10, east: 180, north: 10 };
  // 360° × 20° at 0.01° is 72 M cells: merged 9 × 9 (the fewest within the budget) is 4000 × 224 = 896,000.
  const land = meshAreaLand(tiles, world, exact, 1_000_000);
  assert.equal(land.resolutionDeg, 0.09);
  assert.equal(land.nx, 4000, 'one turn of the globe, not a column more');
  assert.equal(land.isLand(179.6, 5.1), true);
  assert.equal(land.isLand(-179.9, 5.1), false);
  assert.equal(land.isLand(0.5, 0.5), false, 'inside the exact mask, no triangle marked');
});

test('the base holds whole cells: where the world’s area alone would fit the budget by a cell a side, the next size is taken', () => {
  // A 1° × 1° world at 0.01° is 10,000 cells, the budget exactly; the exact mask starts half a cell inside the world,
  // so the base needs a column and a row more (10,100) and merges 2 × 2 (51 × 51 = 2,601).
  const exact = emptyMask(0.005, 0.005, 10, 10, 0.01);
  const world = { west: 0, south: 0, east: 1, north: 1 };
  const land = meshAreaLand([], world, exact, 10_000);
  assert.equal(land.resolutionDeg, 0.02);
  assert.equal(land.nx * land.ny, 51 * 51);
  assert.ok(land.bbox.west <= world.west && land.bbox.south <= world.south, 'the base covers the world');
});
