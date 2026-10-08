// Weather Router Plus — Defaults tab (server-side settings): entry module,
// imports UI_UNITS, API, escapeHtml and loadPluginStatus from rp-core.js.
//
// GET  /api/settings → {values, schema}: values are SI (m, m/s, s, deg);
//      schema.settings[] gives key, group, label, type, unit, quantity,
//      min/max (SI), multipleOf, oneOf, default, nullable, enum, help, reload.
// PUT  /api/settings with only the changed keys ({group: {key: SI}}) →
//      {values, changed, reloaded} or 400 {error, errors: {key: msg}}.
// Inputs show values in the Signal K user's unit preferences;
// conversion happens here, the server only ever sees SI.

import { oneOpenAtATime, API, escapeHtml, loadPluginStatus, UI_UNITS, UNIT_MISSING, unitTextHtml } from './rp-core.js';
(function () {
  const form = document.getElementById('srvSettingsForm');
  const saveBtn = document.getElementById('srvSettingsSave');
  const revertBtn = document.getElementById('srvSettingsRevert');
  const dirtyEl = document.getElementById('srvSettingsDirty');
  const statusEl = document.getElementById('srvSettingsStatus');
  if (!form || !saveBtn || !revertBtn || !statusEl) return;
  oneOpenAtATime(form); // one group open at a time (the groups are rendered into the form later; the listener is on the form)

  let schema = null;      // {groups, settings}
  let values = null;      // last saved values (SI), nested
  let rows = [];          // [{spec, input, row, errEl, conv, initialText}]
  let loading = false;

  const esc = escapeHtml; // rp-core.js
  const getVal = (key) => { const [g, k] = key.split('.'); return values && values[g] ? values[g][k] : undefined; };

  // Display conversion for a spec: display = fn(si), si = inv(display).
  // User-unit quantities use the Signal K unit preferences (UI_UNITS).
  const lin = (unit, f, prec) => ({ unit, fn: v => v * f, inv: d => d / f, prec });
  function convFor(spec) {
    const q = spec.quantity;
    if (q === 'speed' || q === 'depth' || q === 'wave_height' || q === 'short_distance' || q === 'ratio') {
      // No fallback unit: unresolved → the value shows empty and can't be saved.
      const c = UI_UNITS[q];
      if (c && c.inv) return { unit: c.unit, fn: c.fn, inv: c.inv, prec: Math.max(1, c.precision) + 1 };
      return { unit: UNIT_MISSING, fn: () => NaN, inv: () => NaN, prec: 0, missing: true };
    }
    if (q === 'hours' || q === 'minutes' || q === 'seconds') {
      // Durations in the user's time unit. A duration-format preference
      // (e.g. "1d 2h") has no single unit to type a number in: no unit.
      const c = UI_UNITS.time;
      if (c && c.inv && !c.text) return { unit: c.unit, fn: c.fn, inv: c.inv, prec: Math.max(1, c.precision) + 1 };
      return { unit: UNIT_MISSING, fn: () => NaN, inv: () => NaN, prec: 0, missing: true };
    }
    if (q === 'data_size') {
      const c = UI_UNITS.data_size;
      if (c && c.inv) return { unit: c.unit, fn: c.fn, inv: c.inv, prec: Math.max(1, c.precision) + 1 };
      return { unit: UNIT_MISSING, fn: () => NaN, inv: () => NaN, prec: 0, missing: true };
    }
    if (q === 'angle') {
      // Stored in degrees; the user's angle unit is over radians (the category's SI).
      const c = UI_UNITS.angle, D = Math.PI / 180;
      if (c && c.inv) return { unit: c.unit, fn: v => c.fn(v * D), inv: d => c.inv(d) / D, prec: Math.max(1, c.precision) + 1 };
      return { unit: UNIT_MISSING, fn: () => NaN, inv: () => NaN, prec: 0, missing: true };
    }
    return lin(spec.unit || '', 1, spec.type === 'integer' ? 0 : 3);
  }
  function fmtNum(v, prec) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '';
    const t = v.toFixed(prec);
    // Trim trailing zeros after the point ("3.10" → "3.1", "72" stays).
    return t.indexOf('.') >= 0 ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
  }
  function textFor(spec, si, conv) {
    if (spec.type === 'boolean') return si ? 'true' : 'false';
    if (spec.type === 'string' || spec.type === 'enum') return si == null ? '' : String(si);
    return fmtNum(si == null ? null : conv.fn(si), conv.prec);
  }
  function currentText(r) {
    return r.spec.type === 'boolean' ? (r.input.checked ? 'true' : 'false') : r.input.value.trim();
  }
  // Input text → SI value, or throws Error(message) for an inline error.
  function parseInput(r) {
    const s = r.spec, t = currentText(r);
    if (s.type === 'boolean') return t === 'true';
    if (s.type === 'enum') return t;
    if (s.type === 'string') {
      if (s.maxLength && t.length > s.maxLength) throw new Error('at most ' + s.maxLength + ' characters');
      return t;
    }
    if (t === '') {
      if (s.nullable) return null;
      throw new Error('required');
    }
    const d = Number(t);
    if (!Number.isFinite(d)) throw new Error('not a number');
    if (r.conv.missing) throw new Error('no unit for this value in your Signal K unit preferences');
    let si = r.conv.inv(d);
    if (s.multipleOf) {
      const q = si / s.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-6) throw new Error('must be a whole multiple of ' + textFor(s, s.multipleOf, r.conv) + (r.conv.unit ? ' ' + r.conv.unit : ''));
      si = Math.round(q) * s.multipleOf;
    }
    if (s.type === 'integer' && !Number.isInteger(si)) throw new Error('must be a whole number');
    if (s.oneOf && !s.oneOf.some((x) => Math.abs(x - si) < 1e-9)) {
      throw new Error('must be ' + s.oneOf.map((x) => textFor(s, x, r.conv)).join(' or ') + (r.conv.unit ? ' ' + r.conv.unit : ''));
    }
    const lo = s.min, hi = s.max;
    if ((lo !== undefined && si < lo - 1e-9) || (hi !== undefined && si > hi + 1e-9)) {
      throw new Error('must be ' + textFor(s, lo, r.conv) + '–' + textFor(s, hi, r.conv) + (r.conv.unit ? ' ' + r.conv.unit : ''));
    }
    return si;
  }

  function setStatus(html) { statusEl.innerHTML = html || ''; }

  function render() {
    if (!schema || !values) return;
    const byGroup = {};
    for (const s of schema.settings) (byGroup[s.group] = byGroup[s.group] || []).push(s);
    let html = '';
    for (const g of schema.groups) {
      const specs = byGroup[g.id] || [];
      if (!specs.length) continue;
      html += '<details class="subsection"><summary>' + esc(g.label) + '</summary><div class="subsection-body">';
      if (g.help) html += '<div class="ctl-hint">' + unitTextHtml(g.help) + '</div>';
      for (const s of specs) {
        const id = 'st_' + s.key.replace(/\./g, '_');
        if (s.type === 'boolean') {
          html += '<div class="st-row st-bool" data-key="' + esc(s.key) + '"><label for="' + id + '"><input type="checkbox" id="' + id + '">' + esc(s.label) + '</label>'
            + '<div class="ctl-hint">' + unitTextHtml(s.help) + '</div><div class="st-err"></div></div>';
          continue;
        }
        html += '<div class="st-row" data-key="' + esc(s.key) + '"><label for="' + id + '"><span>' + esc(s.label) + '</span><span class="st-unit"></span></label>';
        if (s.type === 'enum') {
          html += '<select id="' + id + '">' + s.enum.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('') + '</select>';
        } else if (s.type === 'string') {
          html += '<input type="text" id="' + id + '"' + (s.maxLength ? ' maxlength="' + s.maxLength + '"' : '') + '>';
        } else {
          html += '<input type="text" inputmode="decimal" id="' + id + '"' + (s.nullable ? ' placeholder="none"' : '') + '>';
        }
        html += '<div class="ctl-hint">' + unitTextHtml(s.help) + '</div><div class="st-err"></div></div>';
      }
      html += '</div></details>';
    }
    form.innerHTML = html;
    rows = schema.settings.map((spec) => {
      const row = form.querySelector('.st-row[data-key="' + spec.key + '"]');
      const input = row.querySelector('input, select');
      const r = { spec, row, input, errEl: row.querySelector('.st-err'), unitEl: row.querySelector('.st-unit'), conv: convFor(spec), initialText: '' };
      input.addEventListener('input', () => { validateRow(r); refreshDirty(); });
      input.addEventListener('change', () => { validateRow(r); refreshDirty(); });
      return r;
    });
    fillFromValues();
  }

  // Put the saved values into the inputs (discarding edits).
  function fillFromValues() {
    for (const r of rows) {
      r.conv = convFor(r.spec);
      r.initialText = textFor(r.spec, getVal(r.spec.key), r.conv);
      if (r.spec.type === 'boolean') r.input.checked = r.initialText === 'true';
      else r.input.value = r.initialText;
      if (r.unitEl) r.unitEl.textContent = r.conv.unit || '';
      r.errEl.textContent = '';
      r.row.classList.remove('st-invalid');
    }
    refreshDirty();
  }

  function validateRow(r) {
    try {
      parseInput(r);
      r.errEl.textContent = '';
      r.row.classList.remove('st-invalid');
      return true;
    } catch (e) {
      r.errEl.innerHTML = unitTextHtml(e.message);
      r.row.classList.add('st-invalid');
      return false;
    }
  }

  function dirtyRows() { return rows.filter((r) => currentText(r) !== r.initialText); }

  function refreshDirty() {
    const d = dirtyRows();
    for (const r of rows) r.row.classList.toggle('st-dirty', d.includes(r));
    saveBtn.disabled = d.length === 0 || loading;
    revertBtn.disabled = d.length === 0 || loading;
    if (dirtyEl) dirtyEl.textContent = d.length ? d.length + ' unsaved change' + (d.length > 1 ? 's' : '') : '';
  }

  // Unit preset changed: redisplay, keeping unsaved edits (re-expressed in the new unit).
  window.addEventListener('rp:units', () => {
    if (!rows.length) return;
    for (const r of rows) {
      const dirty = currentText(r) !== r.initialText;
      let si = null, ok = true;
      if (dirty) { try { si = parseInput(r); } catch (_) { ok = false; } }
      r.conv = convFor(r.spec);
      r.initialText = textFor(r.spec, getVal(r.spec.key), r.conv);
      if (r.unitEl) r.unitEl.textContent = r.conv.unit || '';
      if (r.spec.type === 'boolean' || r.spec.type === 'enum' || r.spec.type === 'string') continue;
      if (!dirty) r.input.value = r.initialText;
      else if (ok) r.input.value = textFor(r.spec, si, r.conv);
    }
    refreshDirty();
  });

  function authMessage(status, verb) {
    if (status === 401) return '<span class="err">Not signed in (HTTP 401).</span> Sign in to Signal K with a read/write account to ' + verb + ' settings.';
    if (status === 403) return '<span class="err">Permission denied (HTTP 403).</span> ' + (verb === 'change' ? 'Changing settings needs a Signal K user with read/write access.' : 'Your Signal K user cannot read the settings.');
    return null;
  }

  async function load() {
    loading = true;
    try {
      // Plain fetch (not authFetch): a 401 here should be reported in the
      // tab, not trip the page-wide sign-in redirect.
      const r = await fetch(API + '/settings', { credentials: 'same-origin', cache: 'no-store' });
      const am = authMessage(r.status, 'view');
      if (am) { form.innerHTML = ''; setStatus(am); return; }
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) { form.innerHTML = ''; setStatus('<span class="err">Settings unavailable:</span> ' + esc((body && body.error) || ('HTTP ' + r.status))); return; }
      schema = body.schema;
      values = body.values;
      render();
      setStatus('');
    } catch (e) {
      setStatus('<span class="err">Settings unavailable:</span> ' + esc(e.message));
    } finally {
      loading = false;
      refreshDirty();
    }
  }

  async function save() {
    const d = dirtyRows();
    if (!d.length) return;
    let ok = true;
    const partial = {};
    for (const r of d) {
      if (!validateRow(r)) { ok = false; continue; }
      const [g, k] = r.spec.key.split('.');
      (partial[g] = partial[g] || {})[k] = parseInput(r);
    }
    if (!ok) { setStatus('<span class="err">Fix the highlighted values first.</span>'); return; }
    loading = true;
    refreshDirty();
    setStatus('Saving…');
    try {
      const r = await fetch(API + '/settings', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial),
      });
      const am = authMessage(r.status, 'change');
      if (am) { setStatus(am); return; }
      const body = await r.json().catch(() => null);
      if (r.status === 400 && body && body.errors) {
        for (const [key, msg] of Object.entries(body.errors)) {
          const row = rows.find((x) => x.spec.key === key);
          if (row) { row.errEl.innerHTML = unitTextHtml(msg); row.row.classList.add('st-invalid'); }
        }
        setStatus('<span class="err">Not saved:</span> the server rejected ' + Object.keys(body.errors).length + ' value(s); nothing was changed.');
        return;
      }
      if (!r.ok || !body) { setStatus('<span class="err">Save failed:</span> ' + esc((body && body.error) || ('HTTP ' + r.status))); return; }
      values = body.values;
      fillFromValues();
      const rl = body.reloaded || {};
      const notes = [];
      if (rl.forecast) notes.push('<span class="warn">The forecast is reloading</span> for the new horizon / field set. Overlays keep the previous forecast until it finishes; a download can take several minutes.');
      if (rl.currents) notes.push('<span class="warn">Currents are reloading</span> (RTOFS).');
      if (rl.refresh_timer) notes.push('Cycle check interval updated.');
      if (rl.jobs) notes.push('Finished-route limit applied.');
      const other = (body.changed || []).length && !rl.forecast && !rl.currents ? 'Applies from the next route.' : '';
      setStatus('<span class="ok">Saved</span> ' + (body.changed || []).length + ' setting(s). ' + (notes.join(' ') + ' ' + other).trim());
      setTimeout(loadPluginStatus, 1500);
      if (rl.forecast) setTimeout(loadPluginStatus, 20000);
    } catch (e) {
      setStatus('<span class="err">Save failed:</span> ' + esc(e.message));
    } finally {
      loading = false;
      refreshDirty();
    }
  }

  saveBtn.addEventListener('click', save);
  revertBtn.addEventListener('click', () => { fillFromValues(); setStatus('Reverted to the saved values.'); });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  // Reload from the server when the tab is opened with no unsaved edits
  // (another client may have changed them).
  window.addEventListener('rp:tab', (e) => { if (e.detail === 'srvSettingsSection' && !loading && dirtyRows().length === 0) load(); });
  load();
})();
