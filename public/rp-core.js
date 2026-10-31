// Weather Router Plus — route planner UI: core module.
// Display units from the Signal K preferences, formatting, the API base
// and authenticated fetch with its rate limiter and auth gate, the polar
// picker and diagram, the plugin status line. rp-layers.js, rp-plan.js
// and rp-settings.js import what they use from here.

import { prefs } from './rp-prefs.js';
import { CATEGORY_PATH, DURATION_FORMATS, fetchDisplayUnits, fetchPresetUnits, unitFromDisplayUnits } from './rp-units.js';

// The user's Setup choices come from the server before anything reads
// them (rp-prefs.js): this await holds back the rest of this module and
// every module that imports it, for one request (3 s at most).
await prefs.load();

// Setup choices this browser held before they were kept per user have no
// owner: they stay in use here, and go to the user's record only when the
// user says they are theirs. Discard drops them and reloads with the defaults.
// With security off the record is every browser's (prefs.shared).
(function legacyChoicesBanner() {
  const choices = prefs.legacyChoices();
  const head = document.getElementById('panelHead');
  const tabs = document.getElementById('tabBar');
  if (!choices.length || !prefs.user || !prefs.remote || !head || !tabs) return;
  const polar = choices.find(([k]) => k === 'polarPath');
  const polarText = polar ? 'the polar ' + polar[1].replace(/\.[^.]+$/, '').replace(/_/g, ' ') : null;
  const rest = choices.length - (polar ? 1 : 0);
  const what = [polarText, rest ? rest + (polar ? ' more' : ' route option' + (rest === 1 ? '' : 's')) : null].filter(Boolean).join(' and ');
  const bar = document.createElement('div');
  bar.id = 'legacyChoicesBanner';
  bar.className = 'recompute-banner';
  bar.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = prefs.shared
    ? 'This browser has Setup choices from before they were shared by every browser on this server (' + what + '). Keep them for everyone?'
    : 'This browser has Setup choices from before they were kept per Signal K user (' + what + '). Keep them as ' + prefs.user + '’s?';
  const actions = document.createElement('span');
  actions.className = 'recompute-actions';
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.textContent = 'Keep';
  keep.title = prefs.shared
    ? 'Save them on the server: every browser starts with them'
    : 'Save them for ' + prefs.user + ': every browser this user opens starts with them';
  const drop = document.createElement('button');
  drop.type = 'button';
  drop.textContent = 'Discard';
  drop.title = 'Drop them from this browser and start from the defaults (the page reloads)';
  keep.addEventListener('click', () => { prefs.keepLegacy(); bar.remove(); });
  drop.addEventListener('click', () => { prefs.discardLegacy(); window.location.reload(); });
  actions.append(keep, drop);
  bar.append(text, actions);
  head.insertBefore(bar, tabs);
})();

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
  for (const u of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.unitOf[data-q]'))) {
    const c = UI_UNITS[u.dataset.q];
    u.textContent = c ? c.unit : UNIT_MISSING;
  }
  drawPolarDiagram();
  window.dispatchEvent(new Event('rp:units'));
}

// Format helpers — null-safe, return null if input is null.
// Durations of a day or more are written as days, hours and minutes
// (Signal K's own duration-compact format, "9d 7h 0m") whatever the user's
// time unit: a passage of "223.0 hour" reads badly. A deliberate exception
// to following the Signal K unit preference, for durations only; shorter
// ones follow the preference as everything else does.
export const LONG_DURATION_S = 86400;
export function longDurationText(s) {
  return Number.isFinite(s) && Math.abs(s) >= LONG_DURATION_S ? DURATION_FORMATS.formatDurationCompact(s) : null;
}
export function _fmt(siValue, key) {
  if (siValue == null) return null;
  if (key === 'time') { const long = longDurationText(siValue); if (long) return long; }
  const c = UI_UNITS[key];
  if (!c) return UNIT_MISSING;
  if (c.text) return c.text(siValue);
  const t = c.fn(siValue).toFixed(c.precision);
  return (t === '-0' ? '0' : t) + unitSuffix(c.unit);
}
// The unit after the number: a space before "kn", "m", "hPa"; none before "°" and "%".
export function unitSuffix(unit) {
  return unit ? (unit === '°' || unit === '%' ? unit : ' ' + unit) : '';
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
  if (cat === 'time') { const long = longDurationText(si); if (long) return long; }
  const c = UI_UNITS[TOKEN_QUANTITY[cat]];
  if (!c || !Number.isFinite(si)) return UNIT_MISSING;
  if (c.text) return c.text(si);
  return Number(c.fn(si).toPrecision(3)) + unitSuffix(c.unit);
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
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.uq'))) el.textContent = unitQuantityText(el.dataset.q, Number(el.dataset.v));
}

/** An angle the plugin gives in degrees, in the user's angle unit. */
// Headings and directions: whole degrees (a tenth of a degree says nothing a helm can use); another angle unit as the preferences format it.
export function fmtAngleDeg(deg) {
  if (deg == null) return null;
  const c = UI_UNITS.angle;
  if (c && !c.text && c.unit === '°') {
    const v = Math.round(c.fn(deg * Math.PI / 180));
    return (Object.is(v, -0) ? 0 : v) + '°';
  }
  return _fmt(deg * Math.PI / 180, 'angle');
}
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
    const inp = /** @type {HTMLInputElement} */ (document.getElementById(id)), lbl = document.getElementById(id + 'Label');
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
}
(function () {
  const SLIDER_IDS = [
    'sailThresh', 'arrivalRadiusM',
    'proximityRadiusM', 'xteThresholdM', 'xteSustainSec', 'simPushDeg',
  ];
  for (const id of SLIDER_IDS) {
    const inp = /** @type {HTMLInputElement} */ (document.getElementById(id));
    const lbl = document.getElementById(id + 'Label');
    if (!inp || !lbl) continue;
    inp.addEventListener('input', () => {
      if (SLIDER_DISPLAY[id]) refreshSliderLabels(); else lbl.textContent = inp.value;
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
    .map((id) => /** @type {HTMLInputElement} */ (document.getElementById(id)))
    .filter(Boolean);

  inputs.forEach((inp) => {
    inp.addEventListener('change', /** @this {HTMLInputElement} */ function () {
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
    // 503 too: "still loading the forecast" is a prompt answer from a working server, not a failure to back off from.
    _rateNote(r.ok || r.status === 400 || r.status === 404 || r.status === 409 || r.status === 422 || r.status === 403 || r.status === 503);
    if (r.status === 401) {
      AuthGate.trip(r.status);
      /** @type {Error & { rateNoted?: boolean }} */
      const err = new Error('auth ' + r.status);
      err.rateNoted = true;
      throw err;
    }
    if (r.status === 403) {
      // Logged in but lacking permission (readonly user hitting a
      // write route) — a real answer, not a dead session.
      /** @type {Error & { scopeMiss?: boolean, rateNoted?: boolean }} */
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
/**
 * The Error for a failed API answer. A 503 that carries `loading` (the
 * server is still getting its first forecast) is marked `waiting`: it is
 * not a failure, and it tells the page to check the status now, since a
 * map tile can get this answer before the page's first status check.
 */
export async function _apiError(r) {
  let d = null;
  try { d = await r.clone().json(); } catch (_) { /* not JSON */ }
  /** @type {Error & { waiting?: boolean }} */
  const err = new Error(d && (d.error || d.message) ? unitText(String(d.error || d.message)) : 'HTTP ' + r.status);
  if (r.status === 503 && d && 'loading' in d) { err.waiting = true; _serverWaiting(); }
  return err;
}
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
/** @type {HTMLInputElement} */ (document.getElementById('departure')).value =
    `${now.getFullYear()}-${_pad(now.getMonth() + 1)}-${_pad(now.getDate())}` +
    `T${_pad(now.getHours())}:${_pad(now.getMinutes())}`;
// (Rewritten in the ship's zone by loadShipTime once that is known.)

// ─────────── Polar picker (GET /api/polars) ───────────
let _polarItems = [];

function _renderPolarOptions(filterText) {
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById('polarSelect'));
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
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById('polarSelect'));
  return authFetch(API + '/polars', {}, null)
    .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Cannot load polars'); return data; })
    .then(items => {
      if (!Array.isArray(items) || items.length === 0) {
        sel.innerHTML = '<option value="">(no polars found — select a polar in Polar Management or configure a local polar source)</option>';
        _polarPreviewGen++;
        _polarItems = [];
        _polarAngles = null; _polarTable = null;
        drawPolarDiagram();
        return;
      }
      document.getElementById('openVesselForm').hidden = false;
      document.getElementById('polarFilter').hidden = false;
      _polarItems = items;
      _renderPolarOptions(/** @type {HTMLInputElement} */ (document.getElementById('polarFilter')).value);
      // Prefer the last-used selection if it's still in the list;
      // otherwise fall back to the vessel default (first item).
      const stored = prefs.get('polarPath') || '';
      const paths = Array.from(sel.options).map(it => it.value);
      sel.value = paths.includes(stored) ? stored : paths[0];
      loadPolarAngles(sel.value);
      loadPolarTable(sel.value);
    })
    .catch(e => {
      sel.innerHTML = '<option value="">(error loading polars)</option>';
      _polarPreviewGen++;
      document.getElementById('polarSourceHint').textContent = 'Active source unavailable: ' + e.message;
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
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('polarDiagram'));
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
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('polarSelect'));
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

document.getElementById('polarSelect').addEventListener('change', /** @this {HTMLSelectElement} */ function() {
  prefs.set('polarPath', this.value);
  loadPolarAngles(this.value);
  loadPolarTable(this.value);
});

// ─────────── Persist route-variable controls across reloads ───────────
// All route params except `departure` (which should default to "now"
// each session) are saved on change (rp-prefs.js: this browser and the
// Signal K user) and restored on load. Ranges fire an 'input' event
// after restore so the paired labels update to match.
(function() {
  const PERSIST_IDS = [
    'mode', 'sailThresh', 'arrivalRadiusM', 'precision',
    'publishSel', 'smootherSel', 'proximityRadiusM', 'xteThresholdM', 'xteSustainSec',
  ];
  const CHECK_IDS = ['noCurrents', 'noForecast', 'regionalWind', 'avoidAreas'];
  // The sail-speed slider holds m/s under routeVar:sailThreshMs; prefs.load()
  // converted the knots it held before 2026-10.
  const KEY = (id) => 'routeVar:' + (id === 'sailThresh' ? 'sailThreshMs' : id);
  for (const id of PERSIST_IDS) {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (!el) continue;
    const saved = prefs.get(KEY(id));
    if (saved != null && saved !== '') {
      el.value = saved;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.addEventListener('change', function() {
      prefs.set(KEY(id), el.value);
    });
    if (el.type === 'range') {
      el.addEventListener('input', function() {
        prefs.set(KEY(id), el.value);
      });
    }
  }
  for (const id of CHECK_IDS) {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (!el) continue;
    const saved = prefs.get(KEY(id));
    if (saved === 'true' || saved === 'false') el.checked = saved === 'true';
    el.addEventListener('change', function() {
      prefs.set(KEY(id), el.checked ? 'true' : 'false');
    });
  }
})();

document.getElementById('polarFilter').addEventListener('input', /** @this {HTMLInputElement} */ function() {
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
  const generateBtn = /** @type {HTMLButtonElement} */ (document.getElementById('vf_generate'));
  const sbdLink = /** @type {HTMLAnchorElement} */ (document.getElementById('sbdLink'));
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
  document.getElementById('vf_name').addEventListener('input', /** @this {HTMLInputElement} */ function() {
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
    for (const f of SPEC_FIELDS) /** @type {HTMLInputElement} */ (document.getElementById(f.id)).disabled = !UI_UNITS[f.q];
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

    const g = id => /** @type {HTMLInputElement | HTMLSelectElement} */ (document.getElementById(id));
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
      prefs.set('polarPath', data.path);
      const filt = /** @type {HTMLInputElement} */ (document.getElementById('polarFilter'));
      if (filt) filt.value = '';
      await loadPolarList();
      const sel = /** @type {HTMLSelectElement} */ (document.getElementById('polarSelect'));
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
// A clock time in the ship's zone: weekday and time, with the date too when
// the time is a day or more away (on a long passage "Tue 21:58" could be
// any Tuesday).
export function fmtWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const far = Math.abs(d.getTime() - Date.now()) >= LONG_DURATION_S * 1000;
  return fmtClock(d, far ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// ─────────── Ship's time ───────────
// Clock times are shown in the ship's time zone when the Signal K server
// publishes one (environment.time.timezoneRegion, an IANA zone such as
// "Pacific/Tongatapu", else environment.time.timezoneOffset, (-)hhmm east
// of Greenwich), else in the browser's. The departure field is read and
// written in the same zone, so what is typed is what is shown.
let _shipZone = null;   // { tz } | { offsetMin } | null = the browser's zone
export function shipZone() { return _shipZone; }
function _skValue(n) { return n && typeof n === 'object' && 'value' in n ? n.value : n; }
export function loadShipTime() {
  // 404: the server publishes no ship's time, so the browser's zone. Any other
  // failure (network, other HTTP status) keeps the zone already in use.
  const KEEP = {};
  return authFetch('/signalk/v1/api/vessels/self/environment/time', { cache: 'no-store' }, null)
    .then(r => (r.ok ? r.json() : r.status === 404 ? null : KEEP))
    .catch(() => KEEP)
    .then(t => {
      if (t === KEEP) return _shipZone;
      let z = null;
      const region = t ? _skValue(t.timezoneRegion) : null;
      const offset = t ? _skValue(t.timezoneOffset) : null;
      if (typeof region === 'string' && region) {
        try { new Intl.DateTimeFormat([], { timeZone: region }); z = { tz: region }; } catch (_) { /* not a zone this browser knows */ }
      }
      // A whole signed hhmm with minutes under 60 (1260 is not 13:00); anything else: the browser's zone.
      if (!z && typeof offset === 'number' && Number.isInteger(offset) && Math.abs(offset) <= 1400 && Math.abs(offset) % 100 < 60) {
        const a = Math.abs(offset);
        z = { offsetMin: Math.sign(offset) * (Math.floor(a / 100) * 60 + (a % 100)) };
      }
      const changed = JSON.stringify(z) !== JSON.stringify(_shipZone);
      // The departure field keeps its moment: read in the old zone, written in the new.
      const dep = /** @type {HTMLInputElement} */ (document.getElementById('departure'));
      const at = changed && dep ? fromClockInput(dep.value) : null;
      _shipZone = z;
      if (at) dep.value = toClockInput(at);
      if (changed) window.dispatchEvent(new Event('rp:units'));   // everything that shows times redraws
      return z;
    });
}
/** The zone in words, for a label: "Pacific/Tongatapu", "UTC+13:00", or null (the browser's zone). */
export function shipZoneLabel() {
  if (!_shipZone) return null;
  if (_shipZone.tz) return _shipZone.tz;
  const m = _shipZone.offsetMin, a = Math.abs(m);
  return 'UTC' + (m < 0 ? '−' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
/** A time as text in the ship's zone (Intl options as for toLocaleString). */
export function fmtClock(t, opts = {}) {
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return '';
  const z = _shipZone;
  if (z && z.tz) return d.toLocaleString([], { ...opts, timeZone: z.tz });
  if (z && z.offsetMin != null) {
    const { timeZoneName, ...rest } = opts;
    const txt = new Date(d.getTime() + z.offsetMin * 60000).toLocaleString([], { ...rest, timeZone: 'UTC' });
    return timeZoneName ? txt + ' ' + shipZoneLabel() : txt;
  }
  return d.toLocaleString([], opts);
}
/** Year, month (1–12), day, hour, minute and weekday (0 = Sunday) of a time in the ship's zone. */
export function clockParts(t) {
  const d = t instanceof Date ? t : new Date(t);
  const z = _shipZone;
  if (z && z.tz) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: z.tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(d)) p[x.type] = x.value;
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
  }
  if (z && z.offsetMin != null) {
    const u = new Date(d.getTime() + z.offsetMin * 60000);
    return { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes(), wd: u.getUTCDay() };
  }
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), wd: d.getDay() };
}
const _p2 = n => String(n).padStart(2, '0');
/** A time as a datetime-local value ("YYYY-MM-DDTHH:MM") in the ship's zone. */
export function toClockInput(t) {
  const c = clockParts(t);
  return c.y + '-' + _p2(c.mo) + '-' + _p2(c.d) + 'T' + _p2(c.h) + ':' + _p2(c.mi);
}
/** A datetime-local value read as the ship's zone wall time; null when not a time. */
export function fromClockInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const z = _shipZone;
  if (z && z.offsetMin != null) return new Date(wall - z.offsetMin * 60000);
  if (z && z.tz) {
    // The zone's offset at that wall time: guess, then correct once (a DST change in between).
    const off = ms => { const c = clockParts(ms); return (Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi) - Math.floor(ms / 60000) * 60000) / 60000; };
    let t = wall - off(wall) * 60000;
    t = wall - off(t) * 60000;
    // A wall time the clocks skip (spring forward) has no instant: the
    // guess lands either side of the gap. Keep the one after it, as the
    // browser does with its own zone (02:30 → 03:30).
    const c = clockParts(t);
    const shown = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi);
    if (shown < wall) t += wall - shown;
    return new Date(t);
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
// The departure field shows the time actually used: a skipped wall time
// (fromClockInput) is rewritten to the moved one before anything reads it.
const _depField = typeof document !== 'undefined' ? /** @type {HTMLInputElement} */ (document.getElementById('departure')) : null;
if (_depField) {
  _depField.addEventListener('change', () => {
    const t = fromClockInput(_depField.value);
    if (t) { const v = toClockInput(t); if (v !== _depField.value.slice(0, 16)) _depField.value = v; }
  });
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

// "2026-10-03T00:00Z" or "2026100300" → "03 Oct 00Z" (UTC), for the header and the meteogram.
const _MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function _shortUtc(v) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T?(\d{2})/.exec(String(v));
  return m ? m[3] + ' ' + _MON[+m[2] - 1] + ' ' + m[4] + 'Z' : escapeHtml(v);
}
// An ISO time as "Mon 20:00 EDT" in the browser's time zone, the UTC time as its tooltip.
function _shortLocal(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return escapeHtml(iso || '');
  const far = Math.abs(d.getTime() - Date.now()) >= LONG_DURATION_S * 1000;
  const local = fmtClock(d, far ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' } : { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return '<span title="' + escapeHtml(d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC') + '">' + escapeHtml(local) + '</span>';
}

// ─────────── Freshness (status `freshness`, plugin/freshness.ts) ───────────
// Each source's run against its own cadence: green until 30 min before the
// next run is due, orange until 60 min after, then red. A pill per source on
// its row, with the run's age; the times are in the tooltip.
let _fresh = new Map();   // source name → freshness entry of the last status
function _clockText(iso) {
  return iso ? fmtClock(new Date(iso), { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : '';
}
// The pill's words: the run's age, "loaded" for a fixed table, "none" when nothing is loaded; after the age, in brackets,
// when the next run is due (freshness `next_due_at`), so the line says when to look again.
function _freshText(f) {
  const age = f.published_at ? Math.max(0, (Date.now() - Date.parse(f.published_at)) / 1000) : null;
  return f.state === 'red' && !f.run ? 'none' : age === null ? 'loaded' : _fmt(age, 'time') + ' old' + _nextText(f);
}
// " (next in 2 h)" before it is due; once due, " (expected now)", or red, " (1.5 h late)"; nothing without a due time.
function _nextText(f) {
  const due = f.next_due_at ? Date.parse(f.next_due_at) : NaN;
  if (!Number.isFinite(due)) return '';
  const s = (due - Date.now()) / 1000;
  return s > 0 ? ' (next in ' + _fmt(s, 'time') + ')' : f.state === 'red' ? ' (' + _fmt(-s, 'time') + ' late)' : ' (expected now)';
}
// The header's sources list collapsed to one line of dots (remembered in this browser).
let _statusCollapsed = (() => { try { return localStorage.getItem('statusCollapsed') !== 'false'; } catch (_) { return true; } })();
(function () {
  const el = document.getElementById('dataStatus');
  if (!el) return;
  el.addEventListener('click', e => {
    const t = /** @type {Element} */ (e.target);
    if (t.closest('.ds-check-now')) { _checkNow(); return; }
    // Collapsed, the whole line opens the list: a dot is too small to aim at on a touch screen, and its tooltip never shows there.
    if (!t.closest('.ds-toggle') && !(_statusCollapsed && t.closest('.ds-summary'))) return;
    _statusCollapsed = !_statusCollapsed;
    try { localStorage.setItem('statusCollapsed', String(_statusCollapsed)); } catch (_) { /* private window */ }
    if (!_statusCollapsed) _loadCheckEvery();
    redrawStatusLine();
  });
})();

// ─────────── The expanded list's details and Check now ───────────
// Under each source, as text: when its run was published and the next is due (the pill's tooltip) and what the last
// check of it found (status `checks`); under the list, how often the plugin checks, with Check now.
let _checks = {};          // status `checks` of the last status
let _checkEveryS = null;   // forecast.refreshInterval from /api/settings, read when the list opens and on a save
let _checkNowNote = '';    // what Check now did, kept across the status redraws while it applies
// Check now is off from the tap until every source in the status `checks` has been checked since the server took the
// request: the round's end. A second request once a round has started queues a whole round more
// (worker/refreshqueue.ts merges only into one still waiting), and a round checks RTOFS before ECMWF and SMOC and the
// tides after it, so ECMWF's `forecast_loading` alone does not span it.
let _checkAsking = false;
let _checkTakenAt = 0;     // when the server took the request, by its own clock (the answer's Date header); 0 before
// The Check now request in flight. Ending its round (every source checked, the limit, a refusal) moves this on, so a late
// answer to it changes nothing.
let _checkAttempt = 0;
const _CHECK_ROUND_MAX_MS = 10 * 60 * 1000;   // on again after this whatever the statuses said
const _CHECK_SAID = {
  newest: 'the newest run is in use',
  'new-run': 'a new run was loaded',
  'could-not-check': 'the server could not be asked',
  failed: 'the new run could not be loaded',
};
// A freshness source's name to the key its check is kept under (protocol.ts CheckedSource); regional models have none.
function _checkKey(source) {
  if (source === 'ECMWF') return 'ecmwf';
  if (/SMOC/i.test(source)) return 'smoc';
  if (/sea level/i.test(source)) return 'tides';
  return /^RTOFS-/.test(source) ? 'rtofs:' + source.slice(6) : null;
}
function _freshDetail(name) {
  const f = _fresh.get(name);
  if (!f) return '';
  const key = _checkKey(name), c = key ? _checks[key] : null;
  const parts = [
    f.published_at ? 'published ' + _clockText(f.published_at) : '',
    f.next_due_at ? 'next due ' + _clockText(f.next_due_at) : '',
    c && c.at ? 'checked ' + _clockText(c.at) + ': ' + (_CHECK_SAID[c.outcome] || c.outcome) : '',
  ].filter(Boolean);
  return parts.length ? '<div class="fresh-detail">' + escapeHtml(parts.join(' · ')) + '</div>' : '';
}
// What the pills' colours mean (as freshness.ts sets them), once under the list.
const _FRESH_LEGEND = '<div class="fresh-legend">'
  + '<span class="fresh fresh-green">●</span> no newer run due yet · '
  + '<span class="fresh fresh-orange">●</span> a newer run is due about now (from 30 min before until an hour after) · '
  + '<span class="fresh fresh-red">●</span> more than an hour late, or nothing loaded</div>';
function _checkLine(s) {
  const every = _checkEveryS ? 'The plugin checks every source every ' + _fmt(_checkEveryS, 'time') + ' (Defaults → Forecast). ' : '';
  // A check or a new run already under way: said here, and Check now waits for it (another request would only queue).
  const l = s.forecast_loading;
  const busy = l && l.phase === 'checking'
    ? 'Checking ECMWF for a newer run' + (l.started_at ? ' since ' + _clockText(l.started_at) : '') + '…'
    : l && l.phase === 'decoding' ? 'A new run is loading (below).' : '';
  return '<div class="ds-check">' + escapeHtml(every)
    + (busy
      ? '<button type="button" class="ds-check-now" disabled>Checking…</button> <span class="ds-check-note">' + escapeHtml(busy) + '</span>'
      : '<button type="button" class="ds-check-now" title="Check every source for a newer run now"' + (_checkAsking ? ' disabled' : '') + '>Check now</button>'
        + (_checkNowNote ? ' <span class="ds-check-note">' + escapeHtml(_checkNowNote) + '</span>' : ''))
    + '</div>';
}
// A status: Check now is on again once every source it lists was checked at or after the request (the check times and
// the request's are both the server's clock). With no sources listed, once no ECMWF check is under way.
function _checkSettled(s) {
  if (!_checkAsking || !_checkTakenAt) return;
  const ats = Object.values(s.checks || {}).map(c => Date.parse(c && c.at));
  const l = s.forecast_loading;
  const over = ats.length ? ats.every(t => t >= _checkTakenAt) : !(l && l.phase === 'checking');
  if (!over) return;
  _endCheck();
}
// Check now on again; whatever its request still answers is ignored.
function _endCheck() {
  _checkAttempt++;
  _checkAsking = false;
  clearTimeout(_checkNoteTimer);
  _checkNowNote = '';
}
// The check line's interval comes from settings reads (this list's and the Defaults tab's) and the Defaults tab's saves,
// which can answer in any order. A save's answer is the value. A read's answer counts unless a save answered after the
// read started (the server may have served the read before it stored the save) or a read started later has already
// shown a value.
let _everyReads = 0, _everyReadShown = 0, _everySaved = 0;
const _everyValid = v => Number.isFinite(v) && v > 0;
function _setCheckEvery(v) {
  if (_everyValid(v) && v !== _checkEveryS) { _checkEveryS = v; redrawStatusLine(); }
}
/** Call as a settings read starts; call the result with its forecast.refreshInterval (s) when it answers. */
export function checkEveryRead() {
  const id = ++_everyReads, saved = _everySaved;
  return v => {
    if (!_everyValid(v) || saved !== _everySaved || id < _everyReadShown) return;
    _everyReadShown = id;
    _setCheckEvery(v);
  };
}
/** Call as a settings save starts; call the result with the saved forecast.refreshInterval (s) when it answers. */
export function checkEverySave() {
  return v => { _everySaved++; _setCheckEvery(v); };
}
function _loadCheckEvery() {
  const apply = checkEveryRead();
  // Plain fetch, as the Defaults tab reads it: a refusal here is no reason for the page-wide sign-in.
  fetch(API + '/settings', { credentials: 'same-origin', cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(b => apply(b && b.values && b.values.forecast ? b.values.forecast.refreshInterval : null))
    .catch(() => { /* the line says nothing of the interval */ });
}
let _checkNoteTimer = null;
function _checkNow() {
  const note = t => { _checkNowNote = t; redrawStatusLine(); };
  if (_checkAsking) return;
  const attempt = ++_checkAttempt;
  const current = () => attempt === _checkAttempt;
  _checkAsking = true;
  _checkTakenAt = 0;
  clearTimeout(_checkNoteTimer);
  // Armed with the request, not its answer: a request that never answers ends the round too.
  _checkNoteTimer = setTimeout(() => { _endCheck(); redrawStatusLine(); }, _CHECK_ROUND_MAX_MS);
  note('asking…');
  authFetch(API + '/forecast/refresh', { method: 'POST' }, null)
    .then(r => {
      if (!current()) return false;
      if (!r.ok) return _apiErrorText(r).then(t => Promise.reject(new Error(t)));
      // The Date header has whole seconds, cut down: a check after the request is never earlier than it.
      const at = Date.parse(r.headers.get('date') || '');
      _checkTakenAt = Number.isFinite(at) ? at : Date.now();
      // The server has taken the request once it answers 2xx; a body that cannot be read changes nothing.
      return r.json().then(() => true, () => true);
    })
    .then(asked => {
      if (!asked || !current()) return;
      note('asked: every source is being checked, and each says what it found when it is done');
      setTimeout(loadPluginStatus, 4000);
      setTimeout(loadPluginStatus, 15000);
    })
    .catch(err => {
      if (!current()) return;
      _endCheck();
      note('could not ask: ' + err.message);
      _checkNoteTimer = setTimeout(() => note(''), 60000);
    });
}
function _freshPill(name) {
  const f = _fresh.get(name);
  if (!f) return '';
  const text = _freshText(f);
  const tip = [
    f.source + (f.run ? ', run ' + f.run : ''),
    f.published_at ? 'published ' + _clockText(f.published_at) : '',
    f.next_due_at ? 'next run due ' + _clockText(f.next_due_at) : '',
    f.pending_since ? 'a newer run appeared ' + _clockText(f.pending_since) + ', still being written' : '',
    f.reason || '',
  ].filter(Boolean).join(' · ');
  return ' <span class="fresh fresh-' + f.state + '" title="' + escapeHtml(tip) + '">● ' + escapeHtml(text) + '</span>';
}
// Why a red source is late, in words: the run in use named by when it was published (CMEMS SMOC's own name is its
// last data hour, which reads as a date days ahead), and a newer run Copernicus Marine is still writing, when there is one.
function _lateText(f) {
  if (f.reason) return f.reason;
  const using = f.published_at ? 'still using the run published ' + _clockText(f.published_at) : 'still on ' + f.run;
  return f.pending_since
    ? 'a newer run appeared ' + _clockText(f.pending_since) + ', but Copernicus Marine has not finished writing it; ' + using
    : 'next run was due ' + _clockText(f.next_due_at) + '; ' + using;
}
// One line naming whatever is late, red.
function _lateLine() {
  const late = [..._fresh.values()].filter(f => f.state === 'red');
  if (!late.length) return '';
  return '<br><span class="err">Late: ' + late.map(f => escapeHtml(f.source) + ' ' + escapeHtml(_lateText(f))).join('; ') + '</span>';
}
// The connection, separate from freshness: blue when the last request reached a server, grey when there was none.
function _netLine(c) {
  if (!c || c.online === null) return '';
  return c.online
    ? '<span class="net-on">● online</span>'
    : '<span class="net-off" title="' + escapeHtml(c.reason || '') + '">● No internet connection since ' + escapeHtml(_clockText(c.since)) + '</span>';
}
// What a check could not do while online (a server that failed, a download that failed); offline says it on its own line.
const _CHECK_NAMES = { ecmwf: 'ECMWF', smoc: 'SMOC', tides: 'sea level' };
// RTOFS is checked per product (`rtofs:west_atl`), named as its current source.
function _checkName(k) {
  return k.startsWith('rtofs:') ? 'RTOFS-' + escapeHtml(k.slice(6)) : (_CHECK_NAMES[k] || escapeHtml(k));
}
function _checkLines(s) {
  const online = s.connectivity && s.connectivity.online !== false;
  return Object.entries(s.checks || {})
    .filter(([, c]) => c.outcome === 'failed' || (c.outcome === 'could-not-check' && online))
    .map(([k, c]) => '<br><span class="warn">' + _checkName(k) + (c.outcome === 'failed' ? ' update failed' : ' check failed')
      + ' at ' + escapeHtml(_clockText(c.at)) + (c.reason ? ': ' + unitTextHtml(c.reason) : '') + '</span>')
    .join('');
}
// New forecast data being processed while the run in use keeps serving.
function _processingLine(s) {
  const l = s.forecast_loading;
  if (!s.forecast || !l || l.phase !== 'decoding') return '';
  const cyc = l.cycle ? String(l.cycle).slice(11, 13) + 'Z' : '';
  return '<br><span class="processing">Processing new forecast data' + (cyc ? ': ' + cyc : '') + (l.total ? ', step ' + l.done + ' of ' + l.total : '') + '</span>';
}

// Every usable regional wind model, one item each for the wind row; one whose grid does not meet the route or the
// map view says so (it is listed all the same, so the list and the collapsed dots show the same sources).
const _NOT_HERE = ' <span class="not-here">(not in this view)</span>';
function _regionalWind(r, area) {
  if (!r) return [];
  const ok = (r.sources || []).filter(x => x.run && !x.problem);
  if (!ok.length) {
    // The downloader is there but has nothing usable: say why.
    return r.root && !(r.sources || []).some(x => x.run && !x.problem)
      ? ['regional: <span class="warn">' + escapeHtml(r.note || ((r.sources || [])[0] || {}).problem || 'no complete run') + '</span>']
      : [];
  }
  const rw = /** @type {HTMLInputElement} */ (document.getElementById('regionalWind'));
  const off = rw && !rw.checked ? ' <span class="warn">(off for routes: Regional wind unticked)</span>' : '';
  return ok.map(x => {
    const d = x.decoded;
    const state = d && d.skipped ? ' (not used: ' + escapeHtml(d.skipped) + ')'
      : d && d.error ? ' <span class="warn">' + unitTextHtml(d.error) + '</span>'
      : d && d.cycle && x.run.slice(0, 13).replace(/[-T]/g, '') === d.cycle ? ' (decoded)'
      : ' (decoding)';
    const here = !x.domain || _meets(x.domain, area);
    return escapeHtml(x.name) + ' ' + _shortUtc(x.run) + (x.validTo ? ', to ' + _shortLocal(x.validTo) : '') + state + _freshPill(x.name) + off + (here ? '' : _NOT_HERE)
      + (_statusCollapsed ? '' : _freshDetail(x.name));
  });
}

function _statusLine(s) {
  const f = s.forecast;
  _fresh = new Map((s.freshness || []).map(x => [x.source, x]));
  _checks = s.checks || {};
  const detail = name => (_statusCollapsed ? '' : _freshDetail(name));
  if (s.starting) return '<span class="warn">' + unitTextHtml(s.starting) + '</span>';
  // No forecast after a failed first load: Check now there too, to try again.
  if (!f) return s.forecast_error && !s.forecast_loading
    ? '<span class="warn">no forecast loaded</span>: ' + unitTextHtml(s.forecast_error) + _checkLine(s)
    : '<span class="warn">loading the forecast</span> (see below)';
  const area = _area();
  const run = escapeHtml(f.model || 'forecast') + ' <span class="nowrap">' + _shortUtc(f.cycle) + ' → ' + _shortLocal(f.valid_to) + '</span>' + _freshPill('ECMWF') + detail('ECMWF');
  // Only the current sources that apply to the route or the map view. SMOC
  // is worldwide (any area loads on demand), its box is only the standing
  // area around the boat; the others cover their own box.
  // Every current source is listed (as the collapsed dots show them); one that does not cover the route or the view says so.
  const applies = c => /SMOC/i.test(c.name) || _meets(c.bbox, area);
  const curList = Array.isArray(s.currents) ? s.currents : [];
  const t = s.tides;
  // The run by when it was published: its own name (t.run) is its last data hour, days ahead.
  const tf = t ? _fresh.get(t.name) : null;
  const tides = s.tides_enabled === false ? 'off (Settings)'
    : s.tides_error ? '<span class="warn">' + unitTextHtml(s.tides_error) + '</span>'
    : t ? escapeHtml(t.name.replace(/ hourly sea level \((\S+) tide\)/, ' ($1)')) + (tf && tf.published_at ? ', published ' + _shortLocal(tf.published_at) : '') + _freshPill(t.name) + detail(t.name)
    : 'loading';
  // Sources that are enabled but have nothing loaded have no row entry of their own: their red pill goes on the currents row.
  const curNames = new Set(curList.map(c => c.name));
  const missing = [..._fresh.values()].filter(x => x.rows.includes('currents') && !x.run && x.state === 'red' && !curNames.has(x.source));
  // Each row's name on its own line, then one bulleted line per source.
  const row = (k, items) =>
    '<div class="statusKey">' + k + '</div><ul class="src-list">' + items.map(v => '<li>' + v + '</li>').join('') + '</ul>';
  // RTOFS where no product covers the vessel: nothing is loaded for it, and that is not late (no pill).
  const rtofsNone = s.rtofs && !s.rtofs.auto && s.rtofs.auto_reason ? ['RTOFS: ' + escapeHtml(s.rtofs.auto_reason)] : [];
  const currents = curList
    .map(c => escapeHtml(c.name) + _freshPill(c.name) + (applies(c) ? '' : _NOT_HERE) + detail(c.name))
    .concat(missing.map(x => escapeHtml(x.source) + _freshPill(x.source) + detail(x.source)))
    .concat(rtofsNone);
  const toggle = '<button type="button" class="ds-toggle" aria-expanded="' + !_statusCollapsed + '" title="'
    + (_statusCollapsed ? 'Show the data sources in full' : 'Collapse the data sources to one line') + '">'
    + (_statusCollapsed ? 'Show ▾' : 'Hide ▴') + '</button>';
  // Collapsed: each row's name and one dot per source in its colour (the details in the dot's tooltip), rows separated by pipes.
  const dots = k => [..._fresh.values()].filter(x => x.rows.includes(k))
    .map(x => '<span class="fresh fresh-' + x.state + ' fresh-dot" title="' + escapeHtml(x.source + ': ' + _freshText(x)) + '"></span>').join('');
  const body = _statusCollapsed
    ? '<div class="ds-head"><span class="ds-summary">'
      + ['wind', 'waves', 'currents', 'tides'].map(k => '<span class="statusKey">' + k + '</span>' + dots(k)).join('<span class="ds-pipe">|</span>')
      + '</span>' + toggle + '</div>'
    : '<div class="ds-head"><span class="ds-title">Data sources</span>' + toggle + '</div>'
      + row('wind', [run, ..._regionalWind(s.regional, area)])
      + row('waves', [f.has_waves ? escapeHtml(f.model || 'forecast') + ', same run' + _freshPill('ECMWF') : '<span class="warn">none in this run</span>'])
      + row('currents', currents.length ? currents : ['none here'])
      + row('tides', [tides])
      + (s.jobs ? '<span class="statusKey">jobs</span> ' + (s.jobs.running ? 'running' : 'idle') + ', ' + s.jobs.queued + ' queued' : '')
      + _FRESH_LEGEND + _checkLine(s);
  return body
    + _processingLine(s)
    + _lateLine()
    + _checkLines(s)
    // A refused reload (e.g. the memory guard) while the previous forecast keeps serving.
    + (s.forecast_error ? '<br><span class="warn">' + unitTextHtml(s.forecast_error) + '</span>' : '');
}
let _statusSoon = null;

// ─────────── Waiting for the server (first forecast, coastline) ───────────
// While the server has no forecast yet (a first start, or a decode after
// the forecast settings changed) every map layer and route waits on it:
// one calm banner says what it is doing and how far it is, the layers stay
// quiet instead of failing one by one, and everything reloads by itself
// when it is ready ('rp:forecast-ready').
let _waiting = false;
let _loadRate = null;   // { cycle, t0, d0 }: the first progress seen, for a measured time left
/** Is the server still getting its first forecast (or starting)? Layers keep quiet meanwhile. */
export function forecastWaiting() { return _waiting; }
function _waitText(s) {
  if (s.starting) return unitText(s.starting);
  const l = s.forecast_loading;
  if (l && l.text) return unitText(l.text.charAt(0).toUpperCase() + l.text.slice(1));
  return 'Loading the forecast';
}
function _showBanner(s) {
  const el = document.getElementById('loadingBanner');
  if (!el) return;
  if (!_waiting) { el.hidden = true; _loadRate = null; return; }
  const l = !s.starting ? s.forecast_loading : null;
  let text = _waitText(s);
  const bar = /** @type {HTMLElement} */ (el.querySelector('.lb-bar')), fill = /** @type {HTMLElement} */ (el.querySelector('.lb-fill'));
  if (l && l.phase === 'decoding' && l.total) {
    bar.hidden = false;
    fill.style.width = Math.round((100 * l.done) / l.total) + '%';
    // Time left from the rate measured here (not a guess): after 3 steps seen.
    if (!_loadRate || _loadRate.cycle !== l.cycle || l.done < _loadRate.d0) _loadRate = { cycle: l.cycle, t0: Date.now(), d0: l.done };
    const steps = l.done - _loadRate.d0;
    // Shown only when it reads as something in the user's time unit (2 minutes is "0.0 hour").
    const tu = UI_UNITS.time;
    if (steps >= 3 && tu) {
      const left = ((Date.now() - _loadRate.t0) / 1000 / steps) * (l.total - l.done);
      if (tu.fn(left) >= 1) text += ' · about ' + _fmt(left, 'time') + ' left';
    }
  } else bar.hidden = true;
  el.querySelector('.lb-text').textContent = text;
  el.hidden = false;
}
// A "still loading" answer arrived before the status said so: wait now, check the status at once.
let _waitCheck = null;
function _serverWaiting() {
  _waiting = true;
  if (!_waitCheck) _waitCheck = setTimeout(() => { _waitCheck = null; loadPluginStatus(); }, 200);
}
function _noteWaiting(s) {
  const was = _waiting;
  _waiting = !!s.starting || (!s.forecast && (!s.forecast_error || !!s.forecast_loading));
  _showBanner(s);
  if (was && !_waiting) {
    // Ready: units may have failed to load in the rush; then every layer afresh.
    loadUnitPreferences();
    window.dispatchEvent(new Event('rp:forecast-ready'));
  }
}
// ─────────── One section open at a time ───────────
// The <details> sections directly inside `container` behave as an
// accordion: opening one closes the others. `toggle` does not bubble, so
// it is caught in the capture phase on the container (works for sections
// rendered later too).
export function oneOpenAtATime(container) {
  if (!container) return;
  container.addEventListener('toggle', e => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.open || d.parentElement !== container) return;
    for (const other of container.querySelectorAll(':scope > details[open]')) if (other !== d) other.open = false;
  }, true);
}

// ─────────── Plugin status (header line + Forecast data section) ───────────
export function loadPluginStatus() {
  const el = document.getElementById('dataStatus');
  const fi = document.getElementById('forecastInfo');
  return authFetch(API + '/status', { cache: 'no-store' }, 'status')
    .then(r => r.json())
    .then(s => {
      _lastStatus = s;
      _checkSettled(s);
      window.dispatchEvent(new CustomEvent('rp:status', { detail: s }));
      if (el) el.innerHTML = _statusLine(s);
      const net = document.getElementById('netStatus');
      if (net) net.innerHTML = _netLine(s.connectivity);
      _noteWaiting(s);
      // First start (coastline, first forecast): check again soon, not in 30 s.
      clearTimeout(_statusSoon);
      if (_waiting) _statusSoon = setTimeout(loadPluginStatus, 5000);
      if (fi) {
        const f = s.forecast;
        fi.innerHTML = f
          ? 'Cycle <b>' + escapeHtml(f.cycle) + '</b><br>valid ' + escapeHtml(f.valid_from) + ' → ' + escapeHtml(f.valid_to) + '<br>coverage ' + escapeHtml(f.coverage || 'global')
            + (typeof f.decoded_bytes === 'number' ? ', ' + _fmt(f.decoded_bytes, 'data_size') + ' decoded on disk' : '')
            + (f.memory ? ', ' + _fmt(f.memory.data_worker_held_bytes + f.memory.route_worker_held_bytes, 'data_size') + ' in memory now' : '')
            + '<br>params: ' + escapeHtml((f.params || []).join(', ')) + (s.extra_fields ? '' : '<br><span style="color:var(--warn)">extra fields (temperature, precipitation, SST, humidity) are off in Settings</span>')
            + (s.rtofs && s.rtofs.runs.length ? '<br>RTOFS ' + s.rtofs.runs.map(r => escapeHtml(r.product) + ' run ' + escapeHtml(r.run)).join(', ') : '')
            + (s.vessel ? '<br>vessel ' + escapeHtml(s.vessel.name || '—') + ', motor ' + (fmtSpeed(s.vessel.motorSpeedMs) || '—') : '')
          : '<span style="color:var(--warn)">No forecast loaded' + (s.forecast_error ? ': ' + unitTextHtml(s.forecast_error) : '') + '</span>';
      }
      window.dispatchEvent(new Event('rp:status'));
    })
    .catch(e => {
      // A status request replaced by a newer one is not a failure.
      if (e.name === 'AbortError' || e.message === 'auth-gate-tripped') return;
      // While the server is busy getting its forecast a slow answer is expected: keep waiting.
      if (_waiting) { clearTimeout(_statusSoon); _statusSoon = setTimeout(loadPluginStatus, 5000); return; }
      if (el) el.innerHTML = '<span class="err">status unavailable</span>: ' + e.message;
    });
}
loadPluginStatus();
setInterval(loadPluginStatus, 30000);
if (!_statusCollapsed) _loadCheckEvery();   // the list was left open: its check line names the interval too
// The units (or the ship's time zone) arrived after the status: the pills read "— old" until the next status, 30 s on.
window.addEventListener('rp:units', redrawStatusLine);
loadShipTime();
setInterval(loadShipTime, 600000);
document.getElementById('refreshForecast').addEventListener('click', function() {
  const st = document.getElementById('refreshForecastStatus');
  st.textContent = 'requesting…';
  authFetch(API + '/forecast/refresh', { method: 'POST' }, null)
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(() => { st.textContent = 'refresh requested — status updates in a moment'; setTimeout(loadPluginStatus, 4000); setTimeout(loadPluginStatus, 15000); })
    .catch(e => { st.textContent = 'refresh failed: ' + e.message; });
});

