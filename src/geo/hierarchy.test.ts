import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from './landmask';
import type { ShapePolygon } from './shapefile';

function square(level: number, low: number, high: number): ShapePolygon {
  const coords = Float64Array.from([low, low, high, low, high, high, low, high, low, low]);
  return {
    level,
    recordNumber: level,
    minLon: low,
    minLat: low,
    maxLon: high,
    maxLat: high,
    rings: [{ coords, minLon: low, minLat: low, maxLon: high, maxLat: high }],
  };
}
const bbox = { west: 0, south: 0, east: 10, north: 10 };
const shapes = [square(4, 4, 6), square(2, 2, 8), square(1, 1, 9), square(3, 3, 7)];

test('hierarchy applies deepest containing level regardless of polygon input order', () => {
  const mask = LandMask.fromPolygons(shapes, bbox, 0.1);
  for (const [x, land] of [
    [0.5, false],
    [1.5, true],
    [2.5, false],
    [3.5, true],
    [5, false],
  ] as const) {
    assert.equal(mask.isLand(x, x), land);
    assert.equal(mask.isLandExact(x, x), land);
    assert.equal(mask.isLandPolygons(x, x), land);
  }
  assert.equal(mask.legCrossesLandExact(2.5, 2.5, 2.5, 7.5), false);
  assert.equal(mask.legCrossesRaster(2.5, 2.5, 7.5, 7.5), true);
  assert.equal(mask.legCrossesLandExact(2.5, 2.5, 7.5, 7.5), true);
  // Water fills must never erase conservative shoreline cells.
  assert.equal(mask.isLand(2, 5), true);
  mask.refine({ west: 2, south: 2, east: 8, north: 8 }, 0.05);
  assert.equal(mask.isLandExact(2.5, 2.5), false);
  assert.equal(mask.isLandExact(3.5, 3.5), true);
});

test('streamed conservative and centre-sampled masks preserve all four levels', () => {
  const ordered = [...shapes].sort((a, b) => a.level! - b.level!);
  for (const edgeCells of [true, false]) {
    const mask = LandMask.rasterStreamed(bbox, 0.1, add => ordered.forEach(add), { edgeCells });
    for (const [x, land] of [
      [1.5, true],
      [2.5, false],
      [3.5, true],
      [5, false],
    ] as const)
      assert.equal(mask.isLand(x, x), land);
    assert.equal(mask.legCrossesRaster(2.5, 2.5, 2.5, 7.5), false);
    assert.equal(mask.legCrossesRaster(2.5, 2.5, 7.5, 7.5), true);
  }
});
