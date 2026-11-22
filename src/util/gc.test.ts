import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { releaseMemory } from './gc';

const MiB = 1 << 20;
const abMiB = (): number => process.memoryUsage().arrayBuffers / MiB;

test('releaseMemory: a thread that drops SharedArrayBuffers handed to it frees them', async () => {
  // As the route worker adopts each SMOC resident area the data worker relays and keeps only the newest. This thread
  // allocates the buffers, so its arrayBuffers counts each one as long as any thread still holds it. The worker holds
  // every buffer until the 'gc' message, so none can be collected earlier; then it drops all but the newest and
  // collects in the same turn. It loads gc.ts through tsx's require hook, whatever the Node version does with types.
  const code = `
    const { parentPort } = require('node:worker_threads');
    require(${JSON.stringify(require.resolve('tsx/cjs/api'))}).register();
    const { releaseMemory } = require(${JSON.stringify(path.join(__dirname, 'gc.ts'))});
    let kept = [];
    parentPort.on('message', m => {
      if (m === 'gc') {
        kept = kept.slice(-1);
        parentPort.postMessage(releaseMemory());
      } else {
        kept.push(new Float32Array(m));
        parentPort.postMessage('kept');
      }
    });
    parentPort.postMessage('ready');`;
  const w = new Worker(code, { eval: true });
  const reply = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      w.once('message', resolve);
      w.once('error', reject);
    });
  try {
    await reply();
    releaseMemory();
    const base = abMiB();
    for (let i = 0; i < 5; i++) {
      const next = reply();
      w.postMessage(new SharedArrayBuffer(16 * MiB));
      await next;
    }
    releaseMemory(); // this thread's own objects
    const held = abMiB() - base;
    assert.ok(held >= 64, `the receiving thread holds all five buffers (${held.toFixed(1)} MiB)`);
    const next = reply();
    w.postMessage('gc');
    assert.equal(typeof (await next), 'number', 'releaseMemory ran a GC in the receiving thread');
    // V8 sweeps dead array buffers on a background thread, so their memory can go a moment after the GC returns.
    let after = abMiB() - base;
    for (let i = 0; i < 40 && after > 24; i++) {
      await new Promise(r => setTimeout(r, 50));
      after = abMiB() - base;
    }
    assert.ok(after <= 24, `only the newest buffer is left (${after.toFixed(1)} MiB)`);
  } finally {
    await w.terminate();
  }
});
