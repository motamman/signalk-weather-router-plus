/**
 * The mesh handover: where a leg leaving the mesh would switch to the
 * coastline search (on a hand-made corridor), the corridor cut there, and
 * the two parts stitched. The pipeline no longer hands legs over this way
 * (part 5: pipeline.ts chartsLeg, mesh/waters.ts); its two pipeline tests
 * went with it (2026-10-13).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineDistanceM } from '../../geo/geodesy';
import { LandMask } from '../../geo/landmask';
import type { ShapePolygon } from '../../geo/shapefile';
import { SHORE_CLEAR_M, shoreProfile, type Corridor } from '../corridor';
import { NoCurrent } from '../environment';
import type { Route } from '../route';
import { findHandover, OPEN_WATER_WIDTH_M, sliceCorridor, stitchLegParts } from './handover';
import type { MeshLegRunner } from './leg';
import { runMeshLeg } from './legrun';

const T0 = new Date('2026-01-01T00:00:00Z');

/** A mesh covering every point west of `eastEdge`; routes as a straight line, narrow water everywhere, nothing blocked. */
function meshWestOf(eastEdge: number): { mesh: MeshLegRunner; calls: [number, number][][] } {
  const calls: [number, number][][] = [];
  const open = {
    isLand: () => false,
    isLandExact: () => false,
    legCrossesLandExact: () => false,
    legsCrossLandBulk: (la: ArrayLike<number>) => new Uint8Array(la.length),
    clearAlong: (lon: number, lat: number, _b: number, maxM: number) => ({ m: maxM, end: [lon, lat] as [number, number] }),
    depthAt: () => null,
    openingBridgesAlong: () => [],
  };
  return {
    mesh: {
      covers: pts => pts.every(p => p[0] < eastEdge),
      // findHandover asks only `covers`; the pipeline no longer hands legs over this way (part 5, chartsLeg).
      meets: () => true,
      plan: async () => ({ refused: 'not used by these tests' }),
      area: () => {
        throw new Error('not used by these tests');
      },
      leg: async a => {
        const start = a.legStart;
        const end = a.plan.end;
        calls.push([start, end]);
        return runMeshLeg({
          result: {
            ok: true,
            path: [start, end],
            widths: [
              [100, 100],
              [100, 100],
            ],
            lengthM: haversineDistanceM(start[0], start[1], end[0], end[1]),
            costS: 1,
            stats: {
              trianglesLoaded: 1,
              tiles: 1,
              tileReads: 1,
              peakTriangles: 1,
              blocked: 0,
              expanded: 1,
              readMs: 0,
              prepMs: 0,
              searchMs: 0,
              funnelMs: 0,
              bufferM: 0,
              buffered: 0,
              bufferMs: 0,
            },
          },
          land: open,
          ...a,
          wind: null,
          current: new NoCurrent(),
        });
      },
    },
    calls,
  };
}

/** A straight corridor along lat 0 from lon 0 to lon 1, points every 0.02° (2.2 km), with the given widths and distances to land (default: no land within reach). */
function corridorAlong(widths: number[], shore: number[] = widths.map(() => Infinity)): Corridor {
  const skeleton = widths.map((_w, i) => ({ lon: i * 0.02, lat: 0 }));
  let lengthM = 0;
  for (let i = 1; i < skeleton.length; i++) lengthM += haversineDistanceM(skeleton[i - 1].lon, 0, skeleton[i].lon, 0);
  return {
    skeleton,
    widthM: Float64Array.from(widths),
    shoreM: Float64Array.from(shore),
    lengthM,
    bbox: { west: -1, south: -1, east: 2, north: 1 },
    band: { west: -1, south: -1, east: 2, north: 1 },
    reachM: 0,
    land: LandMask.fromPolygons([], { west: -1, south: -1, east: 2, north: 1 }, 0.05),
    autoVias: [
      { lon: 0.1, lat: 0, radiusM: 500, widthM: 800, axisDeg: 90, name: 'narrows', segment: 0, pathIndex: 5 },
      { lon: 0.8, lat: 0, radiusM: 500, widthM: 900, axisDeg: 90, name: 'far narrows', segment: 0, pathIndex: 40 },
    ],
    stats: { astarMs: 0, expanded: 0, windowCells: 0, reroutes: 0, refines: 0, blockedCells: 0, verifyMs: 0 },
  };
}

test('findHandover: the first sustained-open point after the last narrow one inside the mesh; from either end; none without narrow water', () => {
  // 51 points; narrow (800 m) up to index 9, one open blip at 10, narrow again 11–14, open from 15.
  const w = Array.from({ length: 51 }, (_x, i) => (i >= 15 || i === 10 ? 5000 : 800));
  const c = corridorAlong(w);
  const { mesh } = meshWestOf(0.6); // covers indices 0..29
  const h = findHandover(c, 'start', mesh);
  assert.ok(h);
  assert.equal(h.index, 15, 'the blip at 10 does not count: narrow water follows it');
  assert.deepEqual(h.point, [0.3, 0]);
  assert.ok(Math.abs(h.distanceM - haversineDistanceM(0, 0, 0.3, 0)) < 1);
  // A harbour: wide at the start, a narrow mouth, open beyond (Newport's shape): the handover is past the mouth.
  const harbour = Array.from({ length: 51 }, (_x, i) => (i <= 4 ? 2800 : i <= 10 ? 950 : i === 12 ? 1500 : 8000));
  const hh = findHandover(corridorAlong(harbour), 'start', mesh);
  assert.ok(hh);
  assert.equal(hh.index, 13, 'after the last narrow point (12), the first point that is open and stays open');
  // No narrow water at all: no mesh part.
  assert.equal(findHandover(corridorAlong(w.map(() => 5000)), 'start', mesh), null);
  // Narrow water only beyond the scan distance: not seen, no mesh part (the cap is 50 km; points are 2.2 km apart).
  const far = Array.from({ length: 51 }, (_x, i) => (i >= 24 && i <= 26 ? 800 : 5000));
  assert.equal(findHandover(corridorAlong(far), 'start', mesh), null);
  // Narrow all the way: the last point within the 50 km scan (index 22 at 2.2 km spacing), not the last covered one.
  const narrow = corridorAlong(w.map(() => OPEN_WATER_WIDTH_M - 1));
  assert.equal(findHandover(narrow, 'start', mesh)!.index, 22);
  // From the end: a mesh covering the east.
  const east: MeshLegRunner = { ...mesh, covers: pts => pts.every(p => p[0] > 0.5) };
  const wEnd = Array.from({ length: 51 }, (_x, i) => (i <= 40 ? 5000 : 800));
  const he = findHandover(corridorAlong(wEnd), 'end', east);
  assert.ok(he);
  assert.equal(he.index, 40);
});

test('findHandover: open water near the shore is not a handover; the first point clear of land (and staying clear) is', () => {
  const { mesh } = meshWestOf(0.6); // covers indices 0..29
  const open = Array.from({ length: 51 }, () => 5000);
  // An open-coast start: open across the track everywhere, land within 500 m for the first four points.
  const coast = findHandover(
    corridorAlong(
      open,
      open.map((_x, i) => (i < 4 ? 500 : Infinity))
    ),
    'start',
    mesh
  );
  assert.ok(coast);
  assert.equal(coast.index, 4);
  assert.equal(coast.reason, 'clear');
  // One clear point between near-shore ones does not count: the handover is where it stays clear.
  const blip = findHandover(
    corridorAlong(
      open,
      open.map((_x, i) => (i < 6 && i !== 3 ? 800 : Infinity))
    ),
    'start',
    mesh
  );
  assert.equal(blip!.index, 6);
  // A harbour mouth then a near-shore stretch: past the last narrow point AND clear of land.
  const widths = open.map((_x, i) => (i <= 5 ? 900 : 5000));
  const shore = open.map((_x, i) => (i <= 9 ? 1000 : Infinity));
  assert.equal(findHandover(corridorAlong(widths, shore), 'start', mesh)!.index, 10);
  // Already clear at the start (and after): no mesh part.
  assert.equal(
    findHandover(
      corridorAlong(
        open,
        open.map(() => SHORE_CLEAR_M)
      ),
      'start',
      mesh
    ),
    null
  );
  // Hugging the coast beyond the scan: the last scanned point (index 22 at 2.2 km spacing), said so.
  const hug = findHandover(
    corridorAlong(
      open,
      open.map(() => 800)
    ),
    'start',
    mesh
  );
  assert.equal(hug!.index, 22);
  assert.equal(hug!.reason, 'scan-limit');
});

test('shoreProfile: the distance to the nearest land in any direction, Infinity beyond the reach', () => {
  // Land south of lat 0; points north of it at 0.005° (556 m), 0.01° (1.1 km) and 0.05° (5.6 km).
  const south: ShapePolygon = {
    recordNumber: 1,
    minLon: -1,
    minLat: -1,
    maxLon: 1,
    maxLat: 0,
    rings: [{ coords: Float64Array.from([-1, -1, 1, -1, 1, 0, -1, 0, -1, -1]), minLon: -1, minLat: -1, maxLon: 1, maxLat: 0 }],
  };
  const land = LandMask.fromPolygons([south], { west: -1, south: -1, east: 1, north: 1 }, 0.0005);
  const d = shoreProfile(land, [
    { lon: 0, lat: 0.005 },
    { lon: 0, lat: 0.01 },
    { lon: 0, lat: 0.05 },
  ]);
  assert.ok(Math.abs(d[0] - 556) < 60, `${d[0]}`);
  assert.ok(Math.abs(d[1] - 1112) < 60, `${d[1]}`);
  assert.equal(d[2], Infinity);
});

test('shoreProfile: a small island between two sampling directions is seen, not missed', () => {
  // A 150 m island about 3 km from the point at bearing 11°, between the 0° and 22.5° rays of a 16-ray scan.
  const cLon = 0.00526;
  const cLat = 0.02646;
  const hw = 0.00067;
  const islet: ShapePolygon = {
    recordNumber: 1,
    minLon: cLon - hw,
    minLat: cLat - hw,
    maxLon: cLon + hw,
    maxLat: cLat + hw,
    rings: [
      {
        coords: Float64Array.from([
          cLon - hw,
          cLat - hw,
          cLon + hw,
          cLat - hw,
          cLon + hw,
          cLat + hw,
          cLon - hw,
          cLat + hw,
          cLon - hw,
          cLat - hw,
        ]),
        minLon: cLon - hw,
        minLat: cLat - hw,
        maxLon: cLon + hw,
        maxLat: cLat + hw,
      },
    ],
  };
  const land = LandMask.fromPolygons([islet], { west: -0.1, south: -0.1, east: 0.1, north: 0.1 }, 0.0005);
  assert.ok(land.isLand(cLon, cLat), 'the islet is on the raster');
  const d = shoreProfile(land, [
    { lon: 0, lat: 0 },
    { lon: 0, lat: -0.05 },
  ]);
  const expected = haversineDistanceM(0, 0, cLon, cLat - hw);
  assert.notEqual(d[0], Infinity, 'islet seen');
  assert.ok(Math.abs(d[0] - expected) < 80, `${d[0]} vs ${expected}`);
  // 8.5 km away: beyond the reach.
  assert.equal(d[1], Infinity);
});

test('sliceCorridor keeps the part on one side of the handover with its automatic vias', () => {
  const c = corridorAlong(Array.from({ length: 51 }, () => 5000));
  const after = sliceCorridor(c, 15, 'after');
  assert.equal(after.skeleton.length, 36);
  assert.deepEqual(after.skeleton[0], { lon: 0.3, lat: 0 });
  assert.equal(after.widthM.length, 36);
  assert.equal(after.shoreM.length, 36);
  assert.deepEqual(
    after.autoVias.map(v => v.name),
    ['far narrows']
  );
  const before = sliceCorridor(c, 15, 'before');
  assert.equal(before.skeleton.length, 16);
  assert.deepEqual(
    before.autoVias.map(v => v.name),
    ['narrows']
  );
  assert.ok(Math.abs(after.lengthM + before.lengthM - c.lengthM) < 1);
});

test('stitchLegParts joins two parts at their shared point, re-bases warnings, recomputes totals', () => {
  const wp = (lon: number, t: number, mode: 'sailing' | 'motoring' = 'motoring'): Route['waypoints'][number] => ({
    lon,
    lat: 0,
    time: new Date(T0.getTime() + t * 1000),
    sogMs: 0,
    cogDeg: 0,
    mode,
  });
  const a: Route = {
    waypoints: [wp(0, 0), wp(0.1, 1000), wp(0.2, 2000)],
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
    meshLeg: true,
    warnings: [{ leg_index: 0, violation: 'leg_crosses_land', from: [0, 0], to: [0.1, 0], repaired: false }],
  };
  const b: Route = {
    waypoints: [wp(0.2, 2000), wp(0.5, 5000, 'sailing'), wp(1, 9000, 'sailing')],
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
    warnings: [{ leg_index: 1, violation: 'wind_over_limit', from: [0.5, 0], to: [1, 0], repaired: false }],
    forecastHorizonExceededS: 100,
  };
  const r = stitchLegParts(a, b);
  assert.deepEqual(
    r.waypoints.map(w => w.lon),
    [0, 0.1, 0.2, 0.5, 1]
  );
  assert.equal(r.totalTimeS, 9000);
  assert.equal(r.motoringTimeS, 2000);
  assert.equal(r.sailingTimeS, 7000);
  assert.deepEqual(
    r.warnings!.map(w => w.leg_index),
    [0, 3]
  );
  assert.equal(r.meshLeg, true);
  assert.equal(r.forecastHorizonExceededS, 100);
  assert.ok(Math.abs(r.totalDistanceM - haversineDistanceM(0, 0, 1, 0)) < 1);
});
