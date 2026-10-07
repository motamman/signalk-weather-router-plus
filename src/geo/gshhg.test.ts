import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ensureGshhg, GSHHG_ENTRIES, gshhgInstalled } from './gshhg';

/** A zip with the given entries (deflated), built by hand. */
function makeZip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    centrals.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('coastline download: fetch, check the size, extract all four hierarchy levels, drop the archive', async () => {
  const shp = Buffer.alloc(200_000, 7);
  const files: Record<string, Buffer> = { 'README.TXT': Buffer.from('x'), 'GSHHS_shp/f/GSHHS_f_L2.shp': Buffer.alloc(10) };
  for (const e of GSHHG_ENTRIES) files[e] = e.endsWith('.shp') ? shp : Buffer.from(e);
  const zip = makeZip(files);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': zip.length });
    res.end(zip);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/g.zip`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-gshhg-'));
  try {
    const logs: string[] = [];
    const got = await ensureGshhg(dir, m => logs.push(m), { urls: [url], expectBytes: zip.length, expectSha256: null });
    assert.equal(got, gshhgInstalled(dir));
    assert.deepEqual(fs.readFileSync(got), shp);
    const names = fs.readdirSync(path.dirname(got)).sort();
    assert.deepEqual(names, [...GSHHG_ENTRIES.map(e => path.basename(e)), 'complete.json'].sort(), 'all four levels; archive removed');
    // A truncated .shp is not counted as installed.
    fs.truncateSync(got, 10);
    assert.equal(gshhgInstalled(dir), null);
    fs.writeFileSync(got, shp);
    assert.ok(logs.some(l => l.includes('downloaded {percentage:1}')));
    // An older L1-only installation must be upgraded, not accepted as complete.
    for (const e of GSHHG_ENTRIES.filter(e => !e.includes('_L1.'))) fs.unlinkSync(path.join(path.dirname(got), path.basename(e)));
    assert.equal(gshhgInstalled(dir), null);
    assert.equal(await ensureGshhg(dir, () => undefined, { urls: [url], expectBytes: zip.length, expectSha256: null }), got);
    // In place: no second download.
    server.close();
    assert.equal(await ensureGshhg(dir, () => undefined, { urls: [url], expectBytes: zip.length, expectSha256: null }), got);
    // A short download is refused and leaves no partial file.
    fs.rmSync(path.join(dir, 'coastline'), { recursive: true });
    server.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const url2 = `http://127.0.0.1:${(server.address() as { port: number }).port}/g.zip`;
    await assert.rejects(
      ensureGshhg(dir, () => undefined, { urls: [url2], expectBytes: zip.length + 1, expectSha256: null }),
      /incomplete/
    );
    assert.deepEqual(fs.readdirSync(path.join(dir, 'coastline', 'gshhg-2.3.7')), []);
    // Unreachable: the reason is named, not just "fetch failed".
    const closed = http.createServer();
    await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
    const freePort = (closed.address() as { port: number }).port;
    await new Promise(r => closed.close(r));
    await assert.rejects(
      ensureGshhg(dir, () => undefined, { urls: [`http://127.0.0.1:${freePort}/g.zip`], expectBytes: 1, expectSha256: null }),
      /cannot reach 127\.0\.0\.1:\d+: ECONNREFUSED/
    );
    // First source down: the second (the backup copy) is used; a wrong hash is refused.
    const sha = crypto.createHash('sha256').update(zip).digest('hex');
    const viaBackup = await ensureGshhg(dir, () => undefined, {
      urls: [`http://127.0.0.1:${freePort}/g.zip`, url2],
      expectBytes: zip.length,
      expectSha256: sha,
    });
    assert.deepEqual(fs.readFileSync(viaBackup), shp);
    fs.rmSync(path.join(dir, 'coastline'), { recursive: true });
    await assert.rejects(
      ensureGshhg(dir, () => undefined, { urls: [url2], expectBytes: zip.length, expectSha256: '0'.repeat(64) }),
      /different file/
    );
    // Cancelled: rejects, nothing left behind.
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      ensureGshhg(dir, () => undefined, { urls: [url2], expectBytes: zip.length, expectSha256: null, signal: ctrl.signal })
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadableCoastlines names missing files', async () => {
  const { unreadableCoastlines } = await import('./gshhg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-coast-'));
  const ok = path.join(dir, 'a.shp');
  fs.writeFileSync(ok, 'x');
  const bad = unreadableCoastlines([ok, path.join(dir, 'missing.shp'), dir]);
  assert.equal(bad.length, 2);
  assert.match(bad[0], /missing\.shp \(not found\)/);
  assert.match(bad[1], /not a file/);
  fs.rmSync(dir, { recursive: true, force: true });
});
