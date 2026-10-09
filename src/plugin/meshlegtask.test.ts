/**
 * The mesh leg in a child process (childtask.ts 'mesh-leg',
 * meshlegtask.ts): a leg on a two-tile mesh on disk comes back as a
 * finished route with its progress streamed first and the charted depth
 * under its waypoints, under motor with calm wind and no currents.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeTwoTileMesh } from '../engine/mesh/fixture';
import { planLegs } from '../engine/multileg';
import { makeVessel } from '../vessel/vessel';
import { type ChildEvent, runChildTask } from './childtask';
import { SmocClient, SmocCurrentSource } from '../currents/smoc';
import { H, makeMock, SETTINGS, T0, URLS } from '../currents/smoc.mock.test';
import { bboxFromLonLat } from '../geo/geodesy';
import { MESH_BOX_PAD_MAX_DEG } from '../engine/mesh/route';

test('mesh-leg child task: the leg planned where the mesh is, progress streamed, depths from the triangles', async () => {
  const dir = writeTwoTileMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), [10, 10, 7.5, 7.5]);
  const [plan] = planLegs(
    [
      { lon: 0.25, lat: 0.1 },
      { lon: 1.75, lat: 0.1 },
    ],
    'precise',
    300
  );
  const events: ChildEvent[] = [];
  try {
    const r = await runChildTask(
      {
        task: 'mesh-leg',
        dir,
        plan,
        legIndex: 0,
        legStart: [0.25, 0.1],
        legDepartureMs: Date.parse('2026-01-01T00:00:00Z'),
        tag: '',
        multi: false,
        rules: { draughtM: 2, airDraftM: 18, motorSpeedMs: 2 },
        vessel: makeVessel({ motorSpeedMs: 2, draughtM: 2, airDraftM: 18 }),
        polar: null,
        sim: { modePolicy: 'motor', sailThreshMs: 2.5, simStepM: 200 },
        propagator: { subsectors: 20, headings: 30 },
        stages: 12,
        simplifyM: 0,
        smoother: false,
        smootherTolerance: 0.05,
        drawbridges: 'ask',
        bridgeWaitS: 0,
        forecast: null,
        regional: null,
        currents: null,
      },
      60_000,
      undefined,
      e => events.push(e)
    );
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (r.ok) {
      const wps = r.route.waypoints;
      assert.equal(wps.length, 2, 'a straight line across the seam');
      assert.ok(wps[0].time instanceof Date && wps[1].time > wps[0].time, 'dates survive the round trip');
      assert.equal(wps[0].depthM, 10);
      assert.equal(wps[1].depthM, 7.5);
      assert.equal(r.route.meshLeg, true);
      assert.ok(r.route.totalDistanceM > 160_000 && r.route.totalDistanceM < 170_000, `${r.route.totalDistanceM} m`);
    }
    const lines = events.filter(e => e.event === 'progress').map(e => (e.event === 'progress' ? e.message : ''));
    assert.ok(
      lines.some(m => /^chart mesh: the search's every move is tested against the mesh/.test(m)),
      lines.join('\n')
    );
    assert.ok(
      lines.some(m => /^chart mesh: \{distance:\d+\}, 2 points;/.test(m)),
      lines.join('\n')
    );
    assert.ok(
      lines.some(m => /^chart mesh: charted depth under 2 of 2 waypoints$/.test(m)),
      lines.join('\n')
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mesh-leg child task: CMEMS SMOC of a provisional run is read from the cache the worker wrote, for the area and steps the worker loaded', async () => {
  const dir = writeTwoTileMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), [10, 10, 7.5, 7.5]);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-smoc-'));
  const [plan] = planLegs(
    [
      { lon: 0.25, lat: 0.1 },
      { lon: 1.75, lat: 0.1 },
    ],
    'precise',
    300
  );
  // The worker's side: a provisional run, the leg's widest box, the steps from departure; loaded over the (mock) network and so cached.
  const mock = makeMock();
  mock.stacUpdating = true;
  const client = new SmocClient({ cacheDir, urls: URLS, fetchImpl: mock.fetch, sleepImpl: async () => undefined });
  const run = await client.probe();
  assert.equal(run.settled, false);
  client.saveRun(run);
  const departureMs = T0 + 6 * H;
  const area = bboxFromLonLat([0.25, 1.75], [0.1, 0.1], MESH_BOX_PAD_MAX_DEG);
  const worker = new SmocCurrentSource(run, SETTINGS, client);
  const steps = worker.stepsBetween(departureMs, departureMs + 24 * H);
  assert.ok(steps.length > 1);
  await worker.ensure(area, steps, { reason: 'route area' });
  const fetched = mock.total();
  const events: ChildEvent[] = [];
  try {
    const r = await runChildTask(
      {
        task: 'mesh-leg',
        dir,
        plan,
        legIndex: 0,
        legStart: [0.25, 0.1],
        legDepartureMs: departureMs,
        tag: '',
        multi: false,
        rules: { draughtM: 2, airDraftM: 18, motorSpeedMs: 2 },
        vessel: makeVessel({ motorSpeedMs: 2, draughtM: 2, airDraftM: 18 }),
        polar: null,
        sim: { modePolicy: 'motor', sailThreshMs: 2.5, simStepM: 200 },
        propagator: { subsectors: 20, headings: 30 },
        stages: 12,
        simplifyM: 0,
        smoother: false,
        smootherTolerance: 0.05,
        drawbridges: 'ask',
        bridgeWaitS: 0,
        forecast: null,
        regional: null,
        currents: { smoc: { cacheDir, run, settings: SETTINGS, area, steps }, rtofs: null, harmonicDir: null },
      },
      60_000,
      undefined,
      e => events.push(e)
    );
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const lines = events.filter(e => e.event === 'progress').map(e => (e.event === 'progress' ? e.message : ''));
    assert.ok(
      lines.some(m => /^chart mesh: CMEMS SMOC read from the cache \(run \d{10}, provisional, \d+ steps\)/.test(m)),
      lines.join('\n')
    );
    assert.ok(!lines.some(m => /SMOC not read/.test(m)), lines.join('\n'));
    assert.equal(mock.total(), fetched, 'the child fetched nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
