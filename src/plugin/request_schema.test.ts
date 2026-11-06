import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_REQUEST_FIELDS, routeRequestSchema, validateRouteRequest } from './request_schema';
import { SETTINGS_SPEC } from './settings';
import type { RouteRequest } from './protocol';

const ok: RouteRequest = { start: { lat: 40.5, lon: -73.9 }, end: { lat: 40.4, lon: -73.6 } };

test('route request: ranges come from the settings they override, and the OpenAPI schema lists every field', () => {
  const spec = (k: string) => SETTINGS_SPEC.find(s => s.key === k)!;
  for (const [field, key] of [
    ['stages', 'routing.stages'],
    ['max_wind_ms', 'routing.maxWind'],
    ['max_swh_m', 'routing.maxSwh'],
    ['simplify_m', 'routing.simplify'],
    ['smoother_tolerance', 'routing.smootherTolerance'],
    ['smoother_sim_step_m', 'routing.simStep'],
    ['tack_penalty', 'routing.tackPenalty'],
  ] as const) {
    // The field's JSON Schema keywords (TypeBox's types do not declare them on a number).
    const f = ROUTE_REQUEST_FIELDS[field] as { type?: string; minimum?: number; maximum?: number };
    assert.equal(f.type, 'number');
    assert.deepEqual([f.minimum, f.maximum], [spec(key).min, spec(key).max], field);
  }
  const schema = routeRequestSchema() as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties), [
    'start',
    'end',
    'waypoints',
    ...Object.keys(ROUTE_REQUEST_FIELDS),
    'vessel',
    'ensemble',
  ]);
});

test('route request: an ensemble check names a known ensemble and 5 to 51 members (50 and a control)', () => {
  assert.equal(validateRouteRequest({ ...ok, ensemble: { model: 'ifs-ens', members: 5 } }), null);
  assert.equal(validateRouteRequest({ ...ok, ensemble: { model: 'aifs-ens', members: 51 } }), null);
  assert.equal(
    validateRouteRequest({ ...ok, ensemble: { model: 'gefs', members: 5 } as unknown as RouteRequest['ensemble'] }),
    'ensemble.model must be ifs-ens or aifs-ens'
  );
  for (const members of [4, 52, 5.5, '10'])
    assert.equal(
      validateRouteRequest({ ...ok, ensemble: { model: 'ifs-ens', members } as unknown as RouteRequest['ensemble'] }),
      'ensemble.members must be a whole number 5..51',
      String(members)
    );
  assert.equal(validateRouteRequest({ ...ok, ensemble: null as unknown as RouteRequest['ensemble'] }), 'ensemble must be {model, members}');
});

test('route request: valid bodies pass, each bad field names itself', () => {
  assert.equal(validateRouteRequest(ok), null);
  assert.equal(
    validateRouteRequest({ ...ok, stages: 50, mode: 'motor', smoother: false, departure: '', vessel: { polar_performance: 0.9 } }),
    null
  );
  assert.equal(validateRouteRequest({ ...ok, start: { lat: 'x', lon: 1 } } as unknown as RouteRequest), 'start must be {lat, lon}');
  assert.equal(validateRouteRequest({ ...ok, end: { lat: 95, lon: 1 } }), 'end out of range');
  assert.equal(validateRouteRequest({ ...ok, waypoints: new Array(21).fill({ lat: 40, lon: -73 }) }), 'at most 20 waypoints');
  assert.equal(validateRouteRequest({ ...ok, stages: 3 }), 'stages must be 4..200');
  assert.equal(validateRouteRequest({ ...ok, max_wind_ms: 120 }), 'max_wind_ms must be 0..100');
  assert.equal(validateRouteRequest({ ...ok, sail_thresh_ms: -1 }), 'sail_thresh_ms must be >= 0');
  assert.equal(validateRouteRequest({ ...ok, tack_penalty: 0, smoother_sim_step_m: 5000 }), null);
  assert.equal(validateRouteRequest({ ...ok, tack_penalty: 3601 }), 'tack_penalty must be 0..3600');
  assert.equal(validateRouteRequest({ ...ok, tack_penalty: -1 }), 'tack_penalty must be 0..3600');
  assert.equal(validateRouteRequest({ ...ok, smoother_sim_step_m: 49 }), 'smoother_sim_step_m must be 50..5000');
  assert.equal(validateRouteRequest({ ...ok, smoother_sim_step_m: 5001 }), 'smoother_sim_step_m must be 50..5000');
  assert.equal(
    validateRouteRequest({ ...ok, mode: 'drift' as unknown as RouteRequest['mode'] }),
    'mode must be sail_max, fastest or motor'
  );
  assert.equal(validateRouteRequest({ ...ok, departure: 'yesterday' }), 'departure must be ISO 8601');
  assert.equal(validateRouteRequest({ ...ok, smoother: 'yes' as unknown as boolean }), 'smoother must be true or false');
  assert.equal(
    validateRouteRequest({ ...ok, precision: 'approximate', arrival_radius_m: 0 }),
    'arrival_radius_m must be > 0 when precision is "approximate" (use "precise" for exact waypoints)'
  );
  assert.equal(validateRouteRequest({ ...ok, vessel: { polar_performance: 2 } }), 'vessel.polar_performance must be 0.3..1.2');
  assert.equal(validateRouteRequest({ ...ok, vessel: { polar: 'x'.repeat(201) } }), 'vessel.polar must be a polar token from /api/polars');
  assert.equal(validateRouteRequest({ ...ok, vessel: null as unknown as RouteRequest['vessel'] }), 'vessel must be an object');
});
