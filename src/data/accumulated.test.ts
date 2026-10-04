/**
 * The accumulated fields (ACCUMULATED_PARAMS: ECMWF's tp, ssrd, sf, strd,
 * str, which accumulate since the forecast start): the step-difference
 * pass turns them into per-interval values, step 0's empty range is
 * dropped, and the interval length is carried on the step (3 h to 144 h,
 * 6 h past it) through the store, its serialization and the decoded-run
 * index — and survives a window read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ACCUMULATED_PARAMS,
  applyAccumulated,
  ForecastStore,
  GLOBAL_BBOX,
  sampleField,
  type AccumPrev,
  type FieldGrid,
  type ForecastStep,
} from './forecast';
import { DecodedRunWriter, openDecodedRun } from './decoded';
import { pointForecasts } from '../plugin/weather';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-accum-'));
}

const T0 = Date.UTC(2026, 9, 3, 0);
const N = 8; // cells per field

/** A uniform field with value `v` everywhere (cell 0 marked with its index, to catch swapped arrays). */
function field(v: number): FieldGrid {
  const values = new Float32Array(N);
  for (let i = 0; i < N; i++) values[i] = v + i * 1e-6;
  return { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 1, nLon: N, values, wrapLon: false };
}

/** A step with the given params at uniform values; `intervals` is set as given (only the accumulated params carry one). */
function makeStep(stepHours: number, values: Record<string, number>, intervals?: [string, number][]): ForecastStep {
  const fields = new Map<string, FieldGrid>();
  for (const [p, v] of Object.entries(values)) fields.set(p, field(v));
  return {
    validMs: T0 + stepHours * 3_600_000,
    stepHours,
    fields,
    intervals: intervals === undefined ? undefined : new Map(intervals),
  };
}

test('applyAccumulated: step 0 is dropped (its range is empty), later steps diff against the raw previous step', () => {
  const prev: Map<string, AccumPrev> = new Map();
  // Raw accumulated values: 0 at step 0 (ECMWF codes the empty range as zeros).
  const s0 = makeStep(0, { tp: 0, ssrd: 0 });
  applyAccumulated(s0, prev);
  assert.ok(!s0.fields.has('tp') && !s0.fields.has('ssrd'), 'no interval value at step 0');
  assert.equal(s0.intervals, undefined);
  assert.equal(prev.get('tp')!.stepHours, 0);
  assert.ok(
    prev.get('tp')!.values.every(v => Math.abs(v) < 1e-5),
    'the raw step-0 range is empty (zeros)'
  );

  // Step 3: raw tp 0.004 m accumulated, ssrd 3.6e6 J/m² → depth 0.004 m over 3 h,
  // solar 3.6e6 / (3 × 3600) ≈ 333.3 W/m² average.
  const s3 = makeStep(3, { tp: 0.004, ssrd: 3.6e6 });
  applyAccumulated(s3, prev);
  assert.equal(s3.intervals!.get('tp'), 3);
  assert.equal(s3.intervals!.get('ssrd'), 3);
  assert.ok(Math.abs(s3.fields.get('tp')!.values[3] - 0.004) < 1e-9);
  assert.ok(Math.abs(s3.fields.get('ssrd')!.values[3] - 3.6e6 / 10_800) < 1e-3, 'the J/m² become an average W/m² over the interval');

  // Step 6: the difference against step 3's raw values, again 3 h.
  const s6 = makeStep(6, { tp: 0.007, ssrd: 7.2e6 });
  applyAccumulated(s6, prev);
  assert.ok(Math.abs(s6.fields.get('tp')!.values[3] - 0.003) < 1e-8);
  assert.ok(Math.abs(s6.fields.get('ssrd')!.values[3] - 3.6e6 / 10_800) < 1e-3);
  assert.ok(ACCUMULATED_PARAMS.includes('tp') && ACCUMULATED_PARAMS.includes('str'), 'the reviewed parameter set');
});

test('applyAccumulated: a parameter absent from a step diffs over the real span when it comes back', () => {
  const prev: Map<string, AccumPrev> = new Map();
  applyAccumulated(makeStep(0, { tp: 0 }), prev);
  applyAccumulated(makeStep(3, { tp: 0.004 }), prev);
  // tp missing from the step-6 index: prev keeps step 3's raw values…
  applyAccumulated(makeStep(6, { ssrd: 0 }), prev);
  assert.equal(prev.get('tp')!.stepHours, 3);
  // …so step 9 diffs 9 − 3 and its interval is 6 h.
  const s9 = makeStep(9, { tp: 0.01 });
  applyAccumulated(s9, prev);
  assert.equal(s9.intervals!.get('tp'), 6);
  assert.ok(Math.abs(s9.fields.get('tp')!.values[3] - 0.006) < 1e-8);
  // A first appearance later than step 0 (the parameter was absent from the
  // cycle's first steps): no range can be derived, the field is dropped and
  // becomes the baseline.
  const s12 = makeStep(12, { sf: 0.002 });
  applyAccumulated(s12, prev);
  assert.ok(!s12.fields.has('sf'));
  const s15 = makeStep(15, { sf: 0.005 });
  applyAccumulated(s15, prev);
  assert.equal(s15.intervals!.get('sf'), 3);
  assert.ok(Math.abs(s15.fields.get('sf')!.values[3] - 0.003) < 1e-9);
});

/** A store of three steps (0, 3, 6 h): wind everywhere; tp/10fg only from step 3, with tp's interval. */
function intervalStore(): ForecastStore {
  const steps: ForecastStep[] = [
    makeStep(0, { '10u': 3, '10v': 1 }),
    makeStep(3, { '10u': 4, '10v': 1, tp: 0.004, '10fg': 9 }, [['tp', 3]]),
    makeStep(6, { '10u': 5, '10v': 1, tp: 0.003, '10fg': 11 }, [['tp', 3]]),
  ];
  steps[0].validMs = T0;
  steps[1].validMs = T0 + 3 * 3_600_000;
  steps[2].validMs = T0 + 6 * 3_600_000;
  return new ForecastStore(steps, {
    cycleTime: new Date(T0),
    bbox: GLOBAL_BBOX,
    steps: [0, 3, 6],
    params: ['10u', '10v', 'tp', '10fg'],
    loadedAt: new Date(T0),
  });
}

test('interval fields: has/hasAny, intervalAt (the containing interval, not interpolated)', () => {
  const store = intervalStore();
  const lon = 2.5;
  const lat = 0; // cell 3 (values[3])
  assert.equal(store.has('tp'), false, 'tp is not in every step (step 0 has no interval)');
  assert.equal(store.hasAny('tp'), true);
  assert.equal(store.hasAny('10fg'), true);
  // At the step time: that step's own interval value.
  const at3 = store.intervalAt('tp', lon, lat, new Date(T0 + 3 * 3_600_000))!;
  assert.equal(at3.intervalHours, 3);
  assert.ok(Math.abs(at3.value - 0.004) < 1e-5);
  // Strictly inside the 3–6 h interval: step 6's value, unblended.
  const mid = store.intervalAt('tp', lon, lat, new Date(T0 + 4.5 * 3_600_000))!;
  assert.equal(mid.intervalHours, 3);
  assert.ok(Math.abs(mid.value - 0.003) < 1e-5);
  assert.equal(mid.value, sampleField(store.steps[2].fields.get('tp')!, lon, lat));
  // Before the first interval: null (as is an unloaded parameter).
  assert.equal(store.intervalAt('tp', lon, lat, new Date(T0)), null);
  assert.equal(store.intervalAt('swh', lon, lat, new Date(T0 + 3 * 3_600_000)), null);
});

test('Weather API: precipitationVolume carries the interval depth on point forecasts only; the step-0 gust is absent', () => {
  const store = intervalStore();
  const lon = 2.5;
  const lat = 0;
  const items = pointForecasts(store, lon, lat, T0, null);
  assert.equal(items.length, 3);
  // Step 0: no gust (the empty range is dropped at the decode) and no depth.
  assert.equal(items[0].wind?.gust, undefined);
  assert.equal(items[0].outside?.precipitationVolume, undefined);
  // Steps 3 and 6: the real maximum gust and the interval depth.
  assert.ok(Math.abs(items[1].wind!.gust! - 9) < 1e-5);
  assert.ok(Math.abs(items[1].outside!.precipitationVolume! - 0.004) < 1e-5);
  assert.ok(Math.abs(items[2].outside!.precipitationVolume! - 0.003) < 1e-5);
  // An observation's time falls inside an interval that has not ended: no depth.
  const [obs] = pointForecasts(store, lon, lat, T0 + 4.5 * 3_600_000, 1, { observation: true });
  assert.equal(obs.type, 'observation');
  assert.equal(obs.outside?.precipitationVolume, undefined);
});

test('the decoded-run index carries the intervals, and a window read restores them', async () => {
  const root = tmpDir();
  const store = intervalStore();
  const w = new DecodedRunWriter(root, '2026100300');
  for (const s of store.steps) w.writeStep(s);
  w.finish({ cycleTimeMs: T0, request: { horizonHours: 6, params: ['10u', '10v', 'tp', '10fg'] }, stepHours: [0, 3, 6], decodeMs: 1 });
  const { run, problem } = openDecodedRun(w.finalDir);
  assert.ok(run, problem ?? '');
  assert.deepEqual(run.index.steps[0].intervals, undefined, 'step 0 holds no interval fields');
  assert.deepEqual(run.index.steps[1].intervals, [['tp', 3]]);
  const win = await run.window({ bbox: null, params: ['tp', '10fg', '10u'] });
  assert.deepEqual([...(win.steps[1].intervals?.entries() ?? [])], [['tp', 3]]);
  assert.ok(!win.steps[0].fields.has('tp'));
  // And the windowed store samples exactly what the whole store does.
  const at3 = win.intervalAt('tp', 2.5, 0, new Date(T0 + 3 * 3_600_000))!;
  assert.equal(at3.intervalHours, 3);
  assert.ok(Math.abs(at3.value - 0.004) < 1e-5);
  fs.rmSync(root, { recursive: true, force: true });
});
