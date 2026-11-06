/**
 * The route API's checks before a job is queued (a request too large, a polar not in the library), the event
 * stream's replay when Last-Event-ID is not a number, a departure window's route read back from disk, and what
 * the deletes of a window and of its routes wait for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerApi, type ApiDeps } from './api';
import { JobManager } from './jobs';
import { WindowManager } from './windows';

type Handler = (req: unknown, res: unknown) => unknown;
interface Answer {
  status: number;
  body: Record<string, unknown>;
  written: string;
}

function api(
  jobs: Record<string, unknown>,
  polarsDir: string,
  windows?: Record<string, unknown>
): (key: string, req: Record<string, unknown>) => Promise<Answer> {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (p: string | string[], h: Handler) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  registerApi(
    router as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: '/nonexistent',
      jobs,
      windows,
      polarLibrary: () => ({ polarFile: path.join(polarsDir, 'a.csv'), polarsDir }),
    } as unknown as ApiDeps
  );
  return async (key, req) => {
    const out: Answer = { status: 200, body: {}, written: '' };
    const res = {
      status(c: number) {
        out.status = c;
        return res;
      },
      json(b: Record<string, unknown>) {
        out.body = b;
        return res;
      },
      setHeader() {
        return res;
      },
      flushHeaders() {},
      write(s: string) {
        out.written += s;
        return true;
      },
      end() {
        return res;
      },
      headersSent: false,
      destroyed: false,
    };
    await routes.get(key)!({ query: {}, headers: {}, params: {}, on() {}, ...req }, res);
    return out;
  };
}

const ROUTE = { start: { lat: 41, lon: -71 }, end: { lat: 41.1, lon: -71.1 } };

test('POST /api/routes: a body over 64 KB is 413 and a polar not in the library 400, before any job is queued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-polars-'));
  fs.writeFileSync(path.join(dir, 'a.csv'), 'twa/tws;6\n0;0\n');
  try {
    const submitted: unknown[] = [];
    const jobs = {
      queueLength: 0,
      submit: (b: unknown) => (submitted.push(b), { id: 'j1', status: 'queued' }),
      links: () => ({ self: '/x/api/routes/j1' }),
    };
    const call = api(jobs, dir);
    const big = await call('POST /api/routes', { body: { ...ROUTE, name: 'n', pad: 'x'.repeat(70_000) } });
    assert.equal(big.status, 413);
    // 40 000 characters, 80 000 bytes in UTF-8: the limit is in bytes.
    const wide = await call('POST /api/routes', { body: { ...ROUTE, name: 'n', pad: 'é'.repeat(40_000) } });
    assert.equal(wide.status, 413);
    const bad = await call('POST /api/routes', { body: { ...ROUTE, vessel: { polar: 'nosuch.csv' } } });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /^vessel\.polar: polar not found: nosuch\.csv/);
    assert.equal(submitted.length, 0, 'nothing queued');
    const ok = await call('POST /api/routes', { body: { ...ROUTE, vessel: { polar: 'a.csv' } } });
    assert.equal(ok.status, 202);
    assert.equal(submitted.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/routes/:id/events: a Last-Event-ID that is not a number replays every event', async () => {
  const job = {
    id: 'j1',
    status: 'done',
    events: [
      { id: 1, event: 'status', data: { status: 'running' } },
      { id: 2, event: 'done', data: { status: 'done' } },
    ],
  };
  const call = api({ full: (id: string) => (id === 'j1' ? job : undefined) }, os.tmpdir());
  const replayed = async (lastId?: string): Promise<number> => {
    const a = await call('GET /api/routes/:id/events', {
      params: { id: 'j1' },
      headers: lastId === undefined ? {} : { 'last-event-id': lastId },
    });
    return (a.written.match(/^id: /gm) ?? []).length;
  };
  assert.equal(await replayed(), 2);
  assert.equal(await replayed('1'), 1);
  assert.equal(await replayed('garbage'), 2);
  for (const bad of ['', ' 1', '1e0', '0x1', '1.0', '99999999999999999999']) assert.equal(await replayed(bad), 2, bad);
});

test("GET /api/routes/:id/result, /signalk, /events: a departure window's route comes from its file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const jobs = new JobManager(dir, 50, '/x', () => undefined);
    const job = jobs.submit({ ...ROUTE, departure: '2026-11-02T00:00:00.000Z' }, 'w1');
    const geo = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} }],
    };
    const summary = {
      total_distance_m: 1,
      total_time_s: 1,
      sailing_time_s: 1,
      motoring_time_s: 0,
      waypoint_count: 2,
      warnings: 0,
      departure: '',
      arrival: '',
    };
    jobs.onDone(job.id, geo, { name: 'sk' }, summary);
    assert.equal(jobs.get(job.id)!.geojson, undefined, 'not held in memory');
    const call = api(jobs as unknown as Record<string, unknown>, dir);
    const result = await call('GET /api/routes/:id/result', { params: { id: job.id } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, geo);
    const sk = await call('GET /api/routes/:id/signalk', { params: { id: job.id } });
    assert.deepEqual(sk.body, { name: 'sk' });
    const events = await call('GET /api/routes/:id/events', { params: { id: job.id } });
    assert.deepEqual(
      [...events.written.matchAll(/^event: (\w+)$/gm)].map(m => m[1]),
      ['status', 'status', 'route', 'done']
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/windows: no body is 400, too large 413 and a polar not in the library 400, before any window is created', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-polars-'));
  fs.writeFileSync(path.join(dir, 'a.csv'), 'twa/tws;6\n0;0\n');
  try {
    const created: unknown[] = [];
    const windows = {
      running: 0,
      create: (b: unknown) => (created.push(b), { id: 'w1', status: 'running', departures: [{}] }),
      links: () => ({ self: '/x/api/windows/w1' }),
    };
    const call = api({}, dir, windows);
    const from = '2026-11-02T00:00:00.000Z';
    const to = '2026-11-02T12:00:00.000Z';
    const none = await call('POST /api/windows', {});
    assert.equal(none.status, 400);
    assert.match(String(none.body.error), /^JSON body required/);
    const big = await call('POST /api/windows', { body: { route: { ...ROUTE, name: 'n', pad: 'x'.repeat(70_000) }, from, to } });
    assert.equal(big.status, 413);
    const bad = await call('POST /api/windows', { body: { route: { ...ROUTE, vessel: { polar: 'nosuch.csv' } }, from, to } });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /^route: vessel\.polar: polar not found: nosuch\.csv/);
    assert.equal(created.length, 0, 'no window');
    const ok = await call('POST /api/windows', { body: { route: { ...ROUTE, vessel: { polar: 'a.csv' } }, from, to } });
    assert.equal(ok.status, 202);
    assert.equal(created.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DELETE /api/routes/:id: a departure window's job is 409; DELETE /api/windows/:id: 409 until a cancelled departure has stopped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const jobs = new JobManager(dir, 50, '/x', () => undefined);
    const stopping: string[] = [];
    const windows = new WindowManager(jobs, dir, { cancelRunning: id => stopping.push(id), forecastValidToMs: () => null }, '/x');
    const call = api(jobs as unknown as Record<string, unknown>, dir, windows as unknown as Record<string, unknown>);
    // An ordinary route computing; the window's first departure waits behind it.
    const other = jobs.submit({ ...ROUTE, departure: '2026-11-02T00:00:00.000Z' });
    const w = windows.create({ route: ROUTE, from: '2026-11-02T00:00:00.000Z', to: '2026-11-02T06:00:00.000Z', step_s: 6 * 3600 });
    const first = w.departures[0].job_id!;
    assert.equal(jobs.get(first)!.status, 'queued');

    // Deleted through the route API, the window would wait for it forever (a slot of the two taken).
    const del = await call('DELETE /api/routes/:id', { params: { id: first } });
    assert.equal(del.status, 409);
    assert.match(String(del.body.error), /^a departure window's route: delete the window \(DELETE \/x\/api\/windows\//);
    jobs.onError(other.id, 'failed');
    assert.equal(jobs.runningId, first, 'still queued, so it is computed next');
    assert.equal(windows.get(w.id)!.departures[0].status, 'running');

    // Running: 409. Cancelled, its departure still stopping: 409, the job kept with its window.
    assert.equal((await call('DELETE /api/windows/:id', { params: { id: w.id } })).status, 409);
    assert.equal((await call('POST /api/windows/:id/cancel', { params: { id: w.id } })).status, 202);
    assert.deepEqual(stopping, [first]);
    assert.equal(windows.get(w.id)!.status, 'cancelled');
    const early = await call('DELETE /api/windows/:id', { params: { id: w.id } });
    assert.equal(early.status, 409);
    assert.match(String(early.body.error), /^a cancelled departure is still stopping/);
    assert.ok(windows.get(w.id) && jobs.get(first), 'the window and its job are kept');
    // The route worker stops: the window goes, and its job with it.
    jobs.onError(first, 'cancelled', true);
    assert.equal(windows.get(w.id)!.departures[0].status, 'cancelled');
    assert.equal((await call('DELETE /api/windows/:id', { params: { id: w.id } })).status, 204);
    assert.equal(windows.get(w.id), undefined);
    assert.equal(jobs.get(first), undefined);
    assert.ok(!fs.existsSync(path.join(dir, `${first}.json`)), "the job's file is deleted");
    windows.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST routes and departure windows accept managed tokens before dispatch without a provider', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-managed-tokens-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const submitted: unknown[] = [];
  const created: unknown[] = [];
  const call = api(
    {
      queueLength: 0,
      submit: (body: unknown) => (submitted.push(body), { id: 'job', status: 'queued' }),
      links: () => ({ self: '/x/api/routes/job' }),
    },
    dir,
    {
      running: 0,
      create: (body: unknown) => (created.push(body), { id: 'window', status: 'running', departures: [{}] }),
      links: () => ({ self: '/x/api/windows/window' }),
    }
  );
  for (const mode of ['sail_max', 'motor']) {
    for (const polar of ['auto', 'signalk-active']) {
      const route = { ...ROUTE, mode, vessel: { polar } };
      const answer = await call('POST /api/routes', { body: route });
      assert.equal(answer.status, 202, `${mode}/${polar}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(submitted.at(-1), route, 'the selection is left for dispatch');
      const window = { route, from: '2030-01-01T00:00:00Z', to: '2030-01-01T01:00:00Z', step_s: 3600 };
      const windowAnswer = await call('POST /api/windows', { body: window });
      assert.equal(windowAnswer.status, 202, `${mode}/${polar}: ${JSON.stringify(windowAnswer.body)}`);
      assert.deepEqual(created.at(-1), window);
    }
  }
  for (const polar of ['missing.csv', '../private.csv']) {
    assert.equal((await call('POST /api/routes', { body: { ...ROUTE, vessel: { polar } } })).status, 400);
    const body = { route: { ...ROUTE, vessel: { polar } }, from: '2030-01-01T00:00:00Z', to: '2030-01-01T01:00:00Z' };
    assert.equal((await call('POST /api/windows', { body })).status, 400);
  }
  assert.equal(submitted.length, 4, 'invalid local tokens never queue');
  assert.equal(created.length, 4);
});
