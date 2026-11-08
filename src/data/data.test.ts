import { mock, test } from 'node:test';
import { HOUR_S } from '../geo/units';
import assert from 'node:assert/strict';
import { availableSteps, cycleFor, ENSEMBLE_MEMBER_CHOICES, ENSEMBLE_MEMBER_MAX, ENSEMBLES } from './ecmwf';
import { buildStep, cropField, nanFillLimited, sampleField, ForecastStore, type FieldGrid } from './forecast';
import type { Grib2Grid, Grib2Message } from '../grib/grib2';

test('cycle naming and stream selection', () => {
  const c00 = cycleFor(new Date('2026-09-27T00:00:00Z'));
  assert.equal(c00.yyyymmdd, '20260927');
  assert.equal(c00.hh, '00');
  assert.equal(c00.atmStream, 'oper');
  assert.equal(c00.waveStream, 'wave');
  assert.equal(c00.maxStep, 360);
  // 06z/18z are published under oper/wave too, to 144 h (data.ecmwf.int, 2026-09-29).
  const c06 = cycleFor(new Date('2026-09-27T06:00:00Z'));
  assert.equal(c06.atmStream, 'oper');
  assert.equal(c06.waveStream, 'wave');
  assert.equal(c06.maxStep, 144);
});

test('the ensemble member choices are in fives up to the members each model has; the highest member number is theirs', () => {
  assert.deepEqual(
    Object.values(ENSEMBLES).map(m => [m.id, m.members]),
    [
      ['ifs-ens', 50],
      ['aifs-ens', 50],
    ]
  );
  assert.deepEqual([...ENSEMBLE_MEMBER_CHOICES], [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
  assert.equal(ENSEMBLE_MEMBER_MAX, 50, 'the highest member number: every schema and the record check read it');
});

test('published step lists', () => {
  const main = cycleFor(new Date('2026-09-27T00:00:00Z'));
  const short = cycleFor(new Date('2026-09-27T06:00:00Z'));
  assert.deepEqual(availableSteps(main, 12), [0, 3, 6, 9, 12]);
  const s = availableSteps(main, 360);
  assert.equal(s[s.length - 1], 360);
  assert.equal(s.length, 85, '0–144 every 3 h (49) + 150–360 every 6 h (36), as listed on data.ecmwf.int');
  assert.ok(s.includes(144) && s.includes(150) && !s.includes(147));
  const sc = availableSteps(short, 360);
  assert.equal(sc[sc.length - 1], 144);
  assert.equal(sc.length, 49);
});

// A tiny global-style grid: 0..359 by 1°, 90..-90 by 1°, scanning north→south like ECMWF.
function syntheticGrid(): { grid: Grib2Grid; values: Float64Array } {
  const ni = 360;
  const nj = 181;
  const grid: Grib2Grid = {
    ni,
    nj,
    la1: 90,
    lo1: 0,
    la2: -90,
    lo2: 359,
    di: 1,
    dj: 1,
    scanningMode: 0,
    jScansPositively: false,
    iScansPositively: true,
  };
  const values = new Float64Array(ni * nj);
  for (let r = 0; r < nj; r++) {
    for (let c = 0; c < ni; c++) {
      const lat = 90 - r;
      const lon = c;
      values[r * ni + c] = lat * 1000 + lon; // unique, linear in both axes
    }
  }
  return { grid, values };
}

test('cropField keeps the bbox slice with correct geo-referencing, including across the antimeridian', () => {
  const { grid, values } = syntheticGrid();
  const f = cropField(grid, values, { west: -75, south: 36, east: -65, north: 45 }, 1);
  // Rows run south → north in the crop.
  assert.equal(f.lat0, 35);
  assert.equal(f.dLat, 1);
  assert.equal(f.nLat, 12);
  assert.equal(f.lon0, -76);
  assert.equal(f.nLon, 13);
  // Value at (lat 40, lon -70): 40*1000 + 290 (lon -70 ≡ 290 in the 0..359 grid).
  assert.equal(sampleField(f, -70, 40), 40 * 1000 + 290);
  // Bilinear midpoint.
  assert.equal(sampleField(f, -70.5, 40.5), 40.5 * 1000 + 289.5);

  const g = cropField(grid, values, { west: 175, south: -5, east: -175, north: 5 }, 1);
  assert.equal(sampleField(g, 179, 0), 179);
  assert.equal(sampleField(g, -179, 0), 181);
  assert.equal(sampleField(g, 180, 2), 2 * 1000 + 180);
});

test('sampleField clamps outside the crop instead of extrapolating', () => {
  const f: FieldGrid = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2, values: Float32Array.from([0, 1, 2, 3]) };
  assert.equal(sampleField(f, 0.5, 0.5), 1.5);
  assert.equal(sampleField(f, 5, 5), 3);
  assert.equal(sampleField(f, -5, -5), 0);
});

test('nanFillLimited fills near valid cells and leaves distant NaN', () => {
  const v = new Float32Array(25).fill(NaN);
  v[12] = 10;
  const f: FieldGrid = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 5, nLon: 5, values: v };
  const g = nanFillLimited(f, 2);
  assert.equal(g.values[12], 10);
  assert.ok(Math.abs(g.values[13] - 5) < 1e-6); // distance 1 of max 2 → half weight
  assert.equal(g.values[0], 0); // corner: Euclidean 2.83 > 2 → fade 0 → 0
  assert.ok(Math.abs(g.values[6] - 10 * (1 - Math.SQRT2 / 2)) < 1e-6); // diagonal neighbour (row 1, col 1)
});

test('ForecastStore blends steps in time and reports wind FROM direction', () => {
  const mk = (u: number, _v: number): FieldGrid => ({
    lat0: 0,
    lon0: 0,
    dLat: 1,
    dLon: 1,
    nLat: 2,
    nLon: 2,
    values: Float32Array.from([u, u, u, u]),
  });
  const t0 = Date.UTC(2026, 0, 1, 0);
  const t1 = t0 + 3 * 3600_000;
  const steps = [
    {
      validMs: t0,
      stepHours: 0,
      fields: new Map([
        ['10u', mk(0, 0)],
        ['10v', mk(-10, 0)],
      ]),
    },
    {
      validMs: t1,
      stepHours: 3,
      fields: new Map([
        ['10u', mk(10, 0)],
        ['10v', mk(0, 0)],
      ]),
    },
  ];
  // Fix the v component grids: mk builds a constant field of its first arg.
  steps[0].fields.set('10v', { ...mk(-10, 0) });
  const store = new ForecastStore(steps, {
    cycleTime: new Date(t0),
    bbox: { west: 0, south: 0, east: 1, north: 1 },
    steps: [0, 3],
    params: ['10u', '10v'],
    loadedAt: new Date(),
  });
  // At t0: u=0, v=-10 → wind blowing south → FROM north (0°).
  const [s0, d0] = store.at(0.5, 0.5, new Date(t0));
  assert.ok(Math.abs(s0 - 10) < 1e-6);
  assert.ok(Math.abs(d0 - 0) < 1e-6);
  // At t1: u=10, v=0 → blowing east → FROM west (270°).
  const [s1, d1] = store.at(0.5, 0.5, new Date(t1));
  assert.ok(Math.abs(s1 - 10) < 1e-6);
  assert.ok(Math.abs(d1 - 270) < 1e-6);
  // Midway: components blend linearly → u=5, v=-5 → FROM 315°.
  const [sm, dm] = store.at(0.5, 0.5, new Date((t0 + t1) / 2));
  assert.ok(Math.abs(sm - Math.hypot(5, 5)) < 1e-6);
  assert.ok(Math.abs(dm - 315) < 1e-6);
  assert.equal(store.hasWaves, false);
  const ser = store.serialize();
  const back = ForecastStore.deserialize(ser);
  assert.equal(back.steps.length, 2);
  assert.ok(back.coversBBox({ west: 0, south: 0, east: 1, north: 1 }));
  assert.ok(!back.coversBBox({ west: 0, south: 0, east: 5, north: 1 }));
});

import * as os from 'node:os';
import * as fs from 'node:fs';
// The module object itself, to replace one of its functions in a test: a namespace import is read-only getters over it.
import nodeFs from 'node:fs';
import * as path from 'node:path';
import { EcmwfClient, latestExpectedCycle, nextCycle, parseRetryAfterMs, publishedAt } from './ecmwf';
import { isOffline } from './http';
import { resolveCycle } from './loader';
import { gribShell } from '../grib/grib2fixture';

test('latestExpectedCycle uses the measured publication times and skips short cycles for long horizons', () => {
  // 12z is published at 19:34Z.
  const c = latestExpectedCycle(new Date('2026-09-27T20:00:00Z'), 72 * HOUR_S);
  assert.equal(c.yyyymmdd + c.hh, '2026092712');
  assert.equal(latestExpectedCycle(new Date('2026-09-27T19:33:59Z'), 72 * HOUR_S).hh, '06');
  assert.equal(latestExpectedCycle(new Date('2026-09-27T19:34:00Z'), 72 * HOUR_S).hh, '12');
  // 06z is published at 12:27Z (387 min); 00z at 07:34Z (454 min).
  assert.equal(latestExpectedCycle(new Date('2026-09-27T12:00:00Z'), 72 * HOUR_S).hh, '00');
  assert.equal(latestExpectedCycle(new Date('2026-09-27T12:27:00Z'), 72 * HOUR_S).hh, '06');
  assert.equal(latestExpectedCycle(new Date('2026-09-27T07:33:00Z'), 72 * HOUR_S).hh, '18');
  // 06z (to 144 h) is fine for 72 and 144 h but not for 150 h → falls back to 00z.
  assert.equal(latestExpectedCycle(new Date('2026-09-27T14:00:00Z'), 72 * HOUR_S).hh, '06');
  assert.equal(latestExpectedCycle(new Date('2026-09-27T14:00:00Z'), 144 * HOUR_S).hh, '06');
  assert.equal(latestExpectedCycle(new Date('2026-09-27T14:00:00Z'), 150 * HOUR_S).hh, '00');
  // A horizon between two 3-hourly steps (110 h: last step 108 h) still lets 06z/18z qualify: they run to 144 h.
  assert.equal(latestExpectedCycle(new Date('2026-10-06T18:34:00Z'), 110 * HOUR_S).hh, '06');
  assert.equal(latestExpectedCycle(new Date('2026-10-06T01:00:00Z'), 110 * HOUR_S).hh, '18');
  assert.equal(latestExpectedCycle(new Date('2026-10-06T18:34:00Z'), 145 * HOUR_S).hh, '00');
});

test('publishedAt and nextCycle: the measured lags, and the 12 h ladder when the horizon needs 00z/12z', () => {
  assert.equal(publishedAt(cycleFor(new Date('2026-10-19T00:00:00Z'))).toISOString(), '2026-10-19T07:34:00.000Z');
  assert.equal(publishedAt(cycleFor(new Date('2026-10-18T18:00:00Z'))).toISOString(), '2026-10-19T00:27:00.000Z');
  const c12 = cycleFor(new Date('2026-10-18T12:00:00Z'));
  assert.equal(nextCycle(c12, 110 * HOUR_S).time.toISOString(), '2026-10-18T18:00:00.000Z');
  assert.equal(nextCycle(c12, 150 * HOUR_S).time.toISOString(), '2026-10-19T00:00:00.000Z');
});

test('resolveCycle with the connection already known down: the server is not asked, the cached cycle says why', async () => {
  const dir = tmpDir();
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    throw new Error('network must not be used');
  }) as unknown as typeof fetch;
  const client = new EcmwfClient({ baseUrl: 'https://x', fallbackUrls: [], cacheDir: dir, fetchImpl, sleepImpl: async () => undefined });
  const cached = cycleFor(new Date('2026-09-27T12:00:00Z'));
  for (const step of [0, 3, 6]) {
    for (const [stream, params] of [
      [cached.atmStream, ['10u', '10v', 'msl']],
      [cached.waveStream, ['swh', 'mwp', 'mwd']],
    ] as const) {
      for (const p of params) {
        const f = client.cachePath(cached, stream, step, p);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, gribShell());
      }
    }
  }
  const r = await resolveCycle(client, 6 * HOUR_S, { now: new Date('2026-09-28T03:00:00Z'), offline: 'no internet connection (test)' });
  assert.equal(n, 0);
  assert.equal(r.cycle.yyyymmdd + r.cycle.hh, '2026092712');
  assert.ok(r.fallback && r.fallback.includes('no internet connection (test)'), r.fallback);
  // Nothing cached either: the offline error itself.
  await assert.rejects(
    resolveCycle(new EcmwfClient({ baseUrl: 'https://x', fallbackUrls: [], cacheDir: tmpDir(), fetchImpl }), 6 * HOUR_S, {
      offline: 'no internet connection (test)',
    }),
    (e: unknown) => isOffline(e)
  );
});

test('EcmwfClient: no connection at all fails at once, with no retries and no other mirror', async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) });
  }) as unknown as typeof fetch;
  const client = new EcmwfClient({
    baseUrl: 'https://primary',
    fallbackUrls: ['https://secondary'],
    cacheDir: tmpDir(),
    fetchImpl,
    sleepImpl: async ms => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(client.stepPublished(cycleFor(new Date('2026-09-27T00:00:00Z')), 'oper', 0), (e: unknown) => isOffline(e));
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
  assert.equal(client.baseUrl, 'https://primary');
});

test('parseRetryAfterMs handles seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('30'), 30_000);
  const now = Date.parse('2026-09-27T20:00:00Z');
  assert.equal(parseRetryAfterMs('Sun, 27 Sep 2026 20:00:45 GMT', now), 45_000);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs('garbage'), null);
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-test-'));
}

test('EcmwfClient retries 429 with backoff, honours Retry-After, then falls back to the next mirror', async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://primary')) {
      return new Response('', { status: 429, headers: { 'retry-after': '5' } });
    }
    return new Response('{"param":"10u","step":"0","levtype":"sfc","_offset":0,"_length":4}\n', { status: 200 });
  }) as unknown as typeof fetch;
  const client = new EcmwfClient({
    baseUrl: 'https://primary',
    fallbackUrls: ['https://secondary'],
    cacheDir: tmpDir(),
    retries: 3,
    fetchImpl,
    sleepImpl: async ms => {
      sleeps.push(ms);
    },
  });
  const cycle = latestExpectedCycle(new Date('2026-09-27T20:00:00Z'), 24 * HOUR_S);
  const idx = await client.fetchIndex(cycle, 'oper', 0);
  assert.equal(idx.length, 1);
  assert.equal(calls.filter(c => c.startsWith('https://primary')).length, 3); // exhausted
  assert.equal(calls.filter(c => c.startsWith('https://secondary')).length, 1);
  assert.equal(sleeps.length, 2); // two backoffs on the primary
  assert.ok(sleeps[0] >= 5000 && sleeps[0] < 5600, `first backoff ${sleeps[0]} should honour Retry-After 5 s`);
  assert.equal(client.baseUrl, 'https://secondary'); // sticks for the session
});

test('EcmwfClient: a download slower than the timeout that keeps arriving is read whole; one fetch ends is retried, then failed', async () => {
  const cycle = cycleFor(new Date('2026-09-27T00:00:00Z'));
  const whole = gribShell(64);
  const rec = { param: '10u', step: '0', levtype: 'sfc', _offset: 0, _length: 64 };
  const client = (fetchImpl: typeof fetch) =>
    new EcmwfClient({
      baseUrl: 'https://x',
      fallbackUrls: [],
      cacheDir: tmpDir(),
      timeoutMs: 20,
      retries: 2,
      fetchImpl,
      sleepImpl: async () => undefined,
    });
  // The headers at once, then the body in four pieces 15 ms apart: 60 ms in all, three times the 20 ms timeout. As fetch
  // does, the request's signal aborting ends the body.
  const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Response(
      new ReadableStream({
        async start(c) {
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')), { once: true });
          for (let k = 0; k < 4 && !init?.signal?.aborted; k++) {
            await new Promise(r => setTimeout(r, 15));
            if (!init?.signal?.aborted) c.enqueue(whole.subarray(k * 16, (k + 1) * 16));
          }
          if (!init?.signal?.aborted) c.close();
        },
      }),
      { status: 206 }
    )) as unknown as typeof fetch;
  assert.deepEqual(await client(slow).fetchField(cycle, 'oper', 0, '10u', [rec]), whole, 'read to its end');
  // A body that stops arriving: fetch ends it (undici's body timeout, http.ts), and the attempt is retried.
  let calls = 0;
  const ended = (async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(whole.subarray(0, 16));
          setTimeout(() => c.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_BODY_TIMEOUT' } })), 5);
        },
      }),
      { status: 206 }
    );
  }) as unknown as typeof fetch;
  await assert.rejects(client(ended).fetchField(cycle, 'oper', 0, '10u', [rec]), /terminated/);
  assert.equal(calls, 2, 'retried as a failed connection, then failed');
});

test('EcmwfClient does not retry 404 and reports it', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const client = new EcmwfClient({
    baseUrl: 'https://x',
    fallbackUrls: [],
    cacheDir: tmpDir(),
    fetchImpl,
    sleepImpl: async () => undefined,
  });
  const cycle = latestExpectedCycle(new Date('2026-09-27T20:00:00Z'), 24 * HOUR_S);
  assert.equal(await client.stepPublished(cycle, 'oper', 0), false);
  assert.equal(n, 1);
});

test('resolveCycle uses a fully cached expected cycle without any network call', async () => {
  const dir = tmpDir();
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    throw new Error('network must not be used');
  }) as unknown as typeof fetch;
  const client = new EcmwfClient({ baseUrl: 'https://x', fallbackUrls: [], cacheDir: dir, fetchImpl, sleepImpl: async () => undefined });
  const now = new Date('2026-09-27T20:00:00Z');
  const expected = latestExpectedCycle(now, 6 * HOUR_S);
  // Fake a complete cache for +0/+3/+6 h: 3 atm params + 3 wave params per step.
  for (const step of [0, 3, 6]) {
    for (const [stream, params] of [
      [expected.atmStream, ['10u', '10v', 'msl']],
      [expected.waveStream, ['swh', 'mwp', 'mwd']],
    ] as const) {
      for (const p of params) {
        const f = client.cachePath(expected, stream, step, p);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, gribShell());
      }
    }
  }
  const r = await resolveCycle(client, 6 * HOUR_S, { now });
  assert.equal(r.fromCache, true);
  assert.equal(r.cycle.yyyymmdd + r.cycle.hh, expected.yyyymmdd + expected.hh);
  assert.equal(n, 0);
  // With the network down and only an older cached cycle, that cycle is used.
  const later = new Date(now.getTime() + 6 * 3600_000);
  const r2 = await resolveCycle(client, 6 * HOUR_S, { now: later });
  assert.equal(r2.fromCache, true);
  assert.ok(r2.fallback && r2.fallback.includes('using cached cycle'));
  assert.equal(r2.cycle.yyyymmdd + r2.cycle.hh, expected.yyyymmdd + expected.hh);
});

test('the cache gate (hasCached, the loader’s): a whole message is read with no network; one cut short is not cached and is fetched again', async () => {
  const dir = tmpDir();
  const cycle = cycleFor(new Date('2026-09-27T00:00:00Z'));
  const whole = gribShell(64);
  const rec = { param: '10u', step: '0', levtype: 'sfc', _offset: 0, _length: 64 };
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('.index')) return new Response(`${JSON.stringify(rec)}\n`, { status: 200 });
    return new Response(whole, { status: 206 });
  }) as unknown as typeof fetch;
  const client = new EcmwfClient({ baseUrl: 'https://x', fallbackUrls: [], cacheDir: dir, fetchImpl, sleepImpl: async () => undefined });
  const f = client.cachePath(cycle, 'oper', 0, '10u');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, whole);
  assert.equal(client.hasCached(cycle, 'oper', 0, '10u'), true);
  assert.equal(client.cycleFullyCached(cycle, 0, ['10u'], []), true);
  assert.deepEqual(await client.fetchField(cycle, 'oper', 0, '10u'), whole);
  assert.deepEqual(calls, [], 'a whole message needs no network');
  // The same file cut short on disk (a write that stopped): not a cached message, by the length the message itself
  // states, so the loader reads the index (loader.ts decodeSteps) and the message is fetched again.
  fs.writeFileSync(f, whole.subarray(0, 40));
  assert.equal(client.hasCached(cycle, 'oper', 0, '10u'), false);
  assert.equal(client.cycleFullyCached(cycle, 0, ['10u'], []), false);
  assert.deepEqual(await client.fetchField(cycle, 'oper', 0, '10u'), whole);
  assert.equal(calls.length, 2, 'the index and the message');
  assert.equal(fs.statSync(f).size, 64, 'written over');
});

test('a fetched message whose rename into the cache fails fails the fetch, unless a whole message is there', async () => {
  const dir = tmpDir();
  const cycle = cycleFor(new Date('2026-09-27T00:00:00Z'));
  const whole = gribShell(64);
  const rec = { param: '10u', step: '0', levtype: 'sfc', _offset: 0, _length: 64 };
  const fetchImpl = (async (url: string | URL | Request) =>
    String(url).endsWith('.index')
      ? new Response(`${JSON.stringify(rec)}\n`, { status: 200 })
      : new Response(whole, { status: 206 })) as unknown as typeof fetch;
  const client = new EcmwfClient({ baseUrl: 'https://x', fallbackUrls: [], cacheDir: dir, fetchImpl, sleepImpl: async () => undefined });
  const f = client.cachePath(cycle, 'oper', 0, '10u');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // A message cut short on disk, and a rename over it that fails (Windows: a reader holding the file open).
  fs.writeFileSync(f, whole.subarray(0, 40));
  const busy = (): never => {
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  };
  const rename = mock.method(nodeFs, 'renameSync', busy);
  try {
    await assert.rejects(client.fetchField(cycle, 'oper', 0, '10u'), /EPERM/);
    assert.equal(fs.statSync(f).size, 40, 'the cut-short file is left, and said');
    assert.deepEqual(fs.readdirSync(path.dirname(f)), [path.basename(f)], 'no temporary file left');
    // Another writer put the whole message in place meanwhile: that is this fetch's answer.
    rename.mock.mockImplementation((...a: unknown[]) => {
      fs.writeFileSync(f, whole);
      fs.rmSync(String(a[0]));
      busy();
    });
    assert.deepEqual(await client.fetchField(cycle, 'oper', 0, '10u'), whole);
  } finally {
    rename.mock.restore();
  }
});

test('a fetched message whose write into the cache fails (a full disk) fails the fetch and leaves no partial copy', async () => {
  const dir = tmpDir();
  const cycle = cycleFor(new Date('2026-09-27T00:00:00Z'));
  const whole = gribShell(64);
  const rec = { param: '10u', step: '0', levtype: 'sfc', _offset: 0, _length: 64 };
  const fetchImpl = (async (url: string | URL | Request) =>
    String(url).endsWith('.index')
      ? new Response(`${JSON.stringify(rec)}\n`, { status: 200 })
      : new Response(whole, { status: 206 })) as unknown as typeof fetch;
  const client = new EcmwfClient({ baseUrl: 'https://x', fallbackUrls: [], cacheDir: dir, fetchImpl, sleepImpl: async () => undefined });
  const f = client.cachePath(cycle, 'oper', 0, '10u');
  const write = nodeFs.writeFileSync;
  // The temporary copy cut short by a full disk: part of it written, then the error.
  const full = mock.method(nodeFs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: Uint8Array) => {
    write(file, data.subarray(0, 10));
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
  try {
    await assert.rejects(client.fetchField(cycle, 'oper', 0, '10u'), /ENOSPC/);
  } finally {
    full.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(path.dirname(f)), [], 'no partial copy left, and no message cached');
});

test('buildStep converts tprate from kg m⁻² s⁻¹ to a depth rate in m/s at ingestion', () => {
  const { grid, values } = syntheticGrid();
  const ref = new Date('2026-09-27T00:00:00Z');
  const msg = (p: string) => ({
    param: p,
    message: { grid, referenceTime: ref, product: { forecastHours: 3 }, decode: () => values } as unknown as Grib2Message,
  });
  const step = buildStep([msg('10u'), msg('10v'), msg('tprate')], { west: -75, south: 36, east: -65, north: 45 });
  const raw = sampleField(step.fields.get('10u')!, -70, 40);
  const rate = sampleField(step.fields.get('tprate')!, -70, 40);
  assert.equal(raw, 40 * 1000 + 290);
  assert.ok(Math.abs(rate - raw * 1e-3) < 1e-6, `got ${rate}`);
});
