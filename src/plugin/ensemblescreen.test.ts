/**
 * An ensemble set on the page's screen (public/rp-plan.js _ensStart, _ensPoll, _ensCancel, _ensGone), run as the page
 * runs them with the requests stubbed (as apierror.test.ts runs the page's error readers): a set whose screen ended
 * before it was started is cancelled on the server only when Find Route asked for that; an answer for a screen that
 * has ended changes nothing; a set gone from the server (404) leaves the screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Answer = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
type Call = { url: string; method: string; answer: (a: Answer) => void };

const answer = (status: number, body: unknown): Answer => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** The page's set functions, with every request held until the test answers it. */
function screen() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const from = source.indexOf('function _ensStart(');
  const to = source.indexOf('/** Each finished route of the set on screen');
  assert.ok(from > 0 && to > from, 'the slice of rp-plan.js is found');
  const calls: Call[] = [];
  const logs: string[] = [];
  const counts = { draw: 0, render: 0, cleared: 0 };
  const context = {
    API: '/api',
    authFetch: (url: string, init: { method?: string } = {}) =>
      new Promise<Answer>(resolve => calls.push({ url, method: init.method ?? 'GET', answer: resolve })),
    _apiErrorText: async (r: Answer) => `HTTP ${r.status}`,
    appendLog: (m: string) => logs.push(m),
    _ensDraw: () => counts.draw++,
    _ensRender: () => counts.render++,
    _ensSource: { clear: () => counts.cleared++ },
    _ensCorridorSource: { clear: () => undefined },
    _ensDrawn: new Set(),
    _ensLines: new Map(),
    // The poll's next read is not run here: a timer set is only counted.
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  // The page's own state (rp-plan.js), declared as it is there.
  const code = `let _ens = null;\nlet _ensTimer = null;\nlet _ensScreen = { ended: false, cancel: false, pollFailing: false, setId: null };\n${source.slice(from, to)}
({ start: _ensStart, poll: _ensPoll, gone: _ensGone, ens: () => _ens, current: () => _ensScreen })`;
  const api = runInNewContext(code, context) as {
    start: (route: object, want: { model: string; members: number }, main: string) => void;
    poll: (id: string, screen: object) => void;
    gone: (cancel: boolean) => void;
    ens: () => unknown;
    current: () => object;
  };
  return { ...api, calls, logs, counts };
}

/** Let the stubbed answers' promise chains run. */
const settle = () => new Promise(r => setImmediate(r));

test('a set whose screen ended before it started is cancelled once when Find Route asked, and not otherwise', async () => {
  for (const cancel of [true, false]) {
    const s = screen();
    s.start({ start: {}, end: {} }, { model: 'ifs-ens', members: 5 }, 'main-1');
    assert.deepEqual(
      s.calls.map(c => [c.method, c.url]),
      [['POST', '/api/ensemble-sets']]
    );
    s.gone(cancel);
    s.calls[0].answer(answer(201, { id: 'set-1', members: 5 }));
    await settle();
    const cancels = s.calls.filter(c => c.url === '/api/ensemble-sets/set-1/cancel');
    assert.equal(cancels.length, cancel ? 1 : 0, `cancel ${cancel}`);
    assert.equal(s.calls.filter(c => c.url === '/api/ensemble-sets/set-1').length, 0, 'an ended screen does not follow the set');
  }
});

test('Find Route cancels a set it follows whose first poll has not answered yet; a set that finished is not cancelled', async () => {
  const s = screen();
  s.poll('set-9', s.current());
  s.gone(true);
  assert.equal(s.calls.filter(c => c.url.endsWith('/ensemble-sets/set-9/cancel')).length, 1, 'cancelled though its state is not known yet');
  // A set shown as done: nothing to cancel.
  const d = screen();
  d.poll('set-8', d.current());
  d.calls[0].answer(answer(200, { id: 'set-8', status: 'done', members: [] }));
  await settle();
  d.gone(true);
  assert.equal(d.calls.filter(c => c.url.endsWith('/cancel')).length, 0);
});

test('an answer for a screen that has ended changes nothing; a set gone from the server leaves the screen', async () => {
  const s = screen();
  // A poll answered after its screen ended.
  s.poll('set-1', s.current());
  s.gone(false);
  const rendered = s.counts.render;
  s.calls[0].answer(answer(200, { id: 'set-1', status: 'running', members: [] }));
  await settle();
  assert.equal(s.ens(), null);
  assert.equal(s.counts.render, rendered, 'nothing drawn for the ended screen');
  // A poll on the current screen: the set is shown; then the server says it is gone.
  s.poll('set-2', s.current());
  s.calls[1].answer(answer(200, { id: 'set-2', status: 'done', members: [] }));
  await settle();
  assert.deepEqual(s.ens(), { id: 'set-2', status: 'done', members: [] });
  const cleared = s.counts.cleared;
  s.poll('set-2', s.current());
  s.calls[2].answer(answer(404, { error: 'not found' }));
  await settle();
  assert.equal(s.ens(), null);
  assert.equal(s.counts.cleared, cleared + 1, 'its routes leave the map');
  assert.ok(s.logs.some(m => /set-2 is gone from the server/.test(m)));
});

test('a row without a route: its status in words (skipped too), the reason escaped, wrapping across the number columns', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const from = source.indexOf("/** A route job's status in words");
  const to = source.indexOf("/** A member's name in the table");
  assert.ok(from > 0 && to > from, 'the slice of rp-plan.js is found');
  const escapeHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = runInNewContext(`${source.slice(from, to)}\n_noRouteCell`, { escapeHtml, unitText: (s: string) => s }) as (
    status: string,
    why: string | null
  ) => string;
  assert.equal(cell('skipped', null), '<td colspan="5" style="text-align:left; white-space:normal;">skipped</td>');
  assert.equal(
    cell('failed', 'no <water> path'),
    '<td colspan="5" style="text-align:left; white-space:normal;">no route: no &lt;water&gt; path</td>'
  );
  assert.equal(cell('running', null), '<td colspan="5" style="text-align:left; white-space:normal;">computing…</td>');
});

test("the warnings list stays open when the strip is drawn again (a set's poll redraws it every 3 s)", () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const from = source.indexOf('let _lastRouteProps = null');
  const to = source.indexOf('// The same summary at the top of the Itinerary tab');
  assert.ok(from > 0 && to > from, 'the slice of rp-plan.js is found');
  // The strip's element, as much of the DOM as the strip uses: its list hidden as the drawn HTML says, until toggled.
  const badge = { onclick: (): void => assert.fail('no badge handler set') };
  const list = { hidden: true };
  const strip = {
    classList: { toggle: () => undefined },
    set innerHTML(html: string) {
      list.hidden = /id="rsWarnList" hidden/.test(html);
    },
    querySelector: (q: string) => (q === '#rsBadge' ? badge : q === '#rsWarnList' ? list : null),
  };
  const context = {
    document: { getElementById: () => strip, querySelectorAll: () => [list] },
    _routeStale: false,
    fmtDist: String,
    fmtTime: String,
    fmtWhen: String,
    fmtSwh: String,
    _ensLine: () => '',
    _warningKind: () => 'wind over the limit',
    _warningDetail: () => '',
    showTab: () => undefined,
  };
  const render = runInNewContext(`${source.slice(from, to)}\nrenderResultStrip`, context) as (p: object, navWarns: string[]) => void;
  const route = {
    total_distance_m: 1000,
    total_time_s: 3600,
    warnings: [{ violation: 'wind_over_limit', leg_index: 0, to: [-71, 41] }],
  };
  render(route, []);
  assert.equal(list.hidden, true, 'closed at first');
  badge.onclick();
  assert.equal(list.hidden, false, 'opened with its badge');
  render(route, []);
  assert.equal(list.hidden, false, 'still open after the strip is drawn again');
  badge.onclick();
  render(route, []);
  assert.equal(list.hidden, true, 'closed again, and kept closed');
});
