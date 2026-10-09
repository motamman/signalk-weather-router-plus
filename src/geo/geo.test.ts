import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alongTrackDistanceM,
  bboxFromLonLat,
  bboxContains,
  haversineBearing,
  haversineDistanceM,
  perpendicularOffsetM,
  projectAlongBearing,
  segmentWithinDisc,
  slerpSamples,
  wrapLon,
} from './geodesy';
import { dilate, LandMask } from './landmask';
import type { ShapePolygon } from './shapefile';
import { pointInShape } from './shapefile';
import { buildCoarseGrid } from './grid';

function square(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number, holes: number[][] = []): ShapePolygon {
  const ring = (c: number[]): { coords: Float64Array; minLon: number; minLat: number; maxLon: number; maxLat: number } => {
    const xs = c.filter((_, i) => i % 2 === 0);
    const ys = c.filter((_, i) => i % 2 === 1);
    return {
      coords: Float64Array.from(c),
      minLon: Math.min(...xs),
      minLat: Math.min(...ys),
      maxLon: Math.max(...xs),
      maxLat: Math.max(...ys),
    };
  };
  const outer = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return { recordNumber, minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1, rings: [ring(outer), ...holes.map(ring)] };
}

test('haversine distance and bearing', () => {
  // Newport RI to Bermuda, roughly 1170 km at ~150°.
  const d = haversineDistanceM(-71.31, 41.49, -64.78, 32.3);
  assert.ok(d > 1_150_000 && d < 1_190_000, `distance ${d}`);
  const b = haversineBearing(-71.31, 41.49, -64.78, 32.3);
  assert.ok(b > 145 && b < 155, `bearing ${b}`);
  assert.equal(haversineBearing(0, 0, 0, 1), 0);
  assert.equal(haversineBearing(0, 0, 1, 0), 90);
});

test('projectAlongBearing inverts distance/bearing and wraps the antimeridian', () => {
  const [lon, lat] = projectAlongBearing(-71.31, 41.49, 150, 100_000);
  assert.ok(Math.abs(haversineDistanceM(-71.31, 41.49, lon, lat) - 100_000) < 1);
  assert.ok(Math.abs(haversineBearing(-71.31, 41.49, lon, lat) - 150) < 0.01);
  const [lon2] = projectAlongBearing(179.9, 0, 90, 50_000);
  assert.ok(lon2 < -179 && lon2 > -180, `wrapped lon ${lon2}`);
  assert.equal(wrapLon(190), -170);
  assert.equal(wrapLon(-190), 170);
});

test('perpendicular offset sign and magnitude', () => {
  // Reference track due east along the equator; a point 1° north is
  // ~111 km off track. The reference formula (asin(sin d13 · sin(θ13 − θ12)))
  // returns NEGATIVE for points left of the track; the sign only has to
  // be consistent, since it is used for binning.
  const off = perpendicularOffsetM(0, 0, 10, 0, 5, 1);
  assert.ok(Math.abs(off) > 110_000 && Math.abs(off) < 112_000, `offset ${off}`);
  assert.ok(off < 0);
  assert.ok(perpendicularOffsetM(0, 0, 10, 0, 5, -1) > 0);
});

test('segmentWithinDisc is a segment test, not an endpoint test', () => {
  // Segment 0..10° along the equator; via at (5°, 0.001°) with 500 m radius: crossed although both endpoints are far away.
  assert.equal(segmentWithinDisc(0, 0, 10, 0, 5, 0.001, 500), true);
  // Via 5 km north of the track: not crossed with a 500 m disc.
  assert.equal(segmentWithinDisc(0, 0, 10, 0, 5, 0.045, 500), false);
  // Via beyond the end of the segment.
  assert.equal(segmentWithinDisc(0, 0, 10, 0, 10.5, 0, 500), false);
});

test('slerpSamples starts and ends on the endpoints', () => {
  const lon = new Float64Array(5);
  const lat = new Float64Array(5);
  slerpSamples(-71, 41, -64, 32, 5, lon, lat, 0);
  assert.ok(Math.abs(lon[0] + 71) < 1e-9 && Math.abs(lat[0] - 41) < 1e-9);
  assert.ok(Math.abs(lon[4] + 64) < 1e-9 && Math.abs(lat[4] - 32) < 1e-9);
});

test('bboxFromLonLat takes the short way round the antimeridian', () => {
  const b = bboxFromLonLat([175, -175], [-10, 10], 1);
  assert.equal(b.west, 174);
  assert.equal(b.east, -174);
  assert.ok(bboxContains(b, 179, 0));
  assert.ok(bboxContains(b, -179, 0));
  assert.ok(!bboxContains(b, 0, 0));
});

test('point-in-shape honours holes (even-odd)', () => {
  const shape = square(1, 0, 0, 10, 10, [[3, 3, 7, 3, 7, 7, 3, 7, 3, 3]]);
  assert.equal(pointInShape(shape, 1, 1), true);
  assert.equal(pointInShape(shape, 5, 5), false); // inside the hole (a lake)
  assert.equal(pointInShape(shape, 11, 5), false);
});

test('land mask rasterises polygons with holes and tests legs', () => {
  const island = square(1, 0, 0, 1, 1, [[0.4, 0.4, 0.6, 0.4, 0.6, 0.6, 0.4, 0.6, 0.4, 0.4]]);
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([island], bbox, 0.01);
  assert.equal(lm.isLand(0.2, 0.2), true);
  assert.equal(lm.isLand(0.5, 0.5), false); // lake
  assert.equal(lm.isLand(1.5, 1.5), false);
  assert.equal(lm.isLandExact(0.2, 0.2), true);
  assert.equal(lm.isLandExact(0.5, 0.5), false);
  // Leg passing over the island is blocked; a leg passing south of it is clear.
  const cross = lm.legsCrossLandBulk(
    Float64Array.of(-0.5, -0.5),
    Float64Array.of(0.5, -0.5),
    Float64Array.of(1.5, 1.5),
    Float64Array.of(0.5, -0.5)
  );
  assert.equal(cross[0], 1);
  assert.equal(cross[1], 0);
  // Land fraction ≈ (1 - 0.04) / 9 with conservative boundary cells.
  const frac = lm.landFraction();
  assert.ok(frac > 0.1 && frac < 0.13, `land fraction ${frac}`);
});

test('land mask works across the antimeridian', () => {
  const island = square(1, 179.5, 0, 180, 1); // touches the dateline from the west
  const island2 = square(2, -180, 0, -179.5, 1); // continues east of it
  const bbox = { west: 178, south: -1, east: -178, north: 2 };
  const lm = LandMask.fromPolygons([island, island2], bbox, 0.01);
  assert.equal(lm.isLand(179.8, 0.5), true);
  assert.equal(lm.isLand(-179.8, 0.5), true);
  assert.equal(lm.isLand(178.5, 0.5), false);
  assert.equal(lm.isLand(-178.5, 0.5), false);
  const grid = buildCoarseGrid(lm, bbox, 0.05);
  const [i, j] = grid.spec.lonlatToIJ(-179.8, 0.5);
  assert.equal(grid.isPassable(i, j), false);
});

test('chooseResolution respects the cell budget', () => {
  const r = LandMask.chooseResolution({ west: -75, south: 30, east: -65, north: 45 }, 25_000_000);
  assert.equal(r, 0.005); // 10.2° × 15.2° at 0.002° would be 38.8M cells
  const r2 = LandMask.chooseResolution({ west: -72, south: 41, east: -70, north: 42 }, 25_000_000);
  assert.equal(r2, 0.0005);
});

test('alongTrackDistanceM: closest point along the track, negative behind the start', () => {
  // Equator east from (0, 0): a point at (0.5, 0.01) is abreast of lon 0.5.
  const at = alongTrackDistanceM(0, 0, 1, 0, 0.5, 0.01);
  const half = haversineDistanceM(0, 0, 0.5, 0);
  assert.ok(Math.abs(at - half) < 1, `${at} vs ${half}`);
  assert.ok(alongTrackDistanceM(0, 0, 1, 0, -0.2, 0.01) < 0);
});

test('land checks find a spit narrower than the old 200 m sampling gap (Point Judith, job b0d324f7)', async () => {
  const { walkGrid } = await import('./landmask');
  // A 20 m wide north-south spit at 41.36 N; a 2 km leg crossing it east-west.
  const spit = square(1, -71.48012, 41.35, -71.47988, 41.37);
  const bbox = { west: -71.5, south: 41.34, east: -71.46, north: 41.38 };
  const lm = LandMask.fromPolygons([spit], bbox, 0.0005);
  const [a, b] = [
    [-71.492, 41.3601],
    [-71.468, 41.3601],
  ];
  // The old check tested points every 200 m: none falls on the spit.
  const n = Math.ceil(haversineDistanceM(a[0], a[1], b[0], b[1]) / 200) + 1;
  const lo = new Float64Array(n);
  const la = new Float64Array(n);
  slerpSamples(a[0], a[1], b[0], b[1], n, lo, la, 0);
  assert.ok(![...lo].some((x, i) => lm.isLand(x, la[i])), 'the 200 m samples miss the spit (the old failure)');
  assert.equal(lm.legsCrossLandBulk([a[0]], [a[1]], [b[0]], [b[1]])[0], 1, 'cell walk finds it');
  assert.equal(lm.legCrossesLandExact(a[0], a[1], b[0], b[1]), true, 'exact check finds it');
  // A leg that passes 150 m north of the spit's end is clear in the exact check.
  assert.equal(lm.legCrossesLandExact(-71.492, 41.3714, -71.468, 41.3714), false);
  // Inside a finer patch the walk uses the patch's cells.
  lm.refine({ west: -71.485, south: 41.355, east: -71.475, north: 41.365 }, 0.0001);
  assert.equal(lm.legsCrossLandBulk([a[0]], [a[1]], [b[0]], [b[1]])[0], 1, 'found through the patch');
  // walkGrid visits every cell of a diagonal, including both sides of an exact corner.
  const seen: string[] = [];
  walkGrid(0.5, 0.5, 2.5, 2.5, (i, j) => (seen.push(`${i},${j}`), false));
  assert.deepEqual(seen, ['0,0', '1,0', '0,1', '1,1', '2,1', '1,2', '2,2']);
  const shallow: string[] = [];
  walkGrid(0.2, 0.1, 3.7, 0.9, (i, j) => (shallow.push(`${i},${j}`), false));
  assert.deepEqual(shallow, ['0,0', '1,0', '2,0', '3,0']);
});

test('land buffer: the raster grows by the buffer and the exact tests measure to the shoreline', () => {
  // An island from lon 0 to 1, lat 0 to 1; raster 0.001° (111 m); the box at the equator so a degree of lon is 111 km too.
  const island = square(1, 0, 0, 1, 1);
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const plain = LandMask.fromPolygons([island], bbox, 0.001);
  const m100 = plain.withBuffer(100);
  const m300 = plain.withBuffer(300);
  assert.equal(plain.bufferM, 0);
  assert.equal(m100.bufferM, 100);
  // A point 200 m east of the island's east shore (lon 1 + 200 m).
  const lon200 = 1 + 200 / 111_320;
  assert.equal(plain.isLandExact(lon200, 0.5), false);
  assert.equal(m100.isLandExact(lon200, 0.5), false, '200 m off, buffer 100: water');
  assert.equal(m300.isLandExact(lon200, 0.5), true, '200 m off, buffer 300: land');
  assert.equal(m300.isLand(lon200, 0.5), true, 'the grown raster agrees');
  // The raster is conservative: the shore's own cell counts as land, plus the grown cells (one for 100 m at 111 m cells).
  // 200 m out is in that grown cell; 350 m out is not.
  assert.equal(m100.isLand(lon200, 0.5), true, 'the grown raster, conservative');
  assert.equal(m100.isLand(1 + 350 / 111_320, 0.5), false, '350 m out is beyond the grown cell');
  // A move running north-south 200 m off the east shore.
  assert.equal(plain.legCrossesLandExact(lon200, -0.5, lon200, 1.5), false);
  assert.equal(m100.legCrossesLandExact(lon200, -0.5, lon200, 1.5), false);
  assert.equal(m300.legCrossesLandExact(lon200, -0.5, lon200, 1.5), true);
  assert.deepEqual(Array.from(m300.legsCrossLandBulk([lon200], [-0.5], [lon200], [1.5])), [1]);
  // Far from land both agree.
  assert.equal(m300.isLandExact(1.5, 1.5), false);
  assert.equal(m300.legCrossesLandExact(1.2, -0.5, 1.2, 1.5), false);
  // The underlying mask is untouched; 0 gives the mask itself.
  assert.equal(plain.isLand(lon200, 0.5), false);
  assert.equal(plain.withBuffer(0), plain);
});

test('dilate: a cell is set when any cell within the window is', () => {
  const nx = 5;
  const ny = 4;
  const r = new Uint8Array(nx * ny);
  r[1 * nx + 2] = 1; // (i=2, j=1)
  const d = dilate(r, nx, ny, 1, 1);
  const at = (i: number, j: number): number => d[j * nx + i];
  assert.equal(at(2, 1), 1);
  assert.equal(at(1, 0), 1);
  assert.equal(at(3, 2), 1);
  assert.equal(at(0, 0), 0);
  assert.equal(at(4, 1), 0);
  assert.equal(at(2, 3), 0);
  assert.equal(
    Array.from(d).reduce((a, b) => a + b, 0),
    9
  );
  assert.deepEqual(Array.from(dilate(r, nx, ny, 0, 0)), Array.from(r));
  const dx = dilate(r, nx, ny, 2, 0);
  assert.equal(
    Array.from(dx).reduce((a, b) => a + b, 0),
    5,
    'east-west only'
  );
});
