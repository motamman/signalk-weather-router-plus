/**
 * Decoded runs on disk: file format round trip (bit for bit, NaN
 * included), atomic completeness, pruning, row-range window reads, and
 * sample-for-sample agreement of windows (map views, point series, route
 * corridors) with the whole in-memory global store they replace. The
 * streaming decoder must write exactly the fields the whole-store
 * decoder builds (real ECMWF messages).
 */

import { test } from 'node:test';
import { HOUR_S } from '../geo/units';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { iterateGrib2 } from '../grib/grib2';
import { ForecastStore, GLOBAL_BBOX, sampleField, type FieldGrid, type ForecastStep } from './forecast';
import { DecodedRunWriter, fieldFile, listDecodedRuns, openDecodedRun, pruneDecodedRuns, INDEX_FILE, type DecodedRun } from './decoded';
import { decodeForecastToDisk, loadGlobalForecast } from './loader';
import { cycleFor, type EcmwfClient } from './ecmwf';
import { conditionsSeries, fieldGrid, pressureFeatures, windPoints, type OverlaySources } from '../plugin/overlays';
import { pointForecasts } from '../plugin/weather';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-decoded-'));
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PARAMS = ['10u', '10v', 'msl', '2t', 'tprate', 'skt', '2d', 'ptype', 'tcc', '10fg', 'swh', 'mwp', 'mwd'];
const T0 = Date.UTC(2026, 8, 28, 12);

/**
 * A synthetic global store on a 1° wrapping grid (360 × 181, pole to
 * pole, the same geometry rules as ECMWF's 0.25°): smooth fields with
 * noise, NaN "land" blocks in the wave fields, -0 and integer codes.
 */
function syntheticStore(nSteps = 5, params: readonly string[] = PARAMS): ForecastStore {
  const nLon = 360;
  const nLat = 181;
  const rand = rng(7);
  const steps: ForecastStep[] = [];
  for (let k = 0; k < nSteps; k++) {
    const fields = new Map<string, FieldGrid>();
    params.forEach((p, pi) => {
      const v = new Float32Array(nLon * nLat);
      for (let r = 0; r < nLat; r++) {
        for (let c = 0; c < nLon; c++) {
          const i = r * nLon + c;
          const base = Math.sin((c + 13 * pi) * 0.07 + k * 0.3) * Math.cos((r - 90) * 0.05) * 10 + rand() * 0.5;
          if (p === 'ptype') v[i] = Math.floor(rand() * 8);
          else if (p === 'msl') v[i] = 101300 + base * 100;
          else if (p === 'mwd') v[i] = (base * 36 + 360) % 360;
          else v[i] = p === 'swh' || p === 'mwp' ? Math.abs(base) : base;
          if (
            (p === 'swh' || p === 'mwp' || p === 'mwd') &&
            ((c > 100 && c < 140 && r > 60 && r < 120) || (c < 5 && r > 80 && r < 95) || c > 354)
          )
            v[i] = NaN;
        }
      }
      v[pi] = -0;
      fields.set(p, { lat0: -90, lon0: -180, dLat: 1, dLon: 1, nLat, nLon, values: v, wrapLon: true });
    });
    steps.push({ validMs: T0 + k * 3 * 3600_000, stepHours: k * 3, fields });
  }
  return new ForecastStore(steps, {
    cycleTime: new Date(T0),
    bbox: GLOBAL_BBOX,
    steps: steps.map(s => s.stepHours),
    params: PARAMS,
    loadedAt: new Date(T0),
  });
}

function writeRun(root: string, store: ForecastStore, cycle = '2026092812'): DecodedRun {
  const w = new DecodedRunWriter(root, cycle);
  for (const s of store.steps) w.writeStep(s);
  w.finish({
    cycleTimeMs: store.meta.cycleTime.getTime(),
    request: { horizonHours: 12, params: PARAMS },
    stepHours: store.meta.steps,
    decodeMs: 1,
  });
  const { run, problem } = openDecodedRun(w.finalDir);
  assert.ok(run, problem ?? '');
  return run!;
}

test('file format: raw Float32 rows from the south, bit for bit (NaN and -0 kept); window(null) returns the same store', async () => {
  const root = tmpDir();
  const store = syntheticStore();
  const run = writeRun(root, store);
  assert.equal(run.index.bytes, 5 * PARAMS.length * 360 * 181 * 4);
  assert.deepEqual(run.index.grid, { lat0: -90, lon0: -180, dLat: 1, dLon: 1, nLat: 181, nLon: 360, wrapLon: true });
  for (const s of store.steps) {
    for (const [p, f] of s.fields) {
      const raw = fs.readFileSync(path.join(run.dir, fieldFile(s.stepHours, p)));
      assert.equal(raw.length, f.values.byteLength);
      assert.ok(Buffer.from(f.values.buffer, f.values.byteOffset, f.values.byteLength).equals(raw), `${p} +${s.stepHours}h bytes`);
    }
  }
  const back = await run.window({ bbox: null, params: PARAMS });
  assert.equal(back.steps.length, store.steps.length);
  let nan = 0;
  for (let k = 0; k < store.steps.length; k++) {
    for (const p of PARAMS) {
      const a = store.steps[k].fields.get(p)!.values;
      const b = back.steps[k].fields.get(p)!.values;
      for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) assert.fail(`${p} step ${k} cell ${i}: ${a[i]} vs ${b[i]}`);
        if (Number.isNaN(a[i])) nan++;
      }
    }
  }
  assert.ok(nan > 1000, 'the wave fields carried NaN through');
  fs.rmSync(root, { recursive: true, force: true });
});

test('atomic completeness: nothing looks complete until finish(); damaged runs are refused', () => {
  const root = tmpDir();
  const store = syntheticStore(2);
  const w = new DecodedRunWriter(root, '2026092800');
  w.writeStep(store.steps[0]);
  // Mid-write (or after a crash): only a .tmp directory exists.
  assert.equal(fs.existsSync(w.finalDir), false);
  assert.deepEqual(listDecodedRuns(root), []);
  assert.match(openDecodedRun(w.finalDir).problem!, /no readable index\.json/);
  assert.match(openDecodedRun(w.tmpDir).problem!, /no readable index\.json/);
  w.abort();
  assert.equal(fs.existsSync(w.tmpDir), false);
  // A finished run, then damaged three ways.
  const run = writeRun(root, store, '2026092806');
  const file = path.join(run.dir, fieldFile(3, 'swh'));
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, good.subarray(0, good.length - 4));
  assert.match(openDecodedRun(run.dir).problem!, /003-swh\.f32 is \d+ B, expected/);
  fs.rmSync(file);
  assert.match(openDecodedRun(run.dir).problem!, /003-swh\.f32 is missing/);
  fs.writeFileSync(file, good);
  assert.equal(openDecodedRun(run.dir).problem, null);
  const ix = JSON.parse(fs.readFileSync(path.join(run.dir, INDEX_FILE), 'utf8'));
  fs.writeFileSync(path.join(run.dir, INDEX_FILE), JSON.stringify({ ...ix, complete: false }));
  assert.match(openDecodedRun(run.dir).problem!, /not marked complete/);
  fs.writeFileSync(path.join(run.dir, INDEX_FILE), JSON.stringify({ ...ix, version: 99 }));
  assert.match(openDecodedRun(run.dir).problem!, /format/);
  // Re-writing the same cycle replaces it in one rename.
  const again = writeRun(root, store, '2026092806');
  assert.equal(openDecodedRun(again.dir).problem, null);
  assert.deepEqual(fs.readdirSync(root).sort(), ['2026092806']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pruning keeps the named runs and removes older runs and interrupted writes', () => {
  const root = tmpDir();
  const store = syntheticStore(1);
  for (const c of ['2026092700', '2026092712', '2026092800', '2026092812']) writeRun(root, store, c);
  const active = new DecodedRunWriter(root, '2026092900');
  fs.mkdirSync(path.join(root, '.tmp-2026092818-1-x'));
  fs.mkdirSync(path.join(root, '.old-2026092800-1-y'));
  const removed = pruneDecodedRuns(root, ['2026092812', '2026092806'], active.tmpDir).sort();
  assert.deepEqual(removed, ['.old-2026092800-1-y', '.tmp-2026092818-1-x', '2026092700', '2026092712', '2026092800']);
  assert.deepEqual(listDecodedRuns(root), ['2026092812']);
  assert.ok(fs.existsSync(active.tmpDir), 'the write in progress is left alone');
  active.abort();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Boxes exercising the antimeridian, the grid's lon0 seam, both poles and a near-global view. */
const BOXES = [
  { west: -75, south: 30, east: -60, north: 45 },
  { west: 170, south: -20, east: -170, north: 5 },
  { west: -185, south: 10, east: -175, north: 20 },
  { west: 350, south: 40, east: 365, north: 55 },
  { west: -30, south: 80, east: 30, north: 90 },
  { west: 100, south: -90, east: 140, north: -70 },
  { west: -170, south: -60, east: 170, north: 60 },
];

test('bbox window reads: each cell equals the global field at its row/column (row preads, column wrap)', async () => {
  const root = tmpDir();
  const store = syntheticStore(3);
  const run = writeRun(root, store);
  for (const bbox of BOXES) {
    const win = await run.window({ bbox, params: ['msl', 'swh'], steps: [1, 2], marginCells: 2 });
    assert.equal(win.steps.length, 2);
    for (let k = 0; k < 2; k++) {
      for (const p of ['msl', 'swh']) {
        const g = store.steps[k + 1].fields.get(p)!;
        const f = win.steps[k].fields.get(p)!;
        const w = f.win!;
        assert.ok(w.nr <= 181 && w.nc <= 360);
        assert.equal(f.values.length, w.nr * w.nc);
        for (let r = 0; r < w.nr; r++) {
          for (let c = 0; c < w.nc; c++) {
            const want = g.values[(w.r0 + r) * 360 + ((w.c0 + c) % 360)];
            if (!Object.is(f.values[r * w.nc + c], want)) assert.fail(`${JSON.stringify(bbox)} ${p} r${r} c${c}`);
          }
        }
      }
    }
    // Every point of the box is covered.
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const width = (((bbox.east - bbox.west) % 360) + 360) % 360 || 360;
        assert.ok(
          win.covers(bbox.west + (width * i) / 10, bbox.south + ((bbox.north - bbox.south) * j) / 10),
          `${JSON.stringify(bbox)} covers ${i},${j}`
        );
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function randomPointIn(b: { west: number; south: number; east: number; north: number }, r: () => number): [number, number] {
  const width = (((b.east - b.west) % 360) + 360) % 360 || 360;
  return [b.west + r() * width, b.south + r() * (b.north - b.south)];
}

test('route corridor store: at / atMany / wavesAt / mslAt / paramAt identical to the whole store at every sampled point and time', async () => {
  const root = tmpDir();
  const store = syntheticStore(5);
  const run = writeRun(root, store);
  const r = rng(99);
  for (const bbox of BOXES) {
    const corridor = await run.window({ bbox, params: ['10u', '10v', 'swh', 'mwp', 'mwd', 'msl', 'ptype'], marginCells: 1 });
    const lons = new Float64Array(200);
    const lats = new Float64Array(200);
    for (let n = 0; n < 200; n++) [lons[n], lats[n]] = randomPointIn(bbox, r);
    for (const tOff of [-3600_000, 0, 1, 4000_000, 3 * 3600_000, 5.5 * 3600_000, 12 * 3600_000, 20 * 3600_000]) {
      const t = new Date(T0 + tOff);
      const a = store.atMany(lons, lats, t);
      const b = corridor.atMany(lons, lats, t);
      for (let n = 0; n < 200; n++) {
        assert.ok(Object.is(a.speed[n], b.speed[n]) && Object.is(a.dir[n], b.dir[n]), `atMany ${lons[n]},${lats[n]}`);
        assert.deepEqual(corridor.at(lons[n], lats[n], t), store.at(lons[n], lats[n], t));
        assert.deepEqual(corridor.wavesAt(lons[n], lats[n], t), store.wavesAt(lons[n], lats[n], t));
        assert.ok(Object.is(corridor.mslAt(lons[n], lats[n], t), store.mslAt(lons[n], lats[n], t)));
        assert.ok(Object.is(corridor.paramAt('ptype', lons[n], lats[n], t), store.paramAt('ptype', lons[n], lats[n], t)));
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('point series (conditions, Weather API) from a few cells × all steps equal the whole store', async () => {
  const root = tmpDir();
  const store = syntheticStore(5);
  const run = writeRun(root, store);
  const src = (f: ForecastStore): OverlaySources => ({ forecast: f, currents: null, land: null, tides: null });
  for (const [lon, lat] of [
    [-71.3, 41.4],
    [179.9, -10.2],
    [-179.95, 10.5],
    [359.7, 50.1],
    [0, 0],
    [12.5, 89.9],
    [-60, -89.6],
    [120.25, 33.75],
  ]) {
    const pt = await run.window({ bbox: { west: lon, east: lon, south: lat, north: lat }, params: PARAMS, marginCells: 2 });
    assert.ok(pt.bytes() <= 5 * PARAMS.length * 6 * 6 * 4, `a few cells only (${pt.bytes()} B)`);
    const a = conditionsSeries(src(store), lon, lat, new Date(T0 - 3600_000), 14, 1);
    const b = conditionsSeries(src(pt), lon, lat, new Date(T0 - 3600_000), 14, 1);
    assert.deepEqual(b, a);
    assert.deepEqual(pointForecasts(pt, lon, lat, T0, null), pointForecasts(store, lon, lat, T0, null));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('map windows (two bracketing steps): field grids, wind arrows and isobars equal the whole store', async () => {
  const root = tmpDir();
  const store = syntheticStore(5);
  const run = writeRun(root, store);
  const src = (f: ForecastStore): OverlaySources => ({ forecast: f, currents: null, land: null, tides: null });
  const layers: [string, string[]][] = [
    ['wind', ['10u', '10v']],
    ['waves', ['swh', 'mwp', 'mwd']],
    ['msl', ['msl']],
    ['precip', ['tprate', 'ptype']],
    ['sea_state', ['10u', '10v', 'swh', 'mwp', 'mwd']],
  ];
  for (const bbox of BOXES.slice(0, 5)) {
    for (const tOff of [0, 4000_000, 12 * 3600_000]) {
      const t = new Date(T0 + tOff);
      const steps = run.bracket(t.getTime());
      for (const [layer, params] of layers) {
        const win = await run.window({ bbox, params, steps, marginCells: 2 });
        assert.deepEqual(
          fieldGrid(src(win), layer as 'wind', bbox, t, 1),
          fieldGrid(src(store), layer as 'wind', bbox, t, 1),
          `${layer} ${JSON.stringify(bbox)}`
        );
      }
      const w = await run.window({ bbox, params: ['10u', '10v'], steps, marginCells: 2 });
      assert.deepEqual(windPoints(src(w), bbox, t, 2), windPoints(src(store), bbox, t, 2));
      const m = await run.window({ bbox, params: ['msl'], steps, marginCells: 10 });
      assert.deepEqual(pressureFeatures(src(m), bbox, t, 4), pressureFeatures(src(store), bbox, t, 4));
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('window sampling equals sampleField on the whole field for random points (real 0.25° ECMWF fields)', async () => {
  const fixture = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.grib2');
  const bytes = new Uint8Array(fs.readFileSync(fixture));
  const msgs = [...iterateGrib2(bytes)];
  const client = fakeClient(bytes, msgs);
  const cycle = cycleFor(msgs[0].referenceTime);
  const store = await loadGlobalForecast(client, { horizonS: 6 * HOUR_S, cycle, includeWaves: false });
  const root = tmpDir();
  const w = new DecodedRunWriter(root, 'x');
  for (const s of store.steps) w.writeStep(s);
  w.finish({ cycleTimeMs: cycle.time.getTime(), request: { horizonHours: 6, params: ['10u', '10v'] }, stepHours: [0, 3, 6], decodeMs: 0 });
  const run = openDecodedRun(w.finalDir).run!;
  const r = rng(5);
  for (const bbox of BOXES) {
    const win = await run.window({ bbox, params: ['10u', '10v'], marginCells: 1 });
    for (let n = 0; n < 500; n++) {
      const [lon, lat] = randomPointIn(bbox, r);
      for (let k = 0; k < 3; k++) {
        const a = sampleField(store.steps[k].fields.get('10u')!, lon, lat);
        const b = sampleField(win.steps[k].fields.get('10u')!, lon, lat);
        if (!Object.is(a, b)) assert.fail(`${lon},${lat} step ${k}: ${a} vs ${b}`);
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** An EcmwfClient stand-in serving the fixture's messages as if cached (10u/10v only; msl absent). */
function fakeClient(bytes: Uint8Array, msgs: ReturnType<typeof iterateGrib2> extends Iterable<infer M> ? M[] : never): EcmwfClient {
  const byKey = new Map<string, Uint8Array>();
  for (const m of msgs)
    byKey.set(`${m.product.forecastHours}-${m.product.parameterNumber === 2 ? '10u' : '10v'}`, bytes.slice(m.offset, m.offset + m.length));
  return {
    hasCached: (_c: unknown, _s: string, step: number, p: string) => byKey.has(`${step}-${p}`),
    fetchIndex: async () => [],
    fetchField: async (_c: unknown, _s: string, step: number, p: string) => byKey.get(`${step}-${p}`) ?? null,
  } as unknown as EcmwfClient;
}

test('streaming decode writes exactly the fields the whole-store decode builds (real ECMWF messages)', async () => {
  const fixture = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.grib2');
  const bytes = new Uint8Array(fs.readFileSync(fixture));
  const msgs = [...iterateGrib2(bytes)];
  const client = fakeClient(bytes, msgs);
  const cycle = cycleFor(msgs[0].referenceTime);
  const store = await loadGlobalForecast(client, { horizonS: 6 * HOUR_S, cycle, includeWaves: false });
  const root = tmpDir();
  const writer = new DecodedRunWriter(root, `${cycle.yyyymmdd}${cycle.hh}`);
  const out = await decodeForecastToDisk(client, writer, { horizonS: 6 * HOUR_S, cycle, includeWaves: false });
  // One step's block (3 atmosphere params requested; msl is absent from the fixture), not the whole store.
  assert.equal(out.stepBlockBytes, 3 * 1440 * 721 * 4);
  assert.deepEqual(out.index.stepHours, [0, 3, 6]);
  assert.deepEqual(
    out.index.steps.map(s => s.params),
    [
      ['10u', '10v'],
      ['10u', '10v'],
      ['10u', '10v'],
    ]
  );
  assert.deepEqual(out.index.request.params, store.meta.params);
  for (const s of store.steps) {
    for (const [p, f] of s.fields) {
      const raw = fs.readFileSync(path.join(writer.finalDir, fieldFile(s.stepHours, p)));
      assert.ok(Buffer.from(f.values.buffer, f.values.byteOffset, f.values.byteLength).equals(raw), `${p} +${s.stepHours}h identical`);
    }
  }
  assert.equal(openDecodedRun(writer.finalDir).problem, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Weather API: an observation is one entry interpolated to its time, and surface current comes from the current sources where they cover the point', async () => {
  const store = syntheticStore(5);
  const lon = -71.3;
  const lat = 41.4;
  // Halfway between the first two steps.
  const s0 = store.steps[0].validMs;
  const s1 = store.steps[1].validMs;
  const mid = (s0 + s1) / 2;
  const [obs] = pointForecasts(store, lon, lat, mid, null, { observation: true });
  assert.equal(obs.type, 'observation');
  assert.equal(obs.date, new Date(mid).toISOString());
  const [ws, wd] = store.at(lon, lat, new Date(mid));
  assert.equal(obs.wind?.speedTrue, ws);
  assert.equal(obs.wind?.directionTrue, (wd * Math.PI) / 180);
  // Cloud cover and gust map from the extra fields, sampled like every other field.
  assert.equal(obs.outside?.cloudCover, store.paramAt('tcc', lon, lat, new Date(mid)));
  assert.equal(obs.wind?.gust, store.paramAt('10fg', lon, lat, new Date(mid)));
  assert.equal(obs.water?.surfaceCurrentSpeed, undefined, 'no current source: no current fields');
  // A current source covering the point: u east 0.3, v north 0.4 → 0.5 m/s towards 036.87°.
  const currents = {
    contains: (x: number, y: number) => Math.abs(x - lon) < 1 && Math.abs(y - lat) < 1,
    at: (): [number, number] => [0.3, 0.4],
  };
  const [withCur] = pointForecasts(store, lon, lat, mid, null, { observation: true, currents });
  assert.ok(Math.abs((withCur.water?.surfaceCurrentSpeed ?? 0) - 0.5) < 1e-12);
  assert.ok(Math.abs((withCur.water?.surfaceCurrentDirection ?? 0) - Math.atan2(0.3, 0.4)) < 1e-12);
  // Point forecasts carry the same current fields; outside the source's area they are left out.
  const steps = pointForecasts(store, lon, lat, s0, 2, { currents });
  assert.equal(steps.length, 2);
  assert.equal(steps[0].type, 'point');
  assert.ok(Math.abs((steps[0].water?.surfaceCurrentSpeed ?? 0) - 0.5) < 1e-12);
  const far = pointForecasts(store, lon + 5, lat, s0, 1, { currents });
  assert.equal(far[0].water?.surfaceCurrentSpeed, undefined);
});

test('Weather API: cloud cover and gust are extra fields; a run decoded without them leaves the fields out', async () => {
  const withExtras = syntheticStore(2);
  const lon = -71.3;
  const lat = 41.4;
  const s0 = withExtras.steps[0].validMs;
  const [item] = pointForecasts(withExtras, lon, lat, s0, 1);
  assert.equal(item.outside?.cloudCover, withExtras.paramAt('tcc', lon, lat, new Date(s0)));
  assert.equal(item.wind?.gust, withExtras.paramAt('10fg', lon, lat, new Date(s0)));

  // extraFields off: the decoded run holds none of the two, and the fields vanish
  // while everything else keeps coming.
  const base = syntheticStore(
    2,
    PARAMS.filter(p => p !== 'tcc' && p !== '10fg')
  );
  const [bare] = pointForecasts(base, lon, lat, s0, 1);
  assert.equal(bare.outside?.cloudCover, undefined);
  assert.equal(bare.wind?.gust, undefined);
  assert.notEqual(bare.outside?.temperature, undefined);
  assert.notEqual(bare.wind?.speedTrue, undefined);
});
