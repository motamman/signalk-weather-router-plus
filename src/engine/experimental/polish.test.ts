import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../../geo/landmask';
import type { ShapePolygon } from '../../geo/shapefile';
import { NoCurrent, type WindSource } from '../environment';
import { simulateLegTime } from '../legsim';
import type { Waypoint } from '../route';
import { PolarDiagram } from '../../vessel/polar';
import { makeVessel } from '../../vessel/vessel';
import { crossTrackPolish } from './polish';

const T0 = new Date('2026-01-01T00:00:00Z');
const POLAR = PolarDiagram.parse(
  `twa/tws,4,6,8,10,12,14,16,20,25
0,0,0,0,0,0,0,0,0,0
30,1.5,2.5,3.3,4.0,4.3,4.5,4.6,4.7,4.7
45,2.5,3.6,4.5,5.1,5.5,5.7,5.8,5.9,5.9
60,3.0,4.2,5.1,5.7,6.1,6.3,6.4,6.5,6.5
90,3.2,4.5,5.5,6.1,6.5,6.7,6.8,6.9,6.9
120,3.0,4.3,5.3,6.0,6.4,6.7,6.9,7.1,7.2
150,2.4,3.6,4.6,5.4,6.0,6.4,6.7,7.0,7.3
180,2.0,3.0,4.0,4.8,5.5,6.0,6.4,6.8,7.1`,
  ','
);

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

/** Wind from the north whose speed grows northward: 6 kt at lat 0, +4 kt per 0.1° north. */
const WIND: WindSource = {
  hasWaves: false,
  at: (_lon, lat) => [(6 + 40 * lat) * 0.514444, 0],
  atMany: (lons, lats) => ({ speed: Float64Array.from(lats, lat => (6 + 40 * lat) * 0.514444), dir: new Float64Array(lons.length) }),
  wavesAt: () => null,
};

const wp = (lon: number, lat: number): Waypoint => ({ lon, lat, time: T0, sogMs: 0, cogDeg: 0, mode: 'sailing' });

function timeLegWith(land: LandMask) {
  void land;
  const vessel = makeVessel({ motorSpeedMs: 1 });
  return (a: Waypoint, b: Waypoint): boolean => {
    const r = simulateLegTime(a.lon, a.lat, a.time, b.lon, b.lat, vessel, POLAR, WIND, new NoCurrent(), {
      modePolicy: 'sail_max',
      sailThreshMs: 1,
      simStepM: 200,
    });
    if (!Number.isFinite(r.seconds) || r.seconds <= 0) return false;
    b.time = new Date(a.time.getTime() + r.seconds * 1000);
    b.mode = r.dominantMode === 'sailing' ? 'sailing' : 'motoring';
    return true;
  };
}

test('cross-track polish moves interior waypoints towards stronger wind, keeps the ends, gains time, respects land and vias', () => {
  const box = { west: -1, south: -1, east: 2, north: 1 };
  const land = LandMask.fromPolygons([], box, 0.01);
  const timeLeg = timeLegWith(land);
  // A reach due east along lat 0, three interior waypoints 20 km apart; more wind lies north.
  const wps = [wp(0, 0), wp(0.18, 0), wp(0.36, 0), wp(0.54, 0), wp(0.72, 0)];
  for (let i = 1; i < wps.length; i++) assert.ok(timeLeg(wps[i - 1], wps[i]));
  const before = wps[wps.length - 1].time.getTime();
  const r = crossTrackPolish(wps, land, timeLeg);
  assert.ok(r.moved >= 3, `moved ${r.moved}`);
  assert.ok(r.gainedS > 60, `gained ${r.gainedS} s`);
  assert.equal(wps[wps.length - 1].time.getTime(), before - Math.round(r.gainedS * 1000), 'the gain is the arrival difference');
  for (let i = 1; i < wps.length - 1; i++) assert.ok(wps[i].lat > 0, `waypoint ${i} moved north (lat ${wps[i].lat})`);
  assert.deepEqual([wps[0].lon, wps[0].lat, wps[4].lon, wps[4].lat], [0, 0, 0.72, 0], 'the ends did not move');
  for (let i = 1; i < wps.length; i++) assert.ok(wps[i].time > wps[i - 1].time);

  // Land just north of the line: no move north is allowed; a via is never moved.
  const landN = LandMask.fromPolygons([rect(1, -0.5, 0.001, 1.5, 0.5)], box, 0.002);
  const wps2 = [wp(0, 0), wp(0.18, 0), { ...wp(0.36, 0), role: 'via' as const }, wp(0.54, 0), wp(0.72, 0)];
  for (let i = 1; i < wps2.length; i++) assert.ok(timeLeg(wps2[i - 1], wps2[i]));
  crossTrackPolish(wps2, landN, timeLeg);
  for (let i = 1; i < wps2.length - 1; i++) assert.ok(wps2[i].lat <= 0, `waypoint ${i} did not cross into the land (lat ${wps2[i].lat})`);
  assert.deepEqual([wps2[2].lon, wps2[2].lat], [0.36, 0], 'the via stayed');
});
