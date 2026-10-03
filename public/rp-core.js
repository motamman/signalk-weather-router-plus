// Weather Router Plus — route planner UI: core module.
// Display units from the Signal K preferences, formatting, the API base
// and authenticated fetch with its rate limiter and auth gate, the polar
// picker and diagram, the plugin status line. rp-layers.js, rp-plan.js
// and rp-settings.js import what they use from here.

import { CATEGORY_PATH, fetchDisplayUnits, fetchPresetUnits, unitFromDisplayUnits } from './rp-units.js';

// ─── Slider label wiring / display units ─────────────────────────────
// Display units come from the Signal K user's unit preferences, never
// from a choice on this page. Everything the plugin sends is SI. As the
// Signal K Unit Preferences guide describes for clients, the page reads
// `displayUnits` from path metadata,
//   GET /signalk/v1/api/vessels/self/<path>/meta
// which the server resolves for the logged-in user (category,
// targetUnit, formula, inverseFormula, symbol, displayFormat). The
// page's values aren't Signal K paths, so each quantity takes the
// displayUnits of one path in its category (paths from the server's
// default-categories mapping; rp-units.js, shared with the Freeboard panel).
// Quantities with no Signal K category:
//   wave_height → follows the user's depth unit (as tide height does)
//   wave_period → always seconds
//   precip      → mm/h when the user's length unit is metric, else in/h
// There is no fallback: until the metadata loads, or for any category
// the server doesn't resolve, values show as '—' and the Display
// section names what is missing.
const UNIT_CATEGORY = {
  speed: 'speed', distance: 'distance', depth: 'depth', short_distance: 'length',
  wave_height: 'depth', time: 'time', temperature: 'temperature', pressure: 'pressure',
  ratio: 'percentage', angle: 'angle', mass: 'mass', area: 'area', data_size: 'dataSize',
};
const METRIC_LENGTH_UNITS = ['m', 'meter', 'mm', 'cm', 'km', 'kilometer'];
const _ident = v => v;
const WAVE_PERIOD_UNIT = { unit: 's', fn: _ident, inv: _ident, precision: 0 };
export const UNIT_MISSING = '—';      // shown in place of a value whose unit is unresolved
export let UI_UNITS = {};             // page quantity → {unit, fn, inv, precision[, text]}; empty until loaded

// category → displayUnits (null where unresolved) → {units, missing}.
function _buildUnits(byCategory) {
  const u = {}, missing = new Set();
  const resolved = {};
  for (const [cat, du] of Object.entries(byCategory)) {
    resolved[cat] = unitFromDisplayUnits(du);
    if (!resolved[cat]) missing.add(cat);
  }
  for (const [key, cat] of Object.entries(UNIT_CATEGORY)) if (resolved[cat]) u[key] = resolved[cat];
  u.wave_period = WAVE_PERIOD_UNIT;
  const len = byCategory.length;
  if (resolved.length && len) {
    u.precip = METRIC_LENGTH_UNITS.includes(len.targetUnit)
      ? { unit: 'mm/h', fn: v => v * 3600000, inv: v => v / 3600000, precision: 1 }
      : { unit: 'in/h', fn: v => v * 3600000 / 25.4, inv: v => v * 25.4 / 3600000, precision: 2 };
  }
  return { units: u, missing: [...missing] };
}

const PRESET_CATEGORIES = ['dataSize'];

let _lastUnitsJson = null;
async function loadUnitPreferences() {
  const cats = Object.keys(CATEGORY_PATH);
  const [got, fromPreset] = await Promise.all([Promise.all(cats.map(fetchDisplayUnits)), fetchPresetUnits(PRESET_CATEGORIES)]);
  const byCategory = { ...Object.fromEntries(cats.map((c, i) => [c, got[i]])), ...fromPreset };
  const { units, missing } = _buildUnits(byCategory);
  let status = missing.length === Object.keys(byCategory).length
    ? 'Could not read your Signal K unit preferences, so values show as ' + UNIT_MISSING + '.'
    : 'Units from your Signal K unit preferences.';
  if (missing.length && missing.length < Object.keys(byCategory).length) {
    status += ' No unit for: ' + missing.join(', ') + ', so those values show as ' + UNIT_MISSING + '.';
  }
  const json = JSON.stringify(byCategory);
  if (json !== _lastUnitsJson) { _lastUnitsJson = json; UI_UNITS = units; applyDisplayUnits(); }
  const el = document.getElementById('unitSource');
  if (el) el.textContent = status;
}

// Re-render everything that shows a number: this file's own displays
// here, the other files' (legends, result strip, itinerary, conditions
// popup, route library) through the `rp:units` event.
function applyDisplayUnits() {
  refreshSliderLabels();
  fillUnitTokens();
  // Unit names next to inputs (.unitOf[data-q="<quantity>"]).
  for (const u of document.querySelectorAll('.unitOf[data-q]')) {
    const c = UI_UNITS[u.dataset.q];
    u.textContent = c ? c.unit : UNIT_MISSING;
  }
  drawPolarDiagram();
  window.dispatchEvent(new Event('rp:units'));
}

// Format helpers — null-safe, return null if input is null.
export function _fmt(siValue, key) {
  if (siValue == null) return null;
  const c = UI_UNITS[key];
  if (!c) return UNIT_MISSING;
  if (c.text) return c.text(siValue);
  const t = c.fn(siValue).toFixed(c.precision);
  return (t === '-0' ? '0' : t) + (c.unit ? ' ' + c.unit : '');
}
export function fmtSpeed(ms)        { return _fmt(ms, 'speed'); }
export function fmtDist(m)          { return _fmt(m, 'distance'); }
export function fmtDepth(m)         { return _fmt(m, 'depth'); }
export function fmtSwh(m)           { return _fmt(m, 'wave_height'); }
export function fmtWavePeriod(s)    { return _fmt(s, 'wave_period'); }
export function fmtTime(s)          { return _fmt(s, 'time'); }
export function fmtTemp(k)          { return _fmt(k, 'temperature'); }
export function fmtPressure(pa)     { return _fmt(pa, 'pressure'); }
export function fmtPrecip(rate)     { return _fmt(rate, 'precip'); }
// Text from the plugin (help, progress, errors) carries quantities as
// tokens {<Signal K unit category>:<value in its base unit>}. unitTextHtml
// escapes the text and turns each token into a span that fillUnitTokens
// writes in the user's unit for that category (again when it changes).
const UNIT_TOKEN = /\{([A-Za-z]+):([-0-9.e+]+)\}/g;
// Signal K category → the page quantity that holds the user's unit for it.
const TOKEN_QUANTITY = {
  length: 'short_distance', distance: 'distance', depth: 'depth', time: 'time',
  dataSize: 'data_size', speed: 'speed', angle: 'angle', percentage: 'ratio',
};
export function unitQuantityText(cat, si) {
  const c = UI_UNITS[TOKEN_QUANTITY[cat]];
  if (!c || !Number.isFinite(si)) return UNIT_MISSING;
  if (c.text) return c.text(si);
  return Number(c.fn(si).toPrecision(3)) + (c.unit ? ' ' + c.unit : '');
}
export function unitTextHtml(text) {
  return escapeHtml(text).replace(UNIT_TOKEN, (_, q, v) =>
    '<span class="uq" data-q="' + q + '" data-v="' + v + '">' + escapeHtml(unitQuantityText(q, Number(v))) + '</span>');
}
/** The same text with the tokens written out, for places that take plain text. */
export function unitText(text) {
  return String(text).replace(UNIT_TOKEN, (_, q, v) => unitQuantityText(q, Number(v)));
}
export function fillUnitTokens(root = document) {
  for (const el of root.querySelectorAll('.uq')) el.textContent = unitQuantityText(el.dataset.q, Number(el.dataset.v));
}

/** An angle the plugin gives in degrees, in the user's angle unit. */
export function fmtAngleDeg(deg)    { return deg == null ? null : _fmt(deg * Math.PI / 180, 'angle'); }
// Display-unit descriptor for chart axes and legends: {fn, u, p};
// fn converts SI → display (may be non-linear, e.g. Beaufort). When the
// unit is unresolved, `missing` is set and fn gives NaN.
export function unitDesc(key) {
  const c = UI_UNITS[key];
  return c ? { fn: c.fn, u: c.unit, p: c.precision } : { fn: () => NaN, u: '', p: 0, missing: true };
}

// Sliders hold SI (m/s for sail speed, metres for the distances,
// seconds otherwise) except the push angle (degrees, the plugin's angle
// unit); `toSI` maps the slider value to the category's base unit and the
// readout converts that to the user's unit.
const SLIDER_DISPLAY = {
  sailThresh:         { q: 'speed',          toSI: v => v },
  arrivalRadiusM:     { q: 'short_distance', toSI: v => v },
  proximityRadiusM:   { q: 'short_distance', toSI: v => v },
  xteThresholdM:      { q: 'short_distance', toSI: v => v },
  xteSustainSec:      { q: 'time',           toSI: v => v },
  simPushDeg:         { q: 'angle',          toSI: v => v * Math.PI / 180 },
};
function refreshSliderLabels() {
  for (const id of Object.keys(SLIDER_DISPLAY)) {
    const inp = document.getElementById(id), lbl = document.getElementById(id + 'Label');
    if (!inp || !lbl) continue;
    const d = SLIDER_DISPLAY[id], c = UI_UNITS[d.q];
    const u = document.querySelector('.unitOf[data-for="' + id + 'Label"]');
    // aria-valuetext: a screen reader reads the value in the user's unit, not the slider's SI value.
    if (!c) { lbl.textContent = UNIT_MISSING; if (u) u.textContent = ''; inp.setAttribute('aria-valuetext', UNIT_MISSING); continue; }
    const v = c.fn(d.toSI(parseFloat(inp.value)));
    lbl.textContent = v.toFixed(v >= 100 ? 0 : c.precision);
    if (u) u.textContent = c.unit;
    inp.setAttribute('aria-valuetext', lbl.textContent + (c.unit ? ' ' + c.unit : ''));
  }
  const st = document.getElementById('stages'), stl = document.getElementById('stagesLabel');
  if (st && stl) stl.textContent = parseInt(st.value, 10) > 0 ? st.value : 'auto';
}
(function () {
  const SLIDER_IDS = [
    'sailThresh', 'stages', 'arrivalRadiusM',
    'proximityRadiusM', 'xteThresholdM', 'xteSustainSec', 'simPushDeg',
  ];
  for (const id of SLIDER_IDS) {
    const inp = document.getElementById(id);
    const lbl = document.getElementById(id + 'Label');
    if (!inp || !lbl) continue;
    inp.addEventListener('input', () => {
      if (SLIDER_DISPLAY[id] || id === 'stages') refreshSliderLabels(); else lbl.textContent = inp.value;
    });
  }
  refreshSliderLabels();
  // Pick up the user's preferences now, and again when the page regains
  // focus (they may have changed them in the admin UI meanwhile).
  loadUnitPreferences();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadUnitPreferences(); });
})();

// ─── Sailing tack ────────────────────────────────────────────────────
// Convention (shared with the ZedDisplay client): `wind_dir_deg` is
// the direction the wind comes FROM; the API's `twa_deg` is unsigned
// 0..180 and carries no side, so the client derives it. The side is
// the wind's bearing relative to the bow, wind minus course, wrapped
// to 0..360: 0..180 means the wind is over the starboard rail
// (starboard tack), otherwise port. Course minus wind names the
// opposite tack — do not use it.
// Returns 'starboard', 'port', or null when either input is missing.
export function tackSide(cogDeg, windFromDeg) {
  if (cogDeg == null || windFromDeg == null) return null;
  const rel = ((windFromDeg - cogDeg) % 360 + 360) % 360;
  return rel <= 180 ? 'starboard' : 'port';
}
export const TACK_COLOR = { starboard: '#2E7D32', port: '#D32F2F' };

// ─── Exclusive heatmap layer group ───────────────────────────────────
// Only one full-map heatmap may be visible at a time. Wind barbs,
// vector tidal-current arrows, and synoptic pressure are NOT in this
// group — they don't fully cover the map and read fine alongside a
// heatmap.
(function () {
  const HEATMAP_TOGGLE_IDS = [
    'windCombinedToggle',
    'currentHeatmapToggle',
    'roughnessToggle',
    'wavesCombinedToggle',
    'precipToggle',
    'temperatureToggle',
    'sstToggle',
    'tideToggle',
  ];
  const inputs = HEATMAP_TOGGLE_IDS
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  inputs.forEach((inp) => {
    inp.addEventListener('change', function () {
      // We only need to enforce exclusivity when this toggle was
      // just TURNED ON. A user un-checking a heatmap just hides it;
      // siblings don't need to know.
      if (!this.checked) return;
      for (const other of inputs) {
        if (other === this) continue;
        if (!other.checked) continue;
        other.checked = false;
        // Re-fire the sibling's `change` event so its toggle
        // handler (rp-layers.js, which clears the layer source)
        // runs. The recursive entry into this same handler is a
        // no-op because `other.checked` is now false (see the
        // early return above).
        other.dispatchEvent(new Event('change'));
      }
    });
  });
})();

// ─── API base ────────────────────────────────────────────────────────
// The page is served at <base>/ui (base = /plugins/signalk-weather-
// router-plus); the API lives at <base>/api. Derive the base from the
// current path so a renamed plugin id or a proxy prefix still works.
const BASE = (function () {
  const m = window.location.pathname.match(/^(.*?)\/ui(?:\/|$)/);
  return m ? m[1] : '/plugins/signalk-weather-router-plus';
})();
export const API = BASE + '/api';

// Server and page are SI throughout; a number is converted only when it
// is formatted through UI_UNITS (the Signal K user's preferences). Knots
// appear in exactly one place: the wind-barb and current-arrow class
// tables (rp-layers.js), because barbs are a glyph drawn in 5-kt steps
// by meteorological convention. This is that one factor.
export const KT_MS = 1852 / 3600;

// ─────────── Auth gate / request circuit breaker ───────────
// Every same-origin app fetch funnels through authFetch(): a global
// token bucket caps the rate with exponential backoff on failure, and
// the first 401 trips a hard breaker that cancels in-flight requests,
// blocks all new ones, and routes to Signal K's login page once. A
// successful sign-in redirects back here, which starts the gate
// untripped. Signal K cookie auth — no bearer tokens.
export const AuthGate = {
  tripped: false,
  _inflight: new Set(),
  _stopHooks: [],
  _reauthStarted: false,
  track(c) { this._inflight.add(c); return c; },
  untrack(c) { this._inflight.delete(c); },
  onStop(fn) { this._stopHooks.push(fn); },
  trip(status) {
    if (this.tripped) return;
    this.tripped = true;
    console.warn('AuthGate: HTTP ' + status + ' — halting overlay requests');
    for (const c of this._inflight) { try { c.abort(); } catch (_) {} }
    this._inflight.clear();
    for (const fn of this._stopHooks) { try { fn(); } catch (_) {} }
    this._showBanner();
  },
  _showBanner() {
    if (document.getElementById('authExpiredBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'authExpiredBanner';
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b00020;color:#fff;' +
      'font:14px/1.4 system-ui,sans-serif;padding:10px 16px;display:flex;' +
      'align-items:center;justify-content:center;gap:12px;';
    bar.innerHTML =
      '<span>Signal K login required — map data has stopped loading.</span>' +
      '<button id="authReauthBtn" style="background:#fff;color:#b00020;border:0;' +
      'border-radius:4px;padding:6px 14px;font-weight:600;cursor:pointer;">Sign in</button>';
    document.body.appendChild(bar);
    document.getElementById('authReauthBtn').addEventListener('click', () => this.reauth());
    setTimeout(() => this.reauth(), 1500);   // unattended clients recover on their own
  },
  reauth() {
    if (this._reauthStarted) return;
    this._reauthStarted = true;
    const here = window.location.pathname + window.location.search + window.location.hash;
    window.location.assign('/admin/#/login?redirect=' + encodeURIComponent(here));
  },
};

// Global rate limiter (token bucket) + consecutive-failure backoff.
const _rate = { tokens: 30, max: 30, refill: 30, last: Date.now(), fails: 0, blockedUntil: 0 };
function _rateAcquire(signal) {
  // Abortable: a superseded pan/zoom request must stop waiting AND stop
  // holding its place in line.
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal) {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    (function attempt() {
      const now = Date.now();
      if (now < _rate.blockedUntil) { timer = setTimeout(attempt, _rate.blockedUntil - now); return; }
      _rate.tokens = Math.min(_rate.max, _rate.tokens + (now - _rate.last) / 1000 * _rate.refill);
      _rate.last = now;
      if (_rate.tokens >= 1) { _rate.tokens -= 1; cleanup(); resolve(); }
      else timer = setTimeout(attempt, Math.ceil((1 - _rate.tokens) / _rate.refill * 1000));
    })();
  });
}
function _rateNote(ok) {
  if (ok) { _rate.fails = 0; _rate.blockedUntil = 0; }
  else { _rate.fails = Math.min(_rate.fails + 1, 8);
         _rate.blockedUntil = Date.now() + Math.min(30000, 250 * 2 ** _rate.fails); }
}

// The single funnel for same-origin app fetches. `channel` makes a new
// request abort the prior one on that channel (pan/zoom supersession).
// 400 from an overlay endpoint ("no wave data in the forecast", "skt
// not loaded") is a routine answer, not a server failure: it must not
// wind up the backoff for every other caller.
const _authChannels = new Map();
export async function authFetch(url, opts, channel) {
  if (AuthGate.tripped) throw new Error('auth-gate-tripped');
  opts = Object.assign({ credentials: 'same-origin' }, opts || {});
  const ctrl = new AbortController();
  opts.signal = ctrl.signal;
  if (channel) {
    const prev = _authChannels.get(channel);
    if (prev) { try { prev.abort(); } catch (_) {} }
    _authChannels.set(channel, ctrl);
  }
  AuthGate.track(ctrl);
  try {
    await _rateAcquire(ctrl.signal);
    if (AuthGate.tripped) throw new Error('auth-gate-tripped');
    const r = await fetch(url, opts);
    _rateNote(r.ok || r.status === 400 || r.status === 404 || r.status === 409 || r.status === 422 || r.status === 403);
    if (r.status === 401) {
      AuthGate.trip(r.status);
      const err = new Error('auth ' + r.status);
      err.rateNoted = true;
      throw err;
    }
    if (r.status === 403) {
      // Logged in but lacking permission (readonly user hitting a
      // write route) — a real answer, not a dead session.
      const err = new Error('permission denied (HTTP 403)');
      err.scopeMiss = true;
      err.rateNoted = true;
      throw err;
    }
    return r;
  } catch (e) {
    if (e.name !== 'AbortError' && !e.scopeMiss && !e.rateNoted) _rateNote(false);
    throw e;
  }
  finally {
    AuthGate.untrack(ctrl);
    if (channel && _authChannels.get(channel) === ctrl) _authChannels.delete(channel);
  }
}

// Error text out of a plugin JSON error body ({error} or {message}).
export async function _apiErrorText(r) {
  try {
    const d = await r.clone().json();
    return (d && (d.error || d.message)) ? unitText(String(d.error || d.message)) : ('HTTP ' + r.status);
  } catch (_) { return 'HTTP ' + r.status; }
}

// Replan EventSource handle so the gate can close it on trip.
// Set default departure to now — `datetime-local` inputs interpret their
// value as LOCAL time, so build a local-time YYYY-MM-DDTHH:MM string.
const now = new Date();
now.setMinutes(0, 0, 0);
const _pad = n => String(n).padStart(2, '0');
document.getElementById('departure').value =
    `${now.getFullYear()}-${_pad(now.getMonth() + 1)}-${_pad(now.getDate())}` +
    `T${_pad(now.getHours())}:${_pad(now.getMinutes())}`;

// ─────────── Polar picker (GET /api/polars) ───────────
let _polarItems = [];

function _renderPolarOptions(filterText) {
  const sel = document.getElementById('polarSelect');
  const needle = (filterText || '').trim().toLowerCase();
  const filtered = needle
    ? _polarItems.filter(it => it.label.toLowerCase().includes(needle)
                            || it.path.toLowerCase().includes(needle))
    : _polarItems;
  const current = sel.value;
  sel.innerHTML = filtered.map(it => {
    const opt = document.createElement('option');
    opt.value = it.path;
    opt.textContent = it.label;
    return opt.outerHTML;
  }).join('') || '<option value="">(no matches)</option>';
  // Preserve current selection if still visible; otherwise pick first match.
  if (filtered.some(it => it.path === current)) {
    sel.value = current;
  } else if (filtered.length > 0) {
    sel.value = filtered[0].path;
  }
}

function loadPolarList() {
  const sel = document.getElementById('polarSelect');
  return authFetch(API + '/polars', {}, null)
    .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Cannot load polars'); return data; })
    .then(items => {
      if (!Array.isArray(items) || items.length === 0) {
        sel.innerHTML = '<option value="">(no polars found — select a polar in Polar Management or configure a local polar source)</option>';
        _polarItems = [];
        _polarAngles = null; _polarTable = null;
        drawPolarDiagram();
        return;
      }
      document.getElementById('openVesselForm').hidden = false;
      document.getElementById('polarFilter').hidden = false;
      _polarItems = items;
      _renderPolarOptions('');
      // Prefer the last-used selection if it's still in the list;
      // otherwise fall back to the vessel default (first item).
      const stored = (() => { try { return localStorage.getItem('polarChoiceV2') || ''; } catch (_) { return ''; } })();
      const paths = items.map(it => it.path);
      sel.value = paths.includes(stored) ? stored : paths[0];
      loadPolarAngles(sel.value);
      loadPolarTable(sel.value);
    })
    .catch(e => {
      sel.innerHTML = '<option value="">(error loading polars)</option>';
      _polarItems = []; _polarAngles = null; _polarTable = null;
      drawPolarDiagram();
      document.getElementById('polarInfo').textContent = e.message;
      console.log('Polar list error:', e);
    });
}

export let _polarAngles = null;   // { tws_ms:[], beat_deg:[], run_deg:[] }
function loadPolarAngles(polarPath) {
  if (!polarPath) { _polarAngles = null; drawPolarDiagram(); return; }
  authFetch(API + '/polar-angles?path=' + encodeURIComponent(polarPath), {}, 'polar-angles')
    .then(r => r.ok ? r.json() : null)
    .then(d => { _polarAngles = d; drawPolarDiagram(); })
    .catch(() => { _polarAngles = null; });
}

// The angles of any polar (a /api/polars token; '' = the default), without
// touching the picker's: for the points of sail of a route computed with it.
export function fetchPolarAngles(token) {
  return authFetch(API + '/polar-angles?path=' + encodeURIComponent(token || ''), {}, null)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
}

// ─────────── Polar diagram (GET /api/polars/table) ───────────
// Half polar, TWA 0–180° clockwise from the top, one curve per TWS,
// radius = boat speed in the display speed unit. Beat/run angles from
// /polar-angles are dotted on each curve.
let _polarPreviewGen = 0;
let _polarTable = null;    // { twa_deg:[], tws_ms:[], speeds_ms:[][] } rows = twa
function loadPolarTable(polarPath) {
  const gen = ++_polarPreviewGen;
  if (!polarPath) { _polarTable = null; drawPolarDiagram(); return; }
  authFetch(API + '/polars/table?path=' + encodeURIComponent(polarPath), {}, 'polar-table')
    .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error ? unitText(d.error) : 'HTTP ' + r.status))))
    .then(d => {
      if (gen !== _polarPreviewGen) return;
      _polarTable = d; drawPolarDiagram();
      const hint = document.getElementById('polarSourceHint');
      const automatic = polarPath === 'auto';
      hint.textContent = d.source === 'signalk'
        ? 'Active source: Polar Management — ' + d.label + (automatic ? ' (automatically detected).' : ' (selected override).')
        : 'Active source: internal polar — ' + d.label + (automatic ? ' (fallback; no usable managed polar detected).' : ' (selected override).');
      const link = document.createElement('a'); link.href = '/signalk-polar-management/'; link.textContent = 'Open Polar Management';
      hint.appendChild(document.createTextNode(' ')); hint.appendChild(link);
    })
    .catch(err => {
      if (gen !== _polarPreviewGen) return;
      document.getElementById('polarSourceHint').textContent = 'Active source unavailable: ' + err.message;
      _polarTable = null; drawPolarDiagram();
      const info = document.getElementById('polarInfo');
      if (info) info.textContent = 'Polar table unavailable: ' + err.message;
    });
}
const _POLAR_TWS_COLORS = ['#90caf9', '#4fc3f7', '#00897b', '#43a047', '#f9a825', '#e64a19', '#c62828', '#8a0000', '#6a1b9a', '#ad1457', '#37474f', '#000'];
export function drawPolarDiagram() {
  const canvas = document.getElementById('polarDiagram');
  const info = document.getElementById('polarInfo');
  if (!canvas) return;
  // PLOT_H is the diagram; the strip below it holds the caption, clear of the 180° label.
  const W = 380, PLOT_H = 300, H = PLOT_H + 16;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px sans-serif';
  const T = _polarTable;
  if (!T || !Array.isArray(T.twa_deg) || !Array.isArray(T.tws_ms) || !T.twa_deg.length || !T.tws_ms.length) {
    ctx.fillStyle = '#888'; ctx.textAlign = 'center';
    ctx.fillText(_polarItems.length ? 'Loading polar…' : 'No polar loaded', W / 2, H / 2);
    if (info && !T) info.textContent = '';
    return;
  }
  const u = unitDesc('speed'); u.p = 0;
  if (u.missing) {
    ctx.fillStyle = '#888'; ctx.textAlign = 'center';
    ctx.fillText('No speed unit from your Signal K unit preferences', W / 2, H / 2);
    return;
  }
  const cx = 96, cy = PLOT_H / 2, R = Math.min(cy - 18, W - cx - 14);
  let vmax = 0;
  for (const row of T.speeds_ms) for (const v of row) if (Number.isFinite(v)) vmax = Math.max(vmax, u.fn(v));
  if (vmax <= 0) vmax = 1;
  // Ring step: a round number in the display unit giving 3–6 rings.
  const rawStep = vmax / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= rawStep) || rawStep;
  const rmax = Math.ceil(vmax / step) * step;
  const rOf = v => v / rmax * R;
  const xy = (twa, v) => { const a = twa * Math.PI / 180; return [cx + Math.sin(a) * rOf(v), cy - Math.cos(a) * rOf(v)]; };
  // Rings + radial spokes.
  ctx.strokeStyle = '#e0e0e0'; ctx.fillStyle = '#777'; ctx.lineWidth = 1;
  for (let v = step; v <= rmax + 1e-9; v += step) {
    ctx.beginPath(); ctx.arc(cx, cy, rOf(v), -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(v.toFixed(u.p), cx - 3, cy - rOf(v) + 1);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let a = 0; a <= 180; a += 30) {
    const [x, y] = xy(a, rmax);
    ctx.strokeStyle = a % 90 === 0 ? '#bbb' : '#eaeaea';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    const [lx, ly] = xy(a, rmax * 1.06);
    ctx.fillStyle = '#555';
    ctx.textAlign = a === 0 || a === 180 ? 'center' : 'left';
    ctx.fillText(fmtAngleDeg(a), lx, ly);
  }
  ctx.strokeStyle = '#999'; ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  // One curve per TWS.
  const nW = T.tws_ms.length;
  for (let k = 0; k < nW; k++) {
    const color = _POLAR_TWS_COLORS[Math.min(k, _POLAR_TWS_COLORS.length - 1)];
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    let up = true;
    for (let i = 0; i < T.twa_deg.length; i++) {
      const v = T.speeds_ms[i] ? T.speeds_ms[i][k] : null;
      if (v == null || !Number.isFinite(v)) { up = true; continue; }
      const [x, y] = xy(T.twa_deg[i], u.fn(v));
      if (up) { ctx.moveTo(x, y); up = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Beat / run angle markers from /polar-angles.
    if (_polarAngles && Array.isArray(_polarAngles.tws_ms)) {
      const j = _polarAngles.tws_ms.findIndex(t => Math.abs(t - T.tws_ms[k]) < 1e-6);
      if (j >= 0) {
        for (const ang of [_polarAngles.beat_deg[j], _polarAngles.run_deg[j]]) {
          if (ang == null) continue;
          const v = _polarSpeedAt(T, ang, k);
          if (v == null) continue;
          const [x, y] = xy(ang, u.fn(v));
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        }
      }
    }
  }
  // Legend: TWS per curve, in the display speed unit.
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '10px sans-serif';
  const lx = 6; let ly = 14;
  ctx.fillStyle = '#333'; ctx.fillText('TWS (' + u.u + ')', lx, ly); ly += 13;
  for (let k = 0; k < nW; k++) {
    ctx.fillStyle = _POLAR_TWS_COLORS[Math.min(k, _POLAR_TWS_COLORS.length - 1)];
    ctx.fillRect(lx, ly - 4, 14, 3);
    ctx.fillStyle = '#333'; ctx.fillText(u.fn(T.tws_ms[k]).toFixed(u.p), lx + 18, ly);
    ly += 12;
    if (ly > PLOT_H - 8) break;
  }
  ctx.fillStyle = '#777'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('rings: boat speed (' + u.u + ') · dots: beat / run VMG angles', lx, H - 4);
  if (info) {
    const sel = document.getElementById('polarSelect');
    const it = _polarItems.find(p => p.path === (sel ? sel.value : ''));
    info.textContent = (it ? it.label + ' — ' : '') + T.twa_deg.length + ' angles × ' + nW + ' wind speeds' + (T.performance_factor != null ? ' · performance ' + Math.round(T.performance_factor * 100) + '%' : '');
  }
}
// Linear interpolation of a polar row at an arbitrary TWA for curve k.
function _polarSpeedAt(T, twa, k) {
  const A = T.twa_deg;
  if (!A.length) return null;
  if (twa <= A[0]) return T.speeds_ms[0][k];
  if (twa >= A[A.length - 1]) return T.speeds_ms[A.length - 1][k];
  for (let i = 1; i < A.length; i++) {
    if (twa <= A[i]) {
      const f = (twa - A[i - 1]) / (A[i] - A[i - 1]);
      const a = T.speeds_ms[i - 1][k], b = T.speeds_ms[i][k];
      if (a == null || b == null) return a == null ? b : a;
      return a + f * (b - a);
    }
  }
  return null;
}

document.getElementById('polarSelect').addEventListener('change', function() {
  try { localStorage.setItem('polarChoiceV2', this.value); } catch (_) {}
  loadPolarAngles(this.value);
  loadPolarTable(this.value);
});

// ─────────── Persist route-variable controls across reloads ───────────
// All route params except `departure` (which should default to "now"
// each session) are saved to localStorage on change and restored on
// load. Ranges fire an 'input' event after restore so the paired
// labels update to match.
(function() {
  const PERSIST_IDS = [
    'mode', 'sailThresh', 'stages', 'arrivalRadiusM', 'precision',
    'publishSel', 'proximityRadiusM', 'xteThresholdM', 'xteSustainSec',
  ];
  const CHECK_IDS = ['noCurrents', 'noForecast', 'regionalWind'];
  // The sail-speed slider held knots until 2026-10; it holds m/s now under a new key.
  try {
    const old = localStorage.getItem('routeVar:sailThresh');
    if (old !== null) {
      if (old !== '' && localStorage.getItem('routeVar:sailThreshMs') === null)
        localStorage.setItem('routeVar:sailThreshMs', String(Math.round(parseFloat(old) * KT_MS * 10) / 10));
      localStorage.removeItem('routeVar:sailThresh');
    }
  } catch (_) {}
  const KEY = (id) => 'routeVar:' + (id === 'sailThresh' ? 'sailThreshMs' : id);
  for (const id of PERSIST_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    let saved = null;
    try { saved = localStorage.getItem(KEY(id)); } catch (_) {}
    if (saved != null && saved !== '') {
      el.value = saved;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.addEventListener('change', function() {
      try { localStorage.setItem(KEY(id), el.value); } catch (_) {}
    });
    if (el.type === 'range') {
      el.addEventListener('input', function() {
        try { localStorage.setItem(KEY(id), el.value); } catch (_) {}
      });
    }
  }
  for (const id of CHECK_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    let saved = null;
    try { saved = localStorage.getItem(KEY(id)); } catch (_) {}
    if (saved === 'true' || saved === 'false') el.checked = saved === 'true';
    el.addEventListener('change', function() {
      try { localStorage.setItem(KEY(id), el.checked ? 'true' : 'false'); } catch (_) {}
    });
  }
})();

document.getElementById('polarFilter').addEventListener('input', function() {
  _renderPolarOptions(this.value);
});
loadPolarList();
setInterval(loadPolarList, 30000);

// ─────────── Vessel/polar specs form (VPP generator) ───────────
// POST /api/polar-from-specs runs the plugin's polar calculator on the specs
// and writes <polarsDir>/user/<slug>.csv; the new polar is then selected
// in the picker. There is no online boat-specs search: a Signal K server
// on a boat is often offline and the plugin makes no third-party calls
// from the browser. The plain sailboatdata.com link stays.
(function() {
  const overlay = document.getElementById('vesselOverlay');
  const openBtn = document.getElementById('openVesselForm');
  const closeBtn = document.getElementById('vesselClose');
  const cancelBtn = document.getElementById('vf_cancel');
  const generateBtn = document.getElementById('vf_generate');
  const sbdLink = document.getElementById('sbdLink');
  const resultDiv = document.getElementById('vf_result');
  const warnDiv = document.getElementById('vf_warnings');

  function openModal() {
    overlay.style.display = 'flex';
    resultDiv.innerHTML = '';
    warnDiv.innerHTML = '';
  }
  function closeModal() {
    overlay.style.display = 'none';
  }
  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  // Update the sailboatdata link to use the current boat name as a
  // hint for the user's search.
  document.getElementById('vf_name').addEventListener('input', function() {
    const name = this.value.trim();
    if (name) {
      sbdLink.href = 'https://sailboatdata.com/?s=' + encodeURIComponent(name);
    } else {
      sbdLink.href = 'https://sailboatdata.com/';
    }
  });

  function post(body) {
    return authFetch(API + '/polar-from-specs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, null);
  }

  // The boat-spec fields: input id, SI key sent, page quantity (its unit
  // from the Signal K preferences), label for messages.
  const SPEC_FIELDS = [
    { id: 'vf_loa', key: 'loa_m', q: 'short_distance', label: 'LOA', required: true },
    { id: 'vf_lwl', key: 'lwl_m', q: 'short_distance', label: 'LWL', required: true },
    { id: 'vf_beam', key: 'beam_m', q: 'short_distance', label: 'Beam', required: true },
    { id: 'vf_draft', key: 'draft_m', q: 'short_distance', label: 'Draft', required: true },
    { id: 'vf_disp', key: 'displacement_kg', q: 'mass', label: 'Displacement', required: true },
    { id: 'vf_ballast', key: 'ballast_kg', q: 'mass', label: 'Ballast', required: false },
    { id: 'vf_sa_up', key: 'sail_area_upwind_m2', q: 'area', label: 'Upwind sail area', required: true },
  ];
  const SPEC_UNIT_NAMES = { short_distance: 'length', mass: 'mass', area: 'area' };
  // A field without a unit can't be typed in: disabled, its label shows the missing mark.
  function syncSpecInputs() {
    for (const f of SPEC_FIELDS) document.getElementById(f.id).disabled = !UI_UNITS[f.q];
  }
  window.addEventListener('rp:units', syncSpecInputs);
  syncSpecInputs();
  // The server's spec error (field and limits in SI) in the user's units.
  function _specErrorText(data) {
    const f = data && SPEC_FIELDS.find(x => x.key === data.field);
    if (!f || data.value == null) return null;
    const v = _fmt(data.value, f.q);
    if (data.longer_than) {
      const o = SPEC_FIELDS.find(x => x.key === data.longer_than.field);
      return f.label + ' ' + v + ' is longer than ' + (o ? o.label : data.longer_than.field) + ' ' + _fmt(data.longer_than.value, f.q) + '; swapped?';
    }
    return f.label + ' ' + v + ' is outside ' + _fmt(data.min, f.q) + ' to ' + _fmt(data.max, f.q) + '.';
  }

  generateBtn.addEventListener('click', async function() {
    warnDiv.innerHTML = '';
    resultDiv.innerHTML = '';

    const g = id => document.getElementById(id);
    const name = g('vf_name').value.trim();
    if (!name) {
      warnDiv.innerHTML = 'Boat name is required.';
      return;
    }

    // Typed in the user's units (labels from the Signal K preferences),
    // sent in SI. No unit for a field → refuse rather than guess one.
    const specs = {};
    const missingUnits = new Set();
    for (const f of SPEC_FIELDS) {
      const v = g(f.id).value.trim();
      if (v === '') {
        if (f.required) { warnDiv.innerHTML = 'Missing required value: ' + escapeHtml(f.label) + '.'; return; }
        specs[f.key] = null;
        continue;
      }
      const c = UI_UNITS[f.q];
      if (!c || !c.inv) { missingUnits.add(f.q); continue; }
      const x = c.inv(parseFloat(v));
      if (!Number.isFinite(x)) { warnDiv.innerHTML = escapeHtml(f.label) + ' is not a number.'; return; }
      specs[f.key] = x;
    }
    if (missingUnits.size) {
      warnDiv.innerHTML = 'No unit in your Signal K unit preferences for: ' + escapeHtml([...missingUnits].map(q => SPEC_UNIT_NAMES[q]).join(', ')) + '.';
      return;
    }

    const body = {
      name: name,
      specs: {
        ...specs,
        rig_type: g('vf_rig').value,
        keel_type: g('vf_keel').value,
        hull_type: 'monohull',
      },
      overwrite: false,
    };

    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    try {
      let resp = await post(body);
      if (resp.status === 409) {
        if (!confirm('A polar with that name already exists. Overwrite?')) {
          return;
        }
        body.overwrite = true;
        resp = await post(body);
      }
      const data = await resp.json();
      if (!resp.ok) {
        warnDiv.innerHTML = 'Error: ' + escapeHtml(_specErrorText(data) || data.error || data.detail || resp.status);
        return;
      }
      const warnings = (data.warnings || []).join('; ');
      resultDiv.innerHTML =
        '<div style="color:#2a7;">✓ Polar saved to ' + escapeHtml(data.path) + ' (' + escapeHtml(data.label) + ')</div>'
        + (warnings ? '<div style="color:#c60;margin-top:4px;">Warnings: ' + escapeHtml(warnings) + '</div>' : '')
        + '<div style="margin-top:8px;">Refreshing polar list…</div>';

      // Refresh the polar dropdown so the new entry appears, and select it.
      // Stored first: loadPolarList() restores the stored path and loads
      // its angles and diagram. The filter is cleared so the entry shows.
      try { localStorage.setItem('polarChoiceV2', data.path); } catch (_) {}
      const filt = document.getElementById('polarFilter');
      if (filt) filt.value = '';
      await loadPolarList();
      const sel = document.getElementById('polarSelect');
      let found = false;
      for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === data.path) {
          if (sel.selectedIndex !== i) {
            sel.selectedIndex = i;
            loadPolarAngles(sel.value);
            loadPolarTable(sel.value);
          }
          found = true;
          break;
        }
      }
      resultDiv.innerHTML += found
        ? '<div style="color:#2a7;margin-top:4px;">Selected as active polar.</div>'
        : '<div style="color:#c60;margin-top:4px;">Saved, but it is not in the polar list (check the plugin\'s polars directory).</div>';
    } catch (e) {
      warnDiv.innerHTML = 'Request failed: ' + unitTextHtml(e.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate polar';
    }
  });
})();

// A time as "Thu 06:00 PM" in the browser's locale; '' when missing or invalid.
export function fmtWhen(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

/** Text for innerHTML: escapes &, <, >, " and '. */
export function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Regional GRIB runs found from signalk-grib-downloader (discovery only so far).
// The area the header's sources are filtered by: the loaded route's
// extent, else the map view, as { west, south, east, north } in degrees
// (east may exceed 180 across the antimeridian). Set by the planning page.
let _statusArea = null;
let _lastStatus = null;
export function setStatusArea(fn) { _statusArea = fn; }
/** Redraw the header from the last status (after the route or the map view changed). */
export function redrawStatusLine() {
  const el = document.getElementById('dataStatus');
  if (el && _lastStatus) el.innerHTML = _statusLine(_lastStatus);
}
// Does a source's box meet the area? Longitudes compared across the antimeridian.
function _meets(b, a) {
  if (!b || !a) return true;
  if (b.north < a.south || b.south > a.north) return false;
  if (a.east - a.west >= 360) return true;
  // A map view panned round the globe sits in a wrapped world copy (lon 500…).
  const shift = Math.floor((a.west + 180) / 360) * 360;
  a = { west: a.west - shift, east: a.east - shift };
  let bw = b.west, be = b.east;
  if (be < bw) be += 360;
  for (const k of [-360, 0, 360]) if (a.west + k <= be && a.east + k >= bw) return true;
  return false;
}
function _area() {
  try { return _statusArea ? _statusArea() : null; } catch (_) { return null; }
}

// "2026-10-03T00:00Z" or "2026100300" → "03 Oct 00Z" (UTC), for the header.
const _MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function _shortUtc(v) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T?(\d{2})/.exec(String(v));
  return m ? m[3] + ' ' + _MON[+m[2] - 1] + ' ' + m[4] + 'Z' : escapeHtml(v);
}
// An ISO time as "Mon 20:00 EDT" in the browser's time zone, the UTC time as its tooltip.
function _shortLocal(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return escapeHtml(iso || '');
  const local = d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return '<span title="' + escapeHtml(d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC') + '">' + escapeHtml(local) + '</span>';
}

// Regional wind models whose grid meets the route or the map view, as text for the wind line.
function _regionalWind(r, area) {
  if (!r) return '';
  const ok = (r.sources || []).filter(x => x.run && !x.problem && (!x.domain || _meets(x.domain, area)));
  if (!ok.length) {
    // The downloader is there but has nothing usable: say why.
    return r.root && !(r.sources || []).some(x => x.run && !x.problem)
      ? ' · regional: <span class="warn">' + escapeHtml(r.note || ((r.sources || [])[0] || {}).problem || 'no complete run') + '</span>'
      : '';
  }
  const rw = document.getElementById('regionalWind');
  const off = rw && !rw.checked ? ' <span class="warn">(off for routes: Regional wind unticked)</span>' : '';
  return ' · ' + ok.map(x => {
    const d = x.decoded;
    const state = d && d.error ? ' <span class="warn">' + unitTextHtml(d.error) + '</span>'
      : d && d.cycle && x.run.slice(0, 13).replace(/[-T]/g, '') === d.cycle ? ' (decoded)'
      : ' (decoding)';
    return escapeHtml(x.name) + ' ' + _shortUtc(x.run) + (x.validTo ? ', to ' + _shortLocal(x.validTo) : '') + state;
  }).join(', ') + off;
}

function _statusLine(s) {
  const f = s.forecast;
  if (s.starting) return '<span class="warn">' + unitTextHtml(s.starting) + '</span>';
  if (!f) return '<span class="warn">no forecast loaded</span>' + (s.forecast_error ? ': ' + unitTextHtml(s.forecast_error) : ' (loading)');
  const area = _area();
  const run = escapeHtml(f.model || 'forecast') + ' <span class="nowrap">' + _shortUtc(f.cycle) + ' → ' + _shortLocal(f.valid_to) + '</span>';
  // Only the current sources that apply to the route or the map view. SMOC
  // is worldwide (any area loads on demand), its box is only the standing
  // area around the boat; the others cover their own box.
  const applies = c => /SMOC/i.test(c.name) || _meets(c.bbox, area);
  const curList = Array.isArray(s.currents) ? s.currents.filter(applies) : [];
  const t = s.tides;
  const tides = s.tides_enabled === false ? 'off (Settings)'
    : s.tides_error ? '<span class="warn">' + unitTextHtml(s.tides_error) + '</span>'
    : t ? escapeHtml(t.name.replace(/ hourly sea level \((\S+) tide\)/, ' ($1)')) + (t.run ? ', run ' + _shortUtc(t.run) : '')
    : 'loading';
  const row = (k, v) => '<span class="statusKey">' + k + '</span> ' + v;
  return row('wind', run + _regionalWind(s.regional, area))
    + '<br>' + row('waves', f.has_waves ? escapeHtml(f.model || 'forecast') + ', same run' : '<span class="warn">none in this run</span>')
    + '<br>' + row('currents', curList.length ? curList.map(c => escapeHtml(c.name)).join(', ') : 'none here')
    + '<br>' + row('tides', tides)
    + (s.jobs ? '<br>' + row('jobs', (s.jobs.running ? 'running' : 'idle') + ', ' + s.jobs.queued + ' queued') : '')
    // A refused reload (e.g. the memory guard) while the previous forecast keeps serving.
    + (s.forecast_error ? '<br><span class="warn">' + unitTextHtml(s.forecast_error) + '</span>' : '');
}
let _statusSoon = null;
// ─────────── Plugin status (header line + Forecast data section) ───────────
export function loadPluginStatus() {
  const el = document.getElementById('dataStatus');
  const fi = document.getElementById('forecastInfo');
  return authFetch(API + '/status', { cache: 'no-store' }, 'status')
    .then(r => r.json())
    .then(s => {
      _lastStatus = s;
      if (el) el.innerHTML = _statusLine(s);
      // First start (coastline, first forecast): check again soon, not in 30 s.
      clearTimeout(_statusSoon);
      if (s.starting || !s.forecast) _statusSoon = setTimeout(loadPluginStatus, 5000);
      if (fi) {
        const f = s.forecast;
        fi.innerHTML = f
          ? 'Cycle <b>' + f.cycle + '</b><br>valid ' + f.valid_from + ' → ' + f.valid_to + '<br>coverage ' + (f.coverage || 'global')
            + (typeof f.decoded_bytes === 'number' ? ', ' + _fmt(f.decoded_bytes, 'data_size') + ' decoded on disk' : '')
            + (f.memory ? ', ' + _fmt(f.memory.data_worker_held_bytes + f.memory.route_worker_held_bytes, 'data_size') + ' in memory now' : '')
            + '<br>params: ' + (f.params || []).join(', ') + (s.extra_fields ? '' : '<br><span style="color:var(--warn)">extra fields (temperature, precipitation, SST, humidity) are off in Settings</span>')
            + (s.rtofs_run ? '<br>RTOFS run ' + s.rtofs_run : '')
            + (s.vessel ? '<br>vessel ' + (s.vessel.name || '—') + ', motor ' + (fmtSpeed(s.vessel.motorSpeedMs) || '—') : '')
          : '<span style="color:var(--warn)">No forecast loaded' + (s.forecast_error ? ': ' + unitTextHtml(s.forecast_error) : '') + '</span>';
      }
      window.dispatchEvent(new Event('rp:status'));
    })
    .catch(e => { if (el) el.innerHTML = '<span class="err">status unavailable</span>: ' + e.message; });
}
loadPluginStatus();
setInterval(loadPluginStatus, 30000);
document.getElementById('refreshForecast').addEventListener('click', function() {
  const st = document.getElementById('refreshForecastStatus');
  st.textContent = 'requesting…';
  authFetch(API + '/forecast/refresh', { method: 'POST' }, null)
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(() => { st.textContent = 'refresh requested — status updates in a moment'; setTimeout(loadPluginStatus, 4000); setTimeout(loadPluginStatus, 15000); })
    .catch(e => { st.textContent = 'refresh failed: ' + e.message; });
});

