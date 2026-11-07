import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WindSource } from './environment';
import { fmtUtc, limitsAt, limitsEaseAt, refusalText, RouteRefused } from './refusal';

const H = 3600_000;
const t0 = Date.UTC(2026, 9, 25, 17);

/** Wind and waves that fall with time: 20 kn and 4.6 m at t0, down by 1 m/s and 0.3 m an hour. */
const easing: WindSource = {
  at: (_lon, _lat, t) => [Math.max(0, 10 - (t.getTime() - t0) / H), 300],
  atMany: () => {
    throw new Error('unused');
  },
  hasWaves: true,
  wavesAt: (_lon, _lat, t) => ({ swh: Math.max(0, 4.6 - (0.3 * (t.getTime() - t0)) / H), mwp: 11, mp2: 11, mwd: 300 }),
};

test('refusal text: waves over the limit at the start, when they ease, what to do', () => {
  const text = refusalText({
    kind: 'over_limit',
    at: null,
    atMs: t0,
    wind: null,
    waves: { seen: 4.6, limit: 3.05 },
    easesMs: t0 + 6 * H,
    untilMs: t0 + 72 * H,
    untilForecastEnd: false,
  });
  assert.equal(
    text,
    `Forecast at the start: waves {length:4.6} against your {length:3.05} limit. It comes under the limit about ${fmtUtc(t0 + 6 * H)}. Raise the limit or depart after that.`
  );
});

test('refusal text: both limits mid-route, never easing within the forecast; the other kinds name the place', () => {
  const at = { lon: -5.6789, lat: 43.1234 };
  const both = refusalText({
    kind: 'over_limit',
    at,
    atMs: t0,
    wind: { seen: 15.2, limit: 12.86 },
    waves: { seen: 4.1, limit: 3.05 },
    easesMs: null,
    untilMs: t0 + 48 * H,
    untilForecastEnd: true,
  });
  assert.match(
    both,
    /^Forecast at 43\.1234, -5\.6789, reached 2026-10-25 17:00 UTC: wind \{speed:15\.2\} against your \{speed:12\.86\} limit and waves/
  );
  assert.match(
    both,
    /Conditions there do not meet all your limits again before 2026-10-27 17:00 UTC, as far as the forecast goes\. Raise the limit, or change the departure/
  );
  assert.match(
    refusalText({ kind: 'coast', at, atMs: t0 }),
    /^Every heading at 43\.1234, -5\.6789, reached .* crosses land: .* Add a waypoint/
  );
  assert.match(refusalText({ kind: 'coast', at: null, atMs: t0 }), /at the start crosses land: .* Move the start into open water\.$/);
  assert.match(refusalText({ kind: 'dead_upwind', at: null, atMs: t0 }), /^At the start the wind is dead ahead/);
  assert.match(refusalText({ kind: 'stopped', at, atMs: t0 }), /^From 43\.1234, -5\.6789, reached .* the boat makes no way/);
});

test('refusal text: without a known forecast end the window is the one checked; mixed reasons name no single place', () => {
  const ahead = refusalText({
    kind: 'over_limit',
    at: null,
    atMs: t0,
    wind: { seen: 15.2, limit: 12.86 },
    waves: null,
    easesMs: null,
    untilMs: t0 + 72 * H,
    untilForecastEnd: false,
  });
  assert.match(ahead, /Conditions there do not meet all your limits again before 2026-10-28 17:00 UTC, as far ahead as was checked\./);
  assert.doesNotMatch(ahead, /forecast goes/);
  assert.equal(
    refusalText({ kind: 'mixed', at: 'front', atMs: t0, reasons: ['land', 'no_go'] }),
    `From the search's front, reached ${fmtUtc(t0)}, the search could not make progress: its moves were stopped by land, the wind dead ahead for this polar. Add a waypoint or choose another departure.`
  );
  assert.match(
    refusalText({ kind: 'mixed', at: null, atMs: t0, reasons: ['stopped'] }),
    /^At the start the search could not make progress: its moves were stopped by no boat speed/
  );
});

test('limitsAt and limitsEaseAt: the values against the limits, and the first whole hour under both', () => {
  const now = limitsAt(easing, 0, 0, t0, 8, 3.05);
  assert.deepEqual(now, { wind: { seen: 10, limit: 8 }, waves: { seen: 4.6, limit: 3.05 } });
  // Wind under 8 m/s after 2 h; waves under 3.05 m after 5.2 h: both from the 6th hour.
  assert.equal(limitsEaseAt(easing, 0, 0, t0, t0 + 72 * H, 8, 3.05), t0 + 6 * H);
  // Not before the forecast ends.
  assert.equal(limitsEaseAt(easing, 0, 0, t0, t0 + 3 * H, 8, 3.05), null);
  // No wave limit, or no wave data: only the wind counts.
  assert.equal(limitsEaseAt(easing, 0, 0, t0, t0 + 72 * H, 8, undefined), t0 + 2 * H);
  assert.equal(limitsAt({ ...easing, hasWaves: false }, 0, 0, t0, undefined, 3.05).waves, null);
  assert.equal(limitsEaseAt({ ...easing, hasWaves: false }, 0, 0, t0, t0 + 72 * H, 8, 3.05), t0 + 2 * H);
});

test('limitsEaseAt: a missing wind or wave reading is not easing', () => {
  const noWind: WindSource = { ...easing, at: () => [NaN, NaN] };
  assert.equal(limitsEaseAt(noWind, 0, 0, t0, t0 + 72 * H, 8, undefined), null);
  const noWaves: WindSource = { ...easing, wavesAt: () => null };
  assert.equal(limitsEaseAt(noWaves, 0, 0, t0, t0 + 72 * H, 8, 3.05), null);
});

test('refusal text: a reading past the forecast end says the search went beyond it', () => {
  const text = refusalText({
    kind: 'over_limit',
    at: null,
    atMs: t0 + 5 * H,
    wind: { seen: 15.2, limit: 12.86 },
    waves: null,
    easesMs: null,
    untilMs: t0 + 2 * H,
    untilForecastEnd: true,
  });
  assert.match(text, new RegExp(`This is past the forecast's end, ${fmtUtc(t0 + 2 * H)}: the search went beyond the forecast`));
  assert.doesNotMatch(text, /do not meet all your limits/);
});

test('RouteRefused: the sentence plus the suffix is the message; the counts stay on the error', () => {
  const e = new RouteRefused(
    { kind: 'coast', at: null, atMs: t0 },
    'of the last stage’s 40 candidates, 40 crossing land',
    'boxed_in',
    ' The forecast ends.'
  );
  assert.equal(e.code, 'boxed_in');
  assert.match(e.message, /crosses land.* The forecast ends\.$/);
  assert.doesNotMatch(e.message, /40 candidates/);
  assert.match(e.detail, /40 crossing land/);
});
