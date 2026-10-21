import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  roundHour,
  stampMatches,
  tileAt,
  tileBBox,
  tileQuery,
  TileService,
  TileStore,
  trimPoints,
  type TileGroup,
  type TileId,
} from './tiles';
import type { DataStamp } from './protocol';

test('tile boxes: web-map tile edges and the tile holding a point', () => {
  const b = tileBBox(1, 0, 0);
  assert.equal(b.west, -180);
  assert.equal(b.east, 0);
  assert.ok(Math.abs(b.north - 85.0511) < 1e-3);
  assert.ok(Math.abs(b.south) < 1e-9);
  const t = tileAt(-71.5, 41.2, 8);
  const tb = tileBBox(8, t.x, t.y);
  assert.ok(tb.west <= -71.5 && -71.5 < tb.east && tb.south <= 41.2 && 41.2 < tb.north);
});

test('tile queries: colour layers reach one spacing past the tile; spacing is fixed by zoom', () => {
  const q = tileQuery({ layer: 'wind', z: 8, x: 75, y: 95, hourMs: 0 });
  assert.equal(q.kind, 'field');
  const a = q.args as { bbox: { west: number; east: number }; res: number };
  const b = tileBBox(8, 75, 95);
  assert.ok(Math.abs(a.res - (b.east - b.west) / 64) < 1e-12);
  assert.ok(Math.abs(a.bbox.west - (b.west - a.res)) < 1e-12);
  assert.equal(tileQuery({ layer: 'land', z: 8, x: 75, y: 95, hourMs: 0 }).kind, 'land_mask');
});

test('trimPoints keeps west/south edges and drops east/north edges', () => {
  const b = tileBBox(4, 5, 6);
  const pts = [
    { lon: b.west, lat: b.south },
    { lon: b.east, lat: b.south },
    { lon: b.west, lat: b.north },
    { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 },
  ];
  assert.equal(trimPoints(pts, 4, 5, 6).length, 2);
});

test('roundHour rounds to the nearest hour', () => {
  assert.equal(roundHour(Date.UTC(2026, 8, 29, 12, 29)), Date.UTC(2026, 8, 29, 12));
  assert.equal(roundHour(Date.UTC(2026, 8, 29, 12, 31)), Date.UTC(2026, 8, 29, 13));
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-tiles-'));
}

const T: TileId = { layer: 'wind', z: 6, x: 18, y: 23, hourMs: Date.UTC(2026, 8, 29, 12) };

/** What the plugin holds before and after a data swap mid-request. */
const STAMP_A: DataStamp = {
  forecast: { cycleMs: Date.UTC(2026, 8, 29, 6), params: ['10u', '10v'] },
  smoc: { key: 'smoc-a', settled: true },
  rtofs: Date.UTC(2026, 8, 29),
  tide: { key: 'tide-a', settled: true },
};
const STAMP_B: DataStamp = {
  forecast: { cycleMs: Date.UTC(2026, 8, 29, 12), params: ['10u', '10v'] },
  smoc: { key: 'smoc-b', settled: false },
  rtofs: Date.UTC(2026, 8, 29) + 86_400_000,
  tide: { key: 'tide-b', settled: false },
};

/** A query fn whose answers the test hands over, oldest call first. */
function handover(): {
  svc: TileService;
  store: TileStore;
  root: string;
  calls: { n: number };
  /** What the plugin holds now; answers default to its stamp. */
  held: { stamp: DataStamp };
  answer: (v: unknown, stamp?: DataStamp) => void;
} {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  const calls = { n: 0 };
  const resolvers: ((v: { result: unknown; complete: boolean; stamp: DataStamp }) => void)[] = [];
  const held = { stamp: STAMP_A };
  const svc = new TileService(
    store,
    () => {
      calls.n++;
      return new Promise<{ result: unknown; complete: boolean; stamp: DataStamp }>(r => resolvers.push(r));
    },
    () => held.stamp
  );
  return {
    svc,
    store,
    root,
    calls,
    held,
    answer: (v, stamp) => resolvers.shift()?.({ result: v, complete: true, stamp: stamp ?? held.stamp }),
  };
}

const wait = (ms = 2): Promise<void> => new Promise(r => setTimeout(r, ms));

test('tile service: computes once, saves, then answers from disk', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  let calls = 0;
  const svc = new TileService(
    store,
    async () => {
      calls++;
      await new Promise(r => setTimeout(r, 20));
      return { result: { v: 1 }, complete: true, stamp: STAMP_A };
    },
    () => STAMP_A
  );
  const [a, b] = await Promise.all([svc.get(T), svc.get(T)]);
  assert.equal(calls, 1, 'identical requests share one query');
  assert.equal(a.cached, false);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(b.gz).toString()), { v: 1 });
  const c = await svc.get(T);
  assert.equal(c.cached, true);
  assert.equal(calls, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('point answers: one computed from replaced data is never served; the request asks again', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-06z' });
  const args = { lat: 1, lon: 2, startMs: 3, maxCount: null };
  const p = h.svc.point('weather_point', args as never);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  assert.equal(h.calls.n, 1);
  // The forecast run swaps while the query is in flight, and the answer
  // names the replaced data (its stamp): never served. The request asks
  // again, and the worker answers from the data the plugin holds now.
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-12z' });
  h.held.stamp = STAMP_B;
  h.answer({ run: '06z' }, STAMP_A);
  // While the data the plugin holds is what the check saw, asking again
  // would only get the same answer: no query goes out.
  await wait(20);
  assert.equal(h.calls.n, 1, 'no second query while the data held is unchanged');
  h.svc.dataChanged(); // the worker's reload lands: the held data moved
  for (let i = 0; i < 500 && h.calls.n < 2; i++) await wait();
  h.answer({ run: '12z' }, STAMP_B);
  assert.deepEqual(await p, { run: '12z' });
  assert.equal(h.calls.n, 2, 'the replaced-data answer was discarded, one fresh query answered');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('point answers: one computed from the data the plugin holds now is served even when its generation changed while the query ran', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-06z' });
  const args = { lat: 1, lon: 2, startMs: 3, maxCount: null };
  const p = h.svc.point('weather_point', args as never);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  // The worker's refresh ran beside the query: it read the NEW run while
  // the request started under the old generation. The answer's stamp names
  // what the plugin holds now: served (and filed under the new generation),
  // not thrown away and computed again.
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-12z' });
  h.held.stamp = STAMP_B;
  h.answer({ run: '12z' }, STAMP_B);
  assert.deepEqual(await p, { run: '12z' });
  assert.equal(h.calls.n, 1, 'the answer was served, not recomputed');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('point answers: a requester of the newer data never joins a query of the older one', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-06z' });
  const args = { lat: 1, lon: 2, startMs: 3, maxCount: null };
  const p1 = h.svc.point('weather_point', args as never);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-12z' });
  h.held.stamp = STAMP_B;
  const p2 = h.svc.point('weather_point', args as never);
  for (let i = 0; i < 500 && h.svc.inflightCount < 2; i++) await wait();
  assert.equal(h.calls.n, 2, 'the newer data started its own query');
  h.answer({ run: '06z' }, STAMP_A); // resolves the first query: its answer names replaced data, its requester waits out the change
  await wait(20);
  h.svc.dataChanged(); // the held data moves: the first requester asks again
  for (let i = 0; i < 500 && h.calls.n < 3; i++) await wait();
  h.answer({ run: '12z' }, STAMP_B); // resolves the newer data's query
  h.answer({ run: '12z' }, STAMP_B); // resolves the first requester's retry
  assert.deepEqual(await p2, { run: '12z' });
  assert.deepEqual(await p1, { run: '12z' }, "the old query's requester was answered from the newer data");
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('point answers: a saved answer of a superseded generation is not served when the store changes mid-read', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-06z' });
  const args = { lat: 1, lon: 2, startMs: 3, maxCount: null };
  const k = { group: 'pt' as const, rel: 'weather_point/hash.gz' };
  await h.store.write(k, zlib.gzipSync(Buffer.from(JSON.stringify({ run: '06z' }))), h.store.generation('pt'));
  // A read that starts under run-06z and only gets its bytes after the swap:
  // the answer belongs to the old generation and must not be served. The
  // stub delegates every state-touching method to the real store, so both
  // see one truth; only `read` is slowed down.
  let midReadSwap = (): void => undefined;
  const current = { stamp: STAMP_A as DataStamp };
  const slow = Object.assign(Object.create(h.store), {
    read: async () => {
      // The path is computed at read start, under the generation the request captured.
      const f = h.store.file(k as never);
      await wait(20);
      midReadSwap();
      try {
        return await fs.promises.readFile(f!);
      } catch {
        return null;
      }
    },
    generation: (g: 'pt') => h.store.generation(g),
    setGenerations: (g: Record<TileGroup, string | null>) => h.store.setGenerations(g),
    file: (t: TileId | { group: TileGroup; rel: string }) => h.store.file(t as never),
    write: (t: TileId | { group: TileGroup; rel: string }, gz: Buffer, g: string | null) => h.store.write(t as never, gz, g),
    noteNotKept: (): void => h.store.noteNotKept(),
  });
  const svc = new TileService(
    slow as TileStore,
    async () => ({ result: { run: '12z' }, complete: true, stamp: STAMP_B }),
    () => current.stamp
  );
  midReadSwap = (): void => {
    svc.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-12z' });
    current.stamp = STAMP_B;
  };
  const p = svc.point('weather_point', args as never);
  assert.deepEqual(await p, { run: '12z' }, 'the old generation answer was discarded');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('point answers: the request keeps asking until an answer names the data held; there is no attempt cap', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-06z' });
  const args = { lat: 1, lon: 2, startMs: 3, maxCount: null };
  const p = h.svc.point('weather_point', args as never);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  // The data keeps changing under the request: every answer names replaced
  // data and is discarded. The worker always reads its newest data, which
  // changes hours apart: the loop ends when one answers from what the
  // plugin holds — no attempt count cuts it off.
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-12z' });
  h.held.stamp = STAMP_B;
  h.answer({ n: 1 }, STAMP_A);
  await wait(20);
  h.svc.dataChanged(); // the worker's reload lands: the held data moved
  for (let i = 0; i < 500 && h.calls.n < 2; i++) await wait();
  const STAMP_C: DataStamp = { ...STAMP_B, forecast: { cycleMs: Date.UTC(2026, 8, 29, 18), params: ['10u', '10v'] } };
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-18z' });
  h.held.stamp = STAMP_C;
  h.answer({ n: 2 }, STAMP_B);
  await wait(20);
  h.svc.dataChanged();
  for (let i = 0; i < 500 && h.calls.n < 3; i++) await wait();
  const STAMP_D: DataStamp = { ...STAMP_C, forecast: { cycleMs: Date.UTC(2026, 8, 30, 0), params: ['10u', '10v'] } };
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'run-00z' });
  h.held.stamp = STAMP_D;
  h.answer({ n: 3 }, STAMP_C);
  await wait(20);
  h.svc.dataChanged();
  for (let i = 0; i < 500 && h.calls.n < 4; i++) await wait();
  h.answer({ n: 4 }, STAMP_D);
  assert.deepEqual(await p, { n: 4 });
  assert.equal(h.calls.n, 4, 'asked until the answer named the data held, then stopped');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('tile service: a tile computed from replaced data is discarded and asked again', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'gen-06z', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const p = h.svc.get(T);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  h.store.setGenerations({ wx: 'gen-12z', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  h.held.stamp = STAMP_B;
  h.answer([1, 2, 3], STAMP_A);
  // While the data the plugin holds is what the check saw, asking again
  // would only get the same answer: no query goes out.
  await wait(20);
  assert.equal(h.calls.n, 1, 'no second query while the data held is unchanged');
  h.svc.dataChanged(); // the worker's reload lands: the held data moved
  for (let i = 0; i < 500 && h.calls.n < 2; i++) await wait();
  h.answer([4, 5, 6], STAMP_B);
  const { gz } = await p;
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gz).toString()), [4, 5, 6]);
  assert.equal(h.calls.n, 2);
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('stamp: a group is matched against the sources it is computed from, and only those the answer read', () => {
  const off: DataStamp = { forecast: null, smoc: null, rtofs: null, tide: null };
  // The land group: matched against nothing.
  assert.ok(stampMatches('land', STAMP_A, off), 'land has no stamped sources');
  // The weather group: the forecast part, when the answer read one.
  assert.ok(stampMatches('wx', STAMP_A, { ...STAMP_A }), 'same forecast: match');
  assert.ok(
    stampMatches('wx', STAMP_A, { ...STAMP_A, smoc: null, rtofs: null, tide: null }),
    'replaced current and tide sources do not touch wx'
  );
  assert.equal(stampMatches('wx', STAMP_A, { ...STAMP_A, forecast: STAMP_B.forecast }), false, 'another forecast run: mismatch');
  // The current group: the forecast when read (the current and arrows layers read none), SMOC and RTOFS strictly.
  assert.ok(stampMatches('cur', STAMP_A, { ...STAMP_A, tide: null }), 'tide is not part of cur');
  assert.ok(stampMatches('cur', STAMP_A, { ...STAMP_A, forecast: null }), 'an answer that read no forecast is not held to the loaded run');
  assert.equal(stampMatches('cur', STAMP_A, { ...STAMP_A, forecast: STAMP_B.forecast }), false, 'a read forecast must name the loaded run');
  assert.equal(
    stampMatches('cur', STAMP_A, { ...STAMP_A, smoc: { key: 'smoc-a', settled: false } }),
    false,
    'a settledness flip is a different run'
  );
  assert.equal(stampMatches('cur', STAMP_A, { ...STAMP_A, smoc: null }), false, 'no SMOC where the plugin has one: the answer lacked it');
  assert.equal(stampMatches('cur', STAMP_A, { ...STAMP_A, rtofs: 1 }), false, 'another RTOFS run: mismatch');
  // The tide group: only the tide part.
  assert.ok(stampMatches('tide', STAMP_A, { ...off, tide: STAMP_A.tide }), 'same tide run: match');
  assert.equal(stampMatches('tide', STAMP_A, off), false, 'no tide run where the plugin has one: mismatch');
  // The point group: everything the answer read.
  assert.ok(stampMatches('pt', STAMP_A, { ...STAMP_A }));
  assert.ok(stampMatches('pt', STAMP_A, { ...STAMP_A, forecast: null }), 'the tide series reads no forecast: accepted while one is loaded');
  assert.equal(stampMatches('pt', STAMP_A, { ...STAMP_A, tide: null }), false, 'no tide run where the plugin has one: mismatch');
  assert.equal(stampMatches('pt', off, off), true, 'nothing loaded, nothing read: match');
});

test('tile service: current and arrows tiles are accepted while a forecast is loaded (they read none)', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const cur: TileId = { layer: 'current', z: 6, x: 18, y: 23, hourMs: T.hourMs };
  const arr: TileId = { layer: 'arrows', z: 6, x: 18, y: 23, hourMs: T.hourMs };
  // The current colour layer and the current arrows read no forecast (their
  // kinds need none): their answers stamp no forecast and must be accepted
  // while one is loaded, not asked for again until the browser gives up.
  const p1 = h.svc.get(cur);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  h.answer([1], { ...STAMP_A, forecast: null });
  assert.deepEqual(JSON.parse(zlib.gunzipSync((await p1).gz).toString()), [1]);
  const p2 = h.svc.get(arr);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  const b = tileBBox(6, 18, 23);
  h.answer([{ lon: b.west, lat: b.south }], { ...STAMP_A, forecast: null });
  const pts = JSON.parse(zlib.gunzipSync((await p2).gz).toString()) as { lon: number }[];
  assert.equal(pts.length, 1, 'the arrows answer was served, not retried');
  assert.equal(h.calls.n, 2, 'each tile answered once, no retries');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('point answers: a tide series is accepted while a forecast is loaded (it reads none)', async () => {
  const h = handover();
  h.store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const args = { lat: 1, lon: 2, fromMs: 0, hours: 12 };
  const p = h.svc.point('tide_series', args as never);
  for (let i = 0; i < 500 && h.svc.inflightCount < 1; i++) await wait();
  // pointQuery passes no abort signal: a retry loop here would never end.
  h.answer({ waterLevel: [] }, { ...STAMP_A, forecast: null });
  assert.deepEqual(await p, { waterLevel: [] });
  assert.equal(h.calls.n, 1, 'answered once, no retries');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('tile service: an incomplete answer is served but not saved', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const svc = new TileService(
    store,
    async () => ({ result: [], complete: false, stamp: STAMP_A }),
    () => STAMP_A
  );
  assert.equal((await svc.get(T)).cached, false);
  assert.equal((await svc.get(T)).cached, false);
  assert.equal(store.stats().not_kept, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile service: the query is cancelled when every requester has gone', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  let seen: AbortSignal | undefined;
  const svc = new TileService(
    store,
    (_k, _a, signal) => {
      seen = signal;
      return new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(new Error('cancelled'))));
    },
    () => STAMP_A
  );
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = svc.get(T, c1.signal).catch(e => e as Error);
  const p2 = svc.get(T, c2.signal).catch(e => e as Error);
  // Both requesters must have missed the store and joined the one query before the first leaves.
  for (let i = 0; i < 500 && svc.waiters(T) < 2; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(svc.waiters(T), 2, 'both requesters joined the query');
  c1.abort();
  assert.equal(seen?.aborted, false, 'one requester is still waiting');
  c2.abort();
  assert.equal(seen?.aborted, true);
  assert.equal(((await p1) as Error).message, 'cancelled');
  assert.equal(((await p2) as Error).message, 'cancelled');
  assert.equal(svc.inflightCount, 0);
  // Gone before the query was sent: nothing is started.
  const c3 = new AbortController();
  c3.abort();
  seen = undefined;
  assert.equal(((await svc.get(T, c3.signal).catch(e => e as Error)) as Error).message, 'cancelled');
  assert.equal(seen, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: a new generation removes the old one; an answer from the old one is not saved', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g1 = store.generation('wx');
  await store.write(T, zlib.gzipSync('1'), g1);
  assert.ok(await store.has(T));
  store.setGenerations({ wx: 'b', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  assert.equal(await store.has(T), false);
  await store.write(T, zlib.gzipSync('1'), g1);
  assert.equal(await store.has(T), false, 'written under a superseded generation');
  for (let i = 0; i < 50 && fs.existsSync(path.join(root, g1 as string)); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(path.join(root, g1 as string)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: prunes least recently used tiles to 90 % of the cap', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = store.generation('wx');
  const body = Buffer.alloc(1000, 1);
  for (let i = 0; i < 10; i++) {
    const t = { ...T, x: i };
    await store.write(t, body, g);
    const when = new Date(Date.now() - (10 - i) * 60_000);
    fs.utimesSync(store.file(t) as string, when, when);
  }
  store.setCap(5000);
  await store.prune();
  const s = store.stats();
  assert.ok(s.bytes <= 4500, `bytes ${s.bytes}`);
  assert.equal(await store.has({ ...T, x: 0 }), false, 'oldest removed');
  assert.ok(await store.has({ ...T, x: 9 }), 'newest kept');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pyramid: full radius to zoom 8, halved deeper; nearest the centre first; wraps at the date line', async () => {
  const { pyramidTiles, pyramidRadius } = await import('./tiles');
  assert.equal(pyramidRadius(250_000, 6), 250_000);
  assert.equal(pyramidRadius(250_000, 8), 250_000);
  assert.equal(pyramidRadius(250_000, 10), 62_500);
  const z10 = pyramidTiles(41.2, -71.5, 250_000, 10);
  const c = tileAt(-71.5, 41.2, 10);
  assert.deepEqual(z10[0], c, 'centre tile first');
  // Every tile at zoom 10 lies within the 62.5 km box (plus one tile).
  const b = tileBBox(10, c.x, c.y);
  const w = b.east - b.west;
  for (const t of z10) assert.ok(Math.abs(t.x - c.x) * w < 62_500 / (111_320 * Math.cos((41.2 * Math.PI) / 180)) + w);
  const dl = pyramidTiles(0, 179.9, 250_000, 8);
  const n = 2 ** 8;
  assert.ok(dl.some(t => t.x === n - 1) && dl.some(t => t.x === 0), 'both sides of the date line');
  assert.ok(dl.every(t => t.x >= 0 && t.x < n));
});

test('tile store: an empty or non-gzip saved file is a miss and is removed (what a crash leaves behind)', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = store.generation('wx');
  await store.write(T, zlib.gzipSync('1'), g);
  const f = store.file(T) as string;
  fs.writeFileSync(f, Buffer.alloc(0));
  assert.equal(await store.read(T), null, 'empty file is a miss');
  for (let i = 0; i < 50 && fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(f), false, 'and it is removed');
  await store.write(T, zlib.gzipSync('1'), g);
  fs.writeFileSync(f, Buffer.from('not gzip at all, but long enough'));
  assert.equal(await store.read(T), null, 'a non-gzip file is a miss');
  await store.write(T, zlib.gzipSync('2'), g);
  const ok = await store.read(T);
  assert.ok(ok && zlib.gunzipSync(ok).toString() === '2', 'a real tile reads back');
  assert.equal(store.corrupt, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: totals are kept running, saved, and reloaded without a walk', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = store.generation('wx');
  // No saved totals: a count walk learns them (empty store: 0) and the first flush saves them.
  const totalsFile = path.join(root, '.totals.json');
  let counted = false;
  for (let i = 0; i < 500 && !counted; i++) {
    store.stats(); // starts the count when the totals are unknown
    await store.flushTotals();
    counted = fs.existsSync(totalsFile);
    if (!counted) await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(counted, 'initial count did not complete');
  const body = Buffer.alloc(1000, 1);
  // A tile written again replaces its file: counted once, bytes by the difference.
  await store.write({ ...T, x: 0 }, Buffer.alloc(400, 1), g);
  await store.write({ ...T, x: 0 }, body, g);
  assert.deepEqual([store.stats().files, store.stats().bytes], [1, 1000]);
  for (let i = 1; i < 5; i++) await store.write({ ...T, x: i }, body, g);
  assert.equal(store.stats().files, 5);
  assert.equal(store.stats().bytes, 5000);
  await store.flushTotals();
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.totals.json'), 'utf8')) as { files: number; bytes: number; savedAt: string };
  assert.equal(saved.files, 5);
  assert.equal(saved.bytes, 5000);
  // A new store on the same root answers from the saved totals at once.
  const again = new TileStore({ root, capBytes: 1e9 });
  assert.deepEqual([again.stats().files, again.stats().bytes], [5, 5000]);
  // A retired generation is subtracted, not forgotten.
  again.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  again.setGenerations({ wx: 'b', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  for (let i = 0; i < 100 && again.stats().files !== 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual([again.stats().files, again.stats().bytes], [0, 0]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: a root without saved totals is counted in the background', async () => {
  const root = tmp();
  const a = new TileStore({ root, capBytes: 1e9 });
  a.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = a.generation('wx');
  for (let i = 0; i < 3; i++) await a.write({ ...T, x: i }, Buffer.alloc(100, 1), g);
  fs.rmSync(path.join(root, '.totals.json'), { force: true });
  const b = new TileStore({ root, capBytes: 1e9 });
  assert.equal(b.stats().files, 0, 'unknown until counted');
  for (let i = 0; i < 100 && b.stats().files !== 3; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual([b.stats().files, b.stats().bytes], [3, 300]);
  fs.rmSync(root, { recursive: true, force: true });
});
