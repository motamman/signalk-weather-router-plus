/**
 * A finished route sailed in an ensemble member's weather (engine/ensemble.ts): the legs one after the other from the
 * departure, timed as legsim.ts times them, with the tack charge between legs; the limits counted, not stopped at; the
 * summary's percentiles over the members that arrive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoCurrent, type WindSource } from './environment';
import { checkMember, percentile, summarise, type EnsembleMemberResult } from './ensemble';
import { simulateLegTime, type SimOptions } from './legsim';
import type { Route, Waypoint } from './route';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';

/** Wind from the north at `ms` everywhere, waves `swh` m (or none). */
function wind(ms: number, swh: number | null = null): WindSource {
  return {
    hasWaves: swh !== null,
    at: () => [ms, 0],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(ms), dir: new Float64Array(lons.length) }),
    wavesAt: () => (swh === null ? null : { swh, mwd: 0, mwp: 6 }),
  } as WindSource;
}

const KN = 1852 / 3600;
const POLAR = PolarDiagram.parse('twa/tws,6,12,20\n0,0,0,0\n45,2,4,5\n90,2.9158,5.8315,7\n180,2,4,5\n', ',');
const VESSEL = makeVessel({ motorSpeedMs: 3 });
const T0 = new Date('2026-01-01T00:00:00Z');
const SIM: SimOptions = { modePolicy: 'sail_max', sailThreshMs: 0.5, simStepM: 200, tackPenaltyS: 60 };
const ENV = { vessel: VESSEL, polar: POLAR, current: new NoCurrent(), sim: SIM };

function wp(lon: number, lat: number, time: Date): Waypoint {
  return { lon, lat, time, sogMs: 0, cogDeg: 0, mode: 'sailing' };
}
function route(points: [number, number][]): Route {
  return {
    waypoints: points.map(([lon, lat]) => wp(lon, lat, T0)),
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
  } as Route;
}

test('one leg: the time is legsim.ts simulateLegTime from the departure, in the member wind', () => {
  const r = route([
    [0, 0],
    [0.05, 0],
  ]);
  const w = wind(12 * KN);
  const leg = simulateLegTime(0, 0, T0, 0.05, 0, VESSEL, POLAR, w, new NoCurrent(), SIM);
  assert.equal(leg.dominantMode, 'sailing');
  const m = checkMember(r, 3, w, ENV);
  assert.equal(m.member, 3);
  // Times are carried in milliseconds: equal to well under a microsecond.
  assert.ok(Math.abs(m.time_s! - leg.seconds) < 1e-6, `${m.time_s} vs ${leg.seconds}`);
  assert.equal(m.arrival, new Date(T0.getTime() + leg.seconds * 1000).toISOString());
  assert.equal(m.over_wind_s, 0);
  assert.equal(m.max_swh_m, null, 'no waves in this member');
  assert.ok(Math.abs(m.max_wind_ms - 12 * KN) < 1e-9);
  // A stronger member wind sails it faster.
  assert.ok(checkMember(r, 4, wind(20 * KN), ENV).time_s! < m.time_s!);
});

test('two legs across the wind: each leg starts when the one before ends, and the tack between them is charged', () => {
  // 60°, then 300°, into a northerly (60° off the wind each, clear of the polar's no-go): a tack at the middle point.
  const r = route([
    [0, 0],
    [0.0866, 0.05],
    [0, 0.1],
  ]);
  const w = wind(12 * KN);
  const a = simulateLegTime(0, 0, T0, 0.0866, 0.05, VESSEL, POLAR, w, new NoCurrent(), SIM);
  const t1 = new Date(T0.getTime() + a.seconds * 1000);
  const b = simulateLegTime(0.0866, 0.05, t1, 0, 0.1, VESSEL, POLAR, w, new NoCurrent(), SIM);
  assert.equal(a.dominantMode, 'sailing');
  assert.equal(b.dominantMode, 'sailing');
  const m = checkMember(r, 1, w, ENV);
  assert.ok(Math.abs(m.time_s! - (a.seconds + b.seconds + 60)) < 1e-6, `${m.time_s} vs ${a.seconds + b.seconds + 60}`);
});

test('the limits are counted, not stopped at: a member over the wind and wave limits still arrives', () => {
  const r = route([
    [0, 0],
    [0.05, 0],
  ]);
  const env = { ...ENV, sim: { ...SIM, maxWindMs: 10 * KN, maxWindMode: 'block' as const, maxSwhM: 1, maxSwhMode: 'block' as const } };
  const m = checkMember(r, 2, wind(12 * KN, 2.5), env);
  assert.notEqual(m.arrival, null);
  assert.ok(m.over_wind_s > 0 && Math.abs(m.over_wind_s - m.time_s!) < 1, 'over the wind limit the whole way');
  assert.ok(m.over_waves_s > 0, 'over the wave limit');
  assert.equal(m.max_swh_m, 2.5);
});

test('percentile: linear between the two nearest ranks', () => {
  assert.equal(percentile([7], 90), 7);
  assert.equal(percentile([0, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10), 1.9);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9.1);
  assert.equal(percentile([1, 2, 3], 100), 3);
});

test('summarise: arrival percentiles over the members that arrive; counts over the limits and stuck', () => {
  const at = (h: number) => new Date(T0.getTime() + h * 3600e3).toISOString();
  const res = (member: number, h: number | null, overWind = 0, overWaves = 0): EnsembleMemberResult => ({
    member,
    arrival: h === null ? null : at(h),
    time_s: h === null ? null : h * 3600,
    over_wind_s: overWind,
    over_waves_s: overWaves,
    max_wind_ms: 0,
    max_swh_m: null,
    ...(h === null ? { stuck: { lon: 0, lat: 0, reason: 'no_speed' } } : {}),
  });
  const s = summarise([res(0, 10), res(1, 20, 60), res(2, null), res(3, 30, 0, 5)]);
  assert.equal(s.members, 4);
  assert.equal(s.stuck, 1);
  assert.equal(s.over_wind, 1);
  assert.equal(s.over_waves, 1);
  assert.equal(s.arrival_p50, at(20));
  assert.equal(s.arrival_p10, at(12));
  assert.equal(s.arrival_p90, at(28));
  const none = summarise([res(0, null)]);
  assert.equal(none.arrival_p10, null);
  assert.equal(none.arrival_p50, null);
  assert.equal(none.arrival_p90, null);
});
