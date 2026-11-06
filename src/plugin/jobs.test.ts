// The job manager's files (jobs.ts): a job whose file cannot be saved carries it and the queue goes on; a departure
// window's or ensemble set's job keeps its route results in memory until they are saved; files that cannot be read or
// removed are reported. The failures are made with a folder where a file belongs, which fails the same way on every OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobManager, type Job } from './jobs';
import type { RouteRequest, RouteSummary } from './protocol';

const ROUTE: RouteRequest = { start: { lat: 41.4, lon: -71.4 }, end: { lat: 41.2, lon: -71.6 } };
const SUMMARY: RouteSummary = {
  total_distance_m: 30_000,
  total_time_s: 7200,
  sailing_time_s: 7200,
  motoring_time_s: 0,
  waypoint_count: 2,
  warnings: 0,
  departure: '2026-11-06T12:00:00.000Z',
  arrival: '2026-11-06T14:00:00.000Z',
};
const GEOJSON = { type: 'FeatureCollection', features: [] };

/** A folder where `file` belongs: writing over it, and removing it, fail. */
function folderAt(file: string): void {
  fs.rmSync(file, { force: true });
  fs.mkdirSync(path.join(file, 'inside'), { recursive: true });
}

test('a job whose file cannot be saved carries it and says why; the next job still starts, and a later save clears it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    const started: Job[] = [];
    jobs.on('start', (j: Job) => started.push(j));
    const a = jobs.submit(ROUTE);
    const b = jobs.submit(ROUTE);
    folderAt(path.join(dir, 'jobs', `${a.id}.json.tmp`));
    jobs.onDone(a.id, GEOJSON, {}, SUMMARY);
    assert.match(jobs.toPublic(a).save_error ?? '', /^its file could not be saved: .*; its partial copy .* could not be removed: /);
    assert.deepEqual(logged, [`route job ${a.id}: ${a.saveError}`]);
    assert.deepEqual(
      started.map(j => j.id),
      [a.id, b.id],
      'the queue goes on'
    );
    fs.rmSync(path.join(dir, 'jobs', `${a.id}.json.tmp`), { recursive: true });
    jobs.setPublished(a.id, 'res-1');
    assert.equal(jobs.toPublic(a).save_error, undefined);
    assert.equal((JSON.parse(fs.readFileSync(path.join(dir, 'jobs', `${a.id}.json`), 'utf8')) as Job).resourceId, 'res-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a window's job keeps its route results in memory until they are saved; once saved they are read from its file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    const unsaved = jobs.submit(ROUTE, 'win-1');
    folderAt(path.join(dir, 'jobs', `${unsaved.id}.json.tmp`));
    jobs.onDone(unsaved.id, GEOJSON, {}, SUMMARY);
    assert.ok(unsaved.saveError);
    assert.deepEqual(unsaved.geojson, GEOJSON, 'not saved: still in memory');
    assert.deepEqual(jobs.full(unsaved.id)?.geojson, GEOJSON);
    const saved = jobs.submit(ROUTE, 'win-1');
    jobs.onDone(saved.id, GEOJSON, {}, SUMMARY);
    assert.equal(saved.saveError, undefined);
    assert.equal(saved.geojson, undefined, 'saved: out of memory');
    assert.deepEqual(jobs.full(saved.id)?.geojson, GEOJSON, 'read from its file');
    assert.equal(logged.length, 1);
    // Its file cannot be read now: answered without its results, and that is said.
    folderAt(path.join(dir, 'jobs', `${saved.id}.json`));
    assert.equal(jobs.full(saved.id)?.geojson, undefined);
    assert.ok(logged[1].startsWith(`route job ${saved.id}: its file cannot be read (`));
    assert.ok(logged[1].endsWith('); answered without its route results'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a job file that cannot be read at start-up is reported and left as it is; a job whose file cannot be deleted says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  const store = path.join(dir, 'jobs');
  try {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'broken.json'), '{"id": "broken", "sta');
    fs.writeFileSync(path.join(store, 'other.json'), JSON.stringify({ hello: 'world' }));
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    assert.ok(logged.some(m => /^route job file broken\.json cannot be read \(.*\); left as it is, not restored$/.test(m)));
    assert.ok(logged.includes('route job file other.json does not hold a route job; left as it is, not restored'));
    assert.ok(fs.existsSync(path.join(store, 'broken.json')), 'left as it is');
    const j = jobs.submit(ROUTE);
    jobs.onError(j.id, 'no route');
    const file = path.join(store, `${j.id}.json`);
    folderAt(file);
    assert.equal(jobs.delete(j.id), true);
    assert.equal(jobs.get(j.id), undefined);
    assert.ok(
      logged.some(m => m.startsWith(`route job ${j.id}: its file could not be deleted (`) && m.endsWith('it comes back after a restart'))
    );
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
