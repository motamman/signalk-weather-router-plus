/**
 * The chart mesh in the leg pipeline: when the mesh takes a leg, the
 * split into narrow and open segments, the Route built from a mesh
 * polyline, the hybrid leg (narrow parts motored, open water sailed by
 * the isochrone search) and the fall-through to the coastline search
 * when the mesh cannot route the leg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../../geo/landmask';
import type { ShapePolygon } from '../../geo/shapefile';
import { haversineDistanceM } from '../../geo/geodesy';
import { makeVessel } from '../../vessel/vessel';
import { NoCurrent, NoWind, type CurrentSource } from '../environment';
import { planLegs } from '../multileg';
import { runLegPipeline, type LegPipelineInputs } from '../pipeline';
import { classifySegments, type MeshLegRouter, meshRulesFor, routeFromMeshPath } from './leg';
import type { MeshRouteResult } from './route';

const T0 = new Date('2026-01-01T00:00:00Z');
const BOAT = makeVessel({ motorSpeedMs: 3, draughtM: 2, airDraftM: 18 });
const SIM = { modePolicy: 'motor' as const, sailThreshMs: 2.5, simStepM: 200 };

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

const STATS = { trianglesLoaded: 10, blocked: 2, expanded: 5, readMs: 1, prepMs: 1, searchMs: 1, funnelMs: 0 };

function fakeMesh(result: MeshRouteResult, covers = true): { mesh: MeshLegRouter; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    mesh: {
      covers: () => covers,
      route: async (start, end, rules) => {
        calls.push({ start, end, rules });
        return result;
      },
    },
    calls,
  };
}

/** A mesh answering with this path; widths default to open water everywhere. */
function fakeMeshOk(path: [number, number][], widths?: [number, number][]): ReturnType<typeof fakeMesh> {
  return fakeMesh({
    ok: true,
    path,
    widths: widths ?? path.map(() => [4000, 4000] as [number, number]),
    lengthM: 1,
    costS: 1,
    stats: STATS,
  });
}

function inputs(mesh: MeshLegRouter | undefined, over: Partial<LegPipelineInputs> = {}): { inp: LegPipelineInputs; messages: string[] } {
  const land = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 0.2)], { west: -1, south: -1, east: 2, north: 2 }, 0.005);
  const messages: string[] = [];
  const inp: LegPipelineInputs = {
    waterGrid: null,
    mesh,
    allowCanals: false,
    landFor: () => land,
    stages: 12,
    propagator: { subsectors: 20, headings: 30 },
    vessel: BOAT,
    polar: null,
    sim: SIM,
    simplifyM: 0,
    smoother: false,
    smootherTolerance: 0.05,
    loadAreas: async () => null,
    currents: () => ({ source: new NoCurrent(), names: null }),
    multi: false,
    progress: (_s, _t, m) => messages.push(m),
    shouldCancel: () => false,
    ...over,
  };
  return { inp, messages };
}

const PLAN = planLegs(
  [
    { lon: 0, lat: 0.5 },
    { lon: 1, lat: 0.5 },
  ],
  'precise',
  300
)[0];

test('meshRulesFor: both drafts set, no waypoint circles', () => {
  assert.deepEqual(meshRulesFor(BOAT, false), { rules: { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 } });
  assert.match(
    (meshRulesFor(makeVessel({ motorSpeedMs: 3, draughtM: 2 }), false) as { why: string }).why,
    /air draft \(Signal K design.airHeight/
  );
  assert.match(
    (meshRulesFor(makeVessel({ motorSpeedMs: 3, airDraftM: 18 }), false) as { why: string }).why,
    /draught \(Signal K design.draft.maximum/
  );
  assert.match((meshRulesFor(BOAT, true) as { why: string }).why, /waypoint circles/);
});

test('classifySegments: narrow where both shores are near, hysteresis by distance, open run-out kept in the narrow segment', () => {
  // 20 points 600 m apart along a meridian; points 6–13 have both shores within 400 m, the rest open.
  // The flip into narrow needs 1 km of narrow track (points 6–8) and lands on its first point; the flip
  // back needs 1 km of open track (14–16) and lands where that run completes, as the parent pads.
  const path: [number, number][] = [];
  const widths: [number, number][] = [];
  for (let i = 0; i < 20; i++) {
    path.push([0, (i * 600) / 111320]);
    widths.push(i >= 6 && i <= 13 ? [400, 300] : [4000, 4000]);
  }
  assert.deepEqual(classifySegments(path, widths), [
    { type: 'open', start: 0, end: 6 },
    { type: 'constrained', start: 6, end: 16 },
    { type: 'open', start: 16, end: 19 },
  ]);
  // One shore far: coastal, not constrained.
  const coastal = widths.map(([l]) => [l, 4000] as [number, number]);
  assert.deepEqual(classifySegments(path, coastal), [{ type: 'open', start: 0, end: 19 }]);
  // Two narrow points only (600 m of track): under the hysteresis, no flip.
  const brief = widths.map((w, i) => (i === 8 || i === 9 ? w : ([4000, 4000] as [number, number])));
  assert.deepEqual(classifySegments(path, brief), [{ type: 'open', start: 0, end: 19 }]);
});

test('routeFromMeshPath: segments timed at motor speed, totals and metadata set, a foul current fails it', () => {
  const path: [number, number][] = [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
  ];
  const r = routeFromMeshPath(path, T0, BOAT, null, new NoWind(), new NoCurrent(), SIM);
  assert.ok(r);
  assert.equal(r.waypoints.length, 3);
  assert.equal(r.meshLeg, true);
  assert.equal(r.validated, true);
  const d = haversineDistanceM(0, 0, 0.01, 0) + haversineDistanceM(0.01, 0, 0.01, 0.01);
  assert.ok(Math.abs(r.totalDistanceM - d) < 1e-6);
  assert.ok(Math.abs(r.totalTimeS - d / 3) < 1, `time ${r.totalTimeS} for ${d} m at 3 m/s`);
  assert.equal(r.motoringTimeS > 0 && r.sailingTimeS === 0, true);
  assert.ok(Math.abs(r.waypoints[1].cogDeg - 90) < 0.01);
  assert.ok(Math.abs(r.waypoints[1].sogMs - 3) < 0.01);
  // A current faster than the boat, against it: the segment cannot be made.
  const foul: CurrentSource = {
    at: () => [-4, 0],
    atMany: lons => ({ u: new Float64Array(lons.length).fill(-4), v: new Float64Array(lons.length) }),
  };
  assert.equal(routeFromMeshPath(path, T0, BOAT, null, new NoWind(), foul, SIM), null);
});

test('pipeline: a covered motoring leg is routed on the mesh, the coastline search is not run', async () => {
  const path: [number, number][] = [
    [0, 0.5],
    [0.5, 0.6],
    [1, 0.5],
  ];
  const { mesh, calls } = fakeMeshOk(path);
  const { inp, messages } = inputs(mesh, { avoidAreas: [{ lon: 0.5, lat: 0.4, radiusM: 500 }] });
  const r = await runLegPipeline(inp, PLAN, 0, [0, 0.5], T0);
  assert.equal(r.meshLeg, true);
  assert.deepEqual(
    r.waypoints.map(w => [w.lon, w.lat]),
    path
  );
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { rules: unknown }).rules, {
    draughtM: 2,
    airDraftM: 18,
    motorSpeedMs: 3,
    avoid: [{ lon: 0.5, lat: 0.4, radiusM: 500 }],
  });
  assert.ok(
    messages.some(m => /^chart mesh: \{distance:1\}, 3 points/.test(m)),
    messages.join('\n')
  );
  assert.ok(!messages.some(m => /^skeleton/.test(m)), 'the coastline search did not run');
});

test('pipeline: a sailing leg motors the narrow part of the mesh route and sails the open water with the isochrone search', async () => {
  // Six points: a narrow passage over the first three (both shores 200 m), then open water to the end.
  const path: [number, number][] = [
    [0, 0.5],
    [0.05, 0.5],
    [0.1, 0.5],
    [0.15, 0.5],
    [0.2, 0.5],
    [1, 0.5],
  ];
  const widths: [number, number][] = [
    [200, 200],
    [200, 200],
    [200, 200],
    [4000, 4000],
    [4000, 4000],
    [4000, 4000],
  ];
  const { mesh } = fakeMeshOk(path, widths);
  const { inp, messages } = inputs(mesh, { sim: { ...SIM, modePolicy: 'sail_max' } });
  const r = await runLegPipeline(inp, PLAN, 0, [0, 0.5], T0);
  assert.equal(r.meshLeg, true);
  assert.ok(
    messages.some(m => /chart mesh: 2 segment\(s\): 1 narrow .*, 1 open water/.test(m)),
    messages.join('\n')
  );
  assert.ok(
    messages.some(m => /segment 1\/2: narrow passage, motored along the mesh route/.test(m)),
    messages.join('\n')
  );
  assert.ok(
    messages.some(m => /segment 2\/2: open water, .* the isochrone search made it \d+ waypoints/.test(m)),
    messages.join('\n')
  );
  // The narrow part is the mesh polyline, motored, run out into open water (to point 4); the route goes on from there.
  assert.deepEqual(
    r.waypoints.slice(0, 5).map(w => [w.lon, w.lat, w.mode]),
    [
      [0, 0.5, 'motoring'],
      [0.05, 0.5, 'motoring'],
      [0.1, 0.5, 'motoring'],
      [0.15, 0.5, 'motoring'],
      [0.2, 0.5, 'motoring'],
    ]
  );
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(Math.abs(last.lon - 1) < 1e-6 && Math.abs(last.lat - 0.5) < 1e-6);
  for (let i = 1; i < r.waypoints.length; i++) assert.ok(r.waypoints[i].time >= r.waypoints[i - 1].time, 'time runs forward');
  assert.ok(r.totalDistanceM > 100000, `distance ${r.totalDistanceM}`);
});

test('pipeline: the mesh falls through to the coastline search when it finds no route or does not cover the leg', async () => {
  {
    const { mesh, calls } = fakeMesh({ ok: false, reason: 'no route on the mesh', stats: STATS });
    const { inp, messages } = inputs(mesh);
    const r = await runLegPipeline(inp, PLAN, 0, [0, 0.5], T0);
    assert.equal(r.meshLeg, undefined);
    assert.equal(calls.length, 1);
    assert.ok(
      messages.some(m => /^WARNING: chart mesh: no route on the mesh .*using the coastline search instead/.test(m)),
      messages.join('\n')
    );
    assert.ok(
      messages.some(m => /^skeleton/.test(m)),
      'the coastline search ran'
    );
    assert.ok(r.waypoints.length >= 2);
  }
  {
    // Not covered: never asked.
    const { mesh, calls } = fakeMesh({ ok: true, path: [], widths: [], lengthM: 0, costS: 0, stats: STATS }, false);
    const { inp, messages } = inputs(mesh);
    await runLegPipeline(inp, PLAN, 0, [0, 0.5], T0);
    assert.equal(calls.length, 0);
    assert.ok(!messages.some(m => /chart mesh/.test(m)));
  }
});
