/**
 * The data worker's refresh queue (refreshqueue.ts): requests join while one waits, and a refresh runs on the newest
 * position it was sent, not on an older one a settings change queued ahead of it set meanwhile (PR #68 review).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VesselPosition } from '../protocol';
import { refreshQueue } from './refreshqueue';

/** `runGate`: each refresh run waits on it (a run in progress). */
function harness(runGate?: Promise<void>): {
  queue: ReturnType<typeof refreshQueue>;
  background: (fn: () => Promise<void>) => void;
  drain: () => Promise<void>;
  pos: () => VesselPosition | null;
  setPos: (p: VesselPosition | null) => void;
  runs: { force: boolean; pos: VesselPosition | null }[];
  holds: (string | null)[];
} {
  let chain: Promise<void> = Promise.resolve();
  let vesselPos: VesselPosition | null = null;
  const runs: { force: boolean; pos: VesselPosition | null }[] = [];
  const holds: (string | null)[] = [];
  const background = (fn: () => Promise<void>): void => {
    chain = chain.then(fn);
  };
  const queue = refreshQueue({
    inBackground: background,
    setPosition: p => (vesselPos = p),
    run: async (force, hold) => {
      runs.push({ force, pos: vesselPos });
      holds.push(hold);
      await runGate;
    },
  });
  return { queue, background, drain: () => chain, pos: () => vesselPos, setPos: p => (vesselPos = p), runs, holds };
}

const OLD = { lat: 41.6, lon: -70.7 };
const NEW = { lat: -18, lon: 178 };

test('a refresh runs on its own (newest) position, not on the older one a queued settings change set', async () => {
  const h = harness();
  // A settings change is queued first, carrying the position of its time (worker.ts 'config' sets it when it runs).
  h.background(async () => h.setPos(OLD));
  // Then a refresh with the vessel's newer position.
  h.queue({ position: NEW });
  assert.deepEqual(h.pos(), NEW, 'taken at once');
  await h.drain();
  assert.deepEqual(h.runs, [{ force: false, pos: NEW }]);
});

test('requests made while one waits join it: force if either asked, the latest position', async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  h.background(() => gate); // other network work running
  h.queue({ position: OLD });
  h.queue({ force: true, position: NEW });
  h.queue({});
  release();
  await h.drain();
  assert.deepEqual(h.runs, [{ force: true, pos: NEW }]);
  // One asked for after that refresh finished is a refresh of its own.
  h.queue({ position: OLD });
  await h.drain();
  assert.deepEqual(h.runs[1], { force: false, pos: OLD });
});

test('a request made while a refresh runs is done once more after it, with its own force and position', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const h = harness(gate);
  h.queue({ position: OLD });
  // Let the first refresh start and wait on the gate.
  await new Promise(r => setImmediate(r));
  assert.equal(h.runs.length, 1, 'the first refresh is running');
  h.queue({ force: true, position: NEW });
  release();
  await h.drain();
  assert.deepEqual(h.runs, [
    { force: false, pos: OLD },
    { force: true, pos: NEW },
  ]);
});

test('a joined round is held only when every request was held; one that may download makes it download', async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  h.background(() => gate);
  h.queue({ hold: 'metered' });
  h.queue({ hold: 'offline' });
  release();
  await h.drain();
  assert.deepEqual(h.holds, ['offline'], 'held, for the latest reason');
  let release2!: () => void;
  const gate2 = new Promise<void>(r => (release2 = r));
  h.background(() => gate2);
  h.queue({ hold: 'metered' });
  h.queue({ force: true });
  h.queue({ hold: 'metered' });
  release2();
  await h.drain();
  assert.deepEqual(h.holds, ['offline', null], 'the Refresh press among them downloads');
});
