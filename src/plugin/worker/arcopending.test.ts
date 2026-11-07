/**
 * A CMEMS SMOC or sea-level update Copernicus Marine is still writing (its STAC record marks the update in progress).
 * While the store still holds the run in use, the source reports `updating` and no pending run (the run in use is not
 * a newer run). Once the store holds a newer run, the source reports it as `pending` (status, freshness) and the run
 * in use stays; a check reason says which. A round that cannot ask the store leaves both as they were, and they clear
 * once the update is written. Before, the reason was built from the run kept, which is settled, so it was empty
 * (brain, 2026-10-29), and the run in use was reported as its own pending run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runLastMs, SmocClient } from '../../currents/smoc';
import { URLS, makeMock } from '../../currents/smoc.mock.test';
import { CurrentStack } from '../../currents/stack';
import { HOUR_MS, HOUR_S } from '../../geo/units';
import { SeaLevelClient } from '../../tides/sealevel';
import { URLS as TIDE_URLS, mockFetch as tideFetch } from '../../tides/sealevel.mock.test';
import type { ArcoRun } from '../../data/arco';
import type { EcmwfClient } from '../../data/ecmwf';
import type { ResolvedConfig } from '../config';
import { refreshSmoc } from './currents';
import { refreshTides } from './tides';
import type { WorkerState } from './state';

function state(cacheRoot: string, config: unknown): WorkerState {
  return {
    role: 'data',
    cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    send: () => undefined,
    log: () => undefined,
    config: config as ResolvedConfig,
    client: {} as EcmwfClient,
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
    // No position: nothing resident is loaded, only the store is asked.
    vesselPos: null,
    stack: new CurrentStack([]),
    reportedLandBuilds: 0,
    reportedSmocRev: -1,
    cacheRoot,
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

const PENDING_REASON =
  /^a newer run appeared in the store .+ and Copernicus Marine is still writing it; the previous run stays in use until it is finished$/;
const UPDATING_REASON = /^Copernicus Marine has started an update; no newer run is in the store yet; run \d{10} stays in use$/;
/** When the newer run's metadata appeared (newerRun's Last-Modified): before either mock's STAC admp_updated_data, so it is settled once STAC no longer marks an update. */
const NEWER_APPEARED = '2026-09-28T09:00:00.000Z';

/** The key of the run a day after `run` (newerRun's time axis). */
const dayAfter = (run: ArcoRun): string => new Date(runLastMs(run) + 24 * HOUR_MS).toISOString().slice(0, 13).replace(/[-T]/g, '');

/** While `on()`: the timeChunked store holds a newer run (its time axis a day later, new ETag and Last-Modified). */
function newerRun(base: typeof fetch, on: () => boolean): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const res = await base(input, init);
    if (!on() || !url.includes('/time.zarr/')) return res;
    if (url.endsWith('/.zmetadata'))
      return new Response(await res.arrayBuffer(), {
        status: res.status,
        headers: { etag: '"newer"', 'last-modified': 'Mon, 28 Sep 2026 09:00:00 GMT' },
      });
    if (/\/time\.zarr\/time\/\d+$/.test(url)) {
      const t = new Float32Array(await res.arrayBuffer()).map(v => v + 24);
      return new Response(new Uint8Array(t.buffer), { status: res.status });
    }
    return res;
  }) as typeof fetch;
}

test('SMOC: an update over the run in use is reported as updating, a newer run still being written as pending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-pending-'));
  try {
    const mock = makeMock();
    let newer = false;
    const st = state(dir, { currents: { smocEnabled: true, smocStepS: 3 * HOUR_S, smocHorizonS: 24 * HOUR_S, smocHalfWidthDeg: 10 } });
    st.smocClient = new SmocClient({
      cacheDir: dir,
      urls: URLS,
      fetchImpl: newerRun(mock.fetch, () => newer),
      sleepImpl: async () => undefined,
    });
    await refreshSmoc(st);
    const kept = st.smoc;
    assert.ok(kept, 'a run is in use');
    assert.equal(kept.status().pending, null);
    assert.equal(kept.status().updating, false);

    // Copernicus starts its update while the store still holds the run in use: no newer run to report.
    mock.stacUpdating = true;
    await refreshSmoc(st);
    assert.equal(st.smoc, kept, 'the run in use stays');
    assert.equal(kept.status().pending, null, 'the run in use is not a newer run');
    assert.equal(kept.status().updating, true);
    assert.equal(st.checks.smoc?.outcome, 'newest');
    assert.match(st.checks.smoc?.reason ?? '', UPDATING_REASON);

    // A round that could not ask the store knows nothing new: left as it was.
    await refreshSmoc(st, 'skipped: no internet connection');
    assert.equal(kept.status().updating, true, 'left as it was');

    // The update finishes without a newer run: nothing more to say.
    mock.stacUpdating = false;
    await refreshSmoc(st);
    assert.equal(st.smoc, kept);
    assert.equal(kept.status().updating, false);
    assert.equal(st.checks.smoc?.reason, null);

    // The store holds a newer run Copernicus Marine is still writing: it is pending, the run in use stays.
    mock.stacUpdating = true;
    newer = true;
    await refreshSmoc(st);
    assert.equal(st.smoc, kept, 'the run in use stays');
    assert.deepEqual(kept.status().pending, { run: dayAfter(kept.run), appeared_at: NEWER_APPEARED });
    assert.equal(kept.status().updating, false);
    assert.equal(st.checks.smoc?.outcome, 'newest');
    assert.match(st.checks.smoc?.reason ?? '', PENDING_REASON);

    // The newer run is written: it is used, and nothing is pending.
    mock.stacUpdating = false;
    await refreshSmoc(st);
    assert.equal(st.smoc?.run.key, dayAfter(kept.run));
    assert.equal(st.smoc?.status().pending, null);
    assert.equal(st.smoc?.status().updating, false);
    assert.equal(st.checks.smoc?.outcome, 'new-run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tides: an update over the run in use is reported as updating, a newer run still being written as pending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-pending-'));
  try {
    const store = tideFetch(new Map());
    let updating = false;
    let newer = false;
    // The mock's STAC record, with the update marked in progress while `updating`.
    const stac = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('dataset.stac.json') && updating
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                properties: { admp_updated_data: '2026-09-28T10:00:00Z', admp_updating_start_date: '2026-09-28T08:00:00Z' },
              }),
              { status: 200 }
            )
          )
        : store(input, init)) as typeof fetch;
    const st = state(dir, { tides: { enabled: true, halfWidthDeg: 5, horizonS: 24 * HOUR_S } });
    st.seaLevelClient = new SeaLevelClient({
      cacheDir: dir,
      urls: TIDE_URLS,
      fetchImpl: newerRun(stac, () => newer),
      sleepImpl: async () => undefined,
    });
    await refreshTides(st);
    const kept = st.tides;
    assert.ok(kept, 'a run is in use');
    assert.equal(kept.status().pending, null);
    assert.equal(kept.status().updating, false);

    updating = true;
    await refreshTides(st);
    assert.equal(st.tides, kept, 'the run in use stays');
    assert.equal(kept.status().pending, null, 'the run in use is not a newer run');
    assert.equal(kept.status().updating, true);
    assert.equal(st.checks.tides?.outcome, 'newest');
    assert.match(st.checks.tides?.reason ?? '', UPDATING_REASON);

    updating = false;
    await refreshTides(st);
    assert.equal(kept.status().updating, false);
    assert.equal(st.checks.tides?.reason, null);

    updating = true;
    newer = true;
    await refreshTides(st);
    assert.equal(st.tides, kept, 'the run in use stays');
    assert.deepEqual(kept.status().pending, { run: dayAfter(kept.run), appeared_at: NEWER_APPEARED });
    assert.equal(kept.status().updating, false);
    assert.match(st.checks.tides?.reason ?? '', PENDING_REASON);

    updating = false;
    await refreshTides(st);
    assert.equal(st.tides?.run.key, dayAfter(kept.run));
    assert.equal(st.tides?.status().pending, null);
    assert.equal(st.checks.tides?.outcome, 'new-run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
