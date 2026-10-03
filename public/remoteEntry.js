/*
 * Plugin configuration panel for the Signal K Admin UI (keyword
 * `signalk-plugin-configurator`). The Admin UI injects this file as
 * <script src="/signalk-weather-router-plus/remoteEntry.js">, reads the
 * Module Federation container from window.signalk_weather_router_plus,
 * calls init(shareScope) with its own React 19 and get() for
 * './PluginConfigurationPanel', and renders that component with
 * {configuration, save}. The container is written by hand (init + get):
 * the panel uses the Admin UI's React from the share scope, so the
 * package carries no React and needs no bundler.
 *
 * Values are stored in SI (m, s, bytes) and shown in the Signal K user's
 * unit preferences (displayUnits from path metadata, as the webapp). No
 * fallback: a quantity whose unit cannot be read shows "—" and cannot be
 * edited here.
 */
/* eslint-disable */
var signalk_weather_router_plus = (function () {
  'use strict';
  var React = null;
  var API = '/plugins/signalk-weather-router-plus/api';
  var MIRRORS = ['ecmwf', 'aws', 'google'];
  var DEFAULTS = { enabled: true, radius: 250000, window: 0, maxZoom: 15, diskCap: 20e9, workers: 2, followView: true };
  var UNIT_PATH = { distance: 'navigation/log', time: 'navigation/racing/timeToStart' };
  var MISSING = '—';

  // Signal K conversion formulas (mathjs syntax): the arithmetic subset, no eval.
  function compileFormula(src) {
    var toks = String(src).match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*/^(),]/gi);
    if (!toks || toks.join('') !== String(src).replace(/\s+/g, '')) return null;
    var FUNCS = { sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log, log10: Math.log10, round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow, cbrt: Math.cbrt };
    var i = 0;
    function peek() { return toks[i]; }
    function take() { return toks[i++]; }
    function expr() {
      var a = term();
      while (peek() === '+' || peek() === '-') { (function () { var op = take(), b = term(), x = a; a = op === '+' ? function (v) { return x(v) + b(v); } : function (v) { return x(v) - b(v); }; })(); }
      return a;
    }
    function term() {
      var a = unary();
      while (peek() === '*' || peek() === '/') { (function () { var op = take(), b = unary(), x = a; a = op === '*' ? function (v) { return x(v) * b(v); } : function (v) { return x(v) / b(v); }; })(); }
      return a;
    }
    function unary() {
      if (peek() === '-') { take(); var a = unary(); return function (v) { return -a(v); }; }
      if (peek() === '+') { take(); return unary(); }
      return power();
    }
    function power() {
      var a = atom();
      if (peek() === '^') { take(); var b = unary(); return function (v) { return Math.pow(a(v), b(v)); }; }
      return a;
    }
    function atom() {
      var t = take();
      if (t === undefined) throw new Error('end');
      if (t === '(') { var a = expr(); if (take() !== ')') throw new Error(')'); return a; }
      if (/^[\d.]/.test(t)) { var n = Number(t); return function () { return n; }; }
      if (t === 'value') return function (v) { return v; };
      if (FUNCS[t] && peek() === '(') {
        take(); var args = [expr()];
        while (peek() === ',') { take(); args.push(expr()); }
        if (take() !== ')') throw new Error(')');
        var f = FUNCS[t];
        return function (v) { return f.apply(null, args.map(function (g) { return g(v); })); };
      }
      throw new Error('token ' + t);
    }
    try { var f = expr(); return i === toks.length ? f : null; } catch (e) { return null; }
  }
  function precisionOf(fmt) {
    var m = /^0(?:\.(0+))?$/.exec(fmt || '');
    return m ? (m[1] ? m[1].length : 0) : 1;
  }
  // displayUnits → {unit, fn, inv, precision}, or null. A duration format edits in hours.
  function unitFrom(du) {
    if (!du || typeof du.formula !== 'string') return null;
    if (/^\s*formatDuration\w+\(\s*value\s*\)\s*$/.test(du.formula))
      return { unit: 'h', fn: function (v) { return v / 3600; }, inv: function (v) { return v * 3600; }, precision: 1 };
    var fn = compileFormula(du.formula), inv = compileFormula(du.inverseFormula);
    if (!fn || !inv) return null;
    return { unit: du.symbol || du.targetUnit || '', fn: fn, inv: inv, precision: precisionOf(du.displayFormat) };
  }
  function fetchUnit(cat) {
    return fetch('/signalk/v1/api/vessels/self/' + UNIT_PATH[cat] + '/meta', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { return m && m.displayUnits && m.displayUnits.category === cat ? unitFrom(m.displayUnits) : null; })
      .catch(function () { return null; });
  }

  // A number typed in display units: kept as typed while focused, converted
  // to SI and clamped only when the field loses focus (so typing 5000 is
  // not cut to the minimum at the first digit, and the field can be cleared
  // and retyped).
  function DraftNumber(props) {
    var h = React.createElement;
    var ds = React.useState(null);
    var draft = ds[0], setDraft = ds[1];
    var shown = draft !== null ? draft : String(+props.toDisplay(props.si).toFixed(props.precision));
    function commit() {
      if (draft === null) return;
      var n = Number(draft);
      if (draft.trim() !== '' && Number.isFinite(n)) {
        var v = props.fromDisplay(n);
        if (Number.isFinite(v)) props.onChange(Math.min(props.maxSI, Math.max(props.minSI, v)));
      }
      setDraft(null);
    }
    return h('input', { className: 'form-control', type: 'number', value: shown, step: props.step,
      onChange: function (e) { setDraft(e.target.value); },
      onBlur: commit,
      onKeyDown: function (e) { if (e.key === 'Enter') commit(); } });
  }

  function Panel(props) {
    var h = React.createElement;
    var initial = props.configuration || {};
    var st = React.useState(function () { return JSON.parse(JSON.stringify(initial)); });
    var cfg = st[0], setCfg = st[1];
    var us = React.useState({ loaded: false, distance: null, time: null });
    var units = us[0], setUnits = us[1];
    var cs = React.useState(null);
    var coast = cs[0], setCoast = cs[1];
    var ds = React.useState(false);
    var dirty = ds[0], setDirty = ds[1];
    var ms = React.useState(null);
    var msg = ms[0], setMsg = ms[1];

    React.useEffect(function () {
      Promise.all([fetchUnit('distance'), fetchUnit('time')]).then(function (u) { setUnits({ loaded: true, distance: u[0], time: u[1] }); });
    }, []);

    // Coastline state; polled while a download runs.
    React.useEffect(function () {
      var stop = false, timer = null;
      function poll() {
        fetch(API + '/status', { credentials: 'include', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (s) {
            if (stop) return;
            setCoast(s ? s.coastline || null : null);
            timer = setTimeout(poll, s && s.coastline && s.coastline.downloading ? 2000 : 10000);
          })
          .catch(function () { if (!stop) timer = setTimeout(poll, 10000); });
      }
      poll();
      return function () { stop = true; clearTimeout(timer); };
    }, []);

    function set(path, value) {
      setCfg(function (c) {
        var n = JSON.parse(JSON.stringify(c));
        var o = n;
        for (var i = 0; i < path.length - 1; i++) { if (!o[path[i]] || typeof o[path[i]] !== 'object') o[path[i]] = {}; o = o[path[i]]; }
        if (value === undefined) delete o[path[path.length - 1]]; else o[path[path.length - 1]] = value;
        return n;
      });
      setDirty(true);
    }
    function get(path, def) {
      var o = cfg;
      for (var i = 0; i < path.length; i++) { if (o == null) return def; o = o[path[i]]; }
      return o === undefined ? def : o;
    }

    function download() {
      setMsg(null);
      fetch(API + '/coastline/download', { method: 'POST', credentials: 'include' })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t); });
          setCoast(function (c) { return Object.assign({}, c, { downloading: true, message: 'starting download…' }); });
        })
        .catch(function (e) { setMsg('Download could not start: ' + e.message); });
    }

    // Inputs -----------------------------------------------------------------
    function field(label, help, input) {
      return h('div', { className: 'form-group mb-3' },
        h('label', { className: 'form-label fw-bold' }, label), input,
        help ? h('small', { className: 'form-text text-muted d-block' }, help) : null);
    }
    function text(path, placeholder) {
      return h('input', { className: 'form-control', type: 'text', value: get(path, ''), placeholder: placeholder || '',
        onChange: function (e) { set(path, e.target.value); } });
    }
    function check(path, def, label) {
      return h('div', { className: 'form-check mb-2' },
        h('input', { className: 'form-check-input', type: 'checkbox', id: 'wrp-' + path.join('-'), checked: !!get(path, def),
          onChange: function (e) { set(path, e.target.checked); } }),
        h('label', { className: 'form-check-label', htmlFor: 'wrp-' + path.join('-') }, label));
    }
    function number(path, def, opts) {
      return h('input', { className: 'form-control', type: 'number', value: get(path, def), min: opts.min, max: opts.max, step: opts.step || 1,
        onChange: function (e) { var v = e.target.value === '' ? undefined : Number(e.target.value); set(path, v); } });
    }
    // An SI value edited in the user's unit (or shown as — when the unit is unknown).
    function unitNumber(path, def, u, minSI, maxSI) {
      if (!units.loaded) return h('input', { className: 'form-control', disabled: true, value: 'loading units…' });
      if (!u) return h('div', null, h('input', { className: 'form-control', disabled: true, value: MISSING }),
        h('small', { className: 'text-danger' }, 'Your Signal K unit preference for this quantity could not be read, so it cannot be edited here.'));
      return h('div', { className: 'input-group' },
        h(DraftNumber, { si: get(path, def), toDisplay: u.fn, fromDisplay: u.inv, precision: u.precision, step: Math.pow(10, -u.precision),
          minSI: minSI, maxSI: maxSI, onChange: function (v) { set(path, v); } }),
        h('span', { className: 'input-group-text' }, u.unit));
    }

    // Coastline section ----------------------------------------------------------
    var configuredCoast = String(get(['landShapefiles'], '')).trim();
    var coastLines = [];
    if (coast) {
      if (coast.downloading) coastLines.push(h('div', { key: 'd', className: 'text-info' }, 'Downloading GSHHG: ' + (coast.message || '…')));
      else if (coast.error) coastLines.push(h('div', { key: 'e', className: 'text-danger' }, 'Last download failed: ' + coast.error));
      if (coast.downloaded) coastLines.push(h('div', { key: 'p' }, 'Downloaded coastline: ', h('code', null, coast.downloaded)));
      if (coast.in_use && coast.in_use.length) coastLines.push(h('div', { key: 'u' }, 'In use: ', h('code', null, coast.in_use.join(', '))));
    }
    var coastSection = h('div', { className: 'mb-4' },
      h('h5', null, 'Coastline'),
      field('Coastline shapefile(s)',
        'Absolute path(s), comma-separated. Blank: the GSHHG 2.3.7 full-resolution shoreline downloaded into the plugin data directory (downloaded at start if missing). Add GSHHS_f_L6.shp for Antarctica.',
        text(['landShapefiles'], 'blank = downloaded GSHHG')),
      h('div', { className: 'mb-2' },
        h('button', { type: 'button', className: 'btn btn-secondary me-2', disabled: !!(coast && coast.downloading), onClick: download },
          coast && coast.downloading ? 'Downloading…' : coast && coast.downloaded ? 'Download coastline again' : 'Download coastline (149 MB)'),
        coast && coast.downloaded && configuredCoast
          ? h('button', { type: 'button', className: 'btn btn-outline-primary', onClick: function () { set(['landShapefiles'], ''); } }, 'Use the downloaded coastline')
          : null),
      h('small', { className: 'text-muted d-block' }, coastLines.length ? coastLines : 'Coastline status unavailable until the plugin answers.'),
      msg ? h('div', { className: 'text-danger mt-1' }, msg) : null);

    var d = DEFAULTS;
    var cacheSection = h('div', { className: 'mb-4' },
      h('h5', null, 'Map overlay cache'),
      h('p', { className: 'text-muted small' },
        'Map tiles (colour layers, wind barbs, current arrows, coastline, pressure) are saved on disk and shared by every client. Tiles around the boat, and around the area a map shows, are built ahead of time for every hour of the window: the full radius down to zoom 8, half of it at each deeper zoom.'),
      check(['overlayCache', 'enabled'], d.enabled, 'Build tiles ahead of time'),
      check(['overlayCache', 'followView'], d.followView, 'Also build around the area the map shows'),
      field('Radius', 'Around the boat and the map view at zoom 8 and below.', unitNumber(['overlayCache', 'radius'], d.radius, units.distance, 1000, 2000000)),
      field('Window', 'How far ahead tiles are built, from now. 0 = the whole forecast.', unitNumber(['overlayCache', 'window'], d.window, units.time, 0, 360 * 3600)),
      field('Deepest zoom built ahead', '6–18.', number(['overlayCache', 'maxZoom'], d.maxZoom, { min: 6, max: 18 })),
      field('Build workers', 'Threads building tiles ahead of time, 1–8.', number(['overlayCache', 'workers'], d.workers, { min: 1, max: 8 })),
      field('Disk cap', 'Least recently used tiles are removed above this.',
        h('div', { className: 'input-group' },
          h(DraftNumber, { si: get(['overlayCache', 'diskCap'], d.diskCap), toDisplay: function (b) { return b / 1e9; }, fromDisplay: function (g) { return g * 1e9; },
            precision: 1, step: 0.1, minSI: 100e6, maxSI: Number.MAX_SAFE_INTEGER, onChange: function (v) { set(['overlayCache', 'diskCap'], v); } }),
          h('span', { className: 'input-group-text' }, 'GB'))));

    var otherSection = h('div', { className: 'mb-4' },
      h('h5', null, 'Polars, currents, forecast, Weather API'),
      field('Polar source', 'Automatic prefers the active Polar Management polar, with the internal default as fallback. Internal tables remain available as route overrides.',
        h('select', { className: 'form-select form-control', value: get(['polarSource'], 'auto') === 'files' ? 'files' : 'auto',
          onChange: function (e) { set(['polarSource'], e.target.value); } },
          h('option', { value: 'auto' }, 'Automatic (Polar Management with internal fallback)'),
          h('option', { value: 'files' }, 'Internal default'))),
      field('Default polar file (.csv or .pol)', 'Boat speeds in knots. Blank = the bundled Catalina 36 polar.', text(['polarFile'], 'blank = bundled Catalina 36')),
      field('Polar library directory', "Polars offered in the web app's vessel picker. Blank = the ~700 polars bundled with the plugin (weather_routing_pi library, GPL-3.0); polars you generate are then kept in the plugin data directory.", text(['polarsDir'], 'blank = bundled library')),
      field('Tidal harmonics directory (.npz)', 'FES2014 / NECOFS extracts; every *.npz in it is loaded.', text(['currents', 'harmonicDir'])),
      field('ECMWF open-data mirror', null,
        h('select', { className: 'form-select form-control', value: get(['forecast', 'mirror'], 'ecmwf'),
          onChange: function (e) { set(['forecast', 'mirror'], e.target.value); } },
          MIRRORS.map(function (m) { return h('option', { key: m, value: m }, m); }))),
      check(['weatherProvider', 'enabled'], true, 'Register as a Signal K Weather API provider'));

    // First setup: the plugin has no saved configuration yet, the Admin UI
    // hides its Enabled switch and enables the plugin on the first save
    // (Configuration.tsx: enabled defaults to true when unset). Saving the
    // untouched form is valid (start() applies the defaults), so Save must
    // not wait for a field to change.
    var firstSetup = props.configuration == null;
    return h('div', { className: 'wrp-config' },
      h('p', { className: 'text-muted' }, 'Vessel, forecast horizon, currents, routing and publishing are set in the web app (Weather Router Plus → Settings) and shared by every client.'),
      coastSection, cacheSection, otherSection,
      h('button', { type: 'button', className: 'btn btn-primary', disabled: !dirty && !firstSetup,
        onClick: function () { props.save(cfg); setDirty(false); } },
        firstSetup ? 'Save and enable the plugin' : 'Save (restarts the plugin)'));
  }

  // The Admin UI's React, from the share scope it passes to init().
  function reactFrom(scope) {
    var entries = scope && scope.react;
    if (!entries) return Promise.reject(new Error('no React in the Admin UI share scope'));
    var versions = Object.keys(entries).sort(function (a, b) {
      var x = a.split('.').map(Number), y = b.split('.').map(Number);
      for (var i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return 0;
    });
    var e = entries[versions[0]];
    if (e && typeof e.lib === 'function') return Promise.resolve(e.lib());
    return Promise.resolve(e.get()).then(function (factory) { return factory(); });
  }

  var ready = null;
  return {
    init: function (scope) {
      ready = reactFrom(scope).then(function (r) { React = r && r.default && r.default.createElement ? r.default : r; });
      return ready;
    },
    get: function (name) {
      if (name !== './PluginConfigurationPanel') return Promise.reject(new Error('no module ' + name));
      return (ready || Promise.reject(new Error('container not initialised'))).then(function () {
        return function () { return { default: Panel }; };
      });
    }
  };
})();
