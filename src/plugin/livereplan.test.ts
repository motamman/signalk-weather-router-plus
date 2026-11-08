/**
 * A LIVE re-plan on the page (public/rp-plan.js), run as the page runs it with its requests stubbed (as
 * jobstream.test.ts runs a job's stream): a re-plan computing, or its proposal waiting, is for the route on screen it
 * was fired for; another route put on screen (_setRouteOnScreen) drops it as Cancel does, and the route it was fired
 * for, or its own, drops nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

/** The page's route-on-screen change and LIVE's re-plan cancel, with the requests and the proposal counted. */
function page() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const s0 = source.indexOf('function _setRouteOnScreen(');
  const s1 = source.indexOf('\n}\n', s0) + 3;
  const from = source.indexOf('  let replanJobId = null;');
  const to = source.indexOf('  function renderProposal(geojson, reason) {');
  assert.ok(s0 > 0 && s1 > s0 && from > 0 && to > from, 'the slices of rp-plan.js are found');
  const posted: string[] = [];
  const listeners = new Map<string, ((e: { detail: unknown }) => void)[]>();
  const banner = { dataset: {} as Record<string, string> };
  const counts = { dismissed: 0, streamsClosed: 0 };
  const context = {
    API: '/api',
    authFetch: (url: string, init: { method?: string } = {}) => {
      if (init.method === 'POST') posted.push(url);
      return Promise.resolve({ ok: true });
    },
    abortRouteRequests: () => undefined,
    appendLog: () => undefined,
    closeReplanStream: () => counts.streamsClosed++,
    dismissProposal: () => {
      counts.dismissed++;
      delete banner.dataset.geojson;
    },
    banner,
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail: unknown }) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    window: {
      addEventListener: (type: string, fn: (e: { detail: unknown }) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      dispatchEvent: (e: { type: string; detail: unknown }) => {
        for (const fn of listeners.get(e.type) ?? []) fn(e);
        return true;
      },
    },
  };
  // The page's own state (rp-plan.js), declared as it is there.
  const code = `let _currentRouteJobId = null;\nlet _currentRouteName = '';\nlet replanBusy = false;\nlet replanGen = 0;\nlet replanRouteId = null;
${source.slice(s0, s1)}\n${source.slice(from, to)}
({
  onScreen: _setRouteOnScreen,
  computing: (route, job) => { replanRouteId = route; replanBusy = true; replanJobId = job; },
  proposed: route => { replanRouteId = route; replanBusy = false; replanJobId = null; },
  state: () => ({ gen: replanGen, busy: replanBusy }),
})`;
  const api = runInNewContext(code, context) as {
    onScreen: (id: string | null, name: string) => void;
    computing: (route: string, job: string) => void;
    proposed: (route: string) => void;
    state: () => { gen: number; busy: boolean };
  };
  // The state read out of the page's context as this test's own objects (a context's objects are not deep-equal to them).
  const state = (): { gen: number; busy: boolean } => {
    const s = api.state();
    return { gen: s.gen, busy: s.busy };
  };
  return { ...api, state, posted, counts, banner };
}

test('a re-plan computing is cancelled when another route is opened; the route it was fired for drops nothing', () => {
  const p = page();
  p.computing('job-a', 'replan-1');
  p.onScreen('job-a', 'A');
  assert.deepEqual([p.posted, p.state(), p.counts.dismissed], [[], { gen: 0, busy: true }, 0]);
  // A saved route opened from Saved while the re-plan computes.
  p.onScreen('job-b', 'B');
  // The plugin's path, or a host's that serves the API under /api/v1/.
  assert.equal(p.posted.length, 1);
  assert.match(p.posted[0], /^\/api(\/v1)?\/routes\/replan-1\/cancel$/);
  assert.deepEqual(p.state(), { gen: 1, busy: false }, 'its result is dropped (replanGen)');
  assert.equal(p.counts.streamsClosed, 1);
  assert.equal(p.counts.dismissed, 1);
});

test("a proposal waiting is dismissed when the map is cleared; the re-plan's own route put on screen keeps the screen's", () => {
  const p = page();
  p.proposed('job-a');
  p.banner.dataset.geojson = '{}';
  // Clear route and start new here (the map menu): no route on screen.
  p.onScreen(null, '');
  assert.equal(p.counts.dismissed, 1);
  assert.deepEqual([p.posted, p.state()], [[], { gen: 0, busy: false }]);
  // An accepted re-plan: applyRoute records its job as the re-plan's route before it is put on screen.
  p.computing('replan-2', 'replan-2');
  p.onScreen('replan-2', 'A (re-plan)');
  assert.deepEqual([p.posted, p.state(), p.counts.dismissed], [[], { gen: 0, busy: true }, 1]);
});
