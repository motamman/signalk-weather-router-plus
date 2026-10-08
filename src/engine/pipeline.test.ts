import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../geo/landmask';
import type { ShapePolygon } from '../geo/shapefile';
import { NoCurrent } from './environment';
import { planLegs } from './multileg';
import { runLegPipeline, type LegPipelineInputs } from './pipeline';
import { OceanPropagator } from './propagator';
import { makeVessel } from '../vessel/vessel';
import { PolarDiagram } from '../vessel/polar';
import { haversineDistanceM } from '../geo/geodesy';
import { ConstantWind } from './environment';

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

const BBOX = { west: -1, south: -1, east: 2, north: 2 };
const T0 = new Date('2026-01-01T00:00:00Z');

function inputs(land: LandMask, over: Partial<LegPipelineInputs> = {}): { inp: LegPipelineInputs; messages: string[] } {
  const messages: string[] = [];
  const inp: LegPipelineInputs = {
    waterGrid: null,
    allowCanals: false,
    landFor: () => land,
    stages: 12,
    propagator: { subsectors: 20, headings: 30 },
    vessel: makeVessel({ motorSpeedMs: 3 }),
    polar: null,
    sim: { modePolicy: 'motor', sailThreshMs: 2.5, simStepM: 200 },
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

test('pipeline without a water grid and without simplification equals the propagator alone', async () => {
  const land = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 1.3)], BBOX, 0.005);
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  const { inp, messages } = inputs(land);
  const r = await runLegPipeline(inp, plan, 0, [0, 0.5], T0);
  const direct = new OceanPropagator(land, { stages: 12, subsectors: 20, headings: 30 }).computeRoute({
    start: [0, 0.5],
    end: [1, 0.5],
    departureTime: T0,
    vessel: inp.vessel,
    modePolicy: 'motor',
    sailThreshMs: 2.5,
    simStepM: 200,
    arrivalRadiusM: plan.arrivalRadiusM,
    snapToExact: plan.snapToExact,
  });
  assert.deepEqual(
    r.waypoints.map(w => [w.lon, w.lat, w.time.getTime()]),
    direct.waypoints.map(w => [w.lon, w.lat, w.time.getTime()])
  );
  assert.equal(r.validated, true);
  assert.ok(
    messages.some(m => /^skeleton/.test(m)),
    'the per-route skeleton was used'
  );
  assert.ok(!messages.some(m => /corridor/.test(m)), 'no corridor without a water grid');
});

test('pipeline: simplification keeps the route land-free and reports it; the current names travel with the route', async () => {
  const land = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 1.3)], BBOX, 0.005);
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  const { inp, messages } = inputs(land, {
    simplifyM: 10,
    smoother: true,
    currents: () => ({ source: new NoCurrent(), names: ['test-source'] }),
  });
  const r = await runLegPipeline(inp, plan, 0, [0, 0.5], T0);
  assert.ok(r.waypoints.length >= 3);
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1];
    const b = r.waypoints[i];
    assert.equal(land.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat), false);
    assert.ok(b.time > a.time);
  }
  assert.deepEqual(r.currentSources, ['test-source']);
  assert.ok(messages.some(m => /^currents: test-source$/.test(m)));
  assert.ok(messages.some(m => /^simplified: /.test(m)) || r.smootherDrops === undefined);
});

test('the refined router under motor is an exact duplicate of the standard search', async () => {
  const land = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 1.3)], BBOX, 0.005);
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  const a = await runLegPipeline(inputs(land).inp, plan, 0, [0, 0.5], T0);
  const b = await runLegPipeline(inputs(land, { router: 'refined' }).inp, plan, 0, [0, 0.5], T0);
  assert.deepEqual(
    b.waypoints.map(w => [w.lon, w.lat, w.time.getTime(), w.mode]),
    a.waypoints.map(w => [w.lon, w.lat, w.time.getTime(), w.mode])
  );
  assert.equal(b.totalTimeS, a.totalTimeS);
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

test('refined router, convex polar: a dead-upwind leg comes out as tacks the real polar can sail, no later than the isochrone beat', async () => {
  // Open water (the land is far off the track), wind from due east at 12 kt, destination due east: a pure beat.
  const land = LandMask.fromPolygons([rect(1, 0.3, 1.5, 0.7, 2)], BBOX, 0.005);
  const polar = PolarDiagram.parse(POLAR_CSV, ',');
  const wind = Object.assign(new ConstantWind(12 * 0.514444, 90), {
    validRange: [T0, new Date(T0.getTime() + 48 * 3600e3)] as [Date, Date],
  });
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  // A slow motor (1 m/s), so sailing the beat is the better choice under both routers.
  const over: Partial<LegPipelineInputs> = {
    polar,
    vessel: makeVessel({ motorSpeedMs: 1 }),
    sim: { modePolicy: 'sail_max', sailThreshMs: 1, simStepM: 200 },
    loadAreas: async () => wind,
  };
  const iso = await runLegPipeline(inputs(land, over).inp, plan, 0, [0, 0.5], T0);
  const { inp, messages } = inputs(land, { ...over, router: 'refined' });
  const exp = await runLegPipeline(inp, plan, 0, [0, 0.5], T0);
  assert.ok(
    messages.some(m => /^experimental: convex polar: \d+ leg\(s\) laid out as tacks/.test(m)),
    messages.join('\n')
  );
  const tacks = exp.waypoints.filter(w => w.tack).length;
  assert.ok(tacks >= 1, `tack points ${tacks}`);
  // Every sailed leg is sailable by the real polar (not in its no-go angle) and time runs forward.
  for (let i = 1; i < exp.waypoints.length; i++) {
    const w = exp.waypoints[i];
    assert.ok(w.time >= exp.waypoints[i - 1].time);
    if (w.mode === 'sailing' && w.twaDeg !== undefined)
      assert.ok(w.twaDeg >= polar.noGoFloor(12 * 0.514444) - 1e-9, `leg ${i} at TWA ${w.twaDeg}`);
  }
  assert.ok(exp.totalTimeS <= iso.totalTimeS * 1.001, `experimental ${exp.totalTimeS} s vs isochrone ${iso.totalTimeS} s`);
  assert.ok(Math.abs(exp.waypoints[exp.waypoints.length - 1].lon - 1) < 1e-6);
});

test('refined router: a beat up a channel too narrow for two tacks is sailed as short tacks clear of both shores', async () => {
  // A channel 0.04° (4.4 km) wide between two shores, running east; wind from the east; the leg is dead upwind along it.
  const land = LandMask.fromPolygons([rect(1, -0.1, 0.52, 0.5, 0.7), rect(2, -0.1, 0.3, 0.5, 0.48)], BBOX, 0.002);
  const polar = PolarDiagram.parse(POLAR_CSV, ',');
  const wind = Object.assign(new ConstantWind(12 * 0.514444, 90), {
    validRange: [T0, new Date(T0.getTime() + 48 * 3600e3)] as [Date, Date],
  });
  const [plan] = planLegs(
    [
      { lon: 0.02, lat: 0.5 },
      { lon: 0.3, lat: 0.5 },
    ],
    'precise',
    300
  );
  // Two stages: 15 km legs, whose two-tack split would swing 6 km off the line, into the shores.
  const { inp, messages } = inputs(land, {
    router: 'refined',
    stages: 2,
    polar,
    vessel: makeVessel({ motorSpeedMs: 1 }),
    sim: { modePolicy: 'sail_max', sailThreshMs: 1, simStepM: 200 },
    loadAreas: async () => wind,
  });
  const r = await runLegPipeline(inp, plan, 0, [0.02, 0.5], T0);
  const tacks = r.waypoints.filter(w => w.tack).length;
  assert.ok(tacks >= 3, `tack points ${tacks}: ${messages.filter(m => /experimental/.test(m)).join('\n')}`);
  assert.ok(
    messages.some(m => /^experimental: convex polar: \d+ leg\(s\) laid out as tacks \((?:[4-9]|\d\d+) tack point/.test(m)),
    messages.join('\n')
  );
  for (const w of r.waypoints) assert.ok(w.lat > 0.48 && w.lat < 0.52, `waypoint ${w.lat}, ${w.lon} is inside the channel`);
  for (let i = 1; i < r.waypoints.length; i++)
    assert.ok(!land.legCrossesLandExact(r.waypoints[i - 1].lon, r.waypoints[i - 1].lat, r.waypoints[i].lon, r.waypoints[i].lat));
});

test('refined router: a wind that veers over a long beat moves the tacks with it; every leg sailable, no invented speeds', async () => {
  // Open water; wind 12 kt from due east at departure, veering 3° per hour (to the south); destination due east, 111 km.
  const land = LandMask.fromPolygons([rect(1, 0.3, 1.5, 0.7, 2)], BBOX, 0.005);
  const polar = PolarDiagram.parse(POLAR_CSV, ',');
  const dirAt = (t: Date): number => 90 + (3 * (t.getTime() - T0.getTime())) / 3600e3;
  const wind = {
    hasWaves: false,
    at: (_lon: number, _lat: number, t: Date): [number, number] => [12 * 0.514444, dirAt(t)],
    atMany: (lons: Float64Array) => ({
      speed: new Float64Array(lons.length).fill(12 * 0.514444),
      dir: new Float64Array(lons.length).fill(90),
    }),
    atManyAt: (lons: Float64Array, _lats: Float64Array, timesMs: Float64Array) => ({
      speed: new Float64Array(lons.length).fill(12 * 0.514444),
      dir: Float64Array.from(timesMs, ms => dirAt(new Date(ms))),
    }),
    wavesAt: () => null,
    validRange: [T0, new Date(T0.getTime() + 72 * 3600e3)] as [Date, Date],
  };
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  const { inp, messages } = inputs(land, {
    router: 'refined',
    stages: 4,
    polar,
    vessel: makeVessel({ motorSpeedMs: 1 }),
    sim: { modePolicy: 'sail_max', sailThreshMs: 1, simStepM: 200 },
    loadAreas: async () => wind,
  });
  const r = await runLegPipeline(inp, plan, 0, [0, 0.5], T0);
  assert.ok(r.waypoints.filter(w => w.tack).length >= 4, messages.filter(m => /experimental/.test(m)).join('\n'));
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1];
    const b = r.waypoints[i];
    const dt = (b.time.getTime() - a.time.getTime()) / 1000;
    const d = haversineDistanceM(a.lon, a.lat, b.lon, b.lat);
    assert.ok(dt > 0, `leg ${i} takes time`);
    assert.ok(d / dt < 4, `leg ${i}: ${(d / dt).toFixed(1)} m/s is faster than the boat can sail`);
  }
  assert.ok(Math.abs(r.waypoints[r.waypoints.length - 1].lon - 1) < 1e-6);
});

test('refined router: a straight course that veers into the no-go angle mid-leg is laid out step by step and tacked where it must', async () => {
  // Due east, 111 km, one stage leg. Wind 12 kt from 040° at departure (TWA 50°, sailable), veering 6°/h
  // (from 070° after 5 h: TWA 20°, inside the polar's 30° no-go). Checked only at its start the leg would
  // be "sailable" and then fail in the simulator; laid out in steps it is sailed, then tacked.
  const land = LandMask.fromPolygons([rect(1, 0.3, 1.5, 0.7, 2)], BBOX, 0.005);
  const polar = PolarDiagram.parse(POLAR_CSV, ',');
  const dirAt = (t: Date): number => 40 + (6 * (t.getTime() - T0.getTime())) / 3600e3;
  const wind = {
    hasWaves: false,
    at: (_lon: number, _lat: number, t: Date): [number, number] => [12 * 0.514444, dirAt(t)],
    atMany: (lons: Float64Array) => ({
      speed: new Float64Array(lons.length).fill(12 * 0.514444),
      dir: new Float64Array(lons.length).fill(40),
    }),
    atManyAt: (lons: Float64Array, _lats: Float64Array, timesMs: Float64Array) => ({
      speed: new Float64Array(lons.length).fill(12 * 0.514444),
      dir: Float64Array.from(timesMs, ms => dirAt(new Date(ms))),
    }),
    wavesAt: () => null,
    validRange: [T0, new Date(T0.getTime() + 72 * 3600e3)] as [Date, Date],
  };
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  const { inp, messages } = inputs(land, {
    router: 'refined',
    stages: 1,
    polar,
    vessel: makeVessel({ motorSpeedMs: 1 }),
    sim: { modePolicy: 'sail_max', sailThreshMs: 1, simStepM: 200 },
    loadAreas: async () => wind,
  });
  const r = await runLegPipeline(inp, plan, 0, [0, 0.5], T0);
  assert.ok(r.waypoints.filter(w => w.tack).length >= 1, `tack points: ${messages.filter(m => /experimental/.test(m)).join('\n')}`);
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1];
    const b = r.waypoints[i];
    const dt = (b.time.getTime() - a.time.getTime()) / 1000;
    const d = haversineDistanceM(a.lon, a.lat, b.lon, b.lat);
    assert.ok(dt > 0 && d / dt < 4, `leg ${i}: ${d.toFixed(0)} m in ${dt.toFixed(0)} s`);
    assert.ok(!land.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat));
  }
  assert.ok(Math.abs(r.waypoints[r.waypoints.length - 1].lon - 1) < 1e-6);
});
