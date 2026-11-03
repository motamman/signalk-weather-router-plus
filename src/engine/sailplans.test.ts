import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoCurrent, type WindSource } from './environment';
import { simulateLegTime } from './legsim';
import type { Route, Waypoint } from './route';
import { markSailPlans } from './sailplans';
import { PolarDiagram } from '../vessel/polar';
import { sailPlanAt } from '../vessel/sailplan';
import { makeVessel } from '../vessel/vessel';

/** Wind from the north, 4 m/s west of 0.025° E and 8 m/s east of it. */
const WIND: WindSource = {
  hasWaves: false,
  at: lon => [lon < 0.025 ? 4 : 8, 0],
  atMany: lons => ({ speed: Float64Array.from(lons, lon => (lon < 0.025 ? 4 : 8)), dir: new Float64Array(lons.length) }),
  wavesAt: () => null,
};
// The best table, and two plans: "light" is the faster at 4 m/s, "heavy" at 8 m/s (beam reach both).
const BEST = new PolarDiagram([0, 90, 180], [4, 8], [0, 0, 3, 4, 2, 3]);
const PLANS = [
  { name: 'light', polar: new PolarDiagram([0, 90, 180], [4, 8], [0, 0, 3, 3.5, 2, 2.5]) },
  { name: 'heavy', polar: new PolarDiagram([0, 90, 180], [4, 8], [0, 0, 2.5, 4, 1.5, 3]) },
];
const VESSEL = makeVessel({ motorSpeedMs: 2 });
const SIM = { modePolicy: 'sail_max' as const, sailThreshMs: 0.5, simStepM: 100 };
const T0 = new Date('2026-01-01T00:00:00Z');

/** One sailed segment due east from 0° to 0.05° E, timed by the simulator. */
function route(): Route {
  const r = simulateLegTime(0, 0, T0, 0.05, 0, VESSEL, BEST, WIND, new NoCurrent(), SIM);
  const wps: Waypoint[] = [
    { lon: 0, lat: 0, time: T0, sogMs: 0, cogDeg: 0, mode: 'motoring' },
    { lon: 0.05, lat: 0, time: new Date(T0.getTime() + r.seconds * 1000), sogMs: 1, cogDeg: 90, mode: 'sailing' },
  ];
  return { waypoints: wps, totalTimeS: r.seconds, totalDistanceM: 5560, motoringTimeS: 0, sailingTimeS: r.seconds, validated: true };
}

test('the fastest sail plan by its own table, none where no plan sails', () => {
  assert.equal(sailPlanAt(PLANS, 90, 4), 'light');
  assert.equal(sailPlanAt(PLANS, 90, 8), 'heavy');
  assert.equal(sailPlanAt(PLANS, 0, 8), null);
});

test('a route point where the fastest plan changes, on the line, with the times already there kept', () => {
  const r = route();
  const end = r.waypoints[1].time.getTime();
  r.warnings = [{ leg_index: 0, violation: 'wind_over_limit', from: [0, 0], to: [0.05, 0], repaired: false }];
  assert.equal(markSailPlans(r, { vessel: VESSEL, polar: BEST, sailPlans: PLANS, wind: WIND, current: new NoCurrent(), sim: SIM }), 1);
  const [a, w, b] = r.waypoints;
  assert.equal(r.waypoints.length, 3);
  assert.equal(a.time.getTime(), T0.getTime());
  assert.equal(b.time.getTime(), end);
  // The change is where the wind steps up (within one 100 m sub-step), on the segment's line, between its ends in time.
  assert.ok(Math.abs(w.lon - 0.025) < 0.001 && Math.abs(w.lat) < 1e-9, `${w.lon}, ${w.lat}`);
  assert.ok(w.time.getTime() > a.time.getTime() && w.time.getTime() < end);
  assert.equal(w.sailPlan, 'light');
  assert.equal(b.sailPlan, 'heavy');
  assert.equal(w.mode, 'sailing');
  assert.ok(Math.abs(w.cogDeg - 90) < 1e-6 && Math.abs(b.cogDeg - 90) < 1e-6);
  assert.equal(r.warnings[0].leg_index, 0);
  assert.equal(r.totalTimeS, (end - T0.getTime()) / 1000);
});

test("without sail plans (a polarTable, the router's own files) the route is left exactly as it was", () => {
  const r = route();
  const before = structuredClone(r);
  for (const sailPlans of [undefined, null, []])
    assert.equal(markSailPlans(r, { vessel: VESSEL, polar: BEST, sailPlans, wind: WIND, current: new NoCurrent(), sim: SIM }), 0);
  assert.deepEqual(r, before);
});

test('one plan all along: named, no point added', () => {
  const r = route();
  const steady: WindSource = {
    ...WIND,
    at: () => [4, 0],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(4), dir: new Float64Array(lons.length) }),
  };
  assert.equal(markSailPlans(r, { vessel: VESSEL, polar: BEST, sailPlans: PLANS, wind: steady, current: new NoCurrent(), sim: SIM }), 0);
  assert.equal(r.waypoints.length, 2);
  assert.equal(r.waypoints[1].sailPlan, 'light');
  assert.equal(r.waypoints[0].sailPlan, undefined);
});
