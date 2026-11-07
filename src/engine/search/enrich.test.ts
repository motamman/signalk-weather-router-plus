import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichLegRanges } from './enrich';
import { NoWind, type WindSource, type WaveConditions } from '../environment';
import type { Route, Waypoint } from '../route';
import { waypointProperties } from '../../plugin/routeformat';

/** Wind rising eastward (2 m/s per degree of longitude), waves too. */
class GradientWind implements WindSource {
  readonly hasWaves = true;
  at(lon: number): [number, number] {
    return [5 + lon * 2, 180];
  }
  atMany(lons: Float64Array): { speed: Float64Array; dir: Float64Array } {
    const speed = new Float64Array(lons.length);
    const dir = new Float64Array(lons.length);
    for (let i = 0; i < lons.length; i++) {
      speed[i] = 5 + lons[i] * 2;
      dir[i] = 180;
    }
    return { speed, dir };
  }
  wavesAt(lon: number): WaveConditions | null {
    return { swh: 0.5 + lon * 0.5, mwp: 8, mp2: 8, mwd: 180 };
  }
}

/** Wind with a data hole in the middle of the route's longitude span. */
class GappyWind extends GradientWind {
  override at(lon: number): [number, number] {
    if (lon > 1.4 && lon < 1.6) return [NaN, NaN];
    return super.at(lon);
  }
  override wavesAt(lon: number): WaveConditions | null {
    if (lon > 1.4 && lon < 1.6) return null;
    return super.wavesAt(lon);
  }
}

function twoPointRoute(hours: number): Route {
  const t0 = new Date('2026-10-04T00:00:00Z');
  const wp = (lon: number, time: Date): Waypoint => ({ lon, lat: 0, time, sogMs: 0, cogDeg: 90, mode: 'sailing' });
  return {
    waypoints: [wp(0, t0), wp(2, new Date(t0.getTime() + hours * 3600e3))],
    totalTimeS: hours * 3600,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: hours * 3600,
    validated: true,
  };
}

test('leg ranges span the wind and waves sampled along the leg', () => {
  const route = twoPointRoute(4);
  enrichLegRanges(route, new GradientWind());
  const [a, b] = route.waypoints;
  // Wind rises eastward from 5 m/s: the leg departing `a` covers 5..9 m/s.
  assert.ok(Math.abs(a.windMinMs! - 5) < 1e-9, `min ${a.windMinMs}`);
  assert.ok(Math.abs(a.windMaxMs! - 9) < 1e-9, `max ${a.windMaxMs}`);
  // Waves rise from 0.5 m to 1.5 m along the same leg.
  assert.ok(Math.abs(a.swhMinM! - 0.5) < 1e-9, `swh min ${a.swhMinM}`);
  assert.ok(Math.abs(a.swhMaxM! - 1.5) < 1e-9, `swh max ${a.swhMaxM}`);
  // The last waypoint has no departing leg, so no ranges.
  assert.equal(b.windMinMs, undefined);
  assert.equal(b.swhMaxM, undefined);
});

test('leg ranges tolerate data holes and a windless forecast', () => {
  const route = twoPointRoute(4);
  enrichLegRanges(route, new GappyWind());
  const [a] = route.waypoints;
  // The hole (1.4–1.6°) contributes nothing; the finite samples still bound.
  assert.ok(Math.abs(a.windMinMs! - 5) < 1e-9, `min ${a.windMinMs}`);
  assert.ok(Math.abs(a.windMaxMs! - 9) < 1e-9, `max ${a.windMaxMs}`);
  assert.ok(Math.abs(a.swhMinM! - 0.5) < 1e-9);
  assert.ok(Math.abs(a.swhMaxM! - 1.5) < 1e-9);

  const calm = twoPointRoute(2);
  enrichLegRanges(calm, new NoWind());
  assert.equal(calm.waypoints[0].windMinMs, 0);
  assert.equal(calm.waypoints[0].swhMinM, undefined);
});

test('leg ranges ride in the route GeoJSON point properties', () => {
  const route = twoPointRoute(4);
  enrichLegRanges(route, new GradientWind());
  const props = waypointProperties(route.waypoints[0]);
  assert.equal(props.leg_wind_min_ms, 5);
  assert.equal(props.leg_wind_max_ms, 9);
  assert.equal(props.leg_swh_min_m, 0.5);
  assert.equal(props.leg_swh_max_m, 1.5);
  // No departing leg on the last point: no range fields.
  const last = waypointProperties(route.waypoints[1]);
  assert.equal(last.leg_wind_min_ms, undefined);
  assert.equal(last.leg_swh_max_m, undefined);
});
