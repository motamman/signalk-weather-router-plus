import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beaufort, douglas, feelsLike, heatIndexK, relativeHumidity, roughnessIndex, seaStateBand } from './conditions';

test('relative humidity is a ratio in 0..1, not a percent', () => {
  // 20 °C air, 10 °C dew point → about 52.5 % by the Magnus form.
  const rh = relativeHumidity(293.15, 283.15);
  assert.ok(rh !== null && Math.abs(rh - 0.526) < 0.005, `got ${rh}`);
  assert.equal(relativeHumidity(293.15, 293.15), 1);
  assert.equal(relativeHumidity(null, 283.15), null);
  // Dew point above air temperature clamps to 1, never above.
  assert.equal(relativeHumidity(283.15, 293.15), 1);
});

test('heat index and feels-like take the humidity ratio', () => {
  // 32 °C at 70 %: NWS heat index about 41 °C.
  const hi = heatIndexK(305.15, 0.7);
  assert.ok(hi !== null && Math.abs(hi - 273.15 - 41) < 1.5, `got ${hi}`);
  // Below the 40 % threshold the index does not apply.
  assert.equal(heatIndexK(305.15, 0.3), null);
  // A ratio must not be mistaken for a percent: 0.7 as "0.7 %" would return null.
  assert.equal(feelsLike(305.15, 1, 0.7).basis, 'heat_index');
  assert.equal(feelsLike(278.15, 5, 0.7).basis, 'wind_chill');
  assert.equal(feelsLike(293.15, 5, 0.7).basis, 'air');
});

test('dimensionless scales stay integer indices', () => {
  assert.equal(beaufort(0), 0);
  assert.equal(beaufort(10.8), 6);
  assert.equal(beaufort(40), 12);
  assert.equal(douglas(0), 0);
  assert.equal(douglas(1.25), 4);
  assert.equal(seaStateBand(151), 'extreme');
});

test('long-period swell is dampened, short-period coastal swell is not', () => {
  // Calm wind and no current: only the swell term contributes.
  const swellOnly = (swh: number, mwp: number) => roughnessIndex(0, 0, 0, 0, swh, mwp, 0).idx;
  // 2.25 m at 5 s (steep coastal wind sea) keeps the original value:
  // 30 * 2.25^2 = 151.875, still in the extreme band.
  assert.ok(Math.abs(swellOnly(2.25, 5) - 151.875) < 0.01, `got ${swellOnly(2.25, 5)}`);
  assert.equal(seaStateBand(swellOnly(2.25, 5)), 'extreme');
  // Periods under 5 s are treated the same as 5 s (no amplification).
  assert.ok(Math.abs(swellOnly(2.25, 3) - 151.875) < 0.01);
  // The same height at a lazy 12 s trade swell is cut to 5/12:
  // 151.875 * 5/12 = 63.28, back into the slight band.
  assert.ok(Math.abs(swellOnly(2.25, 12) - 151.875 * (5 / 12)) < 0.01, `got ${swellOnly(2.25, 12)}`);
  assert.equal(seaStateBand(swellOnly(2.25, 12)), 'slight');
  // Against an opposing current (flowing against the waves) the steepening
  // factor still applies on top of the period dampening.
  const steep = roughnessIndex(0, 1, 0, 0, 2.25, 12, 0).idx;
  assert.ok(steep > swellOnly(2.25, 12), `steepened ${steep} should exceed dampened ${swellOnly(2.25, 12)}`);
});
