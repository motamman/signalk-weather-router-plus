/**
 * Quantities on the page go through the unit helpers (public/rp-plan.js), run as the page defines them with the
 * helpers stubbed (as ensemblescreen.test.ts runs the page's tables): the interval of the conditions tabs'
 * precipitation and energy fields is the row's `interval_s` (fmtTime), relative humidity a ratio (_fmt 'ratio'), and
 * a leg's time in the itinerary the account's time unit (fmtTime).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Tab = { id: string; hover?: (r: Record<string, unknown>) => string };

test("the precipitation and energy hovers give the row's interval_s through fmtTime", () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const from = source.indexOf('const _COND_TABS = [');
  const to = source.indexOf('\n];\n', from) + 4;
  assert.ok(from > 0 && to > from, 'the slice of rp-plan.js is found');
  const context = {
    _BEAUFORT_NAMES: [],
    _PRECIP_COLORS: {},
    _cond: null,
    _fmt: (v: unknown, key: string) => `${key}(${String(v)})`,
    _fmtDegC: () => '',
    _tideUnit: () => ({}),
    fmtWavePeriod: () => '',
    unitDesc: () => ({}),
    fmtTime: (s: number) => `time(${s})`,
  };
  const tabs = runInNewContext(`${source.slice(from, to)}\n_COND_TABS`, context) as Tab[];
  const hover = (id: string, r: Record<string, unknown>): string => {
    const tab = tabs.find(t => t.id === id);
    assert.ok(tab && tab.hover, id);
    return tab.hover(r);
  };
  assert.equal(hover('precip', { precip_type_label: 'none', interval_s: 10800 }), ' · depth over time(10800)');
  assert.equal(hover('energy', { interval_s: 21600, mucape_jkg: null }), ' · average over time(21600)');
  // No interval (the energy fields off): nothing said of one.
  assert.equal(hover('precip', { precip_type_label: 'none', interval_s: null }), '');
  assert.equal(hover('temp', { rh: 0.62, dewpoint_k: null }), ' · RH ratio(0.62)');
});

test("an itinerary leg's time is the account's time unit (fmtTime)", () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const from = source.indexOf('function _legDescription(');
  const to = source.indexOf('\n}\n', from) + 3;
  assert.ok(from > 0 && to > from, 'the slice of rp-plan.js is found');
  const describe = runInNewContext(`${source.slice(from, to)}\n_legDescription`, {
    fmtWhen: String,
    fmtDist: (m: number) => `distance(${m})`,
    fmtTime: (s: number) => `time(${s})`,
    tackSide: () => null,
    _fmt: () => '',
    _seasHtml: () => '',
  }) as (p: object, isArrival: boolean) => unknown;
  const text = String(describe({ time: 't', leg_distance_m: 1000, leg_time_s: 5400 }, false));
  assert.ok(text.includes('Time time(5400)'), text);
});

test("an itinerary card's leg time is the account's time unit (fmtTime)", () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const from = source.indexOf('function _legCardHtml(');
  const to = source.indexOf('\n}\n', from) + 3;
  assert.ok(from > 0 && to > from, 'the slice of rp-plan.js is found');
  const none = (): null => null;
  const card = runInNewContext(`${source.slice(from, to)}\n_legCardHtml`, {
    fmtTime: (s: number) => `time(${s})`,
    fmtDist: (m: number) => `distance(${m})`,
    _kv: (k: string, v: string | null) => (v == null ? '' : `[${k} ${v}]`),
    formatTime: String,
    fmtSpeed: none,
    fmtAngleDeg: none,
    degToCardinal: none,
    pointOfSail: none,
    tackSide: none,
    fairFoul: none,
    fmtSwh: none,
    fmtWavePeriod: none,
    fmtDepth: none,
    _fmtRange: none,
    _seasHtml: none,
    _fmt: none,
    escapeHtml: String,
  }) as (f: object, i: number, cw: null) => string;
  const html = card({ getProperties: () => ({ next_mode: 'motoring', leg_distance_m: 1000, leg_time_s: 5400 }) }, 0, null);
  assert.ok(html.includes('[Time time(5400)]'), html);
});

test("the polar's performance factor under its diagram is a ratio in the account's unit (_fmt 'ratio')", () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-core.js'), 'utf8');
  const from = source.indexOf('function _polarInfoText(');
  const to = source.indexOf('\n}\n', from) + 3;
  assert.ok(from > 0 && to > from, 'the slice of rp-core.js is found');
  const info = runInNewContext(`${source.slice(from, to)}\n_polarInfoText`, {
    _fmt: (v: unknown, key: string) => `${key}(${String(v)})`,
  }) as (T: object, nW: number, label: string | null) => string;
  const T = { twa_deg: [40, 90, 150], performance_factor: 0.9 };
  assert.equal(info(T, 4, 'Catalina 36'), 'Catalina 36 — 3 angles × 4 wind speeds · performance ratio(0.9)');
  assert.equal(info({ twa_deg: [40] }, 1, null), '1 angles × 1 wind speeds');
});
