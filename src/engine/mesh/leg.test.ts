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
import { ConstantWind, NoCurrent, NoWind, type CurrentSource } from '../environment';
import { planLegs } from '../multileg';
import { PolarDiagram } from '../../vessel/polar';
import { runLegPipeline, type LegPipelineInputs } from '../pipeline';
import { classifySegments, meshCorridor, type MeshLegRunner, meshRulesFor, routeFromMeshPath } from './leg';
import { type MeshLegLand, runMeshLeg } from './legrun';
import type { MeshRouteResult } from './route';
import type { LegWind } from '../horizon';

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

const STATS = {
  trianglesLoaded: 10,
  blocked: 2,
  expanded: 5,
  readMs: 1,
  prepMs: 1,
  searchMs: 1,
  funnelMs: 0,
  padDeg: 0.5,
  attempts: 1,
  bufferM: 0,
  buffered: 0,
  bufferMs: 0,
};
const BOX = { west: -1, south: -1, east: 2, north: 2 };
/** The coastline the tests route on: one island south of the lat 0.5 line. */
const COAST = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 0.2)], BOX, 0.005);

/** A mesh land for the in-process runner: the coastline mask, an extra blocked test, and a depth. */
function fakeLand(
  extra: (lonA: number, latA: number, lonB: number, latB: number) => boolean = () => false,
  depthAt: (lon: number, lat: number) => number | null = () => null
): MeshLegLand {
  const point = (lon: number, lat: number): boolean => COAST.isLandExact(lon, lat) || extra(lon, lat, lon, lat);
  const leg = (a: number, b: number, c: number, d: number): boolean => COAST.legCrossesLandExact(a, b, c, d) || extra(a, b, c, d);
  return {
    isLand: point,
    isLandExact: point,
    legCrossesLandExact: leg,
    legsCrossLandBulk: (la, pa, lb, pb) => Uint8Array.from({ length: la.length }, (_v, k) => (leg(la[k], pa[k], lb[k], pb[k]) ? 1 : 0)),
    depthAt,
  };
}

interface FakeEnv {
  wind?: LegWind | null;
  land?: MeshLegLand;
}

/** The mesh runner the plugin's child process is, in-process: the search's answer is given, the leg is planned by legrun.ts. */
function fakeMesh(result: MeshRouteResult, covers = true, env: FakeEnv = {}): { mesh: MeshLegRunner; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    mesh: {
      covers: () => covers,
      leg: async a => {
        calls.push({ start: a.legStart, end: a.plan.end, rules: a.rules });
        return runMeshLeg({
          result,
          land: result.ok ? (env.land ?? fakeLand()) : null,
          ...a,
          wind: env.wind ?? null,
          current: new NoCurrent(),
        });
      },
    },
    calls,
  };
}

/** A mesh answering with this path; widths default to open water everywhere. */
function fakeMeshOk(path: [number, number][], widths?: [number, number][], env: FakeEnv = {}): ReturnType<typeof fakeMesh> {
  return fakeMesh(
    {
      ok: true,
      path,
      widths: widths ?? path.map(() => [4000, 4000] as [number, number]),
      lengthM: 1,
      costS: 1,
      stats: STATS,
    },
    true,
    env
  );
}

function inputs(mesh: MeshLegRunner | undefined, over: Partial<LegPipelineInputs> = {}): { inp: LegPipelineInputs; messages: string[] } {
  const land = COAST;
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

test('meshCorridor: the mesh route is the search skeleton; the width is both sides of the track, open where both reached the scan cap', () => {
  const c = meshCorridor(
    [
      [0, 0],
      [0.1, 0],
      [0.2, 0],
    ],
    [
      [300, 500],
      [4000, 4000],
      [4000, 1200],
    ]
  );
  assert.deepEqual(c.skeleton, [
    { lon: 0, lat: 0 },
    { lon: 0.1, lat: 0 },
    { lon: 0.2, lat: 0 },
  ]);
  assert.deepEqual(Array.from(c.widthM!), [800, Infinity, 5200]);
  assert.equal(c.source, 'the chart mesh route');
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
  // The search's skeleton is the open segment of the mesh route (points 4 and 5), not a coarse A* of its own.
  assert.ok(
    messages.some(m => /^chart mesh segment 2\/2: skeleton: corridor from the chart mesh route, 2 points, \{distance:\d+\}$/.test(m)),
    messages.join('\n')
  );
  assert.ok(!messages.some(m => /skeleton grid/.test(m)), messages.join('\n'));
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

const POLAR_CSV = `twa/tws,4,6,8,10,12,14,16,20,25
0,0,0,0,0,0,0,0,0,0
30,1.5,2.5,3.3,4.0,4.3,4.5,4.6,4.7,4.7
45,2.5,3.6,4.5,5.1,5.5,5.7,5.8,5.9,5.9
60,3.0,4.2,5.1,5.7,6.1,6.3,6.4,6.5,6.5
90,3.2,4.5,5.5,6.1,6.5,6.7,6.8,6.9,6.9
120,3.0,4.3,5.3,6.0,6.4,6.7,6.9,7.1,7.2
150,2.4,3.6,4.6,5.4,6.0,6.4,6.7,7.0,7.3
180,2.0,3.0,4.0,4.8,5.5,6.0,6.4,6.8,7.1`;

test('pipeline: with a sail threshold of 0 the narrow passage is sailed along the mesh route (tacked where the wind needs it), nothing motored', async () => {
  // The same six-point path: narrow over the first three, open water to the end. Wind 12 kt from the east, the path runs east: a beat.
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
  const wind = Object.assign(new ConstantWind(12 * 0.514444, 90), {
    validRange: [T0, new Date(T0.getTime() + 48 * 3600e3)] as [Date, Date],
  });
  const { mesh } = fakeMeshOk(path, widths, { wind });
  const { inp, messages } = inputs(mesh, {
    polar: PolarDiagram.parse(POLAR_CSV, ','),
    sim: { modePolicy: 'sail_max', sailThreshMs: 0, simStepM: 200 },
    loadAreas: async () => wind,
  });
  const r = await runLegPipeline(inp, PLAN, 0, [0, 0.5], T0);
  assert.ok(
    messages.some(m => /chart mesh: 2 segment\(s\): 1 narrow \(sailed along the mesh route, the sail threshold being 0\)/.test(m)),
    messages.join('\n')
  );
  assert.ok(
    messages.some(m =>
      /^chart mesh segment 1\/2: narrow passage, sailed along the mesh route: \{distance:\d+\}, \{time:[\d.]+\} \(sailing \{time:[\d.]+\}\)$/.test(
        m
      )
    ),
    messages.join('\n')
  );
  assert.ok(
    messages.some(m =>
      /^chart mesh segment 1\/2: experimental: convex polar: \d+ leg\(s\) laid out as tacks \([1-9]\d* tack point/.test(m)
    ),
    messages.join('\n')
  );
  assert.equal(r.motoringTimeS, 0, 'nothing motored');
  assert.ok(r.sailingTimeS > 0);
  for (const w of r.waypoints.slice(1)) assert.equal(w.mode, 'sailing', `${w.lat}, ${w.lon} at ${w.time.toISOString()}`);
  for (let i = 1; i < r.waypoints.length; i++) assert.ok(r.waypoints[i].time > r.waypoints[i - 1].time, 'time runs forward');
  // The passage's end (point 4) is reached before the open water is searched.
  assert.ok(r.waypoints.some(w => Math.abs(w.lon - 0.2) < 1e-9 && Math.abs(w.lat - 0.5) < 1e-9));
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(Math.abs(last.lon - 1) < 1e-6 && Math.abs(last.lat - 0.5) < 1e-6);
});

test('pipeline: the search keeps out of what the mesh blocks (a shoal the coastline does not know), and waypoints carry the charted depth', async () => {
  // Open water on the coastline between lon 0 and 1 at lat 0.5. The mesh route runs straight; the mesh blocks a
  // shoal: everything north of lat 0.5 between lon 0.3 and 0.7. Nothing in the coastline says so, so without the
  // mesh as land the search would cut north freely; with it no waypoint and no leg may be in or across the shoal.
  const path: [number, number][] = [
    [0, 0.5],
    [0.5, 0.45],
    [1, 0.5],
  ];
  const inShoal = (lon: number, lat: number): boolean => lat > 0.5 && lon > 0.3 && lon < 0.7;
  const shoal = (lonA: number, latA: number, lonB: number, latB: number): boolean => {
    // Sampled every 20 m along the leg: enough for a test strip of 44 km.
    const n = Math.max(2, Math.ceil(haversineDistanceM(lonA, latA, lonB, latB) / 20));
    for (let k = 0; k <= n; k++) if (inShoal(lonA + ((lonB - lonA) * k) / n, latA + ((latB - latA) * k) / n)) return true;
    return false;
  };
  const land = fakeLand(shoal, lon => (lon < 0.5 ? 12.5 : null));
  const { mesh } = fakeMeshOk(path, undefined, { land });
  const { inp, messages } = inputs(mesh, { sim: { modePolicy: 'sail_max', sailThreshMs: 2.5, simStepM: 200 } });
  const r = await runLegPipeline(inp, PLAN, 0, [0, 0.5], T0);
  assert.ok(
    messages.some(m => /the isochrone search made it \d+ waypoints/.test(m)),
    messages.join('\n')
  );
  for (const w of r.waypoints) assert.ok(!inShoal(w.lon, w.lat), `waypoint ${w.lat}, ${w.lon} is on the shoal`);
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1];
    const b = r.waypoints[i];
    assert.ok(!shoal(a.lon, a.lat, b.lon, b.lat), `leg ${i} crosses the shoal`);
  }
  assert.ok(
    r.waypoints.some(w => w.lon > 0.3 && w.lon < 0.7),
    'the route still passes the shoal'
  );
  // Depths: the land answers 12.5 m west of lon 0.5 and nothing east of it.
  assert.ok(
    messages.some(m => /^chart mesh: charted depth under \d+ of \d+ waypoints$/.test(m)),
    messages.join('\n')
  );
  for (const w of r.waypoints) {
    if (w.lon < 0.5) assert.equal(w.depthM, 12.5, `depth at ${w.lon}`);
    else assert.equal(w.depthM, undefined, `no depth at ${w.lon}`);
  }
});

test('pipeline: an open stretch whose search fails is not motored under sail_max: the route fails naming the segment', async () => {
  // Wind 10 m/s everywhere under a 5 m/s limit: every candidate of the search is over the limit, and so is every stretch of the mesh route itself.
  const path: [number, number][] = [
    [0, 0.5],
    [0.5, 0.6],
    [1, 0.5],
  ];
  const wind = Object.assign(new ConstantWind(10, 90), {
    validRange: [T0, new Date(T0.getTime() + 48 * 3600e3)] as [Date, Date],
  });
  const { mesh } = fakeMeshOk(path, undefined, { wind });
  const { inp, messages } = inputs(mesh, {
    polar: PolarDiagram.parse(POLAR_CSV, ','),
    sim: { modePolicy: 'sail_max', sailThreshMs: 0, simStepM: 200, maxWindMs: 5 },
    loadAreas: async () => wind,
  });
  await assert.rejects(
    () => runLegPipeline(inp, PLAN, 0, [0, 0.5], T0),
    (err: Error) => {
      assert.match(
        err.message,
        /^chart mesh segment 1\/1: the beat from 0\.5000, 0\.0000 towards 0\.6000, 0\.5000 cannot be tacked at 0\.5000, 0\.0000: every tack tried crossed land or could not be sailed under the sail_max policy, and the course itself cannot be sailed straight; raise the sail threshold \(Route → Options\) so that stretch is motored, or route under motor$/
      );
      return true;
    }
  );
  assert.ok(
    messages.some(m =>
      /^WARNING: chart mesh segment 1\/1: open water, but the isochrone search failed \(.*\); following the mesh route instead under sail_max$/.test(
        m
      )
    ),
    messages.join('\n')
  );
  assert.ok(!messages.some(m => /motor/.test(m) && !/route under motor/.test(m)), messages.join('\n'));
});

test("pipeline: a mesh leg's searched stretch is simplified and smoothed as a coastline leg is, with the mesh as land", async () => {
  // Open water the whole way, searched (sail_max with no polar motors every move but still searches): the search's
  // collinear waypoints along the straight mesh route are removed by the simplification, and the shortcut smoother
  // is offered the rest. Under motor alone the mesh route is the route and nothing is searched.
  const path: [number, number][] = [
    [0, 0.5],
    [0.5, 0.5],
    [1, 0.5],
  ];
  const sail = { modePolicy: 'sail_max' as const, sailThreshMs: 2.5, simStepM: 200 };
  const { mesh } = fakeMeshOk(path);
  const plain = await runLegPipeline(inputs(fakeMeshOk(path).mesh, { sim: sail }).inp, PLAN, 0, [0, 0.5], T0);
  const { inp, messages } = inputs(mesh, { sim: sail, simplifyM: 10, smoother: true, smootherTolerance: 0.05 });
  const r = await runLegPipeline(inp, PLAN, 0, [0, 0.5], T0);
  assert.ok(
    messages.some(m =>
      /^chart mesh segment 1\/1: simplified: \d+ waypoint\(s\) within \{length:10\} of a straight line, \d+ replaced by straight shortcuts; \d+ left$/.test(
        m
      )
    ),
    messages.join('\n')
  );
  assert.ok(r.waypoints.length < plain.waypoints.length, `${r.waypoints.length} waypoints after, ${plain.waypoints.length} before`);
  assert.equal(r.validated, true);
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(Math.abs(last.lon - 1) < 1e-6 && Math.abs(last.lat - 0.5) < 1e-6);
  assert.ok(Math.abs(r.totalTimeS - plain.totalTimeS) / plain.totalTimeS < 0.06, `${r.totalTimeS} s vs ${plain.totalTimeS} s`);
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
