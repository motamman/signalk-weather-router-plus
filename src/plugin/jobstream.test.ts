/**
 * A route job followed on the page (public/rp-plan.js attachToJob), run as the page runs it with its event stream
 * stubbed (as ensemblescreen.test.ts runs the set's screen): the stream acts while its job is the route on screen;
 * once another route is opened or the map cleared, its next event ends the following and nothing of it is drawn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Listener = (ev: { data?: string }) => void;

/** The page's job stream functions, with every handler past the stream counted. */
function page() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-plan.js'), 'utf8');
  const from = source.indexOf('let _activeJobES = null;');
  const to = source.indexOf('function _jobOnStatus(');
  assert.ok(from > 0 && to > from, 'the slice of rp-plan.js is found');
  const streams: { listeners: Map<string, Listener>; closed: boolean }[] = [];
  class EventSource {
    static CLOSED = 2;
    listeners = new Map<string, Listener>();
    closed = false;
    readyState = 1;
    constructor() {
      streams.push(this);
    }
    addEventListener(type: string, fn: Listener) {
      this.listeners.set(type, fn);
    }
    close() {
      this.closed = true;
    }
  }
  const handled: string[] = [];
  const counts = { hidden: 0 };
  const element = () => ({ textContent: '', value: '', disabled: false, style: { display: '' } });
  const elements = new Map<string, ReturnType<typeof element>>();
  const context = {
    API: '/api',
    EventSource,
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
    window: { dispatchEvent: () => true },
    CustomEvent: class {},
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    cancelBtn: element(),
    showModal: () => undefined,
    clearSearchBoat: () => undefined,
    refreshFindRouteEnabled: () => undefined,
    appendLog: () => undefined,
    _ensForRoute: () => undefined,
    RouteProgress: { feed: () => undefined, hide: () => counts.hidden++ },
    _jobOnStatus: () => handled.push('status'),
    _jobOnLog: () => handled.push('log'),
    _jobOnProgress: () => handled.push('progress'),
    _jobOnFrontier: () => handled.push('frontier'),
    _jobOnDone: () => handled.push('done'),
    _jobOnError: () => handled.push('error'),
  };
  // The page's own state and its one way to change the route on screen (rp-plan.js), as they are there but the aborts.
  const code = `let _routeComputing = false;\nlet _currentRouteJobId = null;\nlet _currentRouteName = '';
function _setRouteOnScreen(id, name) {\n  _currentRouteJobId = id;\n  _currentRouteName = name;\n}\n${source.slice(from, to)}
({ attach: attachToJob, onScreen: _setRouteOnScreen, current: () => _currentRouteJobId })`;
  const api = runInNewContext(code, context) as {
    attach: (id: string, row?: object) => void;
    onScreen: (id: string | null, name: string) => void;
    current: () => string | null;
  };
  const fire = (type: string, data: object) => streams[streams.length - 1].listeners.get(type)!({ data: JSON.stringify(data) });
  return { ...api, streams, handled, counts, fire, button: () => context.document.getElementById('findRoute') };
}

test('a job followed draws while it is the route on screen; once another route is opened, its done is not applied', () => {
  const p = page();
  p.attach('job-a');
  assert.equal(p.current(), 'job-a');
  p.fire('frontier', { leg: 0, stage: 1 });
  assert.deepEqual(p.handled, ['frontier']);
  // A saved route opened from Saved while job A computes.
  p.onScreen('job-b', 'saved');
  p.fire('frontier', { leg: 0, stage: 2 });
  assert.deepEqual(p.handled, ['frontier'], 'no front of A drawn over B');
  assert.equal(p.streams[0].closed, true, "A's stream closed at its first event after the change");
  assert.equal(p.button()!.textContent, 'Find Route', 'the page no longer computes');
  assert.equal(p.counts.hidden, 1, 'the progress panel hidden');
  p.fire('done', { summary: null });
  assert.deepEqual(p.handled, ['frontier'], 'its done is not applied');
  assert.equal(p.current(), 'job-b');
});

test('a job followed when the map is cleared: neither its done nor its error is applied', () => {
  for (const type of ['done', 'error']) {
    const p = page();
    p.attach('job-a');
    p.onScreen(null, '');
    p.fire(type, type === 'done' ? { summary: null } : { message: 'Route cancelled' });
    assert.deepEqual(p.handled, [], type);
    assert.equal(p.streams[0].closed, true, type);
    assert.equal(p.current(), null, type);
  }
});
