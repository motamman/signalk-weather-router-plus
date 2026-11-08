// A land mask made from rasters of cells (LandMask.fromCellMasks): what it says beyond its raster is its `outside`
// rule, 'land' (the chart meshes' area over the search's whole world) or 'unknown' (land known only where its data
// covers: the depth gate of a GEBCO grid covering part of the world), for a point and for a move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CellMask, LandMask } from './landmask';

/** A 10 × 10 grid of 0.1° cells over 0..1, 0..1, its cell (5, 5) marked. */
function grid(): CellMask {
  const cells = new Uint8Array(100);
  cells[5 * 10 + 5] = 1;
  return { bbox: { west: 0, south: 0, east: 1, north: 1 }, resolutionDeg: 0.1, nx: 10, ny: 10, cells };
}

test("outside 'land': beyond the raster is land, for a point and a move that leaves it", () => {
  const m = LandMask.fromCellMasks(grid(), [], 'land');
  assert.equal(m.isLand(0.55, 0.55), true, 'the marked cell');
  assert.equal(m.isLand(0.25, 0.25), false);
  assert.equal(m.isLand(1.5, 0.5), true, 'beyond the raster');
  assert.equal(m.legCrossesRaster(0.25, 0.25, 0.25, 0.85), false, 'inside, clear of the marked cell');
  assert.equal(m.legCrossesRaster(0.25, 0.25, 1.5, 0.25), true, 'leaving the raster');
  assert.equal(m.legCrossesLandExact(0.25, 0.25, 1.5, 0.25), true);
});

test("outside 'unknown': beyond the raster says nothing; inside, the marked cells are land as before", () => {
  const m = LandMask.fromCellMasks(grid(), [], 'unknown');
  assert.equal(m.isLand(0.55, 0.55), true, 'the marked cell');
  assert.equal(m.isLand(0.25, 0.25), false);
  assert.equal(m.isLand(1.5, 0.5), false, 'beyond the raster: not known, not land');
  assert.equal(m.isLandExact(1.5, 0.5), false);
  assert.equal(m.legCrossesRaster(0.25, 0.25, 1.5, 0.25), false, 'leaving the raster clear of the marked cell');
  assert.equal(m.legCrossesRaster(0.25, 0.55, 1.5, 0.55), true, 'leaving it through the marked cell');
  assert.equal(m.legCrossesLandExact(0.25, 0.25, 1.5, 0.25), false);
  assert.equal(m.legCrossesLandExact(0.25, 0.55, 1.5, 0.55), true);
  // Added to a coast mask (withExtraLand), it adds only its marked cells: beyond it the coast decides.
  const coast = LandMask.fromCellMasks({ ...grid(), cells: new Uint8Array(100) }, [], 'land').withExtraLand(m);
  assert.equal(coast.isLand(0.55, 0.55), true);
  assert.equal(coast.isLand(0.25, 0.25), false);
});

test('a patch must cover whole base cells: one offset by part of a cell, or with a cell size the base does not divide into, is refused', () => {
  /** A 0.05° patch over 0.2..0.3 × 0.2..0.3 (base cell (2, 2)), its south-west quarter marked, `west` moved by `shift`. */
  const patch = (shift: number, res = 0.05): CellMask => {
    const n = Math.round(0.1 / res);
    const cells = new Uint8Array(n * n);
    cells[0] = 1;
    return {
      bbox: { west: 0.2 + shift, south: 0.2, east: 0.2 + shift + n * res, north: 0.2 + n * res },
      resolutionDeg: res,
      nx: n,
      ny: n,
      cells,
    };
  };
  assert.throws(() => LandMask.fromCellMasks(grid(), [patch(0.025)], 'land'), /not aligned to the base/, 'half a patch cell off');
  assert.throws(() => LandMask.fromCellMasks(grid(), [patch(0, 0.03)], 'land'), /not aligned to the base/, '0.03° into 0.1°');
  // Aligned: the patch answers inside its area, the base elsewhere.
  const m = LandMask.fromCellMasks(grid(), [patch(0)], 'land');
  assert.equal(m.isLand(0.225, 0.225), true, "the patch's marked quarter");
  assert.equal(m.isLand(0.275, 0.275), false, "the patch's clear quarter");
  assert.equal(m.isLand(0.55, 0.55), true, "the base's marked cell");
});
