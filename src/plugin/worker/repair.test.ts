/**
 * The chart-mesh repair (route.ts repairViolations; the owner's decision,
 * 2026-10-15): each blocked segment routed again and spliced back to front,
 * later waypoints shifted by the time the detour added, the stop's role
 * kept, a motoring detour on a sailing route warned, at most 5 detours;
 * what stays blocked is returned for finalDepthCheck to fail the route on.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DepthViolation, RouteDepthCheck } from '../../engine/mesh/check';
import type { Route, Waypoint } from '../../engine/route';
import { repairViolations } from './route';

const T0 = Date.parse('2026-10-15T12:00:00Z');
const wp = (lon: number, minutes: number, extra: Partial<Waypoint> = {}): Waypoint =>
  ({ lon, lat: 41, time: new Date(T0 + minutes * 60_000), mode: 'sailing', ...extra }) as Waypoint;
const route = (wps: Waypoint[]): Route =>
  ({ waypoints: wps, totalTimeS: 0, totalDistanceM: 0, motoringTimeS: 0, sailingTimeS: 0, validated: true }) as Route;
const violation = (segment: number, lon: number): DepthViolation => ({ leg: 0, segment, lon, lat: 41, kind: 'depth', value: 1 });
const check = (violations: DepthViolation[]): RouteDepthCheck => ({ legs: [], violations });
const quiet = (): void => {};

test('repair: a blocked segment is replaced by its detour, later waypoints shift by the time it added', async () => {
  const r = route([wp(0, 0), wp(1, 60), wp(2, 120, { role: 'via' }), wp(3, 180)]);
  const calls: [number, number][] = [];
  const out = await repairViolations(
    r,
    check([violation(1, 1.5)]),
    {
      sailing: true,
      detour: async (a, b) => {
        calls.push([a.lon, b.lon]);
        // Around the shoal: two waypoints, arriving 30 min later than the straight segment did.
        return route([wp(a.lon, 60), wp(1.4, 90), wp(1.6, 120), wp(b.lon, 150)]);
      },
    },
    async () => check([]),
    quiet,
    () => false
  );
  assert.deepEqual(calls, [[1, 2]]);
  assert.deepEqual(
    r.waypoints.map(w => [w.lon, (w.time.getTime() - T0) / 60_000]),
    [
      [0, 0],
      [1, 60],
      [1.4, 90],
      [1.6, 120],
      [2, 150],
      [3, 210],
    ]
  );
  assert.equal(r.waypoints[4].role, 'via', "the detour's end keeps the stop's role");
  assert.equal(r.waypoints[2].role, undefined);
  assert.equal(r.repairsApplied, 1);
  assert.deepEqual(out.violations, []);
  assert.equal(r.warnings, undefined);
});

test('repair: back to front, a motoring detour warns, what stays blocked is returned, at most 5 detours', async () => {
  const r = route(Array.from({ length: 9 }, (_v, i) => wp(i, i * 60)));
  const order: number[] = [];
  const all = [1, 2, 3, 4, 5, 6, 7].map(k => violation(k, k + 0.5));
  const out = await repairViolations(
    r,
    check(all),
    {
      sailing: true,
      detour: async (a, b) => {
        order.push(a.lon);
        const d = route([wp(a.lon, 0), wp(b.lon, 60)]);
        d.waypoints[0].time = a.time;
        d.waypoints[1].time = new Date(a.time.getTime() + 60 * 60_000);
        d.motoringTimeS = a.lon === 7 ? 600 : 0;
        return d;
      },
    },
    async () => check([violation(1, 1.5)]),
    quiet,
    () => false
  );
  assert.deepEqual(order, [7, 6, 5, 4, 3], 'five detours, the last segment first');
  assert.equal(r.repairsApplied, 5);
  // leg_index is the segment (as stitchLegs indexes warnings); these detours add no waypoints, so nothing moves.
  assert.deepEqual(
    (r.warnings ?? []).map(w => [w.violation, w.leg_index, w.detail]),
    [['detour_motored', 7, '600']]
  );
  assert.deepEqual(
    out.violations.map(v => v.segment),
    [1]
  );
});

test('repair: warnings after a detour move with its waypoints; those before it stay', async () => {
  const r = route([wp(0, 0), wp(1, 60), wp(2, 120), wp(3, 180), wp(4, 240)]);
  r.warnings = [
    { leg_index: 0, violation: 'wind_over_limit', from: [0, 41], to: [1, 41], repaired: false },
    { leg_index: 2, violation: 'wind_over_limit', from: [2, 41], to: [3, 41], repaired: false },
  ];
  await repairViolations(
    r,
    check([violation(1, 1.5), violation(3, 3.5)]),
    {
      sailing: true,
      detour: async (a, b) => {
        // Segment 3: straight, motored; segment 1: two waypoints round the shoal.
        const d = a.lon === 3 ? route([wp(3, 180), wp(4, 240)]) : route([wp(a.lon, 60), wp(1.4, 80), wp(1.6, 100), wp(b.lon, 120)]);
        d.motoringTimeS = a.lon === 3 ? 300 : 0;
        return d;
      },
    },
    async () => check([]),
    quiet,
    () => false
  );
  assert.deepEqual(
    r.waypoints.map(w => w.lon),
    [0, 1, 1.4, 1.6, 2, 3, 4]
  );
  assert.deepEqual(
    (r.warnings ?? []).map(w => [w.violation, w.leg_index]),
    [
      ['wind_over_limit', 0],
      ['wind_over_limit', 4],
      ['detour_motored', 5],
    ]
  );
  // Each warning still starts at the waypoint it started at.
  assert.deepEqual(
    (r.warnings ?? []).map(w => r.waypoints[w.leg_index].lon),
    [0, 2, 3]
  );
});

test("repair: the replaced segment's limit and wave-correction warnings go, the detour's own come in at its place", async () => {
  const r = route([wp(0, 0), wp(1, 60), wp(2, 120), wp(3, 180)]);
  const warn = (leg_index: number, violation: 'wind_over_limit' | 'waves_outside_correction' | 'leg_crosses_land', lon: number) => ({
    leg_index,
    violation,
    from: [lon, 41] as [number, number],
    to: [lon + 1, 41] as [number, number],
    repaired: false,
  });
  r.warnings = [
    warn(0, 'wind_over_limit', 0),
    warn(1, 'waves_outside_correction', 1),
    warn(1, 'leg_crosses_land', 1),
    warn(2, 'wind_over_limit', 2),
  ];
  await repairViolations(
    r,
    check([violation(1, 1.5)]),
    {
      sailing: true,
      detour: async (a, b) => {
        const d = route([wp(a.lon, 60), wp(1.4, 80), wp(1.6, 100), wp(b.lon, 120)]);
        // On the detour, outside the wave correction on its second segment (1.4 → 1.6).
        d.warnings = [warn(1, 'waves_outside_correction', 1.4)];
        return d;
      },
    },
    async () => check([]),
    quiet,
    () => false
  );
  assert.deepEqual(
    (r.warnings ?? []).map(w => [w.violation, w.leg_index, r.waypoints[w.leg_index].lon]),
    [
      ['wind_over_limit', 0, 0],
      ['leg_crosses_land', 1, 1],
      ['wind_over_limit', 4, 2],
      ['waves_outside_correction', 2, 1.4],
    ]
  );
});

test('repair: opening bridges after a detour move with its waypoints, the replaced segment drops its own, the detour adds its own', async () => {
  const r = route([wp(0, 0), wp(1, 60), wp(2, 120), wp(3, 180), wp(4, 240)]);
  // legIndex: the waypoint the crossing leg arrives at (multileg.ts stitchLegs).
  r.drawbridges = [
    { lon: 0.5, lat: 41, clearM: 2, legIndex: 1 },
    { lon: 1.5, lat: 41, clearM: 3, legIndex: 2 }, // on the blocked segment 1 → 2
    { lon: 3.5, lat: 41, clearM: 4, legIndex: 4 },
  ];
  await repairViolations(
    r,
    check([violation(1, 1.5)]),
    {
      sailing: true,
      detour: async (a, b) => {
        const d = route([wp(a.lon, 60), wp(1.4, 80), wp(1.6, 100), wp(b.lon, 120)]);
        // The detour passes under a bridge of its own, on its leg arriving at its waypoint 2.
        d.drawbridges = [{ lon: 1.5, lat: 41.1, clearM: 5, legIndex: 2 }];
        return d;
      },
    },
    async () => check([]),
    quiet,
    () => false
  );
  assert.deepEqual(
    r.waypoints.map(w => w.lon),
    [0, 1, 1.4, 1.6, 2, 3, 4]
  );
  assert.deepEqual(
    (r.drawbridges ?? []).map(b => [b.clearM, b.legIndex]),
    [
      [2, 1],
      [5, 3],
      [4, 6],
    ]
  );
  // Each still arrives at the waypoint after it.
  assert.deepEqual(
    (r.drawbridges ?? []).map(b => r.waypoints[b.legIndex].lon),
    [1, 1.6, 4]
  );
});

test('repair: a sailing detour stuck at Min sail speed 0 says the detour could not tack clear, not to change the setting', async () => {
  const r = route([wp(0, 0), wp(1, 60)]);
  const said: string[] = [];
  await repairViolations(
    r,
    check([violation(0, 0.5)]),
    {
      sailing: true,
      detour: async () => {
        throw new Error(
          'chart mesh segment 1/1: ROUTE FAILED: the beat from 41.0000, 0.0000 towards 41.0000, 1.0000 cannot be tacked at 41.0000, 0.0000: every tack tried crossed land or could not be sailed, and the course itself cannot be sailed straight. Min sail speed is 0 (never motor), so the boat may not motor where it cannot tack: set Min sail speed above 0'
        );
      },
    },
    async () => check([]),
    (_s, _t, m) => said.push(m),
    () => false
  );
  assert.equal(said.length, 1);
  assert.match(
    said[0],
    /^WARNING: repair: no detour around 41\.0000, 0\.5000 \(charted depth \{depth:1\}\): a sailing detour could not tack clear/
  );
  assert.doesNotMatch(said[0], /set Min sail speed/);
});

test('repair: a motor route does not warn about motoring; a failed detour leaves the segment for the caller', async () => {
  const r = route([wp(0, 0), wp(1, 60), wp(2, 120)]);
  const out = await repairViolations(
    r,
    check([violation(0, 0.5)]),
    {
      sailing: false,
      detour: async () => {
        throw new Error('no water path');
      },
    },
    async () => check([]),
    quiet,
    () => false
  );
  assert.equal(r.repairsApplied, undefined);
  assert.equal(r.waypoints.length, 3);
  assert.deepEqual(
    out.violations.map(v => v.segment),
    [0]
  );
});
