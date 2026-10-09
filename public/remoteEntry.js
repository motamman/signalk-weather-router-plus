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
    var sts = React.useState(null);
    var status = sts[0], setStatus = sts[1];
    var ds = React.useState(false);
    var dirty = ds[0], setDirty = ds[1];
    var ms = React.useState(null);
    var msg = ms[0], setMsg = ms[1];
    var mshs = React.useState(null);
    var meshes = mshs[0], setMeshes = mshs[1];
    var rdg = React.useState(false);
    var catalogReading = rdg[0], setCatalogReading = rdg[1];

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
            setStatus(s || null);
            setCoast(s ? s.coastline || null : null);
            timer = setTimeout(poll, s && s.coastline && s.coastline.downloading ? 2000 : 10000);
          })
          .catch(function () { if (!stop) timer = setTimeout(poll, 10000); });
      }
      poll();
      return function () { stop = true; clearTimeout(timer); };
    }, []);

    // Managed chart meshes: the catalogue rows and their state, from the plugin (every 10 s).
    React.useEffect(function () {
      var stop = false, timer = null;
      function poll() {
        fetch(API + '/meshes', { credentials: 'include', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (m) { if (!stop) { if (m) setMeshes(m); timer = setTimeout(poll, 10000); } })
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

    // "Read the catalogue now": the plugin reads it before answering, so the
    // answer is the fresh mesh list (or the catalogue's error).
    function refreshCatalog() {
      setMsg(null);
      setCatalogReading(true);
      fetch(API + '/meshes/refresh', { method: 'POST', credentials: 'include' })
        .then(function (r) {
          if (r.ok) return r.json();
          // 502: the read failed; the body is still the list (with catalog_error), else plain text.
          return r.text().then(function (t) {
            var body = null;
            try { body = JSON.parse(t); } catch (e) { /* not JSON */ }
            if (body && body.meshes) setMeshes(body);
            throw new Error(body && body.error ? body.error : 'HTTP ' + r.status + ' ' + t);
          });
        })
        .then(function (m) { if (m) setMeshes(m); })
        .catch(function (e) { setMsg('The catalogue could not be read: ' + e.message); })
        .then(function () { setCatalogReading(false); });
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

    // Rendering helpers for the sections -----------------------------------------
    // A card: title, one line saying what it does, then its rows.
    function card(title, purpose) {
      var kids = Array.prototype.slice.call(arguments, 2);
      return h('div', { className: 'card mb-3' },
        h('div', { className: 'card-body' },
          h('h5', { className: 'card-title mb-1' }, title),
          purpose ? h('p', { className: 'text-muted small mb-3' }, purpose) : null,
          kids));
    }
    // A row: label on the left, the control and its "what it does" on the right.
    function row(label, control, why) {
      return h('div', { className: 'row mb-3' },
        h('div', { className: 'col-sm-4 fw-bold' }, label),
        h('div', { className: 'col-sm-8' }, control, why ? h('small', { className: 'form-text text-muted d-block' }, why) : null));
    }
    function statusDot(kind, text) {
      var color = kind === 'ok' ? '#2a7a4b' : kind === 'warn' ? '#b7791f' : kind === 'bad' ? '#b5451b' : '#8a949a';
      return h('span', null,
        h('span', { style: { display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' } }),
        text);
    }
    function fold(summary) {
      var kids = Array.prototype.slice.call(arguments, 1);
      return h('details', { className: 'mt-2' }, h('summary', { className: 'text-primary small', style: { cursor: 'pointer' } }, summary), h('div', { className: 'mt-2' }, kids));
    }
    function gb(n) { return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' GB'; }

    // Coastline ------------------------------------------------------------------
    var configuredCoast = String(get(['landShapefiles'], '')).trim();
    var coastStatus;
    if (!coast) coastStatus = statusDot('off', 'status unavailable until the plugin answers');
    else if (coast.downloading) coastStatus = statusDot('warn', 'downloading GSHHG: ' + (coast.message || '…'));
    else if (coast.error) coastStatus = statusDot('bad', 'last download failed: ' + coast.error);
    else if (configuredCoast) coastStatus = statusDot('ok', 'your own coastline files, in use');
    else if (coast.downloaded) coastStatus = statusDot('ok', 'GSHHG 2.3.7 full resolution, downloaded, in use');
    else coastStatus = statusDot('warn', 'no coastline yet; it downloads by itself at start');
    var coastSection = card('Coastline',
      "The land the router steers around wherever no chart mesh covers. Needed; downloaded once by itself.",
      h('div', { className: 'mb-2' }, coastStatus),
      msg ? h('div', { className: 'text-danger small' }, msg) : null,
      fold('Use my own coastline files instead',
        row('Shapefiles', text(['landShapefiles'], 'blank = the downloaded coastline'),
          'Absolute paths, comma-separated. A GSHHS level-1 path pulls in levels 2–4 beside it. Leave blank to keep the downloaded coastline.'),
        row('', h('div', null,
          h('button', { type: 'button', className: 'btn btn-outline-secondary btn-sm me-2', disabled: !!(coast && coast.downloading), onClick: download },
            coast && coast.downloading ? 'Downloading…' : coast && coast.downloaded ? 'Download the coastline again (149 MB)' : 'Download the coastline (149 MB)'),
          coast && coast.downloaded && configuredCoast
            ? h('button', { type: 'button', className: 'btn btn-outline-primary btn-sm', onClick: function () { set(['landShapefiles'], ''); } }, 'Use the downloaded coastline')
            : null))));

    // Chart meshes ---------------------------------------------------------------
    var ticked = get(['mesh', 'downloads'], []);
    if (!Array.isArray(ticked)) ticked = [];
    var disabled = get(['mesh', 'disabled'], []);
    if (!Array.isArray(disabled)) disabled = [];
    function toggleMesh(name, on) {
      var next = ticked.filter(function (n) { return n !== name; });
      if (on) next.push(name);
      set(['mesh', 'downloads'], next);
    }
    function toggleEnabled(name, on) {
      var next = disabled.filter(function (n) { return n !== name; });
      if (!on) next.push(name);
      set(['mesh', 'disabled'], next);
    }
    function meshStatus(r, on) {
      if (r.state === 'downloading') {
        var p = r.progress;
        var pct = p && p.total ? Math.round(100 * p.files / p.total) : 0;
        return h('span', null,
          h('span', { style: { display: 'inline-block', width: 90, height: 6, background: '#d6dde1', borderRadius: 3, verticalAlign: 'middle', marginRight: 6, position: 'relative' } },
            h('span', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: '#1f5fa8', borderRadius: 3 } })),
          h('small', null, p ? 'downloading, ' + p.files + ' of ' + p.total + ' files' : 'downloading…'));
      }
      if (r.state === 'ready') return statusDot('ok', 'ready');
      if (r.state === 'update') return statusDot('warn', 'newer build published; updates at the next daily check or on Read the catalogue now');
      if (r.state === 'error') return statusDot('bad', r.error || 'failed');
      if (r.state === 'removing') return statusDot('warn', 'removing…');
      return statusDot('off', on ? 'not on this server yet; downloads after Save' : 'not on this server');
    }
    // A catalogue row with a local folder of the same name: which copy the router opens, and why.
    function usingNote(r) {
      if (r.source !== 'catalog' || !r.local_dir) return null;
      var localDate = r.local_build_date ? 'mesh ' + r.local_build_date.slice(0, 10) : 'no build date';
      var text;
      if (r.using === 'local') {
        text = r.disk_build_date
          ? 'Routing on your local copy (' + localDate + '): built later than the download.'
          : 'Routing on your local copy (' + localDate + ') until a newer published copy is downloaded.';
      } else if (r.using === 'download') {
        text = 'Your local copy (' + localDate + ') is older: routing on the download.';
      } else {
        // using === null: the local folder cannot be opened and there is no download.
        text = 'Your local copy (' + localDate + ') cannot be used' + (r.error ? ': ' + r.error : '') + '; nothing to route on for this mesh.';
      }
      return h('small', { className: 'text-muted d-block' }, text);
    }
    function chk(id, on, enabled, onChange) {
      return h('input', { className: 'form-check-input', type: 'checkbox', id: id, checked: !!on, disabled: !enabled, onChange: function (e) { onChange(e.target.checked); } });
    }
    var meshRows = meshes && meshes.meshes ? meshes.meshes : [];
    var meshTable = meshRows.length
      ? h('div', { className: 'table-responsive' }, h('table', { className: 'table table-sm align-middle' },
          h('thead', null, h('tr', null,
            h('th', null, 'Mesh'), h('th', null, 'Covers'), h('th', null, 'Chart / mesh'), h('th', null, 'Size'), h('th', null, 'Status'),
            h('th', { className: 'text-center' }, 'Download'), h('th', { className: 'text-center' }, 'Use'))),
          h('tbody', null, meshRows.map(function (r) {
            var local = r.source === 'local';
            var on = local || ticked.indexOf(r.name) >= 0;
            // Use applies to a downloaded copy and to a local folder of the same name alike.
            var usable = on || !!r.local_dir;
            var use = disabled.indexOf(r.name) < 0;
            var parts = String(r.description || '').split(' · ');
            var covers = local ? (parts[1] || '') : (parts[0] || '');
            var dates = local ? (parts.slice(3).join(', ') || '—') : parts.filter(function (s) { return /^(chart|mesh) /.test(s); }).map(function (s) { return s.replace(/^(chart|mesh) /, ''); }).join(' / ');
            return h('tr', { key: r.source + ':' + r.name },
              h('td', null, h('strong', null, r.name), h('br'), h('small', { className: 'text-muted' }, local ? 'local folder' : r.title.replace(/^\S+ — /, ''))),
              h('td', null, h('small', null, covers)),
              h('td', null, h('small', null, dates || '—')),
              h('td', null, h('small', null, r.bytes ? gb(r.bytes) : '—')),
              h('td', null, meshStatus(r, on), usingNote(r)),
              h('td', { className: 'text-center' }, local ? h('small', { className: 'text-muted' }, '—') : chk('wrp-mesh-dl-' + r.name, on, true, function (v) { toggleMesh(r.name, v); })),
              h('td', { className: 'text-center' }, chk('wrp-mesh-use-' + r.name, usable && use, usable, function (v) { toggleEnabled(r.name, v); })));
          }))))
      : h('p', { className: 'small text-muted' }, meshes ? (meshes.catalog_error ? 'No meshes to show: the catalogue could not be read (' + meshes.catalog_error + ').' : 'The catalogue lists no meshes, and no local folder is set.') : 'Mesh list unavailable until the plugin answers.');
    var catalogNote = meshes
      ? (meshes.catalog_error ? 'Could not be read: ' + meshes.catalog_error : meshes.catalog_updated ? 'Last read: catalogue of ' + meshes.catalog_updated.slice(0, 16).replace('T', ' ') + 'Z, ' + meshRows.filter(function (r) { return r.source === 'catalog'; }).length + ' meshes' : '')
      : '';
    var meshSection = card('Chart meshes',
      'Routing on charted water (depths, clearances, hazards) needs a navigation mesh of the area. Tick the US Coast Guard districts you sail in; each is downloaded and kept current.',
      meshTable,
      h('p', { className: 'small text-muted' },
        h('b', null, 'Download'), ' copies a published mesh to this server and keeps it current; untick to delete the copy. ',
        h('b', null, 'Use'), " lets the router route on it; untick to keep it on disk but route on the coastline there. A local folder has no Download: it's yours."),
      fold('Where meshes come from',
        row('Catalogue', text(['mesh', 'catalogUrl'], 'blank = the US-ENC catalogue on R2'),
          'List of published meshes. ' + catalogNote),
        h('div', { className: 'mb-3' },
          h('button', { type: 'button', className: 'btn btn-outline-secondary btn-sm', disabled: catalogReading, onClick: refreshCatalog },
            catalogReading ? 'Reading…' : 'Read the catalogue now'),
          h('small', { className: 'form-text text-muted d-block' }, 'Reads the catalogue at the saved address, lists what it says, then downloads ticked meshes that are missing or have a newer build. Otherwise it is read at start and once a day.')),
        row('Local mesh folder', text(['meshDir'], 'blank = none'),
          'A folder holding one mesh (index.json and its tiles) or several mesh folders, managed by you and used beside the downloaded ones.')));

    // Map tiles built ahead ------------------------------------------------------
    var d = DEFAULTS;
    var tiles = status && status.overlay_tiles ? status.overlay_tiles : null;
    var windowSI = get(['overlayCache', 'window'], d.window);
    var cacheSection = card('Map tiles built ahead',
      "The web app's weather layers are drawn from tiles. Building them ahead of time makes the map instant; it costs disk and a little CPU in the background.",
      row('Build ahead', check(['overlayCache', 'enabled'], d.enabled, 'On'),
        'Off: tiles are built when first viewed (slower first view, no background work, nothing stored ahead).'),
      row('Around the boat', unitNumber(['overlayCache', 'radius'], d.radius, units.distance, 1000, 2000000),
        "Radius built around the vessel's position. Halved at each deeper zoom."),
      row('How far ahead', unitNumber(['overlayCache', 'window'], d.window, units.time, 0, 360 * 3600),
        (windowSI === 0 ? 'Currently: the whole forecast. ' : '') + 'Hours of forecast tiles kept ready; 0 = the whole forecast.'),
      row('Where the map looks', check(['overlayCache', 'followView'], d.followView, 'Also build around the area a map shows'),
        'A client panning away from the boat gets tiles built there too.'),
      fold('Advanced',
        row('Deepest zoom', number(['overlayCache', 'maxZoom'], d.maxZoom, { min: 6, max: 18 }), '6–18. Deeper = more detail near the boat, many more tiles.'),
        row('Builders', number(['overlayCache', 'workers'], d.workers, { min: 1, max: 8 }), 'Processes building tiles, 1–8. They start when there is work and exit when done. More = faster, more memory while they run.'),
        row('Disk cap',
          h('div', { className: 'input-group', style: { maxWidth: 220 } },
            h(DraftNumber, { si: get(['overlayCache', 'diskCap'], d.diskCap), toDisplay: function (b) { return b / 1e9; }, fromDisplay: function (g) { return g * 1e9; },
              precision: 1, step: 0.1, minSI: 100e6, maxSI: Number.MAX_SAFE_INTEGER, onChange: function (v) { set(['overlayCache', 'diskCap'], v); } }),
            h('span', { className: 'input-group-text' }, 'GB')),
          'Oldest tiles are removed above this.' + (tiles ? ' Current use: ' + gb(tiles.bytes) + ' in ' + tiles.files + ' files.' : ''))));

    // Polars, currents, forecast source, Weather API -------------------------------
    var polarSection = card('Polars',
      "Boat speed tables for sailing. The web app's Vessel picker offers the library; a route can pick any of them.",
      row('Default polar', text(['polarFile'], 'blank = the bundled Catalina 36'), 'A .csv or .pol file. Used when a route names no polar.'),
      row('Library folder', text(['polarsDir'], 'blank = the ~700 bundled polars'),
        'A folder of .pol / .csv files to offer instead of the bundled library (weather_routing_pi, GPL-3.0). Polars you generate are kept in the plugin data directory either way.'));
    var currentsSection = card('Tidal currents',
      'Ocean currents come from Copernicus and RTOFS by themselves (set up under Defaults → Currents in the web app). Tidal harmonics are optional local files and take precedence where they cover.',
      row('Harmonics folder', text(['currents', 'harmonicDir'], 'blank = none'), 'FES2014 / NECOFS .npz extracts; every file in the folder is loaded.'));
    var MIRROR_LABELS = { ecmwf: 'ECMWF (data.ecmwf.int)', aws: 'Amazon (AWS Open Data)', google: 'Google Cloud' };
    var forecastSection = card('Forecast download',
      "Where the ECMWF open-data forecast is fetched from. Same data on every mirror; pick the one that's fast from your connection.",
      row('Mirror',
        h('select', { className: 'form-select form-control', style: { maxWidth: 320 }, value: get(['forecast', 'mirror'], 'ecmwf'),
          onChange: function (e) { set(['forecast', 'mirror'], e.target.value); } },
          MIRRORS.map(function (m) { return h('option', { key: m, value: m }, MIRROR_LABELS[m] || m); })),
        'Changes which server is contacted every six hours. Nothing else.'));
    var weatherSection = card('Signal K Weather API',
      'Other apps on this Signal K server (Freeboard, KIP, …) can ask it for weather at a point.',
      row('Provide weather', check(['weatherProvider', 'enabled'], true, 'Register as a Weather API provider'),
        "Off only if another plugin should be the server's weather provider."));

    // First setup: the plugin has no saved configuration yet, the Admin UI
    // hides its Enabled switch and enables the plugin on the first save
    // (Configuration.tsx: enabled defaults to true when unset). Saving the
    // untouched form is valid (start() applies the defaults), so Save must
    // not wait for a field to change.
    var firstSetup = props.configuration == null;
    return h('div', { className: 'wrp-config' },
      h('div', { className: 'alert alert-secondary small' },
        h('b', null, 'Two kinds of settings, two places. '),
        'This page is the installation: files on this server, what it downloads, how it serves tiles. Everything about the boat and the routing — draft and height (Signal K vessel data), polar performance, forecast horizon, currents, routing engine, publishing — is in the web app under ',
        h('b', null, 'Defaults'), ', shared by every client. Save here restarts the plugin.'),
      coastSection, meshSection, cacheSection, polarSection, currentsSection, forecastSection, weatherSection,
      h('div', { className: 'd-flex align-items-center gap-3' },
        h('button', { type: 'button', className: 'btn btn-primary', disabled: !dirty && !firstSetup,
          onClick: function () { props.save(cfg); setDirty(false); } },
          firstSetup ? 'Save and enable the plugin' : 'Save (restarts the plugin)'),
        dirty ? h('small', { className: 'text-muted' }, 'Unsaved changes') : null));
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
