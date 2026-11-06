import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptManagedPolar } from '../plugin/managedpolar';
import { simulateLegTime } from '../engine/legsim';
import { NoCurrent, type WindSource } from '../engine/environment';
import type { Route } from '../engine/route';
import { waveCorrectionWarnings } from '../engine/smoother';
import { PolarDiagram } from './polar';
import { makeVessel } from './vessel';
import { waveFactor, type WaveCorrection } from './wavecorrection';

/** polar-format's own example: a neutral 0 m layer and a 2 m layer, head seas slow, following seas fast at long periods. */
const FRAGMENT = {
  heights: [
    {
      significantWaveHeight: 0,
      axes: { wavePeriod: [1, 16], waveAngle: [0, Math.PI] },
      values: {
        speedFactorMatrix: [
          [1, 1],
          [1, 1],
        ],
      },
    },
    {
      significantWaveHeight: 2,
      axes: { wavePeriod: [1, 5, 10, 15], waveAngle: [0, Math.PI] },
      values: {
        speedFactorMatrix: [
          [0.9, 1],
          [0.9, 1.1],
          [0.9, 1.15],
          [0.9, 1.2],
        ],
      },
    },
  ],
};

const set = (waveCorrection: unknown = FRAGMENT) => ({
  kind: 'polarSet',
  schemaVersion: '2.0.0',
  units: { twa: 'rad', tws: 'm/s', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  best: {
    axes: { twa: [0, Math.PI / 2, Math.PI], tws: [4, 8] },
    values: {
      boatSpeedMatrix: [
        [0, 3, 2],
        [0, 4, 3],
      ],
    },
  },
  waveCorrection,
});

const close = (a: number | null, b: number): void => assert.ok(a !== null && Math.abs(a - b) < 1e-12, `${a} != ${b}`);

function correction(): WaveCorrection {
  const wc = adaptManagedPolar(set(), 'boat', 1).waveCorrection;
  assert.ok(wc);
  return wc;
}

test('the factor: linear in angle, then period within each height layer, then height', () => {
  const wc = correction();
  close(waveFactor(wc, 2, 5, 0), 0.9);
  close(waveFactor(wc, 2, 5, 180), 1.1);
  close(waveFactor(wc, 2, 5, 90), 1.0);
  close(waveFactor(wc, 2, 7.5, 180), 1.125);
  // Halfway between the 0 m layer (1) and the 2 m layer (0.9) in head seas.
  close(waveFactor(wc, 1, 5, 0), 0.95);
  close(waveFactor(wc, 0, 12, 45), 1);
});

test('a sea outside the table has no factor (never 1, never extrapolated)', () => {
  const wc = correction();
  assert.equal(waveFactor(wc, 2.5, 5, 0), null, 'higher than the highest layer');
  assert.equal(waveFactor(wc, 1, 16, 0), null, "a period the 2 m layer doesn't cover, between the layers");
  assert.equal(waveFactor(wc, 2, 0.5, 0), null, 'a period below the axis');
  assert.equal(waveFactor(wc, NaN, 5, 0), null);
});

test("Polar Management's switch off, or no table: no correction; a malformed table fails the polar", () => {
  assert.equal(adaptManagedPolar(set(), 'boat', 1, false).waveCorrection, undefined);
  assert.ok(adaptManagedPolar(set(), 'boat', 1, null).waveCorrection);
  const { waveCorrection: _none, ...without } = set();
  assert.equal(adaptManagedPolar(without, 'boat', 1).waveCorrection, undefined);
  for (const bad of [
    { heights: [] },
    { heights: [{ ...FRAGMENT.heights[1], values: { speedFactorMatrix: [[0.9, 1]] } }] },
    { heights: [FRAGMENT.heights[1], FRAGMENT.heights[0]] },
  ])
    assert.throws(() => adaptManagedPolar(set(bad), 'boat', 1), /wave correction/);
});

/** Wind from the north at 8 m/s and `swh` m waves from `mwd`, everywhere: Tm02 (mp2) `mp2` s, mean period mwp `mwp` s. */
function sea(swh: number, mwd: number, mp2 = 5, mwp = mp2): WindSource {
  return {
    hasWaves: true,
    at: () => [8, 0],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(8), dir: new Float64Array(lons.length) }),
    wavesAt: () => ({ swh, mwp, mp2, mwd }),
  };
}

test('the simulator sails at polar × factor, and counts the time sailed where the table has no factor', () => {
  const polar = new PolarDiagram([0, 90, 180], [4, 8], [0, 0, 3, 4, 2, 3]);
  const vessel = makeVessel({ motorSpeedMs: 2 });
  const sim = { modePolicy: 'sail_max' as const, sailThreshMs: 0.5, simStepM: 100 };
  const t0 = new Date('2026-01-01T00:00:00Z');
  // Due east (beam reach, 4 m/s), the waves from the east: head seas, factor 0.9.
  const plain = simulateLegTime(0, 0, t0, 0.05, 0, vessel, polar, sea(2, 90), new NoCurrent(), sim);
  const head = simulateLegTime(0, 0, t0, 0.05, 0, vessel, polar, sea(2, 90), new NoCurrent(), { ...sim, waveCorrection: correction() });
  assert.ok(Math.abs(head.seconds - plain.seconds / 0.9) < 1e-6, `${head.seconds} vs ${plain.seconds / 0.9}`);
  assert.equal(head.uncorrectedWaveSeconds, 0);
  // 3 m waves: above the table's highest layer: sailed at the polar's speed, all of it counted.
  const high = simulateLegTime(0, 0, t0, 0.05, 0, vessel, polar, sea(3, 90), new NoCurrent(), { ...sim, waveCorrection: correction() });
  assert.equal(high.seconds, plain.seconds);
  assert.equal(high.uncorrectedWaveSeconds, high.seconds);
  assert.equal(plain.uncorrectedWaveSeconds, 0);
});

test('the table is read with Tm02 (mp2), not the mean period mwp; without a Tm02 the sea is sailed uncorrected and counted', () => {
  const polar = new PolarDiagram([0, 90, 180], [4, 8], [0, 0, 3, 4, 2, 3]);
  const vessel = makeVessel({ motorSpeedMs: 2 });
  const sim = { modePolicy: 'sail_max' as const, sailThreshMs: 0.5, simStepM: 100 };
  const t0 = new Date('2026-01-01T00:00:00Z');
  const wc = { ...sim, waveCorrection: correction() };
  // Due east, 2 m waves from the west: following seas, where the 2 m layer's factor depends on the period
  // (1.1 at 5 s, 1.15 at 10 s).
  const plain = simulateLegTime(0, 0, t0, 0.05, 0, vessel, polar, sea(2, 270, 5, 10), new NoCurrent(), sim);
  const following = simulateLegTime(0, 0, t0, 0.05, 0, vessel, polar, sea(2, 270, 5, 10), new NoCurrent(), wc);
  assert.ok(Math.abs(following.seconds - plain.seconds / 1.1) < 1e-6, `${following.seconds} vs ${plain.seconds / 1.1}: read at mp2 5 s`);
  assert.equal(following.noPeriodWaveSeconds, 0);
  // No Tm02 in the forecast: the polar's speed, all of it counted apart from seas outside the table.
  const none = simulateLegTime(0, 0, t0, 0.05, 0, vessel, polar, sea(2, 270, NaN, 10), new NoCurrent(), wc);
  assert.equal(none.seconds, plain.seconds);
  assert.equal(none.noPeriodWaveSeconds, none.seconds);
  assert.equal(none.uncorrectedWaveSeconds, 0);
  // Without a wave correction nothing is counted.
  assert.equal(plain.noPeriodWaveSeconds, 0);
});

test('the route carries a waves_no_period warning for the time sailed without a Tm02, replacing the one before', () => {
  const polar = new PolarDiagram([0, 90, 180], [4, 8], [0, 0, 3, 4, 2, 3]);
  const vessel = makeVessel({ motorSpeedMs: 2 });
  const sim = { modePolicy: 'sail_max' as const, sailThreshMs: 0.5, simStepM: 100 };
  const t0 = new Date('2026-01-01T00:00:00Z');
  const wc = { ...sim, waveCorrection: correction() };
  // One leg due east, as the simulator test above; the waypoints' own fields beyond place and time are not read.
  const leg = simulateLegTime(0, 0, t0, 0.05, 0, vessel, polar, sea(2, 270, NaN, 10), new NoCurrent(), wc);
  const route = (warnings?: Route['warnings']): Route =>
    ({
      waypoints: [
        { lon: 0, lat: 0, time: t0 },
        { lon: 0.05, lat: 0, time: new Date(t0.getTime() + leg.seconds * 1000) },
      ],
      warnings,
    }) as unknown as Route;
  const env = (wind: WindSource, s: typeof sim) => ({ vessel, polar, wind, current: new NoCurrent(), sim: s });
  const other = { leg_index: 0, violation: 'wind_over_limit', from: [0, 0], to: [0.05, 0], repaired: false, detail: '60' };
  const stale = { leg_index: 0, violation: 'waves_no_period', from: [0, 0], to: [0.05, 0], repaired: false, detail: '1' };

  // No Tm02: one warning for the leg, with its seconds; a stale one is replaced, another kind kept.
  const r = route([other, stale] as Route['warnings']);
  waveCorrectionWarnings(r, env(sea(2, 270, NaN, 10), wc));
  const noPeriod = (r.warnings ?? []).filter(w => w.violation === 'waves_no_period');
  assert.equal(noPeriod.length, 1);
  assert.equal(noPeriod[0].leg_index, 0);
  assert.equal(noPeriod[0].detail, String(Math.round(leg.noPeriodWaveSeconds)));
  assert.ok(leg.noPeriodWaveSeconds > 0);
  assert.ok(
    (r.warnings ?? []).some(w => w.violation === 'wind_over_limit'),
    'other warnings stay'
  );

  // With a Tm02 the warning goes.
  const fixed = route([stale] as Route['warnings']);
  waveCorrectionWarnings(fixed, env(sea(2, 270, 5, 10), wc));
  assert.equal(fixed.warnings, undefined);

  // Without a wave correction the route's warnings are left as they are.
  const off = route([stale] as Route['warnings']);
  waveCorrectionWarnings(off, env(sea(2, 270, NaN, 10), sim));
  assert.deepEqual(off.warnings, [stale]);
});
