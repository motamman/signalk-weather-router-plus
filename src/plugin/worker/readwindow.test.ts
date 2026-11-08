/**
 * A window of the decoded run (worker/forecast.ts readWindow): the memory check (`admit`) is given the size of the run
 * that is read, the retry's run when the run chosen was pruned, and a refusal stops the read; a pinned run is not
 * retried.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWindow } from './forecast';
import type { WorkerState } from './state';
import type { DecodedRun } from '../../data/decoded';
import type { ForecastStore } from '../../data/forecast';
import type { WindowOptions } from '../../data/decoded';

const OPTS: WindowOptions = { bbox: { west: 0, south: 0, east: 1, north: 1 }, params: ['10u'] };

/** A run whose window holds `bytes`, or whose files are gone (ENOENT); `then` runs as its read starts. */
function run(name: string, bytes: number, gone = false, then?: () => void) {
  const reads: string[] = [];
  const r = {
    name,
    windowBytes: () => bytes,
    window: async () => {
      reads.push(name);
      then?.();
      if (gone) throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
      return { bytes: () => bytes } as unknown as ForecastStore;
    },
  };
  return { run: r as unknown as DecodedRun, reads };
}

const state = (r: DecodedRun) => ({ run: r, forecastMemory: { heldBytes: 0, last: null } }) as unknown as WorkerState;

test('the memory check is given the size of the run read: the run in use, then the newer one when that was pruned', async () => {
  const newer = run('newer', 300);
  const st = state(newer.run);
  // The run in use as the read starts, replaced by a newer cycle (and pruned) while it is read.
  const older = run('older', 200, true, () => (st.run = newer.run));
  st.run = older.run;
  const admitted: number[] = [];
  const got = await readWindow(st, 'leg', OPTS, undefined, n => admitted.push(n));
  assert.equal(got.run, newer.run);
  assert.deepEqual(admitted, [200, 300]);
  assert.equal(st.forecastMemory.heldBytes, 300);
});

test('a refused read reads nothing; a pinned run is not retried', async () => {
  const one = run('one', 500);
  const st = state(one.run);
  await assert.rejects(
    readWindow(st, 'leg', OPTS, undefined, () => {
      throw new Error('not enough memory');
    }),
    /^Error: not enough memory$/
  );
  assert.deepEqual(one.reads, []);
  assert.equal(st.forecastMemory.heldBytes, 0);
  const pinned = run('pinned', 100, true);
  const admitted: number[] = [];
  await assert.rejects(
    readWindow(st, 'leg', OPTS, pinned.run, n => admitted.push(n)),
    /ENOENT: pinned/
  );
  assert.deepEqual(admitted, [100]);
  assert.deepEqual(one.reads, []);
});
