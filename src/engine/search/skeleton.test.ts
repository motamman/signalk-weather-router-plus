/**
 * The coarse skeleton's widths (skeleton.ts skeletonWidths): a point whose raster cell is land is unknown water, not
 * narrow water, on this path (the corridor's re-traces such points; this path keeps the exact endpoints).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../../geo/landmask';
import type { ShapePolygon } from '../../geo/shapefile';
import { widthProfile } from '../corridor';
import { skeletonWidths } from './skeleton';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber,
    minLon: lon0,
    minLat: lat0,
    maxLon: lon1,
    maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}

test('skeletonWidths: a point on a land cell reads as unknown water, a point in a channel as the channel', () => {
  // Two banks with a channel 0.02° (about 2.2 km) wide between them, running north-south through lon 0.
  const banks = [rect(1, -0.5, -0.5, -0.01, 0.5), rect(2, 0.01, -0.5, 0.5, 0.5)];
  const land = LandMask.fromPolygons(banks, { west: -1, south: -1, east: 1, north: 1 }, 0.001);
  // The skeleton runs up the channel; its first point is the exact start, inside the western bank's raster.
  const skeleton = [
    { lon: -0.015, lat: -0.3 },
    { lon: 0, lat: -0.2 },
    { lon: 0, lat: -0.1 },
    { lon: 0, lat: 0 },
  ];
  assert.equal(land.isLand(skeleton[0].lon, skeleton[0].lat), true, 'the start is in a land cell');
  const raw = widthProfile(land, skeleton);
  assert.equal(raw[0], 0, 'the profile reads 0 on land');
  const w = skeletonWidths(land, skeleton);
  assert.equal(w[0], Infinity, 'unknown on this path');
  for (let i = 1; i < w.length; i++) {
    assert.equal(w[i], raw[i], `point ${i} keeps its measured width`);
    assert.ok(w[i] > 1500 && w[i] < 3000, `point ${i}: ${w[i]} m, the channel`);
  }
});
