/**
 * A tile built ahead of time in a builder process (query.ts buildTile, prebuild.ts) is written exactly as the main
 * thread wrote it before (the query answer through tiles.ts encodeTile), and the store adopts it as it saves one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { CurrentStack } from '../../currents/stack';
import type { CurrentSourceLike } from '../../currents/types';
import type { WorkerToMain } from '../protocol';
import { encodeTile, tileQuery, TileStore, type TileId } from '../tiles';
import { defaultSettings } from '../settings';
import { resolveConfig } from '../config';
import { buildTile, query } from './query';
import { adoptCurrentsRef } from './currents';
import { harmonicSignature } from '../../currents/fromcache';
import type { WorkerState } from './state';

/** A current of 0.5 m/s east everywhere in a box. */
const EAST: CurrentSourceLike = {
  name: 'test',
  priority: 1,
  resolutionM: 1000,
  bbox: { south: 30, west: -80, north: 50, east: -60 },
  contains: (lon, lat) => lon >= -80 && lon <= -60 && lat >= 30 && lat <= 50,
  at: () => [0.5, 0],
  atMany: lons => ({ u: new Float64Array(lons.length).fill(0.5), v: new Float64Array(lons.length) }),
};

function state(sent: WorkerToMain[]): WorkerState {
  return {
    role: 'tiles',
    cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    send: m => sent.push(m),
    log: () => undefined,
    config: null,
    client: null,
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
    internetHold: null,
    backgroundRound: false,
    harmonicErrors: [],
    currentsUnread: [],
    decodeAbort: null,
    ensembles: {},
  };
}

const HOUR = Date.UTC(2026, 9, 13, 12);

test('buildTile writes the bytes the main thread wrote from the query answer, and the store adopts them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-buildtile-'));
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  for (const t of [
    { layer: 'current', z: 8, x: 75, y: 95, hourMs: HOUR },
    { layer: 'arrows', z: 8, x: 75, y: 95, hourMs: HOUR },
  ] as TileId[]) {
    const sent: WorkerToMain[] = [];
    const st = state(sent);
    // Before: the answer crossed to the main thread, which encoded it.
    const { kind, args } = tileQuery(t);
    await query(st, 1, kind, args);
    const r = sent.find(m => m.type === 'query-result');
    assert.ok(r && r.type === 'query-result' && r.complete, `${t.layer}: answered`);
    const before = await encodeTile(t, r.result);
    // Now: the builder encodes and writes it beside the tile.
    const tmp = store.tmpFile(t)!;
    await buildTile(st, 2, t, tmp);
    const done = sent.find(m => m.type === 'tile-built');
    assert.ok(done && done.type === 'tile-built' && done.complete, `${t.layer}: built`);
    assert.equal(done.bytes, before.length);
    assert.deepEqual(
      done.stamp,
      { forecast: null, smoc: null, rtofs: [], tide: null },
      `${t.layer}: the stamp names what was read (nothing loaded here)`
    );
    assert.ok(Buffer.from(fs.readFileSync(tmp)).equals(before), `${t.layer}: the same bytes`);
    await store.adopt(t, tmp, done.bytes, store.generation('cur'));
    assert.equal(fs.existsSync(tmp), false, 'moved, not copied');
    const saved = await store.read(t);
    assert.ok(saved && saved.equals(before), `${t.layer}: read back`);
    assert.ok(zlib.gunzipSync(saved).length > 0);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: a tile built while its data changed is removed, not adopted; totals count what is adopted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-adopt-'));
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  // Totals known (an empty store counted), so adopted tiles are counted as they come.
  for (let i = 0; i < 500 && !fs.existsSync(path.join(root, '.totals.json')); i++) {
    store.stats();
    await store.flushTotals();
    await new Promise(r => setTimeout(r, 10));
  }
  const T: TileId = { layer: 'wind', z: 6, x: 18, y: 23, hourMs: HOUR };
  const write = (t: TileId, n: number): { tmp: string; gen: string | null } => {
    const tmp = store.tmpFile(t)!;
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.alloc(n, 1)));
    return { tmp, gen: store.generation('wx') };
  };
  const a = write(T, 10);
  await store.adopt(T, a.tmp, fs.statSync(a.tmp).size, a.gen);
  const b = write({ ...T, x: 19 }, 20);
  const bBytes = fs.statSync(b.tmp).size;
  await store.adopt({ ...T, x: 19 }, b.tmp, bBytes, b.gen);
  assert.equal(store.stats().files, 2);
  assert.equal(store.stats().bytes, fs.statSync(store.file(T)!).size + bBytes);
  // Built under generation a, adopted after the forecast moved to b: removed, nothing counted.
  const c = write({ ...T, x: 20 }, 30);
  store.setGenerations({ wx: 'b', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  await store.adopt({ ...T, x: 20 }, c.tmp, fs.statSync(c.tmp).size, c.gen);
  assert.equal(fs.existsSync(c.tmp), false, 'the stale file is removed');
  assert.equal(await store.has({ ...T, x: 20 }), false, 'not in the new generation');
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildTile keeps no current-layer tile while a current source could not be read, and keeps it once read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-unread-'));
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  for (const layer of ['current', 'arrows'] as const) {
    for (const unread of [['rtofs west_atl'], []]) {
      const sent: WorkerToMain[] = [];
      const st = state(sent);
      st.currentsUnread = unread;
      const t: TileId = { layer, z: 8, x: 75, y: 95, hourMs: HOUR };
      const tmp = store.tmpFile(t)!;
      await buildTile(st, 1, t, tmp);
      const done = sent.find(m => m.type === 'tile-built');
      const kept = unread.length === 0;
      assert.ok(done && done.type === 'tile-built', `${layer}: answered`);
      assert.equal(done.complete, kept, `${layer}, unread ${unread.join() || 'none'}: kept ${kept}`);
      assert.equal(fs.existsSync(tmp), kept, `${layer}, unread ${unread.join() || 'none'}: written ${kept}`);
      fs.rmSync(tmp, { force: true });
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('adoptCurrentsRef: an RTOFS product or harmonic file not read is marked unread, and read again by the next reference', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-harmonic-'));
  fs.writeFileSync(path.join(dir, 'broken.npz'), 'not a zip');
  const st = state([]);
  st.config = resolveConfig({}, defaultSettings());
  st.client = {} as WorkerState['client'];
  const rtofs = {
    cacheDir: path.join(dir, 'empty-rtofs-cache'),
    runs: [{ product: 'west_atl', runMs: HOUR, bbox: { south: 30, west: -80, north: 50, east: -60 } }],
    horizonS: 72 * 3600,
    stepS: 3 * 3600,
  };
  await adoptCurrentsRef(st, { smoc: null, rtofs, harmonicDir: dir, harmonicSig: harmonicSignature(dir) });
  assert.deepEqual(st.currentsUnread, ['rtofs west_atl', 'harmonic broken.npz']);
  assert.equal(st.rtofs.length, 0);
  assert.equal(st.harmonic.length, 0);
  // The same reference after the file is gone: the folder is read again (it was not marked as read).
  fs.rmSync(path.join(dir, 'broken.npz'));
  await adoptCurrentsRef(st, { smoc: null, rtofs, harmonicDir: dir, harmonicSig: harmonicSignature(dir) });
  assert.deepEqual(st.currentsUnread, ['rtofs west_atl'], 'the harmonic folder read again; RTOFS still missing');
  // RTOFS no longer in the reference: nothing unread.
  await adoptCurrentsRef(st, { smoc: null, rtofs: null, harmonicDir: dir, harmonicSig: harmonicSignature(dir) });
  assert.deepEqual(st.currentsUnread, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('adoptCurrentsRef: a harmonic folder changed since the data worker read it is not read, and is read once it matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-harmonic-sig-'));
  fs.writeFileSync(path.join(dir, 'broken.npz'), 'not a zip');
  const st = state([]);
  st.config = resolveConfig({}, defaultSettings());
  st.client = {} as WorkerState['client'];
  // As the data worker read it: read here too (the broken file fails, which shows it was read).
  const asRead = harmonicSignature(dir);
  await adoptCurrentsRef(st, { smoc: null, rtofs: null, harmonicDir: dir, harmonicSig: asRead });
  assert.deepEqual(st.currentsUnread, ['harmonic broken.npz']);
  // A file replaced since the data worker read the folder: nothing read, the current tiles not kept.
  fs.rmSync(path.join(dir, 'broken.npz'));
  await adoptCurrentsRef(st, { smoc: null, rtofs: null, harmonicDir: dir, harmonicSig: asRead });
  assert.equal(st.currentsUnread.length, 1);
  assert.match(st.currentsUnread[0], /changed since the data worker read them; restart the plugin/);
  assert.equal(st.harmonic.length, 0);
  // The data worker restarted and read the folder as it is now: read, nothing unread.
  await adoptCurrentsRef(st, { smoc: null, rtofs: null, harmonicDir: dir, harmonicSig: harmonicSignature(dir) });
  assert.deepEqual(st.currentsUnread, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
