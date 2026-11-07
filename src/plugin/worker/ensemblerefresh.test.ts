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
import { EnsemblePasses, refreshEnsembles } from './forecast';
import type { WorkerState } from './state';
import type { runChildTask } from '../childtask';
import type { EnsembleModelId } from '../../data/ecmwf';
import {
  ENSEMBLE_DECODED_DIR,
  ENSEMBLE_GRIB_DIR,
  memberComplete,
  readEnsembleCurrent,
  type EnsembleModelResult,
} from '../../data/ensemble';
import type { EnsembleDecodeTask, ForecastDecodeEvent } from '../forecastdecodetask';
import { decodedMember as decodedMemberOf } from './ensemblefixture';

const CYCLE = new Date('2026-11-06T00:00:00Z');
const CYCLE_NAME = '2026110600';

/** A data worker's state with only what the pass reads: ensembles `models` chosen, 5 members each, a 6 h horizon. */
function state(root: string, models: EnsembleModelId[]): WorkerState {
  return {
    role: 'data',
    cacheRoot: root,
    config: { forecast: { ensemble: models.length ? { models, members: 5 } : null, horizonS: 6 * 3600, mirror: 'ecmwf' } },
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

/** A complete decoded run of IFS ENS member `member` for the 6 h cycle (ensemblefixture.ts). */
function decodedMember(root: string, member: number): string {
  return decodedMemberOf(root, member, CYCLE);
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

test('ensembles off: a GRIB cache left by a download that failed before any decode goes too', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    put(root, path.join(ENSEMBLE_GRIB_DIR, 'ifs-ens', CYCLE_NAME, 'm01', 'enfo-000h-10u.grib2'));
    assert.ok(!fs.existsSync(path.join(root, ENSEMBLE_DECODED_DIR)), 'no decoded folder');
    await refreshEnsembles(state(root, []), null, () => null, undefined, neverRun);
    assert.ok(!fs.existsSync(path.join(root, ENSEMBLE_GRIB_DIR, 'ifs-ens')));
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

test('one ensemble fails: it keeps its pending GRIB cache and decoded members for the next round; the other, done, has its cache pruned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    const ifsCache = put(root, path.join(ENSEMBLE_GRIB_DIR, 'ifs-ens', CYCLE_NAME, 'm01', 'enfo-000h-10u.grib2'));
    // A member of the failing ensemble already decoded in this cycle (an earlier round got it before stopping).
    decodedMember(root, 1);
    assert.ok(memberComplete(root, 'ifs-ens', 1, CYCLE_NAME, 6), 'the fixture is a complete decoded run');
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
    assert.ok(memberComplete(root, 'ifs-ens', 1, CYCLE_NAME, 6), "the failed ensemble's members decoded in this cycle stay, whole");
    assert.ok(!fs.existsSync(aifsCache), "the finished ensemble's GRIB cache goes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cycle complete on disk is recorded as the one in use, whatever stopped the pass that decoded it: nothing pruned, no download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    // Every wanted IFS ENS member of this cycle is decoded, but current.json still names the cycle before (the plugin
    // stopped after the last decode, before the cycle was recorded).
    for (const n of [1, 2, 3, 4, 5]) decodedMember(root, n);
    fs.writeFileSync(
      path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json'),
      JSON.stringify({
        model: 'ifs-ens',
        cycle: '2026110518',
        cycleTimeMs: CYCLE.getTime() - 6 * 3600_000,
        members: [1, 2, 3, 4, 5],
        horizonHours: 6,
        at: '',
      })
    );
    const st = state(root, ['ifs-ens']);
    await refreshEnsembles(st, null, () => null, undefined, neverRun);
    const cur = readEnsembleCurrent(root, 'ifs-ens');
    assert.equal(cur?.cycle, CYCLE_NAME);
    assert.deepEqual(cur?.members, [1, 2, 3, 4, 5]);
    for (const n of [1, 2, 3, 4, 5]) assert.ok(memberComplete(root, 'ifs-ens', n, CYCLE_NAME, 6), `member ${n} kept`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("after a pass, the members it completed are recorded by the worker from the disk, not from the child's answer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    const st = state(root, ['ifs-ens']);
    // The child decodes every member, and answers nothing about them.
    const run = (async () => {
      for (const n of [1, 2, 3, 4, 5]) decodedMember(root, n);
      return [result('ifs-ens')];
    }) as unknown as typeof runChildTask;
    await refreshEnsembles(st, null, () => null, undefined, run);
    assert.equal(readEnsembleCurrent(root, 'ifs-ens')?.cycle, CYCLE_NAME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a record of the cycle in use that cannot be read is reported each round, and written again once the cycle is complete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    for (const n of [1, 2, 3, 4, 5]) decodedMember(root, n);
    fs.writeFileSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json'), 'not json');
    const logged: string[] = [];
    const st = state(root, ['ifs-ens']);
    (st as unknown as { log: (level: string, m: string) => void }).log = (level, m) => logged.push(`${level}: ${m}`);
    await refreshEnsembles(st, null, () => null, undefined, neverRun);
    assert.ok(
      logged.some(m =>
        /^error: ensembles: ECMWF IFS ENS: current\.json is not JSON: .*; written again once the cycle's members are complete$/.test(m)
      )
    );
    assert.equal(readEnsembleCurrent(root, 'ifs-ens')?.cycle, CYCLE_NAME, 'complete: written again this round');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cycle complete on disk whose record cannot be written is not in use, its status and the log say why, and it stays on disk for the next round', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    for (const n of [1, 2, 3, 4, 5]) decodedMember(root, n);
    const cache = put(root, path.join(ENSEMBLE_GRIB_DIR, 'ifs-ens', CYCLE_NAME, 'm01', 'enfo-000h-10u.grib2'));
    // A folder where the record's copy is written (on every OS): the record cannot be saved.
    fs.mkdirSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json.tmp', 'inside'), { recursive: true });
    const logged: string[] = [];
    const st = state(root, ['ifs-ens']);
    (st as unknown as { log: (level: string, m: string) => void }).log = (level, m) => logged.push(`${level}: ${m}`);
    await refreshEnsembles(st, null, () => null, undefined, neverRun);
    assert.equal(readEnsembleCurrent(root, 'ifs-ens'), null, 'not in use');
    assert.match(st.ensembles['ifs-ens']?.error ?? '', /^cycle 2026110600 complete but not in use: current\.json could not be written: /);
    assert.equal(st.ensembles['ifs-ens']?.loading, null);
    assert.ok(logged.some(m => m.startsWith('error: ensembles: ECMWF IFS ENS: cycle 2026110600 complete but not in use: ')));
    // The cycle is pending, not gone: nothing of it is pruned, so the next round records it without a download.
    for (const n of [1, 2, 3, 4, 5]) assert.ok(memberComplete(root, 'ifs-ens', n, CYCLE_NAME, 6), `member ${n} kept`);
    assert.ok(fs.existsSync(cache), 'its GRIB cache kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('after a pass, a cycle it completed whose record cannot be written stays on disk for the next round, not downloaded again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ensref-'));
  try {
    fs.mkdirSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json.tmp', 'inside'), { recursive: true });
    const st = state(root, ['ifs-ens']);
    let cache = '';
    const run = (async () => {
      for (const n of [1, 2, 3, 4, 5]) decodedMember(root, n);
      cache = put(root, path.join(ENSEMBLE_GRIB_DIR, 'ifs-ens', CYCLE_NAME, 'm01', 'enfo-000h-10u.grib2'));
      return [result('ifs-ens')];
    }) as unknown as typeof runChildTask;
    await refreshEnsembles(st, null, () => null, undefined, run);
    assert.equal(readEnsembleCurrent(root, 'ifs-ens'), null, 'not in use');
    assert.match(st.ensembles['ifs-ens']?.error ?? '', /^cycle 2026110600 complete but not in use: current\.json could not be written: /);
    for (const n of [1, 2, 3, 4, 5]) assert.ok(memberComplete(root, 'ifs-ens', n, CYCLE_NAME, 6), `member ${n} kept`);
    assert.ok(fs.existsSync(cache), 'its GRIB cache kept');
    // The next round, the record writable again: recorded from the disk, no child task.
    fs.rmSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json.tmp'), { recursive: true, force: true });
    await refreshEnsembles(st, null, () => null, undefined, neverRun);
    assert.equal(readEnsembleCurrent(root, 'ifs-ens')?.cycle, CYCLE_NAME);
    assert.equal(st.ensembles['ifs-ens']?.error, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EnsemblePasses: one pass at a time; a start while one runs makes one more after it, the owner’s when any start was', async () => {
  const runs: { offline: string | null; user: boolean }[] = [];
  let changes = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const passes = new EnsemblePasses(
    async offline => {
      runs.push({ offline, user: passes.userPass });
      if (runs.length === 1) await gate;
    },
    () => changes++,
    () => undefined
  );
  passes.start(null, () => null, false);
  assert.equal(passes.active, true);
  assert.equal(passes.userPass, false);
  passes.start('skipped: no internet connection', () => null, true);
  passes.start(null, () => null, false);
  assert.equal(passes.userPass, true, "the owner's ask makes the pass under way theirs");
  assert.equal(runs.length, 1, 'one pass runs');
  release();
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(runs, [
    { offline: null, user: false },
    { offline: null, user: true },
  ]);
  assert.equal(passes.active, false);
  assert.equal(passes.userPass, false);
  assert.equal(changes, 2, 'the status went out at the end of each pass');
  // Nothing asked during the second pass: no third.
  await new Promise(r => setTimeout(r, 0));
  assert.equal(runs.length, 2);
});
