import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comfortRate,
  encounterFactor,
  encounterIndex,
  seaAngle,
  seaSector,
  COMFORT_FREE_INDEX,
  ENCOUNTER_FOLLOWING,
  ENCOUNTER_HEAD,
} from './seas';
import { OceanPropagator } from './propagator';
import { LandMask } from '../geo/landmask';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';
import type { WindSource } from './environment';

test('sea angle, side and sector from the course and the wave direction', () => {
  // Course north, waves from the north: head seas.
  assert.deepEqual(seaAngle(0, 0), { angle: 0, side: null });
  // Waves from the east on a northward course: abeam, to starboard.
  assert.deepEqual(seaAngle(0, 90), { angle: 90, side: 'starboard' });
  assert.deepEqual(seaAngle(0, 300), { angle: 60, side: 'port' });
  // Course 350°, waves from 10°: 20° on the starboard bow, across north.
  assert.deepEqual(seaAngle(350, 10), { angle: 20, side: 'starboard' });
  assert.equal(seaAngle(0, 180).angle, 180);
  assert.deepEqual([10, 45, 90, 135, 170].map(seaSector), ['head', 'bow', 'beam', 'quarter', 'following']);
});

test('encounter weights head seas up and following seas down; the comfort rate starts above "slight"', () => {
  assert.ok(Math.abs(encounterFactor(0) - ENCOUNTER_HEAD) < 1e-12);
  assert.ok(Math.abs(encounterFactor(180) - ENCOUNTER_FOLLOWING) < 1e-12);
  assert.ok(encounterFactor(45) > encounterFactor(90) && encounterFactor(90) > encounterFactor(135));
  assert.ok(Math.abs(encounterIndex(100, 0, 0) - 130) < 1e-9);
  assert.ok(Math.abs(encounterIndex(100, 0, 180) - 80) < 1e-9);
  // Free in slight seas, then linear, capped; 0 weight = off.
  assert.equal(comfortRate(COMFORT_FREE_INDEX, 1), 0);
  assert.ok(Math.abs(comfortRate(125, 1) - 0.5) < 1e-12);
  assert.equal(comfortRate(10_000, 1), 2);
  assert.equal(comfortRate(200, 0), 0);
});

test('with a comfort weight the route leaves heavy head seas for calm water; its times stay real', () => {
  // Course south along 0°; a steady beam wind (from the east). Heavy seas
  // (4 m, from the south: head seas) east of 0.4°W, calm water (0.3 m) west of it.
  const heavy = (lon: number): boolean => lon > -0.4;
  const wind: WindSource = {
    at: () => [7, 90],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(7), dir: new Float64Array(lons.length).fill(90) }),
    hasWaves: true,
    wavesAt: lon => ({ swh: heavy(lon) ? 4 : 0.3, mwp: 8, mp2: 8, mwd: 180 }),
    wavesFullAtManyAt: lons => ({
      swh: Float64Array.from(lons, l => (heavy(l) ? 4 : 0.3)),
      mwp: new Float64Array(lons.length).fill(8),
      mp2: new Float64Array(lons.length).fill(8),
      mwd: new Float64Array(lons.length).fill(180),
    }),
  };
  const polar = new PolarDiagram([45, 90, 135, 180], [5, 10], [3, 4, 4.5, 5.5, 4, 5, 3.5, 4.5]);
  const run = (comfortWeight: number): ReturnType<OceanPropagator['computeRoute']> => {
    const lm = LandMask.fromPolygons([], { west: -3, south: -7, east: 3, north: 1 }, 0.02);
    const skeleton = Array.from({ length: 61 }, (_, i) => ({ lon: 0, lat: -i * 0.1 }));
    const prop = new OceanPropagator(lm, { stages: 16, subsectors: 30, headings: 30, headingIncrementDeg: 1 });
    return prop.computeRoute({
      start: [0, 0],
      end: [0, -6],
      departureTime: new Date('2026-01-01T00:00:00Z'),
      vessel: makeVessel({ motorSpeedMs: 3 }),
      polar,
      wind,
      modePolicy: 'sail_max',
      sailThreshMs: 0,
      comfortWeight,
      corridor: { skeleton, widthM: new Float64Array(skeleton.length).fill(Infinity) },
    });
  };
  const fastest = run(0);
  const comfy = run(1);
  const westmost = (r: typeof fastest): number => Math.min(...r.waypoints.map(w => w.lon));
  assert.ok(westmost(fastest) > -0.4, `the fastest route stays in the heavy seas (west to ${westmost(fastest).toFixed(2)}°)`);
  assert.ok(westmost(comfy) < -0.4, `the comfortable route reaches the calm water (west to ${westmost(comfy).toFixed(2)}°)`);
  // Real times: the waypoint times add up to the route's total, and the detour takes longer.
  const wps = comfy.waypoints;
  assert.ok(Math.abs((wps[wps.length - 1].time.getTime() - wps[0].time.getTime()) / 1000 - comfy.totalTimeS) < 1);
  assert.ok(comfy.totalTimeS > fastest.totalTimeS, 'calmer water at some cost in time');
});
