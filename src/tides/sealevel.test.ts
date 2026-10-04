import { test } from 'node:test';
import { HOUR_S } from '../geo/units';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findExtrema,
  MIN_PROMINENCE_M,
  mslOffset,
  derivedLevels,
  parabolicVertex,
  sampleSeries,
  signalKTendency,
  slopeAt,
  STEADY_RATE_MS,
  tendencyOf,
  tidalRanges,
} from './tidecalc';
import {
  MEAN_WINDOW_DAYS,
  pointTimePlan,
  SeaLevelClient,
  SL_VARS,
  TideSource,
  tideRowAt,
  tideSummary,
  loadTideResident,
  type TidePointSeries,
} from './sealevel';
import { parseConsolidated } from '../data/zarr';
import type { ArcoRun } from '../data/arco';
import { conditionsSeries, fieldGrid, type OverlaySources } from '../plugin/overlays';
import { applyWaterLevel, makeWeatherProvider, pointForecasts, startMsOf, type WeatherData, type PointForecastFn } from '../plugin/weather';
import type { ForecastStore } from '../data/forecast';

const H = 3600_000;
const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-tides-'));

// ───────────── tidecalc: synthetic series ─────────────

const M2 = (2 * Math.PI) / (12.4206012 * H);
const S2 = (2 * Math.PI) / (12 * H);
const K1 = (2 * Math.PI) / (23.9344697 * H);

function hourly(t0: number, n: number, f: (t: number) => number): { t0Ms: number; stepMs: number; values: Float64Array } {
  const v = new Float64Array(n);
  for (let k = 0; k < n; k++) v[k] = f(t0 + k * H);
  return { t0Ms: t0, stepMs: H, values: v };
}

/** Extrema of f by dense (10 s) sampling: the truth for the parabolic refinement. */
function denseExtrema(f: (t: number) => number, a: number, b: number): { kind: 'high' | 'low'; timeMs: number; height: number }[] {
  const out: { kind: 'high' | 'low'; timeMs: number; height: number }[] = [];
  const dt = 10_000;
  for (let t = a + dt; t < b - dt; t += dt) {
    const y0 = f(t - dt);
    const y1 = f(t);
    const y2 = f(t + dt);
    if (y1 > y0 && y1 >= y2) out.push({ kind: 'high', timeMs: t, height: y1 });
    if (y1 < y0 && y1 <= y2) out.push({ kind: 'low', timeMs: t, height: y1 });
  }
  return out;
}

test('tidecalc: parabolic vertex is exact for a parabola and close for a cosine', () => {
  const p = (x: number): number => 2 - 0.7 * (x - 0.3) ** 2;
  const v = parabolicVertex(p(-1), p(0), p(1));
  assert.ok(Math.abs(v.dt - 0.3) < 1e-12 && Math.abs(v.h - 2) < 1e-12);
  assert.deepEqual(parabolicVertex(1, 1, 1), { dt: 0, h: 1 });
});

test('tidecalc: high / low waters of a mixed tide match dense sampling (times within 6 min, heights within 1 cm)', () => {
  const t0 = Date.UTC(2026, 8, 28, 0, 17);
  const f = (t: number): number => 1.2 * Math.cos(M2 * t + 0.4) + 0.35 * Math.cos(S2 * t - 1.1) + 0.3 * Math.cos(K1 * t + 2.0);
  const s = hourly(t0, 96, f);
  const got = findExtrema(s);
  const truth = denseExtrema(f, t0 + H, t0 + 95 * H);
  assert.equal(got.length, truth.length);
  for (let i = 0; i < got.length; i++) {
    assert.equal(got[i].kind, truth[i].kind);
    assert.ok(Math.abs(got[i].timeMs - truth[i].timeMs) < 6 * 60_000, `extremum ${i}: ${(got[i].timeMs - truth[i].timeMs) / 60_000} min`);
    assert.ok(Math.abs(got[i].height - truth[i].height) < 0.01, `extremum ${i}: ${got[i].height} vs ${truth[i].height}`);
  }
  // Alternating, and the ranges are the consecutive differences.
  for (let i = 1; i < got.length; i++) assert.notEqual(got[i].kind, got[i - 1].kind);
  const r = tidalRanges(got);
  assert.equal(r.length, got.length - 1);
  assert.ok(Math.abs(r[0] - Math.abs(got[0].height - got[1].height)) < 1e-12);
  // A pure M2 cosine: every extremum within 3 min and 0.5 % of the amplitude.
  const g = (t: number): number => 0.8 * Math.cos(M2 * (t - t0) - 0.9);
  for (const e of findExtrema(hourly(t0, 72, g))) {
    const phase = M2 * (e.timeMs - t0) - 0.9;
    const k =
      e.kind === 'high'
        ? Math.round(phase / (2 * Math.PI)) * 2 * Math.PI
        : (Math.round((phase - Math.PI) / (2 * Math.PI)) * 2 + 1) * Math.PI;
    assert.ok(Math.abs(phase - k) / M2 < 3 * 60_000, `${e.kind} off by ${((phase - k) / M2 / 60_000).toFixed(1)} min`);
    assert.ok(Math.abs(Math.abs(e.height) - 0.8) < 0.004);
  }
});

test('tidecalc: wiggles below the prominence are dropped, a real double high water is kept, plateaus and gaps', () => {
  const t0 = Date.UTC(2026, 0, 1);
  // Slack-water wiggle of ±1 cm around low water: still one low per tide.
  const base = (t: number): number => Math.cos(M2 * t);
  const noisy = hourly(t0, 60, base);
  const clean = findExtrema(noisy);
  const k = Math.round((clean.find(e => e.kind === 'low')!.timeMs - t0) / H);
  noisy.values[k - 1] = noisy.values[k] - 0.01;
  noisy.values[k + 1] = noisy.values[k] - 0.005;
  const got = findExtrema(noisy);
  assert.equal(got.length, clean.length);
  // Double high water (strong M4, the Solent's pattern): two highs with a dip > 3 cm between them.
  const dbl = (t: number): number => Math.cos(M2 * t) + 0.45 * Math.cos(2 * M2 * t + Math.PI);
  const d = findExtrema(hourly(t0, 26, dbl));
  const truth = denseExtrema(dbl, t0 + H, t0 + 25 * H);
  assert.equal(d.length, truth.length);
  const nh = d.filter(e => e.kind === 'high').length;
  const nl = d.filter(e => e.kind === 'low').length;
  assert.equal(nh, truth.filter(e => e.kind === 'high').length);
  // Two tides in 26 h, each with a double high water: 4 highs, 2 real lows and 2 dips (0.16 m) between the highs.
  assert.equal(nh, 4, `double highs kept: ${nh} highs, ${nl} lows`);
  assert.equal(d.filter(e => e.kind === 'low' && e.height > 0).length, 2);
  // Plateau: the centre of the run.
  const p = findExtrema({ t0Ms: 0, stepMs: H, values: [0, 0.5, 1, 1, 0.5, 0, -0.5, 0] });
  assert.deepEqual(
    p.map(e => [e.kind, e.timeMs / H, e.height]),
    [
      ['high', 2.5, 1],
      ['low', 6, -0.5],
    ]
  );
  // A gap (NaN) next to a sample means no extremum there; the ends are never extrema.
  assert.deepEqual(findExtrema({ t0Ms: 0, stepMs: H, values: [0, 1, NaN, 1, 0] }), []);
  assert.deepEqual(findExtrema({ t0Ms: 0, stepMs: H, values: [3, 2, 1] }), []);
  assert.equal(MIN_PROMINENCE_M, 0.03);
});

test('tidecalc: sampling, slope, tendency and Signal K TendencyKind', () => {
  const s = { t0Ms: 1000, stepMs: H, values: [0, 0.1, 0.3, NaN, 0.2] };
  assert.equal(sampleSeries(s, 1000), 0);
  assert.ok(Math.abs(sampleSeries(s, 1000 + 1.5 * H)! - 0.2) < 1e-12);
  assert.equal(sampleSeries(s, 1000 + 2.5 * H), null, 'next to a gap');
  assert.equal(sampleSeries(s, 999), null);
  assert.ok(Math.abs(slopeAt(s, 1000 + H)! - 0.3 / 7200) < 1e-15, 'central difference');
  assert.ok(Math.abs(slopeAt(s, 1000)! - 0.1 / 3600) < 1e-15, 'one-sided at the start');
  assert.equal(tendencyOf(0.05 / 3600), 'rising');
  assert.equal(tendencyOf(-0.05 / 3600), 'falling');
  assert.equal(tendencyOf(0.019 / 3600), 'steady');
  assert.equal(tendencyOf(null), null);
  assert.equal(signalKTendency(STEADY_RATE_MS * 2), 'increasing');
  assert.equal(signalKTendency(-STEADY_RATE_MS * 2), 'decreasing');
  assert.equal(signalKTendency(0), 'steady');
  assert.equal(signalKTendency(null), 'not available');
});

test('tidecalc: mean-sea-level offset and derived levels (tide + surge = water level, signs)', () => {
  const n = 24 * 60;
  const tide = new Float64Array(n);
  const total = new Float64Array(n);
  const surgeTrue = new Float64Array(n);
  let m = 0;
  for (let k = 0; k < n; k++) {
    tide[k] = 1.1 * Math.cos(M2 * k * H);
    surgeTrue[k] = 0.25 * Math.sin((2 * Math.PI * k) / (24 * 5)); // a 5-day weather cycle
    m += surgeTrue[k];
  }
  m /= n;
  const geoidToMsl = -0.4351; // mean dynamic topography + global terms (Newport's order of magnitude)
  for (let k = 0; k < n; k++) total[k] = tide[k] + geoidToMsl + surgeTrue[k];
  total[7] = NaN; // a missing sample is skipped
  const o = mslOffset(total, tide);
  assert.equal(o.samples, n - 1);
  assert.ok(Math.abs(o.offset - (geoidToMsl + (m * n - surgeTrue[7]) / (n - 1))) < 1e-12);
  for (const k of [0, 100, 777]) {
    const d = derivedLevels(tide[k], total[k], o.offset);
    assert.ok(Math.abs(d.waterLevel - (d.tide + d.surge)) < 1e-12);
    assert.ok(Math.abs(d.surge - (surgeTrue[k] - (o.offset - geoidToMsl))) < 1e-12, 'positive set-up stays positive');
  }
  assert.deepEqual(mslOffset([NaN], [1]), { offset: NaN, samples: 0 });
});

// ───────────── real data: point series vs an xarray decode ─────────────

const FIX = path.join(__dirname, '..', '..', 'test-data', 'sealevel');
const REF = JSON.parse(fs.readFileSync(path.join(FIX, 'ref.json'), 'utf8')) as {
  run_time_count: number;
  t0_index: number;
  hours: number;
  mean_window: [number, number];
  points: {
    name: string;
    lat: number;
    lon: number;
    chunk: string;
    offset: number;
    samples: number;
    tide: (number | null)[];
    water_level: (number | null)[];
    surge: (number | null)[];
    extrapolated: number[];
  }[];
};

/** Run 2026100723 of the real store, built from its geoChunked metadata (no network). */
function realRun(): ArcoRun {
  const { arrays } = parseConsolidated(JSON.parse(fs.readFileSync(path.join(FIX, 'geoChunked.zmetadata'), 'utf8')));
  const meta = { ocean_tide: arrays.get('ocean_tide')!, total_sea_level: arrays.get('total_sea_level')! };
  const grid = { lat0: -80, dLat: 170 / 2040, nLat: 2041, lon0: -180, dLon: 360 / 4320, nLon: 4320, wrap: true };
  const dims = { time: 0, lat: 2, lon: 3, rank: 4 };
  return {
    key: '2026100723',
    timeFirstMs: Date.UTC(2022, 8, 1),
    timeStepMs: H,
    timeCount: REF.run_time_count,
    levels: { time: { layout: 'time', url: 'x', grid, meta, dims }, geo: { layout: 'geo', url: 'x', grid, meta, dims }, ds4: null },
    stacUpdated: null,
    stacUpdating: false,
    metadataModified: null,
    metadataEtag: null,
    settled: true,
    probedAt: '',
  };
}

test('sea level: real point series at 3 coastal points equal an independent xarray decode (bilinear + coastal fill + MSL offset)', async () => {
  const run = realRun();
  const dir = tmpDir();
  for (const p of REF.points) {
    for (const v of SL_VARS) {
      const dst = path.join(dir, run.key, 'geo', v, p.chunk);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(FIX, `${v}_${p.chunk}`), dst);
    }
  }
  const client = new SeaLevelClient({ cacheDir: dir, network: false });
  const src = new TideSource(run, { halfWidthDeg: 5, horizonS: 24 * HOUR_S, budgetBytes: 64 << 20 }, client);
  const from = run.timeFirstMs + REF.t0_index * H;
  assert.equal(new Date(from).toISOString(), '2026-09-28T12:00:00.000Z');
  // The mean window of this run is geo time chunk 9: the chunk holding the last 60 days.
  const plan = pointTimePlan(run, 3648, REF.t0_index, REF.t0_index + 71);
  assert.deepEqual([plan.meanLo, plan.meanHi], REF.mean_window);
  assert.equal(plan.tIdx.length, run.timeCount - 9 * 3648);
  assert.equal(MEAN_WINDOW_DAYS, 60);
  for (const p of REF.points) {
    const s = (await src.pointSeries(p.lat, p.lon, from, from + (REF.hours - 1) * H))!;
    assert.ok(s, p.name);
    assert.equal(s.t0Ms, from);
    assert.equal(s.tide.length, REF.hours);
    assert.equal(s.offsetSamples, p.samples, `${p.name} samples`);
    assert.ok(Math.abs(s.offsetM - p.offset) < 1e-9, `${p.name} offset ${s.offsetM} vs ${p.offset}`);
    let maxd = 0;
    for (let k = 0; k < REF.hours; k++) {
      for (const [a, b] of [
        [s.tide[k], p.tide[k]],
        [s.waterLevel[k], p.water_level[k]],
        [s.surge[k], p.surge[k]],
      ] as [number, number | null][]) {
        assert.ok(b !== null && Number.isFinite(a), `${p.name} ${k}`);
        maxd = Math.max(maxd, Math.abs(a - b));
      }
      assert.equal(s.extrapolated[k], p.extrapolated[k], `${p.name} extrapolated ${k}`);
    }
    assert.ok(maxd < 1e-6, `${p.name}: max |diff| ${maxd}`);
    // Sanity on magnitudes: surge small (< 0.5 m) in these calm-ish days, water level = tide + surge.
    for (let k = 0; k < REF.hours; k++) {
      assert.ok(Math.abs(s.surge[k]) < 0.5, `${p.name} surge ${s.surge[k]}`);
      assert.ok(Math.abs(s.waterLevel[k] - s.tide[k] - s.surge[k]) < 1e-12);
    }
    // Real-series high / low waters: alternating, each at a local extremum of the hourly samples.
    const sum = tideSummary(s, from, from + (REF.hours - 1) * H);
    const all = [...sum.highs.map(e => ({ ...e, hi: true })), ...sum.lows.map(e => ({ ...e, hi: false }))].sort(
      (a, b) => Date.parse(a.time) - Date.parse(b.time)
    );
    assert.ok(all.length >= 4, `${p.name}: ${all.length} extrema in 72 h`);
    for (let i = 1; i < all.length; i++) assert.notEqual(all[i].hi, all[i - 1].hi);
    for (const e of all) {
      const q = (Date.parse(e.time) - from) / H;
      const k = Math.round(q);
      const near = [s.tide[k - 1], s.tide[k], s.tide[k + 1]].filter(Number.isFinite);
      // The parabola may pass beyond the extreme sample (by 7 cm at Portsmouth's flat, M4-shaped low waters).
      if (e.hi) assert.ok(e.height_m >= Math.max(...near) - 1e-4 && e.height_m <= Math.max(...near) + 0.1, `${p.name} high ${e.height_m}`);
      else assert.ok(e.height_m <= Math.min(...near) + 1e-4 && e.height_m >= Math.min(...near) - 0.1, `${p.name} low ${e.height_m}`);
    }
    assert.equal(sum.datum, 'mean sea level');
    assert.equal(sum.run, '2026100723');
    assert.equal(sum.extrapolated, true);
    assert.ok(sum.range_m! > 0.5 && sum.range_m! < 5);
  }
  // Second query in the same cell: served from memory, no chunk read.
  const again = (await src.pointSeries(REF.points[0].lat + 0.001, REF.points[0].lon, from, from + 3 * H))!;
  assert.equal(again.cached, true);
  assert.equal(src.status().point_cache.hits, 1);
});

// ───────────── synthetic store: TideSource end to end ─────────────
//
// Global 1° grid (80°S..90°N), 200 hourly steps from 2026-09-20T00Z, the
// sea-level variable layout. Land (fill) on 40..45°N × 10..20°E and in
// one cell at 0°N 0°E (a coastal fill case). Layouts: time (1 h × 64 ×
// 128), geo (48 h × 16 × 16), ds4 (2°).

const FILL = -9999;
const T0 = Date.UTC(2026, 8, 20, 0);
const NT = 200;
const HOURS_1950 = (T0 - Date.UTC(1950, 0, 1)) / H;
const tideTrue = (lat: number, lon: number, ti: number): number =>
  0.8 * Math.cos((2 * Math.PI * ti) / 12.42 + (lon * Math.PI) / 180) + 0.01 * lat;
const totalTrue = (lat: number, lon: number, ti: number): number =>
  tideTrue(lat, lon, ti) - 0.4 + 0.002 * lon + 0.1 * Math.sin((2 * Math.PI * ti) / 50);
const landAt = (lat: number, lon: number): boolean => (lat >= 40 && lat <= 45 && lon >= 10 && lon <= 20) || (lat === 0 && lon === 0);
const LAYOUTS: Record<string, { d: number; chunks: number[] }> = {
  time: { d: 1, chunks: [1, 1, 64, 128] },
  geo: { d: 1, chunks: [48, 1, 16, 16] },
  ds4: { d: 2, chunks: [1, 1, 86, 180] },
};

function f4(vals: ArrayLike<number>): Uint8Array {
  return new Uint8Array(new Float32Array(Array.from(vals)).buffer);
}

function mockFetch(counts: Map<string, number>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    counts.set(url, (counts.get(url) ?? 0) + 1);
    if (url.endsWith('dataset.stac.json'))
      return new Response(JSON.stringify({ properties: { admp_updated_data: '2026-09-28T10:00:00Z', admp_updating_start_date: null } }), {
        status: 200,
      });
    const m = /\/(time|geo|ds4)\.zarr\/(.+)$/.exec(url);
    if (!m) return new Response('no', { status: 404 });
    const L = LAYOUTS[m[1]];
    const key = m[2];
    const nLat = Math.round(170 / L.d) + 1;
    const nLon = Math.round(360 / L.d);
    const arr = (shape: number[], chunks: number[], fill: unknown): unknown => ({
      chunks,
      compressor: null,
      dtype: '<f4',
      fill_value: fill,
      filters: null,
      order: 'C',
      shape,
      zarr_format: 2,
    });
    if (key === '.zmetadata') {
      const md: Record<string, unknown> = {
        '.zattrs': {},
        'latitude/.zarray': arr([nLat], [nLat], 'NaN'),
        'latitude/.zattrs': { _ARRAY_DIMENSIONS: ['latitude'] },
        'longitude/.zarray': arr([nLon], [nLon], 'NaN'),
        'longitude/.zattrs': { _ARRAY_DIMENSIONS: ['longitude'] },
        'time/.zarray': arr([NT], [64], 'NaN'),
        'time/.zattrs': { _ARRAY_DIMENSIONS: ['time'], calendar: 'gregorian', units: 'hours since 1950-01-01' },
      };
      for (const v of ['ocean_tide', 'total_sea_level', 'invert_barometer']) {
        md[`${v}/.zarray`] = arr([NT, 1, nLat, nLon], L.chunks, FILL);
        md[`${v}/.zattrs`] = { _ARRAY_DIMENSIONS: ['time', 'elevation', 'latitude', 'longitude'], units: 'm' };
      }
      return new Response(JSON.stringify({ metadata: md, zarr_consolidated_format: 1 }), {
        status: 200,
        headers: { etag: '"e1"', 'last-modified': 'Mon, 28 Sep 2026 08:00:00 GMT' },
      });
    }
    if (key === 'latitude/0') return new Response(f4(Array.from({ length: nLat }, (_, i) => -80 + i * L.d)), { status: 200 });
    if (key === 'longitude/0') return new Response(f4(Array.from({ length: nLon }, (_, i) => -180 + i * L.d)), { status: 200 });
    const tm = /^time\/(\d+)$/.exec(key);
    if (tm)
      return new Response(f4(Array.from({ length: 64 }, (_, i) => (+tm[1] * 64 + i < NT ? HOURS_1950 + +tm[1] * 64 + i : NaN))), {
        status: 200,
      });
    const dm = /^(ocean_tide|total_sea_level)\/(\d+)\.0\.(\d+)\.(\d+)$/.exec(key);
    if (!dm) return new Response('no', { status: 404 });
    const [ct, , cr, cc] = L.chunks;
    const [tc, rc, ccI] = [+dm[2], +dm[3], +dm[4]];
    const out = new Float32Array(ct * cr * cc).fill(FILL);
    for (let t = 0; t < ct; t++) {
      const ti = tc * ct + t;
      if (ti >= NT) continue;
      for (let r = 0; r < cr; r++) {
        const gr = rc * cr + r;
        if (gr >= nLat) continue;
        for (let c = 0; c < cc; c++) {
          const gc = ccI * cc + c;
          if (gc >= nLon) continue;
          const lat = -80 + gr * L.d;
          const lon = -180 + gc * L.d;
          if (landAt(lat, lon)) continue;
          out[(t * cr + r) * cc + c] = dm[1] === 'ocean_tide' ? tideTrue(lat, lon, ti) : totalTrue(lat, lon, ti);
        }
      }
    }
    return new Response(new Uint8Array(out.buffer), { status: 200 });
  }) as typeof fetch;
}

const URLS = {
  time: 'https://mock/time.zarr',
  geo: 'https://mock/geo.zarr',
  ds4: 'https://mock/ds4.zarr',
  stac: 'https://mock/dataset.stac.json',
};

async function mockSource(): Promise<{ src: TideSource; client: SeaLevelClient; run: ArcoRun; counts: Map<string, number> }> {
  const counts = new Map<string, number>();
  const client = new SeaLevelClient({ cacheDir: tmpDir(), urls: URLS, fetchImpl: mockFetch(counts), sleepImpl: async () => undefined });
  const run = await client.probe();
  const src = new TideSource(run, { halfWidthDeg: 5, horizonS: 24 * HOUR_S, budgetBytes: 32 << 20 }, client);
  return { src, client, run, counts };
}

/** Bilinear of the float32 node values (all four corners in water). */
function bilin(fn: (lat: number, lon: number, ti: number) => number, lat: number, lon: number, ti: number): number {
  const y = lat + 80;
  const x = lon + 180;
  const r = Math.floor(y);
  const c = Math.floor(x);
  const ty = y - r;
  const tx = x - c;
  const n = (rr: number, cc: number): number => Math.fround(fn(-80 + rr, -180 + cc, ti));
  return (n(r, c) * (1 - tx) + n(r, c + 1) * tx) * (1 - ty) + (n(r + 1, c) * (1 - tx) + n(r + 1, c + 1) * tx) * ty;
}

test('sea level (synthetic store): probe, exact point series, offset, coastal fill flag, cache', async () => {
  const { src, run, counts } = await mockSource();
  assert.equal(run.timeCount, NT);
  assert.ok(run.levels.geo && run.levels.ds4);
  // The 6 × 6 block around this point lies inside one 16 × 16 geo chunk.
  const lat = 25.3;
  const lon = -40.6;
  const from = T0 + 10 * H;
  const s = (await src.pointSeries(lat, lon, from, from + 23 * H))!;
  assert.equal(s.tide.length, 24);
  // Offset: mean over the whole (short) axis of total − tide at the point.
  let m = 0;
  for (let ti = 0; ti < NT; ti++) m += bilin(totalTrue, lat, lon, ti) - bilin(tideTrue, lat, lon, ti);
  m /= NT;
  assert.equal(s.offsetSamples, NT);
  assert.ok(Math.abs(s.offsetM - m) < 1e-9);
  for (let k = 0; k < 24; k++) {
    const ti = 10 + k;
    assert.ok(Math.abs(s.tide[k] - bilin(tideTrue, lat, lon, ti)) < 1e-9);
    assert.ok(Math.abs(s.waterLevel[k] - (bilin(totalTrue, lat, lon, ti) - m)) < 1e-9);
    assert.ok(Math.abs(s.surge[k] - (s.waterLevel[k] - s.tide[k])) < 1e-12);
    assert.equal(s.extrapolated[k], 0);
  }
  const chunkReqs = [...counts.keys()].filter(u => /geo\.zarr\/(ocean_tide|total)/.test(u)).length;
  assert.equal(chunkReqs, 2 * Math.ceil(NT / 48), 'geo layout: one chunk column per variable per time chunk');
  // Coastal fill: the corner at 0°N 0°E is land; a point next to it is extrapolated and finite.
  const c = (await src.pointSeries(0.25, 0.25, from, from + 2 * H))!;
  assert.equal(c.extrapolated[0], 1);
  assert.ok(Number.isFinite(c.tide[0]) && Number.isFinite(c.waterLevel[0]));
  // Deep inside the land block: no model water within 2 cells → no data.
  const inland = (await src.pointSeries(42.5, 15.5, from, from + 2 * H))!;
  assert.ok(Number.isNaN(inland.tide[0]));
  // Outside the grid / the time axis.
  assert.equal(await src.pointSeries(-85, 0, from, from + H), null);
  assert.equal(await src.pointSeries(10, 10, T0 - 10 * H, T0 - 5 * H), null);
  // Rows for the conditions popup: linear between hours, tendency from the tide.
  const row = tideRowAt(s, from + 1.5 * H);
  assert.ok(Math.abs(row.tide_m! - (s.tide[1] + s.tide[2]) / 2) < 1e-4);
  assert.equal(row.tide_extrapolated, false);
  assert.ok(['rising', 'falling', 'steady'].includes(row.tide_tendency!));
  assert.deepEqual(tideRowAt(null, from), {
    tide_m: null,
    water_level_m: null,
    surge_m: null,
    tide_extrapolated: false,
    tide_tendency: null,
  });
  const st = src.status();
  assert.equal(st.run, run.key);
  assert.ok(st.point_cache.entries >= 2 && st.point_cache.bytes > 0);
  assert.equal(st.datum, 'mean sea level');
  assert.ok(st.last_point_query);
});

test('sea level (synthetic store): tide map field — resident window, on-demand hour, display fill, fieldGrid + conditions', async () => {
  const { src, client, run } = await mockSource();
  // Resident window: hourly, starting on a 6-hour boundary, covering now → now + horizon.
  const now = T0 + 20 * H + 25 * 60_000;
  const steps = src.windowSteps(now);
  assert.equal(steps[0], T0 + 18 * H);
  assert.equal(steps[steps.length - 1], T0 + (18 + 24 + 6) * H);
  assert.ok(steps.every((t, i) => i === 0 || t - steps[i - 1] === H));
  const pos = { lat: 30, lon: -40 };
  assert.equal(src.residentStale(pos, steps), true);
  const res = (await loadTideResident(client, run, src.settings, pos, steps))!;
  src.setResident(res.area, pos);
  assert.equal(src.residentStale(pos, steps), false);
  assert.equal(src.residentStale({ lat: 32, lon: -40 }, steps), true, 'moved more than a third of the half-width');
  assert.equal(src.residentStale(pos, src.windowSteps(now + 6 * H)), true, 'window moved on');
  const t = new Date(T0 + 20 * H + 30 * 60_000);
  const v = src.tideAtDisplay(-40.3, 30.6, t);
  const ti0 = 20;
  const want = 0.5 * bilin(tideTrue, 30.6, -40.3, ti0) + 0.5 * bilin(tideTrue, 30.6, -40.3, ti0 + 1);
  assert.ok(Math.abs(v - want) < 1e-6, `${v} vs ${want}`);
  // Outside the resident area: nothing until loaded on demand.
  assert.ok(Number.isNaN(src.tideAtDisplay(100, 10, t)));
  assert.equal(await src.ensure({ west: 99, east: 101, south: 9, north: 11 }, src.bracketSteps(t.getTime()), { reason: 'test' }), true);
  assert.ok(
    Math.abs(src.tideAtDisplay(100.2, 10.4, t) - (0.5 * bilin(tideTrue, 10.4, 100.2, 20) + 0.5 * bilin(tideTrue, 10.4, 100.2, 21))) < 1e-6
  );
  assert.equal(src.status().on_demand.areas, 1);
  // Display fill next to the one-cell land spot at 0°N 0°E.
  await src.ensure({ west: -2, east: 2, south: -2, north: 2 }, src.bracketSteps(t.getTime()), { reason: 'test' });
  assert.ok(Number.isFinite(src.tideAtDisplay(0, 0, t)), "the land cell takes its neighbours' value for display");
  // fieldGrid layer=tide.
  const srcs: OverlaySources = { forecast: null, currents: null, land: null, tides: src };
  const g = fieldGrid(srcs, 'tide', { west: -41, east: -39, south: 29, north: 31 }, t, 0.5);
  assert.equal(g.units.tide_m, 'm');
  assert.ok(g.fields.tide_m.flat().every(x => typeof x === 'number'));
  assert.throws(
    () => fieldGrid({ forecast: null, currents: null, land: null, tides: null }, 'tide', { west: 0, east: 1, south: 0, north: 1 }, t, 0.5),
    /no tide data/
  );
  // conditionsSeries with a tide series: per-row fields and the summary; existing fields untouched.
  const from = new Date(T0 + 10 * H);
  const s = (await src.pointSeries(30.3, -40.6, from.getTime(), from.getTime() + 72 * H))!;
  const cs = conditionsSeries(srcs, -40.6, 30.3, from, 72, 1, { series: s, error: null });
  assert.equal(cs.series.length, 73);
  assert.ok(Math.abs(cs.series[5].tide_m! - Math.round(s.tide[5] * 1e4) / 1e4) < 1e-12);
  assert.ok(cs.tides && cs.tides.highs.length >= 5 && cs.tides.lows.length >= 5);
  assert.equal(cs.tides!.datum, 'mean sea level');
  assert.ok(cs.sources.tides && cs.series[0].wind_ms === null);
  assert.ok(Math.abs(cs.tides!.range_m! - 1.6) < 0.05, `range ${cs.tides!.range_m} (amplitude 0.8 m)`);
  const none = conditionsSeries(srcs, -40.6, 30.3, from, 3, 1, { series: null, error: 'x' });
  assert.equal(none.tides, null);
  assert.equal(none.tides_error, 'x');
  assert.equal(none.series[0].tide_m, null);
});

// ───────────── Weather API, legends, settings ─────────────

test('Weather API: water.level (m above MSL) and water.levelTendency from the point series', async () => {
  const t0 = Date.UTC(2026, 8, 28, 0);
  const wl = new Float64Array(100);
  for (let k = 0; k < 100; k++) wl[k] = 0.9 * Math.cos(M2 * k * H);
  const items: WeatherData[] = [0, 3, 6, 99, 150].map(h => ({ date: new Date(t0 + h * H).toISOString(), type: 'point' }));
  const n = applyWaterLevel(items, { t0Ms: t0, stepMs: H, waterLevel: wl, error: null });
  assert.equal(n, 4, 'beyond the series: no level');
  assert.ok(Math.abs(items[1].water!.level! - wl[3]) < 1e-12);
  assert.equal(items[1].water!.levelTendency, 'decreasing');
  assert.equal(items[4].water, undefined);
  // Through the provider (async), with a minimal store and a fake tide query.
  const steps = [0, 3, 6].map(h => ({ validMs: t0 + h * H, stepHours: h }));
  const store = {
    covers: () => true,
    has: () => false,
    hasAny: () => false,
    steps,
    meta: { cycleTime: new Date(t0) },
    at: () => [5, 90],
    wavesAt: () => null,
    mslAt: () => 101300,
    paramAt: () => NaN,
  } as unknown as ForecastStore;
  const asked: number[][] = [];
  const points: PointForecastFn = async (p, o) => pointForecasts(store, p.longitude, p.latitude, startMsOf(o), o?.maxCount ?? null);
  const provider = makeWeatherProvider(points, 'x', async (lat, lon, fromMs, hours) => {
    asked.push([lat, lon, fromMs, hours]);
    return {
      t0Ms: t0 - H,
      stepMs: H,
      waterLevel: Float64Array.from({ length: 20 }, (_, k) => 0.9 * Math.cos(M2 * (k - 1) * H)),
      error: null,
    };
  });
  const out = await provider.methods.getForecasts({ latitude: 41.4, longitude: -71.3 }, 'point', { startDate: new Date(t0).toISOString() });
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[0].water!.level! - 0.9) < 1e-12);
  assert.equal(out[0].water!.levelTendency, 'steady', 'at high water');
  assert.equal(out[1].water!.levelTendency, 'decreasing', 'falling towards low water at 6.2 h');
  assert.equal(out[2].water!.levelTendency, 'decreasing');
  const rising: WeatherData[] = [{ date: new Date(t0 + 9 * H).toISOString(), type: 'point' }];
  applyWaterLevel(rising, { t0Ms: t0, stepMs: H, waterLevel: wl, error: null });
  assert.equal(rising[0].water!.levelTendency, 'increasing');
  assert.equal(out[0].outside!.pressure, 101300, 'existing fields kept');
  assert.deepEqual(asked, [[41.4, -71.3, t0 - H, 8]]);
  // A failing tide query leaves the forecast intact without water.level.
  const failing = makeWeatherProvider(points, 'x', async () => {
    throw new Error('down');
  });
  const f = await failing.methods.getForecasts({ latitude: 41.4, longitude: -71.3 }, 'point', { startDate: new Date(t0).toISOString() });
  assert.equal(f.length, 3);
  assert.equal(f[0].water, undefined);
});

// Types only: the series shape the worker hands to the main thread.
export type _Series = TidePointSeries;
