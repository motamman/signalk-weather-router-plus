// Ensemble sets (ensembles.ts): one route job per member, one at a time, each on that member's forecast, on the real
// job manager with a stand-in for the route worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobManager, type Job, type JobEvent } from './jobs';
import type { RouteRequest, RouteSummary } from './protocol';
import { EnsembleSetManager, validateEnsembleSetRequest } from './ensembles';

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 5, 12);
const CYCLE = new Date(T0).toISOString();
const ROUTE: RouteRequest = { start: { lat: 41.4, lon: -71.4 }, end: { lat: 32.3, lon: -64.8 }, name: 'Newport-Bermuda' };

function summary(hours: number): RouteSummary {
  return {
    total_distance_m: 1_200_000,
    total_time_s: hours * 3600,
    sailing_time_s: hours * 3600,
    motoring_time_s: 0,
    waypoint_count: 2,
    warnings: 0,
    departure: new Date(T0).toISOString(),
    arrival: new Date(T0 + hours * H).toISOString(),
  };
}

function harness(onDisk: number[] | null = [0, 1, 2, 3, 4, 5, 6]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-sets-'));
  const jobs = new JobManager(dir, 50, '/p', () => undefined);
  const started: Job[] = [];
  jobs.on('start', (j: Job) => started.push(j));
  const cancelled: string[] = [];
  const sets = new EnsembleSetManager(
    jobs,
    dir,
    { cancelRunning: id => cancelled.push(id), onDisk: () => (onDisk ? { cycle: CYCLE, members: onDisk } : null) },
    '/p'
  );
  const finish = (hours: number): void => {
    const id = jobs.runningId;
    assert.ok(id);
    jobs.onDone(id, { type: 'FeatureCollection', features: [] }, {}, summary(hours));
  };
  return { dir, jobs, sets, started, cancelled, finish };
}

test('validateEnsembleSetRequest: the route, a known ensemble, 5 to 51 members, no forecast_member of its own', () => {
  assert.equal(validateEnsembleSetRequest({ route: ROUTE, model: 'ifs-ens', members: 5 }), null);
  assert.match(validateEnsembleSetRequest(null)!, /JSON body required/);
  assert.match(validateEnsembleSetRequest({ model: 'ifs-ens', members: 5 })!, /route is required/);
  assert.match(validateEnsembleSetRequest({ route: ROUTE, model: 'gefs', members: 5 })!, /model must be/);
  assert.match(validateEnsembleSetRequest({ route: ROUTE, model: 'ifs-ens', members: 4 })!, /members must be a whole number 5..51/);
  assert.match(
    validateEnsembleSetRequest({ route: { ...ROUTE, forecast_member: { model: 'ifs-ens', member: 1 } }, model: 'ifs-ens', members: 5 })!,
    /set per member/
  );
  assert.match(validateEnsembleSetRequest({ route: { ...ROUTE, start: { lat: 99, lon: 0 } }, model: 'ifs-ens', members: 5 })!, /^route: /);
});

test('a set routes each member on its own forecast, one job at a time, control first, pinned to the cycle', () => {
  const h = harness();
  const s = h.sets.create({ route: ROUTE, model: 'aifs-ens', members: 5 });
  assert.deepEqual(
    s.members.map(m => m.member),
    [0, 1, 2, 3, 4]
  );
  for (let k = 0; k < 5; k++) {
    assert.equal(h.started.length, k + 1, 'one job at a time');
    const req = h.started[k].request;
    assert.deepEqual(req.forecast_member, { model: 'aifs-ens', member: k, cycle: '2026110512' });
    assert.equal(req.publish, false);
    assert.equal(h.started[k].ensembleSetId, s.id);
    h.finish(100 + k);
  }
  const done = h.sets.get(s.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(
    done.members.map(m => m.metrics!.total_time_s / 3600),
    [100, 101, 102, 103, 104]
  );
  // Its jobs are not in the route list, and go with the set.
  assert.equal(h.jobs.list().length, 0);
  assert.equal(h.jobs.list(50, true).length, 5);
  assert.ok(h.sets.delete(s.id));
  assert.equal(h.jobs.list(50, true).length, 0);
});

test('create refuses an ensemble not on disk, or more members than it has', () => {
  assert.throws(() => harness(null).sets.create({ route: ROUTE, model: 'ifs-ens', members: 5 }), /not on disk/);
  assert.throws(() => harness([1, 2, 3, 4, 5]).sets.create({ route: ROUTE, model: 'ifs-ens', members: 6 }), /5 members on disk, 6 asked/);
});

test('cancel: members not started are cancelled, the running one is asked to stop', () => {
  const h = harness();
  const s = h.sets.create({ route: ROUTE, model: 'ifs-ens', members: 5 });
  h.finish(90);
  const running = h.jobs.runningId!;
  assert.ok(h.sets.cancel(s.id));
  assert.deepEqual(h.cancelled, [running]);
  assert.equal(h.sets.get(s.id)!.status, 'cancelled');
  assert.deepEqual(
    h.sets.get(s.id)!.members.map(m => m.status),
    ['done', 'running', 'cancelled', 'cancelled', 'cancelled']
  );
  assert.equal(h.sets.delete(s.id), false, 'not while its member is stopping');
});

test('the main forecast route named in the request is reported with its metrics once done', () => {
  const h = harness();
  const main = h.jobs.submit(ROUTE);
  const s = h.sets.create({ route: ROUTE, model: 'ifs-ens', members: 5, main_job_id: main.id });
  assert.deepEqual(h.sets.toPublic(s).main, { job_id: main.id, status: 'running' });
  h.finish(95); // the main route, ahead of the members in the queue
  const m = h.sets.toPublic(h.sets.get(s.id)!).main!;
  assert.equal(m.status, 'done');
  assert.equal(m.metrics!.total_time_s, 95 * 3600);
  assert.equal(h.sets.toPublic(h.sets.create({ route: ROUTE, model: 'ifs-ens', members: 5 })).main, null);
  assert.match(validateEnsembleSetRequest({ route: ROUTE, model: 'ifs-ens', members: 5, main_job_id: '' })!, /main_job_id/);
});

test('a listener that throws on a job event is reported, and the job still reaches the worker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    // As an ensemble set's or a departure window's file failing to save on the 'running' event.
    jobs.on('event', (_id: string, ev: JobEvent) => {
      if (ev.event === 'status' && ev.data.status === 'running') throw new Error('ENOSPC: no space left on device');
    });
    const heard: string[] = [];
    jobs.on('event', (_id: string, ev: JobEvent) => heard.push(String(ev.data.status ?? ev.event)));
    const started: string[] = [];
    jobs.on('start', (job: { id: string }) => started.push(job.id));
    const job = jobs.submit({ start: { lat: 41.4, lon: -71.4 }, end: { lat: 41.2, lon: -71.6 } });
    assert.deepEqual(started, [job.id], 'the job reached the worker');
    assert.ok(heard.includes('running'), 'the other listener heard the event');
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`job ${job.id}: a listener of its status event failed: ENOSPC`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
