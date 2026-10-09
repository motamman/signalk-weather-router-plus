/**
 * The mesh handover: where a leg leaving the mesh switches to the
 * coastline search (on a hand-made corridor), the corridor cut there,
 * the two parts stitched; and the whole leg pipeline on a synthetic coast
 * with a real water grid, a mesh covering the start only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { haversineDistanceM } from '../../geo/geodesy';
import { LandMask } from '../../geo/landmask';
import { buildWaterGrid } from '../../geo/watergrid_build';
import type { Corridor } from '../corridor';
import { NoCurrent } from '../environment';
import { planLegs } from '../multileg';
import { runLegPipeline, type LegPipelineInputs } from '../pipeline';
import type { Route } from '../route';
import { makeVessel } from '../../vessel/vessel';
import { findHandover, OPEN_WATER_WIDTH_M, sliceCorridor, stitchLegParts } from './handover';
import type { MeshLegRunner } from './leg';
import { runMeshLeg } from './legrun';

const T0 = new Date('2026-01-01T00:00:00Z');

/** A mesh covering every point west of `eastEdge`; routes as a straight line, narrow water everywhere, nothing blocked. */
function meshWestOf(eastEdge: number): { mesh: MeshLegRunner; calls: [number, number][][] } {
  const calls: [number, number][][] = [];
  const open = {
    isLand: () => false,
    isLandExact: () => false,
    legCrossesLandExact: () => false,
    legsCrossLandBulk: (la: ArrayLike<number>) => new Uint8Array(la.length),
    depthAt: () => null,
  };
  return {
    mesh: {
      covers: pts => pts.every(p => p[0] < eastEdge),
      leg: async a => {
        const start = a.legStart;
        const end = a.plan.end;
        calls.push([start, end]);
        return runMeshLeg({
          result: {
            ok: true,
            path: [start, end],
            widths: [
              [100, 100],
              [100, 100],
            ],
            lengthM: haversineDistanceM(start[0], start[1], end[0], end[1]),
            costS: 1,
            stats: {
              trianglesLoaded: 1,
              blocked: 0,
              expanded: 1,
              readMs: 0,
              prepMs: 0,
              searchMs: 0,
              funnelMs: 0,
              padDeg: 0.5,
              attempts: 1,
              bufferM: 0,
              buffered: 0,
              bufferMs: 0,
            },
          },
          land: open,
          ...a,
          wind: null,
          current: new NoCurrent(),
        });
      },
    },
    calls,
  };
}

/** A straight corridor along lat 0 from lon 0 to lon 1, points every 0.02° (2.2 km), with the given widths. */
function corridorAlong(widths: number[]): Corridor {
  const skeleton = widths.map((_w, i) => ({ lon: i * 0.02, lat: 0 }));
  let lengthM = 0;
  for (let i = 1; i < skeleton.length; i++) lengthM += haversineDistanceM(skeleton[i - 1].lon, 0, skeleton[i].lon, 0);
  return {
    skeleton,
    widthM: Float64Array.from(widths),
    lengthM,
    bbox: { west: -1, south: -1, east: 2, north: 1 },
    land: LandMask.fromPolygons([], { west: -1, south: -1, east: 2, north: 1 }, 0.05),
    autoVias: [
      { lon: 0.1, lat: 0, radiusM: 500, widthM: 800, axisDeg: 90, name: 'narrows', segment: 0, pathIndex: 5 },
      { lon: 0.8, lat: 0, radiusM: 500, widthM: 900, axisDeg: 90, name: 'far narrows', segment: 0, pathIndex: 40 },
    ],
    stats: { astarMs: 0, expanded: 0, windowCells: 0, reroutes: 0, refines: 0, blockedCells: 0, verifyMs: 0 },
  };
}

test('findHandover: the first sustained-open point after the last narrow one inside the mesh; from either end; none without narrow water', () => {
  // 51 points; narrow (800 m) up to index 9, one open blip at 10, narrow again 11–14, open from 15.
  const w = Array.from({ length: 51 }, (_x, i) => (i >= 15 || i === 10 ? 5000 : 800));
  const c = corridorAlong(w);
  const { mesh } = meshWestOf(0.6); // covers indices 0..29
  const h = findHandover(c, 'start', mesh);
  assert.ok(h);
  assert.equal(h.index, 15, 'the blip at 10 does not count: narrow water follows it');
  assert.deepEqual(h.point, [0.3, 0]);
  assert.ok(Math.abs(h.distanceM - haversineDistanceM(0, 0, 0.3, 0)) < 1);
  // A harbour: wide at the start, a narrow mouth, open beyond (Newport's shape): the handover is past the mouth.
  const harbour = Array.from({ length: 51 }, (_x, i) => (i <= 4 ? 2800 : i <= 10 ? 950 : i === 12 ? 1500 : 8000));
  const hh = findHandover(corridorAlong(harbour), 'start', mesh);
  assert.ok(hh);
  assert.equal(hh.index, 13, 'after the last narrow point (12), the first point that is open and stays open');
  // No narrow water at all: no mesh part.
  assert.equal(findHandover(corridorAlong(w.map(() => 5000)), 'start', mesh), null);
  // Narrow water only beyond the scan distance: not seen, no mesh part (the cap is 50 km; points are 2.2 km apart).
  const far = Array.from({ length: 51 }, (_x, i) => (i >= 24 && i <= 26 ? 800 : 5000));
  assert.equal(findHandover(corridorAlong(far), 'start', mesh), null);
  // Narrow all the way: the last point within the 50 km scan (index 22 at 2.2 km spacing), not the last covered one.
  const narrow = corridorAlong(w.map(() => OPEN_WATER_WIDTH_M - 1));
  assert.equal(findHandover(narrow, 'start', mesh)!.index, 22);
  // From the end: a mesh covering the east.
  const east: MeshLegRunner = { ...mesh, covers: pts => pts.every(p => p[0] > 0.5) };
  const wEnd = Array.from({ length: 51 }, (_x, i) => (i <= 40 ? 5000 : 800));
  const he = findHandover(corridorAlong(wEnd), 'end', east);
  assert.ok(he);
  assert.equal(he.index, 40);
});

test('sliceCorridor keeps the part on one side of the handover with its automatic vias', () => {
  const c = corridorAlong(Array.from({ length: 51 }, () => 5000));
  const after = sliceCorridor(c, 15, 'after');
  assert.equal(after.skeleton.length, 36);
  assert.deepEqual(after.skeleton[0], { lon: 0.3, lat: 0 });
  assert.equal(after.widthM.length, 36);
  assert.deepEqual(
    after.autoVias.map(v => v.name),
    ['far narrows']
  );
  const before = sliceCorridor(c, 15, 'before');
  assert.equal(before.skeleton.length, 16);
  assert.deepEqual(
    before.autoVias.map(v => v.name),
    ['narrows']
  );
  assert.ok(Math.abs(after.lengthM + before.lengthM - c.lengthM) < 1);
});

test('stitchLegParts joins two parts at their shared point, re-bases warnings, recomputes totals', () => {
  const wp = (lon: number, t: number, mode: 'sailing' | 'motoring' = 'motoring'): Route['waypoints'][number] => ({
    lon,
    lat: 0,
    time: new Date(T0.getTime() + t * 1000),
    sogMs: 0,
    cogDeg: 0,
    mode,
  });
  const a: Route = {
    waypoints: [wp(0, 0), wp(0.1, 1000), wp(0.2, 2000)],
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
    meshLeg: true,
    warnings: [{ leg_index: 0, violation: 'leg_crosses_land', from: [0, 0], to: [0.1, 0], repaired: false }],
  };
  const b: Route = {
    waypoints: [wp(0.2, 2000), wp(0.5, 5000, 'sailing'), wp(1, 9000, 'sailing')],
    totalTimeS: 0,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
    warnings: [{ leg_index: 1, violation: 'wind_over_limit', from: [0.5, 0], to: [1, 0], repaired: false }],
    forecastHorizonExceededS: 100,
  };
  const r = stitchLegParts(a, b);
  assert.deepEqual(
    r.waypoints.map(w => w.lon),
    [0, 0.1, 0.2, 0.5, 1]
  );
  assert.equal(r.totalTimeS, 9000);
  assert.equal(r.motoringTimeS, 2000);
  assert.equal(r.sailingTimeS, 7000);
  assert.deepEqual(
    r.warnings!.map(w => w.leg_index),
    [0, 3]
  );
  assert.equal(r.meshLeg, true);
  assert.equal(r.forecastHorizonExceededS, 100);
  assert.ok(Math.abs(r.totalDistanceM - haversineDistanceM(0, 0, 1, 0)) < 1);
});

/** Minimal shapefile writer (rectangles), as corridor.test.ts has. */
function writeShapefile(file: string, polys: number[][][]): void {
  const recs: Buffer[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  polys.forEach((rings, k) => {
    const pts = rings.map(r => {
      const c = [...r];
      if (c[0] !== c[c.length - 2] || c[1] !== c[c.length - 1]) c.push(c[0], c[1]);
      return c;
    });
    const nPts = pts.reduce((acc, r) => acc + r.length / 2, 0);
    const len = 44 + 4 * pts.length + 16 * nPts;
    const b = Buffer.alloc(8 + len);
    b.writeInt32BE(k + 1, 0);
    b.writeInt32BE(len / 2, 4);
    const xs = pts.flatMap(r => r.filter((_v, i) => i % 2 === 0));
    const ys = pts.flatMap(r => r.filter((_v, i) => i % 2 === 1));
    const bx = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    minX = Math.min(minX, bx[0]);
    minY = Math.min(minY, bx[1]);
    maxX = Math.max(maxX, bx[2]);
    maxY = Math.max(maxY, bx[3]);
    b.writeInt32LE(5, 8);
    bx.forEach((v, i) => b.writeDoubleLE(v, 12 + 8 * i));
    b.writeInt32LE(pts.length, 44);
    b.writeInt32LE(nPts, 48);
    let o = 52;
    let start = 0;
    for (const r of pts) {
      b.writeInt32LE(start, o);
      o += 4;
      start += r.length / 2;
    }
    for (const r of pts)
      for (let i = 0; i < r.length; i += 2) {
        b.writeDoubleLE(r[i], o);
        b.writeDoubleLE(r[i + 1], o + 8);
        o += 16;
      }
    recs.push(b);
  });
  const body = Buffer.concat(recs);
  const h = Buffer.alloc(100);
  h.writeInt32BE(9994, 0);
  h.writeInt32BE((100 + body.length) / 2, 24);
  h.writeInt32LE(1000, 28);
  h.writeInt32LE(5, 32);
  [minX, minY, maxX, maxY].forEach((v, i) => h.writeDoubleLE(v, 36 + 8 * i));
  fs.writeFileSync(file, Buffer.concat([h, body]));
}

test('pipeline: a leg starting in a channel inside the mesh is routed on the mesh to open water and handed over', async () => {
  // A bay closed on three sides: land north and south of lat 0 (a 0.015° = 1.7 km channel) from lon 160 to 161,
  // open sea east of lon 161. Start inside the channel 33 km from its mouth (within the 50 km handover scan),
  // end 200 km out at sea. The mesh covers lon < 162.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-handover-'));
  const shp = path.join(tmp, 'coast.shp');
  const rect = (w: number, s: number, e: number, n: number): number[][] => [[w, s, e, s, e, n, w, n]];
  writeShapefile(shp, [rect(159.5, 0.0075, 161, 1), rect(159.5, -1, 161, -0.0075)]);
  const grid = buildWaterGrid([shp], { region: { west: 158, east: 165, south: -2, north: 2 } });
  const { mesh, calls } = meshWestOf(162);
  const messages: string[] = [];
  const inp: LegPipelineInputs = {
    waterGrid: grid,
    mesh,
    allowCanals: false,
    landFor: b => LandMask.fromShapefiles([shp], b, { resolutionDeg: 0.002 }),
    stages: 12,
    propagator: { subsectors: 20, headings: 30 },
    vessel: makeVessel({ motorSpeedMs: 3, draughtM: 2, airDraftM: 18 }),
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
  };
  const [plan] = planLegs(
    [
      { lon: 160.7, lat: 0 },
      { lon: 163, lat: 0 },
    ],
    'precise',
    300
  );
  const r = await runLegPipeline(inp, plan, 0, [160.7, 0], T0);
  assert.equal(r.meshLeg, true, messages.join('\n'));
  assert.equal(calls.length, 1, 'the mesh was asked once, for the part to the handover');
  const [meshStart, meshEnd] = calls[0];
  assert.deepEqual(meshStart, [160.7, 0]);
  assert.ok(meshEnd[0] > 161 && meshEnd[0] < 162, `handover at lon ${meshEnd[0]}: just outside the channel mouth, inside the mesh`);
  assert.ok(
    messages.some(m => /chart mesh: the leg leaves the mesh; its first \{distance:\d+\} to open water/.test(m)),
    messages.join('\n')
  );
  assert.ok(
    messages.some(m => /^skeleton|^corridor: \{distance/.test(m)),
    'the coastline search ran for the rest'
  );
  assert.deepEqual([r.waypoints[0].lon, r.waypoints[0].lat], [160.7, 0]);
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(Math.abs(last.lon - 163) < 1e-6 && Math.abs(last.lat) < 1e-6);
  for (let i = 1; i < r.waypoints.length; i++) assert.ok(r.waypoints[i].time >= r.waypoints[i - 1].time, 'time runs forward');
  assert.ok(
    r.waypoints.some(w => Math.abs(w.lon - meshEnd[0]) < 1e-9),
    'the handover point is a waypoint'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});
