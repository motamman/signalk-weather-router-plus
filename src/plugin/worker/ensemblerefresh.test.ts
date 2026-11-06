/**
 * The data worker's ensemble pass (worker/forecast.ts refreshEnsembles): off, held, and a pass where one ensemble
 * fails, with the child task answered by a fake (no network, no child process). The download and decode themselves
 * are data/ensemble.ts's (ensemble.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refreshEnsembles } from './forecast';
import type { WorkerState } from './state';
import type { runChildTask } from '../childtask';
import type { EnsembleModelId } from '../../data/ecmwf';
import { ENSEMBLE_DECODED_DIR, ENSEMBLE_GRIB_DIR, type EnsembleModelResult } from '../../data/ensemble';
import type { EnsembleDecodeTask, ForecastDecodeEvent } from '../forecastdecodetask';

const CYCLE = new Date('2026-11-06T00:00:00Z');
const CYCLE_NAME = '2026110600';

/** A data worker's state with only what the pass reads: ensembles `models` chosen, 5 members each, a 6 h horizon. */
function state(root: string, models: EnsembleModelId[]): WorkerState {
  return {
    role: 'data',
    cacheRoot: root,
    config: { forecast: { ensemble: { models, members: 5 }, horizonS: 6 * 3600, mirror: 'ecmwf' } },
    client: {},
    run: { cycleTime: CYCLE },
    ensembles: {},
    log: () => undefined,
    ensembleAbort: null,
  } as unknown as WorkerState;
}

/** A file at `rel` under `root`, its folders made. */
function put(root: string, rel: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'GRIB');
  return p;
}

/** A child-task runner that must not be called. */
const neverRun = (() => {
  throw new Error('no child task expected');
}) as unknown as typeof runChildTask;

function result(model: EnsembleModelId, error?: string): EnsembleModelResult {
  return {
    model,
    cycle: CYCLE_NAME,
    members: [],
    failed: [],
    steps: [],
    downloaded: 0,
    downloadedBytes: 0,
    decodeMs: 0,
    ...(error ? { error } : {}),
  };
}

test('ensembles off: what an earlier setting left on disk goes, and the status is empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    put(root, path.join(ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm01', CYCLE_NAME, 'index.json'));
    put(root, path.join(ENSEMBLE_GRIB_DIR, 'ifs-ens', CYCLE_NAME, 'm01', 'enfo-000h-10u.grib2'));
    const st = state(root, []);
    st.ensembles = { 'ifs-ens': { loading: null, error: 'old', checkedAt: null } };
    await refreshEnsembles(st, null, () => null, undefined, neverRun);
    assert.ok(!fs.existsSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens')));
    assert.ok(!fs.existsSync(path.join(root, ENSEMBLE_GRIB_DIR, 'ifs-ens')));
    assert.deepEqual(st.ensembles, {});
    assert.deepEqual(st.ensembleBytes, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('held or offline: each missing ensemble says why, and no download starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    const st = state(root, ['ifs-ens', 'aifs-ens']);
    await refreshEnsembles(st, null, () => 'the internet connection is metered (network.internet.state)', undefined, neverRun);
    for (const m of ['ifs-ens', 'aifs-ens'] as const) {
      assert.match(st.ensembles[m]?.error ?? '', /cycle 2026110600 not downloaded: the internet connection is metered/);
      assert.equal(st.ensembles[m]?.loading, null);
    }
    const st2 = state(root, ['ifs-ens']);
    await refreshEnsembles(st2, 'skipped: no internet connection', () => null, undefined, neverRun);
    assert.match(st2.ensembles['ifs-ens']?.error ?? '', /not downloaded: skipped: no internet connection/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one ensemble fails: it keeps its pending GRIB cache for the next round; the other, done, has its cache pruned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    const ifsCache = put(root, path.join(ENSEMBLE_GRIB_DIR, 'ifs-ens', CYCLE_NAME, 'm01', 'enfo-000h-10u.grib2'));
    const aifsCache = put(root, path.join(ENSEMBLE_GRIB_DIR, 'aifs-ens', CYCLE_NAME, 'm00', 'enfo-000h-10u.grib2'));
    const st = state(root, ['ifs-ens', 'aifs-ens']);
    let asked: EnsembleDecodeTask | null = null;
    const progress: unknown[] = [];
    const run = (async (
      task: EnsembleDecodeTask,
      _timeout: number | null,
      _signal: AbortSignal,
      onEvent: (e: ForecastDecodeEvent) => void
    ) => {
      asked = task;
      // A progress step is the one model's it names.
      onEvent({ event: 'decode-step', done: 2, total: 9, model: 'aifs-ens' });
      progress.push(st.ensembles['aifs-ens']?.loading, st.ensembles['ifs-ens']?.loading);
      return [
        result('ifs-ens', 'ECMWF IFS ENS 2026110600: +3 h enfo is not published yet (to +0 h so far); retried next round'),
        result('aifs-ens'),
      ];
    }) as unknown as typeof runChildTask;
    await refreshEnsembles(st, null, () => null, undefined, run);
    assert.ok(asked);
    assert.deepEqual((asked as EnsembleDecodeTask).models, ['ifs-ens', 'aifs-ens']);
    assert.equal((asked as EnsembleDecodeTask).cycle, CYCLE.toISOString());
    assert.deepEqual(progress, [
      { cycle: CYCLE.toISOString(), done: 2, total: 9 },
      { cycle: CYCLE.toISOString(), done: 0, total: null },
    ]);
    assert.match(st.ensembles['ifs-ens']?.error ?? '', /not published yet/);
    assert.equal(st.ensembles['aifs-ens']?.error, null);
    assert.ok(fs.existsSync(ifsCache), "the failed ensemble's GRIB cache stays for the next round");
    assert.ok(!fs.existsSync(aifsCache), "the finished ensemble's GRIB cache goes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
