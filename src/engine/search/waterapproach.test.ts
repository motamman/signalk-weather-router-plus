import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../../geo/landmask';
import type { ShapePolygon } from '../../geo/shapefile';
import { makeVessel } from '../../vessel/vessel';
import { OceanPropagator } from '../propagator';
import type { Route } from '../route';

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

// A coast with a bent channel four raster cells wide: in from the west along lat 0..0.04 to lon 0.72, then north
// between lon 0.72 and 0.76 to lat 0.8. The end lies up the northern arm, so no straight move from the open water
// reaches it, and the search's steps (about 20 km, a quarter of that at the fallback's least) cannot enter it.
const bbox = { west: -1, south: -1, east: 2, north: 2 };
const coast = [
  rect(1, 0.5, -0.5, 1.5, 0.0), // south of the channel
  rect(2, 0.5, 0.04, 0.72, 0.9), // north of the western arm, west of the northern arm
  rect(3, 0.76, 0.0, 1.5, 0.9), // east of the northern arm
  rect(4, 0.72, 0.8, 0.76, 0.9), // the northern arm's head
];
const lm = LandMask.fromPolygons(coast, bbox, 0.01);
const vessel = makeVessel({ motorSpeedMs: 3 });
const t0 = new Date('2026-10-01T00:00:00Z');
const run = (end: [number, number], endApproach?: 'water'): Route =>
  new OceanPropagator(lm, { stages: 10, subsectors: 20, headings: 30 }).computeRoute({
    start: [-0.9, 0.02],
    end,
    departureTime: t0,
    vessel,
    polar: null,
    modePolicy: 'motor',
    sailThreshMs: 0,
    endApproach,
  });

test('an end up a bent channel: without the water approach the search cannot finish; with it, the last moves follow the channel, clear of land', () => {
  const end: [number, number] = [0.74, 0.7];
  assert.ok(!lm.isLand(...end), 'the end is water');
  assert.throws(() => run(end));
  const r = run(end, 'water');
  const wps = r.waypoints;
  const last = wps[wps.length - 1];
  assert.ok(Math.abs(last.lon - end[0]) < 1e-9 && Math.abs(last.lat - end[1]) < 1e-9, 'ends exactly on the end');
  for (let i = 1; i < wps.length; i++)
    assert.ok(!lm.legCrossesLandExact(wps[i - 1].lon, wps[i - 1].lat, wps[i].lon, wps[i].lat), `leg ${i} is clear of land`);
  assert.ok(
    wps.some(w => w.lon > 0.72 && w.lon < 0.76 && w.lat > 0 && w.lat < 0.7),
    'a waypoint at the bend or in the northern arm, before the end'
  );
});

test('an end in open water: the water approach changes nothing', () => {
  const end: [number, number] = [0.3, 0.6];
  const a = run(end);
  const b = run(end, 'water');
  assert.deepEqual(
    b.waypoints.map(w => [w.lon, w.lat, w.time.getTime()]),
    a.waypoints.map(w => [w.lon, w.lat, w.time.getTime()])
  );
});
