import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CURRENT_MS, scoreCandidatesFromParent, simulateLegTime, type SimOptions } from './legsim';
import type { CurrentSource, WindSource } from './environment';
import { makeVessel } from '../vessel/vessel';
import { PolarDiagram } from '../vessel/polar';
import { OceanPropagator, RouteError, ViasNotCrossedError } from './propagator';
import { RouteRefused, refusalText } from './refusal';
import { forecastNote } from './search/context';
import { ExperimentalPropagator } from './experimental/propagator';
import { LandMask } from '../geo/landmask';
import { limitWarnings } from './smoother';
import { routeFromMeshPath } from './mesh/leg';
import { computeAvoidingLimits } from './limitavoid';
import type { Route } from './route';

/** Uniform wind and waves everywhere. */
function wind(speedMs: number, swhM: number): WindSource {
  return {
    at: () => [speedMs, 180],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(speedMs), dir: new Float64Array(lons.length).fill(180) }),
    hasWaves: true,
    wavesAt: () => ({ swh: swhM, mwp: 6, mwd: 180 }),
    wavesAtMany: lons => new Float64Array(lons.length).fill(swhM),
  };
}
const still: CurrentSource = {
  at: () => [0, 0],
  atMany: lons => ({ u: new Float64Array(lons.length), v: new Float64Array(lons.length) }),
};
const vessel = makeVessel({ motorSpeedMs: 3 });
const base: SimOptions = { modePolicy: 'motor', sailThreshMs: 2, simStepM: 200 };
const t0 = new Date('2026-10-01T00:00:00Z');

test('limits: a leg over the wind or wave limit is stuck; under the limits it is not', () => {
  const ok = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(10, 1.5), still, base);
  assert.ok(Number.isFinite(ok.seconds) && ok.seconds > 0);
  const windy = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(20, 1.5), still, { ...base, maxWindMs: 15 });
  assert.equal(windy.seconds, Infinity);
  assert.equal(windy.dominantMode, 'stuck');
  const rough = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(10, 2.5), still, { ...base, maxSwhM: 2 });
  assert.equal(rough.seconds, Infinity);
  // Limits exactly met are allowed.
  const edge = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(15, 2), still, { ...base, maxWindMs: 15, maxSwhM: 2 });
  assert.ok(Number.isFinite(edge.seconds));
});

test('limits: scored candidates over a limit are stuck and flagged as limited', () => {
  const bearings = new Float64Array([0, 90, 180]);
  const dists = new Float64Array([1000, 1000, 1000]);
  const free = scoreCandidatesFromParent(0, 0, t0, bearings, dists, vessel, null, wind(20, 3), still, base);
  assert.ok(free.seconds.every(s => Number.isFinite(s)));
  assert.ok(free.limited.every(l => l === 0));
  const capped = scoreCandidatesFromParent(0, 0, t0, bearings, dists, vessel, null, wind(20, 3), still, { ...base, maxSwhM: 2.5 });
  assert.ok(capped.seconds.every(s => s === Infinity));
  assert.ok(capped.limited.every(l => l === 1));
  assert.ok(capped.dominant.every(d => d === -1));
  // Without wave data in the forecast a wave limit cannot stop anything.
  const noWaves: WindSource = { ...wind(20, 3), hasWaves: false, wavesAt: () => null, wavesAtMany: undefined };
  const dry = scoreCandidatesFromParent(0, 0, t0, bearings, dists, vessel, null, noWaves, still, { ...base, maxSwhM: 2.5 });
  assert.ok(dry.seconds.every(s => Number.isFinite(s)));
});

test('a zero min sail speed sails whenever the polar gives any speed; where it gives none the leg is stuck (so the router tacks), not motored', () => {
  const dead = new PolarDiagram([45, 135], [5, 15], [0, 0, 0, 0]);
  const r = simulateLegTime(0, 0, t0, 0.01, 0, vessel, dead, wind(10, 1), still, {
    modePolicy: 'sail_max',
    sailThreshMs: 0,
    simStepM: 200,
  });
  assert.equal(r.seconds, Infinity);
  assert.equal(r.dominantMode, 'stuck');
  const slow = new PolarDiagram([45, 135], [5, 15], [1, 1, 1, 1]);
  const s = simulateLegTime(0, 0, t0, 0.01, 0, vessel, slow, wind(10, 1), still, {
    modePolicy: 'sail_max',
    sailThreshMs: 0,
    simStepM: 200,
  });
  assert.equal(s.dominantMode, 'sailing');
});

test('a search boxed in by the wind limit fails with a message that counts the limited candidates and names the forecast end', () => {
  // Open water; wind from the north, 8 m/s west of 0.3°E and 20 m/s east of
  // it, so with a 15 m/s limit the route can never get past that line.
  const bbox = { west: -1, south: -3, east: 3, north: 4 };
  const lm = LandMask.fromPolygons([], bbox, 0.02);
  const banded: WindSource = {
    at: (lon: number) => [lon < 0.3 ? 8 : 20, 0],
    atMany: lons => ({ speed: Float64Array.from(lons, lon => (lon < 0.3 ? 8 : 20)), dir: new Float64Array(lons.length) }),
    hasWaves: false,
    wavesAt: () => null,
  };
  const polar = new PolarDiagram(
    [45, 60, 90, 120, 150],
    [4, 8, 12],
    [2.5, 3.2, 3.5, 3.4, 3.0, 3.0, 3.8, 4.2, 4.0, 3.5, 3.3, 4.1, 4.6, 4.4, 3.9]
  );
  const prop = new OceanPropagator(lm, { stages: 8, subsectors: 20, headings: 30 });
  const run = (forecastEndMs?: number) =>
    prop.computeRoute({
      start: [0, 0.5],
      end: [2, 0.5],
      departureTime: t0,
      vessel,
      polar,
      wind: banded,
      modePolicy: 'sail_max',
      sailThreshMs: 0,
      maxWindMs: 15,
      forecastEndMs,
    });
  assert.throws(run, (err: Error) => {
    assert.ok(err instanceof RouteError && err.code === 'boxed_in', `${err.name}: ${err.message}`);
    assert.match(err.message, /wind \{speed:[^}]+\} against your \{speed:15\} limit/);
    assert.ok(
      err instanceof RouteRefused && err.refusal.kind === 'over_limit' && /over the wind\/wave limit/.test(err.detail),
      err.message
    );
    assert.doesNotMatch(err.message, /forecast ends/);
    return true;
  });
  // With a forecast that ended before the search got stuck, the message says so.
  assert.throws(
    () => run(t0.getTime() + 3600_000),
    (err: Error) => {
      assert.ok(err instanceof RouteError && err.code === 'boxed_in', `${err.name}: ${err.message}`);
      assert.match(err.message, /The forecast ends 2026-10-01 01:00 UTC and the search is \d+ h past it/);
      return true;
    }
  );
  // Without the limit the same route is found.
  const free = prop.computeRoute({
    start: [0, 0.5],
    end: [2, 0.5],
    departureTime: t0,
    vessel,
    polar,
    wind: banded,
    modePolicy: 'sail_max',
    sailThreshMs: 0,
  });
  assert.ok(free.waypoints.length >= 2);
});

test('boxed in before a via is crossed raises ViasNotCrossedError (so the router can retry without automatic vias)', () => {
  // A band over the wind limit between 0.3°E and 0.5°E south of 1°N holds
  // the via; the destination beyond is reachable around the band's north
  // end, but no branch can cross the via, so the search must not end with
  // a plain "boxed in" (the caller retries without auto vias only on the
  // vias error; job 58b50b0d, east of Crete with the Kythira via behind).
  const bbox = { west: -1, south: -3, east: 3, north: 4 };
  const lm = LandMask.fromPolygons([], bbox, 0.02);
  const over = (lon: number, lat: number): boolean => lon > 0.3 && lon < 0.5 && lat < 1.0;
  const banded: WindSource = {
    at: (lon: number, lat: number) => [over(lon, lat) ? 20 : 8, 0],
    atMany: (lons, lats) => ({
      speed: Float64Array.from(lons, (lon, i) => (over(lon, lats[i]) ? 20 : 8)),
      dir: new Float64Array(lons.length),
    }),
    hasWaves: false,
    wavesAt: () => null,
  };
  const polar = new PolarDiagram(
    [45, 60, 90, 120, 150],
    [4, 8, 12],
    [2.5, 3.2, 3.5, 3.4, 3.0, 3.0, 3.8, 4.2, 4.0, 3.5, 3.3, 4.1, 4.6, 4.4, 3.9]
  );
  const prop = new OceanPropagator(lm, { stages: 8, subsectors: 20, headings: 30 });
  assert.throws(
    () =>
      prop.computeRoute({
        start: [0, 0.5],
        end: [2, 0.5],
        departureTime: t0,
        vessel,
        polar,
        wind: banded,
        modePolicy: 'sail_max',
        sailThreshMs: 0,
        maxWindMs: 15,
        vias: [{ lon: 0.4, lat: 0.5, radiusM: 5000, auto: true, name: 'the band' }],
      }),
    (err: Error) => {
      assert.ok(err instanceof ViasNotCrossedError, `${err.name}: ${err.message}`);
      assert.match(err.message, /deepest branch crossed 0/);
      assert.match(err.message, /next via at the band/);
      return true;
    }
  );
});

test('a leg stopped by a foul current says so, and a current above MAX_CURRENT_MS is read as no data', () => {
  // Heading east (lon 0 → 0.01), motor 3 m/s; a 5 m/s current flowing west cancels it.
  const foul: CurrentSource = {
    at: () => [-5, 0],
    atMany: lons => ({ u: new Float64Array(lons.length).fill(-5), v: new Float64Array(lons.length) }),
  };
  const r = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(10, 1), foul, base);
  assert.equal(r.seconds, Infinity);
  assert.equal(r.reason, 'current');
  // A "current" of 50 m/s is a data error: ignored, the leg motors through.
  const bad: CurrentSource = {
    at: () => [-50, 0],
    atMany: lons => ({ u: new Float64Array(lons.length).fill(-50), v: new Float64Array(lons.length) }),
  };
  assert.ok(50 > MAX_CURRENT_MS);
  const ok = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(10, 1), bad, base);
  assert.ok(Number.isFinite(ok.seconds) && ok.seconds > 0);
  const sc = scoreCandidatesFromParent(0, 0, t0, new Float64Array([90]), new Float64Array([1000]), vessel, null, wind(10, 1), bad, base);
  assert.equal(sc.badCurrent[0], 1);
  assert.equal(sc.foul[0], 0);
});

test('when no final leg can be sailed, the error says why for the legs tried and gives the conditions at the nearest candidate', () => {
  // Open water, route east along lat 0.5; a 5 m/s westward current within
  // 0.06° of the destination stops every final leg (motor 3 m/s).
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([], bbox, 0.02);
  const end: [number, number] = [1.0, 0.5];
  const near = (lon: number, lat: number): boolean => Math.abs(lon - end[0]) < 0.06 && Math.abs(lat - end[1]) < 0.06;
  const band: CurrentSource = {
    at: (lon, lat) => (near(lon, lat) ? [-5, 0] : [0, 0]),
    atMany: (lons, lats) => ({ u: Float64Array.from(lons, (lon, i) => (near(lon, lats[i]) ? -5 : 0)), v: new Float64Array(lons.length) }),
  };
  const prop = new OceanPropagator(lm, { stages: 10, subsectors: 20, headings: 30 });
  assert.throws(
    () =>
      prop.computeRoute({
        start: [0, 0.5],
        end,
        departureTime: t0,
        vessel,
        polar: null,
        wind: wind(10, 1),
        current: band,
        modePolicy: 'motor',
        sailThreshMs: 0,
      }),
    (err: Error) => {
      assert.match(err.message, /terminal hop to the destination could not be simulated/);
      assert.match(err.message, /Of the \d+ final legs tried: \d+ stopped by a current stronger than the boat's speed/);
      assert.match(
        err.message,
        /at the nearest \([\d.]+ km out, 2026-10-01 \d\d:\d\d UTC\): final leg bearing \d+°, wind 10\.0 m\/s from 180°, current 0\.00 m\/s towards 0°/
      ); // the band is only around the destination
      return true;
    }
  );
});

test('avoid: a leg over a limit set to avoid is allowed, its time over counting (1 + strength) in the penalty, once for both limits', () => {
  const blocked = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(20, 3), still, { ...base, maxWindMs: 15, maxSwhM: 2 });
  assert.equal(blocked.seconds, Infinity, 'block, the default, is unchanged');
  const free = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(20, 3), still, base);
  const avoid = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(20, 3), still, {
    ...base,
    maxWindMs: 15,
    maxSwhM: 2,
    maxWindMode: 'avoid',
    maxSwhMode: 'avoid',
    limitAvoidStrength: 2,
  });
  assert.ok(Math.abs(avoid.seconds - free.seconds) < 1e-9, 'the real time is unchanged');
  assert.ok(Math.abs(avoid.penaltySeconds - 2 * avoid.seconds) < 1e-6, 'over both limits, charged once at strength 2');
  assert.ok(Math.abs(avoid.overWindSeconds - avoid.seconds) < 1e-9);
  assert.ok(Math.abs(avoid.overSwhSeconds - avoid.seconds) < 1e-9);
  // Default strength 1; one limit avoided while the other blocks still blocks.
  const one = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(20, 1), still, { ...base, maxWindMs: 15, maxWindMode: 'avoid' });
  assert.ok(Math.abs(one.penaltySeconds - one.seconds) < 1e-6);
  assert.equal(one.overSwhSeconds, 0);
  const mixed = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(20, 3), still, {
    ...base,
    maxWindMs: 15,
    maxSwhM: 2,
    maxWindMode: 'avoid',
  });
  assert.equal(mixed.seconds, Infinity, 'the wave limit still blocks');
  // Under the limits: nothing over, no surcharge.
  const calm = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(10, 1), still, { ...base, maxWindMs: 15, maxWindMode: 'avoid' });
  assert.equal(calm.penaltySeconds, 0);
  assert.equal(calm.overWindSeconds, 0);
});

test('avoid: the route goes round water over a limit when that costs less than the surcharge, through it otherwise or when no way round exists', () => {
  // Open water; a band over the wind limit across the direct line east (lon 0.4 to 0.6). Motor 3 m/s.
  const bbox = { west: -1, south: -2, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([], bbox, 0.02);
  const banded = (halfLat: number): WindSource => {
    const over = (lon: number, lat: number): boolean => lon > 0.4 && lon < 0.6 && Math.abs(lat) < halfLat;
    return {
      at: (lon: number, lat: number) => [over(lon, lat) ? 20 : 8, 0],
      atMany: (lons, lats) => ({
        speed: Float64Array.from(lons, (lon, i) => (over(lon, lats[i]) ? 20 : 8)),
        dir: new Float64Array(lons.length),
      }),
      hasWaves: false,
      wavesAt: () => null,
    };
  };
  const prop = new OceanPropagator(lm, { stages: 10, subsectors: 20, headings: 30 });
  const logs: string[] = [];
  const run = (halfLat: number, strength: number): Route =>
    computeAvoidingLimits(
      a => prop.computeRoute(a),
      {
        start: [0, 0],
        end: [1, 0],
        departureTime: t0,
        vessel,
        polar: null,
        wind: banded(halfLat),
        modePolicy: 'motor',
        sailThreshMs: 0,
        maxWindMs: 15,
        maxWindMode: 'avoid',
        limitAvoidStrength: strength,
      },
      m => logs.push(m)
    );
  const maxLat = (r: Route): number => Math.max(...r.waypoints.map(w => Math.abs(w.lat)));
  // The band is 0.2° (22 km) wide: about 7,400 s over it at 3 m/s; the way round costs about 2,600 s more.
  assert.ok(maxLat(run(0.06, 1)) > 0.06, 'strength 1: the surcharge exceeds the detour, round');
  assert.match(logs.at(-1)!, /goes round/);
  assert.ok(maxLat(run(0.06, 0.2)) < 0.01, 'strength 0.2: the detour costs more, through');
  assert.match(logs.at(-1)!, /goes through, the way round costing more/);
  assert.ok(maxLat(run(0.06, 0)) < 0.01, 'strength 0: through');
  // A band the search cannot get round: through, whatever the strength.
  assert.ok(maxLat(run(0.3, 10)) < 0.01);
  assert.match(logs.at(-1)!, /no way round it/);
});

test('limitWarnings: legs over a limit set to avoid get a warning with the seconds over; block leaves the search warnings as they are', () => {
  const t1 = new Date(t0.getTime() + 3600_000);
  const route: Route = {
    waypoints: [
      { lon: 0, lat: 0, time: t0, sogMs: 3, cogDeg: 90, mode: 'motoring' },
      { lon: 0.01, lat: 0, time: t1, sogMs: 3, cogDeg: 90, mode: 'motoring' },
    ],
    totalTimeS: 3600,
    totalDistanceM: 1113,
    motoringTimeS: 3600,
    sailingTimeS: 0,
    validated: true,
    warnings: [{ leg_index: 0, violation: 'waves_over_limit', from: [0, 0], to: [0.01, 0], repaired: false }],
  };
  const env = { vessel, polar: null, wind: wind(20, 3), current: still };
  limitWarnings(route, { ...env, sim: { ...base, maxWindMs: 15, maxSwhM: 2 } });
  assert.deepEqual(
    route.warnings?.map(w => w.violation),
    ['waves_over_limit'],
    'block: unchanged'
  );
  limitWarnings(route, { ...env, sim: { ...base, maxWindMs: 15, maxSwhM: 2, maxWindMode: 'avoid', maxSwhMode: 'avoid' } });
  const w = route.warnings ?? [];
  assert.deepEqual(w.map(x => x.violation).sort(), ['waves_over_limit', 'wind_over_limit']);
  assert.ok(
    w.every(x => x.leg_index === 0 && Number(x.detail) > 0),
    'the seconds over, on the leg'
  );
});

test('a walk along the mesh route stopped by a limit set to block says so, not the current', () => {
  const stuck: { reason?: 'limited' | 'no_go' | 'current' | 'no_speed' } = {};
  const r = routeFromMeshPath(
    [
      [0, 0],
      [0.01, 0],
    ],
    t0,
    vessel,
    null,
    wind(20, 1),
    still,
    { ...base, maxWindMs: 15 },
    stuck
  );
  assert.equal(r, null);
  assert.equal(stuck.reason, 'limited');
});

test('a front stopped by land alone is told to find open water, not another departure, and is not offered a longer forecast', () => {
  const land = refusalText({ kind: 'mixed', at: 'front', atMs: t0.getTime(), reasons: ['land'] });
  assert.match(land, /Add a waypoint in open water round the land, or move a point that is close to the shore into open water\./);
  assert.doesNotMatch(land, /departure/);
  const mixed = refusalText({ kind: 'mixed', at: 'front', atMs: t0.getTime(), reasons: ['land', 'limit'] });
  assert.match(mixed, /Add a waypoint or choose another departure\./);
  const ctx = (lastTry: { tried: number; land: number; limited: number; noGo: number; stuck: number }) =>
    ({ args: { forecastEndMs: t0.getTime() }, lastTry: { ...lastTry, latestMs: t0.getTime() + 100 * 3600_000 } }) as unknown as Parameters<
      typeof forecastNote
    >[0];
  assert.equal(forecastNote(ctx({ tried: 600, land: 480, limited: 0, noGo: 0, stuck: 0 })), '', 'land alone: no forecast note');
  assert.match(forecastNote(ctx({ tried: 600, land: 300, limited: 0, noGo: 200, stuck: 0 })), /longer forecast horizon/);
});

test('a laid-out leg stopped by a limit set to block says so and advises the limit, not motoring', () => {
  const polar = new PolarDiagram([45, 90, 135], [4, 12], [3, 4, 4, 5, 3.5, 4.5]);
  const lm = LandMask.fromPolygons([], { west: -1, south: -1, east: 2, north: 2 }, 0.02);
  const lay = new ExperimentalPropagator(lm, { stages: 8, subsectors: 20, headings: 30 });
  assert.throws(
    () =>
      lay.sailPolyline(
        [
          [0, 0],
          [0.05, 0],
        ],
        t0,
        {
          vessel,
          polar,
          wind: wind(20, 1),
          current: still,
          sim: { modePolicy: 'sail_max', sailThreshMs: 0.1, simStepM: 200, maxWindMs: 15 },
          who: 'test',
          advice: 'raise Min sail speed',
        }
      ),
    (err: Error) => {
      assert.match(err.message, /over the wind or wave limit/);
      assert.match(err.message, /raise the limit, set it to Avoid, or change the departure/);
      assert.doesNotMatch(err.message, /Min sail speed/);
      return true;
    }
  );
});
