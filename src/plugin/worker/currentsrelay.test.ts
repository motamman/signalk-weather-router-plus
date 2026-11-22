/**
 * The route worker adopts the SMOC and RTOFS memory the data worker relays (worker.ts 'smoc', 'rtofs', 'config').
 * Whenever adopted memory is replaced or dropped it runs a full GC: an idle route worker otherwise kept every replaced
 * SMOC area alive (issue #113). The GC is seen here by its debug line.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { CurrentStack } from '../../currents/stack';
import { type SerializedRtofsSet } from '../../currents/rtofs';
import { loadResident, SmocClient, SmocCurrentSource, type SerializedSmoc } from '../../currents/smoc';
import { H, makeMock, SETTINGS, T0, tmpDir, URLS } from '../../currents/smoc.mock.test';
import type { ResolvedConfig } from '../config';
import type { WorkerRole } from '../protocol';
import { adoptRtofs, adoptSmoc, dropCurrents } from './currents';
import type { WorkerState } from './state';

const GC_LINE = /^(smoc|rtofs|currents): full GC after dropping shared memory: \d+ ms$/;

function config(currents: { smocEnabled: boolean; rtofsEnabled: boolean }): ResolvedConfig {
  return { currents: { ...currents, rtofsExtra: [] }, tides: { enabled: false } } as unknown as ResolvedConfig;
}

function state(role: WorkerRole, gcLines: string[]): WorkerState {
  return {
    role,
    cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    send: () => undefined,
    log: (_level, m) => {
      if (m.includes('full GC')) gcLines.push(m);
    },
    config: config({ smocEnabled: true, rtofsEnabled: true }),
    // requireInit asks for one; nothing here downloads.
    client: {} as unknown as WorkerState['client'],
    rtofsClients: new Map(),
    run: null,
    runInfo: null,
    forecastMemory: { heldBytes: 0, last: null },
    lastDecode: null,
    decodingBlockBytes: null,
    diskBytes: { decoded: 0, grib: 0 },
    overlayLand: null,
    polar: null,
    landCache: null,
    harmonic: [],
    rtofs: [],
    rtofsChoice: null,
    smocClient: null,
    smoc: null,
    vesselPos: null,
    stack: new CurrentStack([]),
    reportedLandBuilds: 0,
    reportedSmocRev: -1,
    cacheRoot: '',
    cropRoot: '',
    regional: new Map(),
    seaLevelClient: null,
    tides: null,
    tidesError: null,
    reportedTidesRev: -1,
    waterGrid: null,
    gridBuilder: null,
    routeWindow: null,
    routeRegional: [],
    cancelledQueries: new Set(),
    checks: {},
    connectivity: { online: null, since: null, lastOkAt: null, reason: null },
    lastOfflineMs: 0,
    internetHold: null,
    backgroundRound: false,
    harmonicErrors: [],
    currentsUnread: [],
    decodeAbort: null,
    ensembles: {},
  };
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Two resident areas of one run, as the data worker relays them one window step apart. */
async function smocRelays(): Promise<[SerializedSmoc, SerializedSmoc]> {
  const mock = makeMock();
  const dir = tmpDir();
  dirs.push(dir);
  const client = new SmocClient({ cacheDir: dir, urls: URLS, fetchImpl: mock.fetch, sleepImpl: async () => undefined });
  const run = await client.probe();
  const src = new SmocCurrentSource(run, SETTINGS, client);
  const pos = { lat: 50, lon: -3 };
  const relay = async (nowMs: number): Promise<SerializedSmoc> => {
    const res = await loadResident(client, run, SETTINGS, pos, src.windowSteps(nowMs));
    assert.ok(res);
    return { run, resident: res.area, settings: SETTINGS, centre: pos };
  };
  return [await relay(T0 + 20 * H), await relay(T0 + 23 * H)];
}

function rtofsRelay(runMs: number): SerializedRtofsSet {
  const grid = () => ({
    lat0: 0,
    lon0: 0,
    dLat: 1,
    dLon: 1,
    nLat: 2,
    nLon: 2,
    values: new Float32Array(new SharedArrayBuffer(16)),
    wrap: false,
  });
  return {
    extra: [],
    runs: [{ product: 'test', runMs, bbox: { south: 0, west: 0, north: 1, east: 1 }, steps: [{ validMs: runMs, u: grid(), v: grid() }] }],
  };
}

test('route worker: a relayed SMOC area that replaces or drops the one held is collected; a first one is not', async () => {
  const [first, next] = await smocRelays();
  const gc: string[] = [];
  const st = state('route', gc);
  adoptSmoc(st, first);
  assert.equal(st.smoc?.resident, first.resident);
  assert.equal(gc.length, 0, 'nothing held before');
  adoptSmoc(st, next);
  assert.equal(st.smoc?.resident, next.resident, 'same run: the new area is put in place');
  assert.equal(gc.length, 1);
  assert.match(gc[0], GC_LINE);
  assert.ok(gc[0].startsWith('smoc:'));
  adoptSmoc(st, null);
  assert.equal(st.smoc, null);
  assert.equal(gc.length, 2, 'SMOC gone (turned off on the data worker): what it held is collected');
  adoptSmoc(st, null);
  assert.equal(gc.length, 2, 'nothing held: no GC');
});

test('route worker: a relayed RTOFS set that replaces or drops the one held is collected; a first one is not', () => {
  const gc: string[] = [];
  const st = state('route', gc);
  adoptRtofs(st, rtofsRelay(T0));
  assert.equal(st.rtofs.length, 1);
  assert.equal(gc.length, 0, 'nothing held before');
  adoptRtofs(st, rtofsRelay(T0 + 24 * H));
  assert.equal(st.rtofs[0].runMs, T0 + 24 * H);
  assert.equal(gc.length, 1);
  assert.match(gc[0], GC_LINE);
  assert.ok(gc[0].startsWith('rtofs:'));
  adoptRtofs(st, null);
  assert.deepEqual(st.rtofs, []);
  assert.equal(gc.length, 2);
  adoptRtofs(st, null);
  assert.equal(gc.length, 2, 'nothing held: no GC');
});

test('settings change: the route worker collects the relayed memory it drops; the data worker does not', async () => {
  const [first] = await smocRelays();
  const off = config({ smocEnabled: false, rtofsEnabled: false });
  const gc: string[] = [];
  const route = state('route', gc);
  adoptSmoc(route, first);
  adoptRtofs(route, rtofsRelay(T0));
  dropCurrents(route, off, { smoc: true, rtofs: true });
  assert.equal(route.smoc, null);
  assert.deepEqual(route.rtofs, []);
  assert.equal(gc.length, 1);
  assert.match(gc[0], GC_LINE);
  assert.ok(gc[0].startsWith('currents:'));
  dropCurrents(route, off, { smoc: true, rtofs: true });
  assert.equal(gc.length, 1, 'nothing held: no GC');
  // The data worker allocated its areas itself, so V8 counts them there: no GC needed.
  const data = state('data', gc);
  adoptSmoc(data, first);
  dropCurrents(data, off, { smoc: true, rtofs: false });
  assert.equal(data.smoc, null);
  assert.equal(gc.length, 1);
});
