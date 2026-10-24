/**
 * A refresh round held by the internet state (internet.ts) with no forecast on disk yet: the forecast is
 * missing, not failed, so a route waiting for the first forecast is not released (index.ts asks for an unheld
 * round for it). An unheld round that cannot reach ECMWF reports the error as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CurrentStack } from '../../currents/stack';
import type { EcmwfClient } from '../../data/ecmwf';
import type { ResolvedConfig } from '../config';
import type { WorkerToMain } from '../protocol';
import { refreshForecast } from './forecast';
import type { WorkerState } from './state';

function state(sent: WorkerToMain[], cacheRoot: string): WorkerState {
  return {
    role: 'data',
    cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    send: m => sent.push(m),
    log: () => undefined,
    config: { forecast: { horizonS: 72 * 3600, extraFields: false, energyFields: false } } as unknown as ResolvedConfig,
    client: { cycleFullyCached: () => false, cachedCycles: () => [] } as unknown as EcmwfClient,
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
    cacheRoot,
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

test('a held round with no forecast yet sends no refresh-error; an offline unheld one does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-held-'));
  try {
    const sent: WorkerToMain[] = [];
    await refreshForecast(state(sent, dir), false, 'skipped: the internet connection is metered (network.internet.state)', true);
    assert.equal(sent.filter(m => m.type === 'refresh-error').length, 0);
    const check = sent.find(m => m.type === 'forecast-check');
    assert.ok(check && check.type === 'forecast-check' && check.check.outcome === 'could-not-check');
    assert.match(check.check.reason ?? '', /metered/);

    const sent2: WorkerToMain[] = [];
    await refreshForecast(state(sent2, dir), false, 'skipped: no internet connection', false);
    assert.equal(sent2.filter(m => m.type === 'refresh-error').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
