import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runChildTask } from './childtask';
import { unshared } from './prebuild';

test('childtask: rmtree in a child process counts the .gz files and removes the tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-child-'));
  const dir = path.join(root, 'wx-old');
  fs.mkdirSync(path.join(dir, 'wind', '6'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wind', '6', 'a.gz'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, 'wind', '6', 'b.gz'), Buffer.alloc(50));
  fs.writeFileSync(path.join(dir, 'wind', '6', 'c.tmp'), Buffer.alloc(7)); // not a tile: removed, not counted
  const r = await runChildTask({ task: 'rmtree', dir });
  assert.deepEqual(r, { files: 2, bytes: 150 });
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('childtask: a failing task rejects with its error', async () => {
  await assert.rejects(
    runChildTask({
      task: 'regional',
      src: { name: 'x', run: null, problem: 'no run' } as never,
      srcDir: '/nonexistent',
      dataDir: '/nonexistent',
      keepRuns: 1,
    }),
    /no run/
  );
});

test('unshared: SharedArrayBuffer views become plain copies, aliasing kept, other values untouched', () => {
  const shared = new Float32Array(new SharedArrayBuffer(16));
  shared[1] = 2.5;
  const plain = new Float64Array([1, 2]);
  const msg = { type: 'smoc', smoc: { resident: { u: shared, data: { utotal: shared } }, lats: plain, when: new Date(0), list: [shared] } };
  const out = unshared(msg);
  assert.ok(!(out.smoc.resident.u.buffer instanceof SharedArrayBuffer));
  assert.equal(out.smoc.resident.u[1], 2.5);
  assert.equal(out.smoc.resident.u, out.smoc.resident.data.utotal, 'one source array, one copy');
  assert.equal(out.smoc.list[0], out.smoc.resident.u);
  assert.equal(out.smoc.lats, plain, 'non-shared arrays are sent as they are');
  assert.equal(out.smoc.when, msg.smoc.when);
  assert.ok(msg.smoc.resident.u.buffer instanceof SharedArrayBuffer, 'the original is not changed');
});

test('unshared: a shared-backed DataView and Buffer are copied too', () => {
  const sab = new SharedArrayBuffer(8);
  new Uint8Array(sab).set([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = unshared({ dv: new DataView(sab, 2, 4), buf: Buffer.from(sab, 4, 4) });
  assert.ok(out.dv instanceof DataView && !(out.dv.buffer instanceof SharedArrayBuffer));
  assert.deepEqual([out.dv.byteLength, out.dv.getUint8(0), out.dv.getUint8(3)], [4, 3, 6]);
  assert.ok(Buffer.isBuffer(out.buf) && !(out.buf.buffer instanceof SharedArrayBuffer));
  assert.deepEqual([...out.buf], [5, 6, 7, 8]);
});
