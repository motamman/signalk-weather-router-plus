// Ensemble sets (ensembles.ts): one route job per member, one at a time, each on that member's forecast, on the real
// job manager with a stand-in for the route worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobManager, type Job } from './jobs';
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
  const jobs = new JobManager(dir, 50, '/p');
  const started: Job[] = [];
  jobs.on('start', (j: Job) => started.push(j));
  const cancelled: string[] = [];
  const sets = new EnsembleSetManager(
    jobs,
    dir,
    { cancelRunning: id => cancelled.push(id), onDisk: () => (onDisk ? { cycle: CYCLE, members: onDisk } : null), log: () => undefined },
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
  assert.match(
    validateEnsembleSetRequest({ route: { ...ROUTE, no_forecast: true }, model: 'ifs-ens', members: 5 })!,
    /no_forecast cannot be combined/
  );
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

test('a set whose file cannot be saved carries it: its member still reaches the worker, the set says why, and the next save clears it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-sets-'));
  try {
    const jobs = new JobManager(dir, 50, '/p');
    const started: Job[] = [];
    jobs.on('start', (j: Job) => started.push(j));
    const logged: string[] = [];
    const sets = new EnsembleSetManager(
      jobs,
      dir,
      { cancelRunning: () => undefined, onDisk: () => ({ cycle: CYCLE, members: [0, 1, 2, 3, 4, 5] }), log: m => logged.push(m) },
      '/p'
    );
    // The folder the sets are saved in is gone and a file stands in its place: every save fails.
    const store = path.join(dir, 'ensemble-sets');
    fs.rmSync(store, { recursive: true });
    fs.writeFileSync(store, 'not a folder');
    const s = sets.create({ route: ROUTE, model: 'aifs-ens', members: 5 });
    assert.equal(started.length, 1, 'the first member reached the worker');
    assert.match(sets.get(s.id)?.save_error ?? '', /^its file could not be saved: /);
    assert.ok(logged.some(m => m.startsWith(`ensemble set ${s.id}: its file could not be saved`)));
    // The disk is back: the next change saves the set, without the error, and clears it.
    fs.rmSync(store);
    fs.mkdirSync(store);
    sets.cancel(s.id);
    assert.equal(sets.get(s.id)?.save_error, undefined);
    const saved = JSON.parse(fs.readFileSync(path.join(store, `${s.id}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(saved.status, 'cancelled');
    assert.ok(!('save_error' in saved));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a set found running at start-up that cannot be saved still loads, failed, and says why; its file stays as it was', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-sets-'));
  const store = path.join(dir, 'ensemble-sets');
  try {
    fs.mkdirSync(store, { recursive: true });
    const running = {
      id: 'set-1',
      status: 'running',
      created_at: new Date(T0).toISOString(),
      request: { route: ROUTE, model: 'aifs-ens', members: 5 },
      name: 'ECMWF AIFS ENS',
      cycle: CYCLE,
      members: [{ member: 0, job_id: null, status: 'pending' }],
    };
    const file = path.join(store, 'set-1.json');
    fs.writeFileSync(file, JSON.stringify(running));
    // A read-only folder: the recovered set cannot be saved.
    fs.chmodSync(store, 0o500);
    const logged: string[] = [];
    const sets = new EnsembleSetManager(
      new JobManager(dir, 50, '/p'),
      dir,
      { cancelRunning: () => undefined, onDisk: () => null, log: m => logged.push(m) },
      '/p'
    );
    const s = sets.get('set-1');
    assert.equal(s?.status, 'failed');
    assert.match(s?.save_error ?? '', /^its file could not be saved: /);
    assert.equal(logged.length, 1);
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { status: string }).status, 'running', 'the file is as it was');
  } finally {
    fs.chmodSync(store, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a set file that cannot be read at start-up is reported and left as it is; a set whose file cannot be deleted says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-sets-'));
  const store = path.join(dir, 'ensemble-sets');
  try {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'broken.json'), '{"id": "broken", "memb');
    fs.writeFileSync(path.join(store, 'other.json'), JSON.stringify({ hello: 'world' }));
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p');
    const sets = new EnsembleSetManager(
      jobs,
      dir,
      { cancelRunning: () => undefined, onDisk: () => ({ cycle: CYCLE, members: [0, 1, 2, 3, 4, 5] }), log: m => logged.push(m) },
      '/p'
    );
    assert.ok(logged.some(m => /^ensemble set file broken\.json cannot be read \(.*\); left as it is, not restored$/.test(m)));
    assert.ok(logged.includes('ensemble set file other.json does not hold an ensemble set; left as it is, not restored'));
    assert.ok(fs.existsSync(path.join(store, 'broken.json')), 'left as it is');
    // A finished set whose folder became read-only: deleted from the list, its file stays, and that is said.
    const s = sets.create({ route: ROUTE, model: 'aifs-ens', members: 5 });
    sets.cancel(s.id);
    // The member computing stops when its route worker answers (here at once).
    const stopping = jobs.runningId;
    if (stopping) jobs.onError(stopping, 'cancelled', true);
    fs.chmodSync(store, 0o500);
    assert.equal(sets.delete(s.id), true);
    assert.equal(sets.get(s.id), undefined);
    assert.ok(
      logged.some(m => m.startsWith(`ensemble set ${s.id}: its file could not be deleted (`) && m.endsWith('it comes back after a restart'))
    );
  } finally {
    fs.chmodSync(store, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
