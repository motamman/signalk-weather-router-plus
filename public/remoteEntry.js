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
  // The ensembles and member counts the plugin offers (src/data/ecmwf.ts ENSEMBLES, ENSEMBLE_MEMBER_CHOICES).
  var ENSEMBLE_MODELS = [{ id: 'ifs-ens', name: 'ECMWF IFS ENS' }, { id: 'aifs-ens', name: 'ECMWF AIFS ENS' }];
  var ENSEMBLE_MEMBERS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
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
    var act = React.useState(null);
    var acting = act[0], setActing = act[1];   // the mesh an action is running for
    var mm = React.useState(null);
    var meshMsg = mm[0], setMeshMsg = mm[1];   // the mesh card's own error line

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

    // "Check for updates": the plugin reads the catalogue before answering, so the
    // answer is the fresh mesh list (or the catalogue's error); newer builds of the
    // meshes kept are then downloaded.
    function refreshCatalog() {
      setMeshMsg(null);
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
        .catch(function (e) { setMeshMsg('The catalogue could not be read: ' + e.message); })
        .then(function () { setCatalogReading(false); });
    }

    // "Rebuild rough cuts": every mesh's rough cut (the corridor search's map of the water) for the boat's Signal K
    // draught and air draft, rebuilt in the background; the card shows its progress from GET /api/meshes.
    function rebuildRoughCuts() {
      setMeshMsg(null);
      fetch(API + '/meshes/rough-cut', { method: 'POST', credentials: 'include' })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t); });
          return r.json();
        })
        .then(function (rc) { setMeshes(function (m) { return m ? Object.assign({}, m, { rough_cut: rc }) : m; }); })
        .catch(function (e) { setMeshMsg('Rough cuts: ' + e.message); });
    }

    // A mesh action (download, update, redownload, remove, cancel): the plugin
    // changes its own download list and runs a pass; the form's copy of the
    // list is taken from the answer so a later Save does not put an old one back.
    function meshAction(name, action) {
      setMeshMsg(null);
      setActing(name);
      fetch(API + '/meshes/' + encodeURIComponent(name) + '/' + action, { method: 'POST', credentials: 'include' })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t); });
          return r.json();
        })
        .then(function (m) {
          if (m && m.meshes) setMeshes(m);
          if (m && Array.isArray(m.downloads)) setCfg(function (c) { var n = JSON.parse(JSON.stringify(c)); n.mesh = n.mesh || {}; n.mesh.downloads = m.downloads; return n; });
        })
        .catch(function (e) { setMeshMsg(name + ': ' + e.message); })
        .then(function () { setActing(null); });
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
    else if (coast.downloaded) coastStatus = statusDot('ok', 'GSHHG 2.3.7 full resolution, downloaded' + (coast.downloaded_at ? ' on ' + coast.downloaded_at.slice(0, 10) : '') + ', in use');
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
    var preferLocal = get(['mesh', 'preferLocal'], []);
    if (!Array.isArray(preferLocal)) preferLocal = [];
    var preferDownload = get(['mesh', 'preferDownload'], []);
    if (!Array.isArray(preferDownload)) preferDownload = [];
    // Which copy the router uses when a name has both. Two buttons, the copy in use ticked: until the
    // owner clicks, the plugin picks the newer build; a click is kept in one of the two lists. Saved with Save.
    function chooseCopy(name, choice) {
      set(['mesh', 'preferLocal'], preferLocal.filter(function (n) { return n !== name; }).concat(choice === 'local' ? [name] : []));
      set(['mesh', 'preferDownload'], preferDownload.filter(function (n) { return n !== name; }).concat(choice === 'download' ? [name] : []));
    }
    function copyChoice(r) {
      if (r.source !== 'catalog' || !r.local_dir || !r.disk_build_date) return null;
      var choice = preferLocal.indexOf(r.name) >= 0 ? 'local' : preferDownload.indexOf(r.name) >= 0 ? 'download' : (r.using === 'local' ? 'local' : 'download');
      var id = 'wrp-mesh-copy-' + r.name;
      function radio(value, label) {
        return h('label', { className: 'me-3', style: { cursor: 'pointer' } },
          // On click, not on change: clicking the copy already ticked by date records it as the owner's choice, so it stays
          // when a newer copy of the other kind arrives later.
          h('input', { type: 'radio', name: id, className: 'form-check-input me-1', checked: choice === value, onChange: function () {}, onClick: function () { chooseCopy(r.name, value); } }), label);
      }
      return h('div', { className: 'mt-1 small' }, radio('download', 'downloaded'), radio('local', 'my folder'));
    }
    function toggleEnabled(name, on) {
      var next = disabled.filter(function (n) { return n !== name; });
      if (!on) next.push(name);
      set(['mesh', 'disabled'], next);
    }
    function day(iso) { return iso ? String(iso).slice(0, 10) : '—'; }
    // Build times to the minute: two builds of one mesh can be hours apart on the same day.
    function when(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') + 'Z' : 'no build date'; }
    // "On this server": what copy is here, in words.
    function onServer(r) {
      if (r.source === 'local') return h('span', null, 'your folder', h('br'), h('small', { className: 'text-muted' }, 'build of ' + when(r.local_build_date)));
      if (r.state === 'downloading') {
        // The archive: downloaded (bytes of its size), then unpacked (bytes of it read, files written).
        var p = r.progress;
        var pct = p && p.total ? Math.round(100 * p.bytes / p.total) : 0;
        var words = !p ? 'starting…'
          : p.phase === 'unpack' ? 'unpacking, ' + p.files + ' files'
          : 'downloading, ' + gb(p.bytes) + ' of ' + gb(p.total);
        return h('span', null,
          h('span', { style: { display: 'inline-block', width: 90, height: 6, background: '#d6dde1', borderRadius: 3, verticalAlign: 'middle', marginRight: 6, position: 'relative' } },
            h('span', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: '#1f5fa8', borderRadius: 3 } })),
          h('small', null, words));
      }
      if (r.state === 'removing') return statusDot('warn', 'removing…');
      if (r.state === 'error') return statusDot('bad', r.error || 'failed');
      if (!r.catalog_build_date && !r.local_dir) return statusDot('bad', 'unknown name: not published, not in your folder');
      if (r.state === 'update') return h('span', null, statusDot('warn', 'downloaded: build of ' + when(r.disk_build_date)), h('br'), h('small', { className: 'text-muted' }, 'newer build published'));
      if (r.state === 'ready') return statusDot('ok', 'downloaded: build of ' + when(r.disk_build_date));
      return statusDot('off', 'not downloaded');
    }
    // A catalogue row with a local folder of the same name: which copy the router opens, and why.
    function usingNote(r) {
      if (r.source !== 'catalog' || !r.local_dir) return null;
      var mine = 'Also in your folder: build of ' + when(r.local_build_date);
      var text;
      if (r.using === 'local') text = mine + (r.using_why === 'choice' ? ': used, your choice.' : r.disk_build_date ? ', newer than the download: used.' : ': used until a newer build is downloaded.');
      else if (r.using === 'download') text = mine + (r.using_why === 'choice' ? ', not used, your choice.' : ', older, not used.');
      else text = mine + ', cannot be used' + (r.error ? ': ' + r.error : '') + '.';
      return h('small', { className: 'text-muted d-block' }, text);
    }
    function actBtn(label, name, action, kind) {
      return h('button', { type: 'button', className: 'btn btn-sm me-1 mb-1 ' + (kind || 'btn-outline-secondary'), disabled: acting !== null, onClick: function () { meshAction(name, action); } },
        acting === name ? '…' : label);
    }
    function actions(r) {
      if (r.source === 'local') return h('small', { className: 'text-muted' }, '—');
      var unknown = !r.catalog_build_date && !r.local_dir;
      if (unknown) return actBtn('Remove', r.name, 'remove');
      if (r.state === 'downloading') return actBtn('Cancel', r.name, 'cancel');
      if (r.state === 'removing') return null;
      var out = [];
      if (r.state === 'update') out.push(actBtn('Update', r.name, 'update', 'btn-outline-primary'));
      else if (r.state === 'ready') out.push(actBtn('Download again', r.name, 'redownload'));
      else out.push(actBtn('Download', r.name, 'download', 'btn-outline-primary'));
      if (r.ticked || r.disk_build_date) out.push(actBtn('Remove', r.name, 'remove'));
      return h('span', null, out);
    }
    function chk(id, on, enabled, onChange) {
      return h('input', { className: 'form-check-input', type: 'checkbox', id: id, checked: !!on, disabled: !enabled, onChange: function (e) { onChange(e.target.checked); } });
    }
    var meshRows = meshes && meshes.meshes ? meshes.meshes : [];
    var meshTable = meshRows.length
      ? h('div', { className: 'table-responsive' }, h('table', { className: 'table table-sm align-middle' },
          h('thead', null, h('tr', null,
            h('th', null, 'Mesh'), h('th', null, 'Area'), h('th', null, 'Published'), h('th', null, 'On this server'),
            h('th', { className: 'text-center' }, 'Use'), h('th', null, 'Actions'))),
          h('tbody', null, meshRows.map(function (r) {
            var local = r.source === 'local';
            var on = local || r.ticked;
            var usable = on || !!r.local_dir || !!r.disk_build_date;
            var use = disabled.indexOf(r.name) < 0;
            var parts = String(r.description || '').split(' · ');
            var area = local ? (parts[1] || '') : (r.catalog_build_date ? (parts[0] || '') : '');
            return h('tr', { key: r.source + ':' + r.name },
              h('td', null, h('strong', null, r.name), h('br'), h('small', { className: 'text-muted' }, local ? 'your folder' : String(r.title || '').replace(/^\S+ — /, ''))),
              h('td', null, h('small', null, area)),
              h('td', null, h('small', null, r.catalog_build_date ? day(r.catalog_build_date) + (r.bytes ? ', ' + gb(r.bytes) : '') : '—')),
              h('td', null, onServer(r), usingNote(r), copyChoice(r)),
              h('td', { className: 'text-center' }, chk('wrp-mesh-use-' + r.name, usable && use, usable, function (v) { toggleEnabled(r.name, v); })),
              h('td', null, actions(r)));
          }))))
      : h('p', { className: 'small text-muted' }, meshes ? (meshes.catalog_error ? 'No meshes to show: the catalogue could not be read (' + meshes.catalog_error + ').' : 'The catalogue lists no meshes, and no local folder is set.') : 'Mesh list unavailable until the plugin answers.');
    var published = meshRows.filter(function (r) { return r.source === 'catalog' && r.catalog_build_date; }).length;
    var catalogNote = !meshes ? 'Waiting for the plugin.'
      : meshes.catalog_error ? 'The catalogue could not be read: ' + meshes.catalog_error
      : meshes.catalog_updated ? 'Catalogue of ' + meshes.catalog_updated.slice(0, 16).replace('T', ' ') + 'Z, ' + published + ' meshes published.'
      : 'The catalogue has not been read yet.';
    // The rough cuts: what is building, or the last build and its error.
    var rc = meshes && meshes.rough_cut ? meshes.rough_cut : null;
    var rcNote = !rc ? null
      : rc.running ? 'Building rough cuts: ' + rc.done + ' of ' + rc.total + ' done, now ' + rc.running + '.'
      : rc.error ? 'Rough cuts: ' + rc.error
      : rc.last ? 'Rough cuts built ' + String(rc.last.at).slice(0, 16).replace('T', ' ') + 'Z for ' + rc.last.built + ' mesh folder(s) in ' + Math.round(rc.last.ms / 1000) + ' s.'
      : 'No rough cuts built since the plugin started; a route builds the one it needs.';
    var roughCutRow = h('div', { className: 'mb-2 d-flex align-items-center flex-wrap gap-2' },
      h('button', { type: 'button', className: 'btn btn-outline-secondary btn-sm', disabled: !!(rc && rc.running) || acting !== null, onClick: rebuildRoughCuts },
        rc && rc.running ? 'Building…' : 'Rebuild rough cuts'),
      rcNote ? h('small', { className: rc && rc.error ? 'text-danger' : 'text-muted' }, rcNote) : null);
    var meshSection = card('Chart meshes',
      'Routing on charted water (depths, clearances, hazards) needs a navigation mesh of the area. Download the US Coast Guard districts you sail in; each is kept current.',
      h('div', { className: 'mb-2 d-flex align-items-center flex-wrap gap-2' },
        h('button', { type: 'button', className: 'btn btn-outline-secondary btn-sm', disabled: catalogReading || acting !== null, onClick: refreshCatalog },
          catalogReading ? 'Checking…' : 'Check for updates'),
        h('small', { className: 'text-muted' }, catalogNote + ' Checked by itself at start and once a day.')),
      meshTable,
      roughCutRow,
      meshMsg ? h('div', { className: 'text-danger small mb-2' }, meshMsg) : null,
      h('p', { className: 'small text-muted' },
        h('b', null, 'Download'), ' copies a published mesh to this server and keeps it current. ',
        h('b', null, 'Update'), ' fetches a newer published build. ',
        h('b', null, 'Download again'), ' fetches the current build afresh and swaps it in when complete. ',
        h('b', null, 'Remove'), ' deletes the copy. These act at once. ',
        h('b', null, 'Use'), ' lets the router route on a mesh; unticked it stays on disk and the coastline is used there. Where a mesh is both downloaded and in your folder, ',
        h('b', null, 'downloaded / my folder'), ' picks the copy the router uses. Use and that choice apply on Save. ',
        h('b', null, 'Rebuild rough cuts'), ' redoes the map of the water each mesh gives the router to find a long leg\'s way (built by itself after each download, and by a route that needs one).'),
      fold('Catalogue address and your own folder',
        row('Catalogue', text(['mesh', 'catalogUrl'], 'blank = the US-ENC catalogue on R2'), 'The index.json listing the published meshes.'),
        row('Local mesh folder', text(['meshDir'], 'blank = none'),
          'A folder holding one mesh (index.json and its tiles) or several mesh folders, managed by you and used beside the downloaded ones.')));

    // Map tiles built ahead ------------------------------------------------------
    var d = DEFAULTS;
    var tiles = status && status.overlay_tiles ? status.overlay_tiles : null;
    var windowSI = get(['overlayCache', 'window'], d.window);
    var pb = status && status.overlay_prebuild ? status.overlay_prebuild : null;
    var tilesNote = !pb ? null
      : !pb.enabled ? 'Pre-building is off.'
      : 'Built so far: ' + pb.built_total + ' tiles. This pass: ' + pb.built + ' built of ' + pb.seen + ' checked' + (pb.complete ? ', complete.' : ', still building.') + (pb.last_error ? ' Last error: ' + pb.last_error : '');
    var cacheSection = card('Map tiles',
      "The web app's weather layers are drawn from map tiles. Building them before anyone looks makes the map instant; it costs disk and a little CPU in the background.",
      tilesNote ? h('div', { className: 'mb-2 small' }, statusDot(pb.enabled ? (pb.last_error ? 'warn' : 'ok') : 'off', tilesNote)) : null,
      row('Pre-build tiles', check(['overlayCache', 'enabled'], d.enabled, 'On'),
        'Off: tiles are built when first viewed (slower first view, no background work, nothing stored ahead).'),
      row('Radius round the boat', unitNumber(['overlayCache', 'radius'], d.radius, units.distance, 1000, 2000000),
        "Tiles are built this far round the vessel's position. Halved at each deeper zoom."),
      row('Hours of forecast kept ready', unitNumber(['overlayCache', 'window'], d.window, units.time, 0, 360 * 3600),
        (windowSI === 0 ? 'Currently: the whole forecast. ' : '') + '0 = the whole forecast.'),
      row('Also round the area a map shows', check(['overlayCache', 'followView'], d.followView, 'On'),
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
      row('Polar source',
        h('select', { className: 'form-select form-control', value: get(['polarSource'], 'auto') === 'files' ? 'files' : 'auto',
          onChange: function (e) { set(['polarSource'], e.target.value); } },
          h('option', { value: 'auto' }, 'Automatic (Polar Management with internal fallback)'),
          h('option', { value: 'files' }, 'Internal default')),
        'Automatic uses the active Polar Management polar when available. Internal tables remain available as route overrides.'),
      row('Default polar', text(['polarFile'], 'blank = the bundled Catalina 36'), 'A .csv or .pol file. Used for internal fallback or an explicit internal selection.'),
      row('Library folder', text(['polarsDir'], 'blank = the ~700 bundled polars'),
        'A folder of .pol / .csv files to offer instead of the bundled library (weather_routing_pi, GPL-3.0). Polars you generate are kept in the plugin data directory either way.'));
    var MIRROR_LABELS = { ecmwf: 'ECMWF (data.ecmwf.int)', aws: 'Amazon (AWS Open Data)', google: 'Google Cloud' };
    var fc = status && status.forecast ? status.forecast : null;
    // Ensembles (config.ts resolveEnsemble): off unless enabled; on, IFS ENS until another is ticked.
    var ensembleOn = !!get(['forecast', 'ensemble', 'enabled'], false);
    var ensembleStatus = status && Array.isArray(status.ensembles) ? status.ensembles : [];
    var ensembleModels = get(['forecast', 'ensemble', 'models'], ['ifs-ens']);
    if (!Array.isArray(ensembleModels)) ensembleModels = [];
    var forecastSection = card('Forecast download',
      "Where the ECMWF open-data forecast is fetched from. Same data on every mirror; pick the one that's fast from your connection.",
      h('div', { className: 'mb-2 small' }, fc && fc.cycle
        ? statusDot('ok', 'Last fetched: the ' + String(fc.cycle).slice(0, 16).replace('T', ' ') + 'Z run, loaded ' + (fc.loaded_at ? String(fc.loaded_at).slice(0, 16).replace('T', ' ') + 'Z' : '') + (fc.model ? ' (' + fc.model + ')' : ''))
        : statusDot('off', status && status.forecast_loading ? 'Fetching a forecast now.' : 'No forecast loaded yet.')),
      row('Mirror',
        h('select', { className: 'form-select form-control', style: { maxWidth: 320 }, value: get(['forecast', 'mirror'], 'ecmwf'),
          onChange: function (e) { set(['forecast', 'mirror'], e.target.value); } },
          MIRRORS.map(function (m) { return h('option', { key: m, value: m }, MIRROR_LABELS[m] || m); })),
        'Changes which server is contacted every six hours. Nothing else.'),
      ensembleStatus.length ? h('div', { className: 'mb-2 small' }, ensembleStatus.map(function (e) {
        var text = e.name + ': ' + (e.cycle ? e.members.length + ' members of the ' + String(e.cycle).slice(0, 16).replace('T', ' ') + 'Z run, ' + gb(e.bytes) + ' on disk' : 'none on disk yet')
          + (e.loading ? '; downloading the ' + String(e.loading.cycle).slice(0, 16).replace('T', ' ') + 'Z run' + (e.loading.total ? ' (' + e.loading.done + ' of ' + e.loading.total + ')' : '') : '')
          + (e.error ? '; ' + e.error : '');
        return h('div', { key: e.model }, statusDot(e.error ? 'warn' : e.cycle ? 'ok' : 'off', text));
      })) : null,
      row('Ensembles', check(['forecast', 'ensemble', 'enabled'], false, 'Download ensembles'),
        "Each cycle, after the forecast, also download ECMWF ensembles (wind and waves, to the forecast's horizon), so Find Route can " +
        "compute the route on each member's forecast as well: where each member's route goes and when it arrives. At 72 h, per member " +
        'and cycle, on the test box (Pi 5): about 70 MB downloaded (5 IFS ENS members took 350,757,112 B, 2026-11-05); on disk 519 MB ' +
        'for an IFS ENS member and 270 MB for an AIFS ENS member (du, 2026-11-06).'),
      ensembleOn ? row('Which', h('div', null, ENSEMBLE_MODELS.map(function (m) {
        var on = ensembleModels.indexOf(m.id) >= 0;
        var last = on && ensembleModels.length === 1;
        return h('div', { className: 'form-check', key: m.id },
          h('input', { className: 'form-check-input', type: 'checkbox', id: 'wrp-ens-' + m.id, checked: on, disabled: last,
            title: last ? 'At least one ensemble while ensembles are on' : '',
            onChange: function (e) {
              set(['forecast', 'ensemble', 'models'], e.target.checked ? ensembleModels.concat([m.id]) : ensembleModels.filter(function (x) { return x !== m.id; }));
            } }),
          h('label', { className: 'form-check-label', htmlFor: 'wrp-ens-' + m.id }, m.name));
      })), 'At least one while ensembles are on.') : null,
      ensembleOn ? row('Members per ensemble',
        h('select', { className: 'form-select form-control', style: { maxWidth: 120 }, value: get(['forecast', 'ensemble', 'members'], 5),
          onChange: function (e) { set(['forecast', 'ensemble', 'members'], Number(e.target.value)); } },
          ENSEMBLE_MEMBERS.map(function (n) { return h('option', { key: n, value: n }, String(n)); })),
        'Members 1 to this number of each ensemble (and its control where ECMWF publishes one). A route can use any number up to it.') : null);
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
        'This page is what is installed on this server. Boat and routing settings are in the web app\'s ', h('b', null, 'Defaults'), ' tab. Save restarts the plugin.'),
      coastSection, meshSection, cacheSection, polarSection, forecastSection, weatherSection,
      h('div', { className: 'd-flex align-items-center gap-3' },
        h('button', { type: 'button', className: 'btn btn-primary', disabled: (!dirty && !firstSetup) || acting !== null,
          title: acting !== null ? 'A mesh action is running; Save when it has answered' : '',
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
