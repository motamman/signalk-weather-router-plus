/**
 * The data worker's refresh runs beside its queries (worker.ts): a new SMOC source can replace the one a query
 * prepared while the query awaits. The answer is then marked incomplete (not cached), never passed off as complete.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CurrentStack } from '../../currents/stack';
import type { CurrentSourceLike } from '../../currents/types';
import type { SmocCurrentSource } from '../../currents/smoc';
import type { ResolvedConfig } from '../config';
import type { WorkerToMain } from '../protocol';
import { query } from './query';
import type { WorkerState } from './state';

const EAST: CurrentSourceLike = {
  name: 'test',
  priority: 1,
  resolutionM: 1000,
  bbox: { south: 30, west: -80, north: 50, east: -60 },
  contains: (lon, lat) => lon >= -80 && lon <= -60 && lat >= 30 && lat <= 50,
  at: () => [0.5, 0],
  atMany: lons => ({ u: new Float64Array(lons.length).fill(0.5), v: new Float64Array(lons.length) }),
};

function fakeSmoc(onEnsure: () => void): SmocCurrentSource {
  return {
    run: { key: 'test-run', settled: true },
    evictions: 0,
    revision: 0,
    bracketSteps: () => [Date.UTC(2026, 9, 13, 12)],
    ensure: async () => {
      onEnsure();
      return true;
    },
    trimOnDemand: () => 0,
  } as unknown as SmocCurrentSource;
}

function state(sent: WorkerToMain[]): WorkerState {
  return {
    role: 'data',
    cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    send: m => sent.push(m),
    log: () => undefined,
    config: { currents: { smocEnabled: true }, tides: { enabled: false } } as unknown as ResolvedConfig,
    client: null,
    rtofsClient: null,
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
    rtofs: null,
    smocClient: null,
    smoc: null,
    vesselPos: null,
    stack: new CurrentStack([EAST]),
    reportedLandBuilds: 0,
    reportedSmocRev: -1,
    cacheRoot: '',
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
    harmonicErrors: [],
    decodeAbort: null,
  };
}

const ARGS = { bbox: { west: -75, south: 35, east: -70, north: 40 }, timeMs: Date.UTC(2026, 9, 13, 12), res: 0.5 };

test('a query whose SMOC source is replaced while it waits is answered incomplete; an unchanged one complete', async () => {
  const sent: WorkerToMain[] = [];
  const st = state(sent);
  st.smoc = fakeSmoc(() => undefined);
  await query(st, 1, 'currents', ARGS);
  const same = sent.find(m => m.type === 'query-result');
  assert.ok(same && same.type === 'query-result' && same.complete, 'same source: complete');
  assert.deepEqual(
    same.stamp,
    { forecast: null, smoc: { key: 'test-run', settled: true }, rtofs: null, tide: null },
    'the stamp names what was read'
  );

  sent.length = 0;
  const next = fakeSmoc(() => undefined);
  st.smoc = fakeSmoc(() => (st.smoc = next)); // the refresh adopts a new run while this query loads
  await query(st, 2, 'currents', ARGS);
  const swapped = sent.find(m => m.type === 'query-result');
  assert.ok(swapped && swapped.type === 'query-result', 'answered');
  assert.equal(swapped.complete, false, 'swapped source: not complete');
});
