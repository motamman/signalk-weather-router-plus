/**
 * Golden routes: exact output of the isochrone search on synthetic
 * charts, stored under test-data/golden/routes.json. The other engine
 * tests check properties (land-free, monotone time); this one catches
 * any change in the numbers while the search is being restructured
 * (docs/plans/structural-cleanup.md, phase 0).
 *
 * Regenerate on purpose only:  GOLDEN_UPDATE=1 npm test
 * Review the fixture diff before accepting it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LandMask } from '../geo/landmask';
import type { ShapePolygon } from '../geo/shapefile';
import { KTS_TO_MS } from '../geo/geodesy';
import { ConstantWind, type CurrentSource, type WindSource } from './environment';
import { OceanPropagator, type ComputeRouteArgs } from './propagator';
import type { Route } from './route';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';

const FIXTURE = path.join(__dirname, '..', '..', 'test-data', 'golden', 'routes.json');
const UPDATE = process.env.GOLDEN_UPDATE === '1';

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

const POLAR_CSV = `twa/tws,4,6,8,10,12,14,16,20,25
0,0,0,0,0,0,0,0,0,0
30,1.5,2.5,3.3,4.0,4.3,4.5,4.6,4.7,4.7
45,2.5,3.6,4.5,5.1,5.5,5.7,5.8,5.9,5.9
60,3.0,4.2,5.1,5.7,6.1,6.3,6.4,6.5,6.5
90,3.2,4.5,5.5,6.1,6.5,6.7,6.8,6.9,6.9
120,3.0,4.3,5.3,6.0,6.4,6.7,6.9,7.1,7.2
150,2.4,3.6,4.6,5.4,6.0,6.4,6.7,7.0,7.3
180,2.0,3.0,4.0,4.8,5.5,6.0,6.4,6.8,7.1`;

/** Wind that turns with longitude so TWA varies along a route; waves grow with latitude. */
function shearedWind(): WindSource {
  const speed = (lon: number): number => (8 + 4 * Math.sin(lon * 3)) * KTS_TO_MS;
  const dir = (lon: number, lat: number): number => (((90 + 60 * lon + 20 * lat) % 360) + 360) % 360;
  return {
    at: (lon, lat) => [speed(lon), dir(lon, lat)],
    atMany: (lons, lats) => {
      const s = new Float64Array(lons.length);
      const d = new Float64Array(lons.length);
      for (let i = 0; i < lons.length; i++) {
        s[i] = speed(lons[i]);
        d[i] = dir(lons[i], lats[i]);
      }
      return { speed: s, dir: d };
    },
    hasWaves: true,
    wavesAt: (lon, lat) => ({ swh: 0.5 + lat, mwp: 6, mp2: 6, mwd: dir(lon, lat) }),
    wavesAtMany: (_lons, lats) => Float64Array.from(lats, l => 0.5 + l),
  };
}

/** A steady set to the north-east. */
function steadyCurrent(u: number, v: number): CurrentSource {
  return {
    at: () => [u, v],
    atMany: lons => ({ u: new Float64Array(lons.length).fill(u), v: new Float64Array(lons.length).fill(v) }),
  };
}

const BBOX = { west: -1, south: -1, east: 2, north: 2 };
const T0 = new Date('2026-01-01T00:00:00Z');

interface Case {
  name: string;
  land: LandMask;
  options: ConstructorParameters<typeof OceanPropagator>[1];
  args: ComputeRouteArgs;
}

function cases(): Case[] {
  const island = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 1.3)], BBOX, 0.005);
  const corner = LandMask.fromPolygons([rect(1, 1.5, 1.5, 1.9, 1.9)], BBOX, 0.01);
  const open = LandMask.fromPolygons([], BBOX, 0.01);
  const polar = PolarDiagram.parse(POLAR_CSV, ',');
  const beatPolar = new PolarDiagram(
    [45, 60, 90, 120, 150],
    [4, 8, 12],
    [2.5, 3.2, 3.5, 3.4, 3.0, 3.0, 3.8, 4.2, 4.0, 3.5, 3.3, 4.1, 4.6, 4.4, 3.9]
  );
  const motor = makeVessel({ motorSpeedMs: 3 });
  const sailor = makeVessel({ motorSpeedMs: 2.5 });
  return [
    {
      name: 'motor around an island',
      land: island,
      options: { stages: 12, subsectors: 20, headings: 30 },
      args: { start: [0, 0.5], end: [1, 0.5], departureTime: T0, vessel: motor, modePolicy: 'motor' },
    },
    {
      name: 'motor through a via disc',
      land: corner,
      options: { stages: 10, subsectors: 20, headings: 30 },
      args: {
        start: [0, 0.5],
        end: [1, 0.5],
        departureTime: T0,
        vessel: motor,
        modePolicy: 'motor',
        vias: [{ lon: 0.5, lat: 0.9, radiusM: 2000 }],
      },
    },
    {
      name: 'sail: beat dead to windward',
      land: open,
      options: { stages: 12, subsectors: 20, headings: 30 },
      args: {
        start: [0, 0.5],
        end: [0.6, 0.5],
        departureTime: T0,
        vessel: motor,
        polar: beatPolar,
        wind: new ConstantWind(8, 90),
        modePolicy: 'sail_max',
        sailThreshMs: 0,
      },
    },
    {
      name: 'sail_max: sheared wind, waves, current, limits, island',
      land: island,
      options: { stages: 14, subsectors: 24, headings: 36, headingIncrementDeg: 10 },
      args: {
        start: [-0.5, 0.2],
        end: [1.5, 1.0],
        departureTime: T0,
        vessel: sailor,
        polar,
        wind: shearedWind(),
        current: steadyCurrent(0.3, 0.1),
        modePolicy: 'sail_max',
        sailThreshMs: 2.5 * KTS_TO_MS,
        maxWindMs: 30 * KTS_TO_MS,
        maxSwhM: 2.5,
        simStepM: 500,
        forecastEndMs: T0.getTime() + 36 * 3600_000,
      },
    },
    {
      name: 'fastest: approximate arrival with a corridor skeleton',
      land: open,
      options: { stages: 10, subsectors: 20, headings: 30 },
      args: {
        start: [0, 0],
        end: [1.2, 0.8],
        departureTime: T0,
        vessel: sailor,
        polar,
        wind: new ConstantWind(12 * KTS_TO_MS, 0),
        modePolicy: 'fastest',
        sailThreshMs: 2.5 * KTS_TO_MS,
        arrivalRadiusM: 1500,
        snapToExact: false,
        corridor: {
          skeleton: [
            { lon: 0, lat: 0 },
            { lon: 0.3, lat: 0.3 },
            { lon: 0.6, lat: 0.45 },
            { lon: 0.9, lat: 0.6 },
            { lon: 1.2, lat: 0.8 },
          ],
          widthM: [50_000, 50_000, 50_000, 50_000, 50_000],
        },
      },
    },
  ];
}

/** Everything a route says, as plain JSON, with lon/lat rounded to 1e-9°. */
function serialize(r: Route): Record<string, unknown> {
  const n = (v: number | undefined): number | null => (v === undefined ? null : Number.isFinite(v) ? Number(v.toFixed(9)) : null);
  return {
    waypoints: r.waypoints.map(w => ({
      lon: n(w.lon),
      lat: n(w.lat),
      timeMs: w.time.getTime(),
      mode: w.mode,
      sogMs: n(w.sogMs),
      cogDeg: n(w.cogDeg),
      twaDeg: n(w.twaDeg),
      windMs: n(w.windMs),
      windDirDeg: n(w.windDirDeg),
      swhM: n(w.swhM),
      currentMs: n(w.currentMs),
      currentDirDeg: n(w.currentDirDeg),
      role: w.role ?? null,
      leg: w.leg ?? null,
    })),
    totalTimeS: n(r.totalTimeS),
    totalDistanceM: n(r.totalDistanceM),
    motoringTimeS: n(r.motoringTimeS),
    sailingTimeS: n(r.sailingTimeS),
    warnings: r.warnings ?? null,
    validated: r.validated,
    skeleton: r.skeleton ? r.skeleton.map(p => [n(p.lon), n(p.lat)]) : null,
    fronts: r.fronts ? r.fronts.map(f => ({ stage: f.stage, points: f.points.length, best: f.best.length })) : null,
  };
}

test('golden routes are unchanged', () => {
  const out: Record<string, unknown> = {};
  for (const c of cases()) {
    const prop = new OceanPropagator(c.land, c.options);
    out[c.name] = serialize(prop.computeRoute(c.args));
  }
  if (UPDATE || !fs.existsSync(FIXTURE)) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(out, null, 1) + '\n');
    if (!UPDATE) assert.fail(`golden fixture was missing and has been written to ${FIXTURE}; run the tests again`);
    return;
  }
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  for (const c of cases()) {
    assert.deepStrictEqual(out[c.name], want[c.name], `route "${c.name}" changed (GOLDEN_UPDATE=1 regenerates on purpose)`);
  }
  assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(want).sort(), 'golden case list changed');
});
