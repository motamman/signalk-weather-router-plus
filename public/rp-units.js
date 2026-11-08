// Weather Router Plus — the Signal K user's display units, without the
// page: shared by the web app (rp-core.js) and the Freeboard panel
// (plotterext/panel.html). Reads `displayUnits` from path metadata, which
// the server resolves for the logged-in user, one path per category (the
// server's default-categories mapping), and for categories no path carries
// (dataSize) the user's preset in the server's own order.

// The Signal K path whose metadata gives each category's unit.
export const CATEGORY_PATH = {
  speed: 'navigation/speedOverGround',
  distance: 'navigation/log',
  depth: 'environment/depth/belowTransducer',
  length: 'design/beam',
  temperature: 'environment/outside/temperature',
  pressure: 'environment/outside/pressure',
  time: 'navigation/racing/timeToStart',
  percentage: 'environment/outside/relativeHumidity',
  angle: 'navigation/courseOverGroundTrue',
  mass: 'design/displacement',
  // No default-categories path carries area; the spec's sail area does.
  area: 'sails/inventory/main/area',
};

// Signal K conversion formulas use mathjs syntax. This evaluates the
// arithmetic subset (numbers, `value`, + - * / ^, parentheses, and a
// few Math functions) without eval. Returns fn(value) or null.
function compileFormula(src) {
  const toks = String(src).match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*/^(),]/gi);
  if (!toks || toks.join('') !== String(src).replace(/\s+/g, '')) return null;
  const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log, log10: Math.log10,
    round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow, cbrt: Math.cbrt };
  let i = 0;
  const peek = () => toks[i], take = () => toks[i++];
  function expr() {
    let a = term();
    while (peek() === '+' || peek() === '-') { const op = take(), b = term(), x = a; a = op === '+' ? v => x(v) + b(v) : v => x(v) - b(v); }
    return a;
  }
  function term() {
    let a = unary();
    while (peek() === '*' || peek() === '/') { const op = take(), b = unary(), x = a; a = op === '*' ? v => x(v) * b(v) : v => x(v) / b(v); }
    return a;
  }
  function unary() {
    if (peek() === '-') { take(); const a = unary(); return v => -a(v); }
    if (peek() === '+') { take(); return unary(); }
    return power();
  }
  function power() {
    const a = atom();
    if (peek() === '^') { take(); const b = unary(); return v => Math.pow(a(v), b(v)); }
    return a;
  }
  function atom() {
    const t = take();
    if (t === undefined) throw new Error('end');
    if (t === '(') { const a = expr(); if (take() !== ')') throw new Error(')'); return a; }
    if (/^[\d.]/.test(t)) { const n = Number(t); return () => n; }
    if (t === 'value') return v => v;
    if (FUNCS[t] && peek() === '(') {
      take(); const args = [expr()];
      while (peek() === ',') { take(); args.push(expr()); }
      if (take() !== ')') throw new Error(')');
      const f = FUNCS[t];
      return v => f(...args.map(a => a(v)));
    }
    throw new Error('token ' + t);
  }
  try { const f = expr(); return i === toks.length ? f : null; } catch (_) { return null; }
}

// Duration formats named by Signal K's time conversions
// (formatDurationHMS(value) etc.). The server ships only the names, no
// implementation, so these layouts follow the unit keys (HH:MM:SS …);
// verbose and compact are this page's own wording.
const _durPad = (n, w = 2) => String(n).padStart(w, '0');
function _durParts(s) {
  const neg = s < 0; s = Math.abs(s);
  const ms = Math.round(s * 1000);
  return { neg, d: Math.floor(ms / 86400000), h: Math.floor(ms / 3600000), hd: Math.floor(ms / 3600000) % 24,
    m: Math.floor(ms / 60000) % 60, mt: Math.floor(ms / 60000), sec: Math.floor(ms / 1000) % 60, milli: ms % 1000 };
}
export const DURATION_FORMATS = {
  formatDurationDHMS: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.d) + ':' + _durPad(p.hd) + ':' + _durPad(p.m) + ':' + _durPad(p.sec); },
  formatDurationHMS: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.h) + ':' + _durPad(p.m) + ':' + _durPad(p.sec); },
  formatDurationHMSMillis: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.h) + ':' + _durPad(p.m) + ':' + _durPad(p.sec) + '.' + _durPad(p.milli, 3); },
  formatDurationMS: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.mt) + ':' + _durPad(p.sec); },
  formatDurationMSMillis: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.mt) + ':' + _durPad(p.sec) + '.' + _durPad(p.milli, 3); },
  formatDurationVerbose: s => {
    const p = _durParts(s), out = [];
    const part = (n, w) => { if (n) out.push(n + ' ' + w + (n === 1 ? '' : 's')); };
    part(p.d, 'day'); part(p.hd, 'hour'); part(p.m, 'minute');
    if (!out.length) part(p.sec, 'second');
    return (p.neg ? '-' : '') + (out.join(' ') || '0 minutes');
  },
  formatDurationCompact: s => {
    const p = _durParts(s), out = [];
    if (p.d) out.push(p.d + 'd'); if (p.hd) out.push(p.hd + 'h'); if (p.m || !out.length) out.push(p.m + 'm');
    return (p.neg ? '-' : '') + out.join(' ');
  },
};

// Signal K displayFormat ("0", "0.0", "0.00") → decimal places.
function _precisionOf(fmt) {
  const m = /^0(?:\.(0+))?$/.exec(fmt || '');
  return m ? (m[1] ? m[1].length : 0) : 1;
}

// A Signal K displayUnits object → page unit, or null when its formula
// can't be evaluated.
export function unitFromDisplayUnits(du) {
  if (!du || typeof du.formula !== 'string') return null;
  const dur = /^\s*(formatDuration\w+)\(\s*value\s*\)\s*$/.exec(du.formula);
  if (dur) {
    const text = DURATION_FORMATS[dur[1]];
    return text ? { unit: '', fn: v => v / 3600, inv: v => v * 3600, precision: 1, text } : null;
  }
  const fn = compileFormula(du.formula), inv = compileFormula(du.inverseFormula);
  if (!fn) return null;
  return { unit: du.symbol || du.targetUnit || '', fn, inv, precision: _precisionOf(du.displayFormat) };
}

// displayUnits for one category, or null with the reason logged.
export async function fetchDisplayUnits(cat) {
  const url = '/signalk/v1/api/vessels/self/' + CATEGORY_PATH[cat] + '/meta';
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) { console.warn('[units] ' + url + ' → HTTP ' + r.status); return null; }
    const meta = await r.json();
    if (!meta || !meta.displayUnits || meta.displayUnits.category !== cat) {
      console.warn('[units] ' + url + ': no "' + cat + '" displayUnits', meta && meta.displayUnits);
      return null;
    }
    return meta.displayUnits;
  } catch (e) {
    console.warn('[units] ' + url + ' failed', e);
    return null;
  }
}
// Categories no Signal K path carries (dataSize): the user's preset, in
// the server's order (getActivePresetForUser): the user's own preset in
// application data, else the legacy per-user preset in the config, else
// the admin preset. Returns displayUnits-shaped objects, or null each.
export async function fetchPresetUnits(cats) {
  const getJson = url => fetch(url, { credentials: 'include' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const none = Object.fromEntries(cats.map(c => [c, null]));
  let preset = null;
  const own = await getJson('/signalk/v1/applicationData/user/unitpreferences/1.0.0');
  let name = own && own.activePreset;
  if (!name) {
    const [config, login] = await Promise.all([getJson('/signalk/v1/unitpreferences/config'), getJson('/loginStatus')]);
    const user = login && login.username;
    name = user && config && config.userPresets ? config.userPresets[user] : null;
  }
  if (name) preset = await getJson('/signalk/v1/unitpreferences/presets/' + encodeURIComponent(name));
  if (!preset) {
    // The admin preset, already with formulas.
    const active = await getJson('/signalk/v1/unitpreferences/active');
    if (!active || !active.categories) { console.warn('[units] no unit preset for ' + cats.join(', ')); return none; }
    return Object.fromEntries(cats.map(c => [c, active.categories[c] ? { category: c, ...active.categories[c] } : null]));
  }
  const defs = await getJson('/signalk/v1/unitpreferences/definitions');
  return Object.fromEntries(cats.map(c => {
    const cat = preset.categories && preset.categories[c];
    const conv = cat && defs && defs[cat.baseUnit] && defs[cat.baseUnit].conversions ? defs[cat.baseUnit].conversions[cat.targetUnit] : null;
    if (!conv) { console.warn('[units] preset ' + name + ': no conversion for ' + c); return [c, null]; }
    return [c, { category: c, targetUnit: cat.targetUnit, displayFormat: cat.displayFormat, ...conv }];
  }));
}

// What a value whose unit is not known shows: no fallback unit.
export const UNIT_MISSING = '—';
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
// The unit after the number: a space before "kn", "m", "hPa"; none before "°" and "%".
export function unitSuffix(unit) {
  return unit ? (unit === '°' || unit === '%' ? unit : ' ' + unit) : '';
}
/**
 * A value in its base unit, written in unit `u` (unitFromDisplayUnits; null when not known: UNIT_MISSING) of quantity
 * `key`: from a day up a 'time' is written as longDurationText writes it. The page's _fmt (rp-core.js), and pages
 * without rp-core (zeddisplay-router: the admin options page), write through it.
 */
export function formatQuantity(u, siValue, key) {
  if (key === 'time') {
    const long = longDurationText(siValue);
    if (long) return long;
  }
  if (!u) return UNIT_MISSING;
  if (u.text) return u.text(siValue);
  const t = u.fn(siValue).toFixed(u.precision);
  return (t === '-0' ? '0' : t) + unitSuffix(u.unit);
}
/**
 * Unit `u` (unitFromDisplayUnits) when a number can be typed in it, else null: a duration format ("1d 2h") has no
 * single unit to type a number in. The planner's settings (rp-settings.js) and the Signal K Admin panel
 * (remoteEntry.js) edit durations through it.
 */
export function typedUnit(u) {
  return u && u.inv && !u.text ? u : null;
}
