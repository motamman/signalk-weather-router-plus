// The job manager's files (jobs.ts): a job whose file cannot be saved carries it and the queue goes on; its route
// results are saved once in a file of their own that no later save touches; a departure window's or ensemble set's job
// keeps them in memory until they are saved; files that cannot be read or removed are reported; a job file saved with
// its results inside has them moved to their file. The failures are made with a folder where a file belongs, which
// fails the same way on every OS.
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
/** A route as routeformat.ts writes one: its line, then a point per waypoint. */
const GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-71.4, 41.4],
          [-71.6, 41.2],
        ],
      },
      properties: {},
    },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-71.4, 41.4] }, properties: { time: '2026-11-06T12:00:00.000Z' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-71.6, 41.2] }, properties: { time: '2026-11-06T14:00:00.000Z' } },
  ],
};

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

test("a window's job keeps its route results in memory until they are saved; once saved they are read from their file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    const unsaved = jobs.submit(ROUTE, { windowId: 'win-1' });
    folderAt(path.join(dir, 'jobs', 'results', `${unsaved.id}.json.tmp`));
    jobs.onDone(unsaved.id, GEOJSON, {}, SUMMARY);
    assert.match(unsaved.saveError ?? '', /^its route results could not be saved: /);
    assert.deepEqual(unsaved.geojson, GEOJSON, 'not saved: still in memory');
    assert.deepEqual(jobs.full(unsaved.id)?.geojson, GEOJSON);
    // The way is clear again: the next save of the job saves them, and they leave memory.
    fs.rmSync(path.join(dir, 'jobs', 'results', `${unsaved.id}.json.tmp`), { recursive: true });
    jobs.setPublished(unsaved.id, null, 'not published');
    assert.equal(unsaved.saveError, undefined);
    assert.equal(unsaved.geojson, undefined);
    assert.deepEqual(jobs.full(unsaved.id)?.geojson, GEOJSON);
    const saved = jobs.submit(ROUTE, { windowId: 'win-1' });
    jobs.onDone(saved.id, GEOJSON, {}, SUMMARY);
    assert.equal(saved.saveError, undefined);
    assert.equal(saved.geojson, undefined, 'saved: out of memory');
    assert.deepEqual(jobs.full(saved.id)?.geojson, GEOJSON, 'read from their file');
    assert.equal(logged.length, 1);
    // Their file cannot be read now: answered without them, and that is said.
    folderAt(path.join(dir, 'jobs', 'results', `${saved.id}.json`));
    assert.equal(jobs.full(saved.id)?.geojson, undefined);
    assert.ok(logged[1].startsWith(`route job ${saved.id}: its route results cannot be read (`));
    assert.ok(logged[1].endsWith('); answered without them'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a later save of a job never touches its route results' file, even one that cannot be read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    const j = jobs.submit(ROUTE, { windowId: 'win-1' });
    jobs.onDone(j.id, GEOJSON, {}, SUMMARY);
    const results = path.join(dir, 'jobs', 'results', `${j.id}.json`);
    fs.writeFileSync(results, '{"geojson": {"type": "Feat');
    jobs.setPublished(j.id, 'res-1');
    assert.equal(fs.readFileSync(results, 'utf8'), '{"geojson": {"type": "Feat', 'their file is as it was');
    assert.equal(j.saveError, undefined);
    const own = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', `${j.id}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(own.resourceId, 'res-1');
    assert.ok(!('geojson' in own) && !('events' in own), "the job's own file holds no results");
    assert.deepEqual(logged, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a job saved with its results inside its file has them moved to their own file at start-up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  const store = path.join(dir, 'jobs');
  try {
    fs.mkdirSync(store, { recursive: true });
    const old = {
      id: 'old-1',
      status: 'done',
      request: ROUTE,
      createdAt: '2026-11-06T12:00:00.000Z',
      finishedAt: '2026-11-06T12:05:00.000Z',
      summary: SUMMARY,
      windowId: 'win-1',
      geojson: GEOJSON,
      skRoute: {},
      skeleton: null,
      fronts: null,
      progress: [],
      events: [{ id: 1, event: 'done', data: { status: 'done' } }],
      nextEventId: 2,
    };
    fs.writeFileSync(path.join(store, 'old-1.json'), JSON.stringify(old));
    const jobs = new JobManager(dir, 50, '/p', m => assert.fail(`unexpected log: ${m}`));
    assert.equal(jobs.get('old-1')?.geojson, undefined, "a window's job: out of memory");
    assert.deepEqual(jobs.full('old-1')?.geojson, GEOJSON);
    assert.deepEqual(jobs.full('old-1')?.events, old.events);
    const own = JSON.parse(fs.readFileSync(path.join(store, 'old-1.json'), 'utf8')) as Record<string, unknown>;
    assert.ok(!('geojson' in own) && !('events' in own));
    assert.deepEqual(
      (JSON.parse(fs.readFileSync(path.join(store, 'results', 'old-1.json'), 'utf8')) as Record<string, unknown>).geojson,
      GEOJSON
    );
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
      logged.some(
        m =>
          m.startsWith(`route job ${j.id}: its file could not be deleted (`) &&
          m.endsWith('it comes back after a restart, with its route results')
      )
    );
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an old job file keeps its results while their own file cannot be saved, and a later start moves them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  const store = path.join(dir, 'jobs');
  try {
    fs.mkdirSync(store, { recursive: true });
    const old = {
      id: 'old-1',
      status: 'done',
      request: ROUTE,
      createdAt: '2026-11-06T12:00:00.000Z',
      finishedAt: '2026-11-06T12:05:00.000Z',
      summary: SUMMARY,
      windowId: 'win-1',
      geojson: GEOJSON,
      skRoute: {},
      skeleton: null,
      fronts: null,
      progress: [],
      events: [{ id: 1, event: 'done', data: { status: 'done' } }],
      nextEventId: 2,
    };
    const file = path.join(store, 'old-1.json');
    fs.writeFileSync(file, JSON.stringify(old));
    const blocked = path.join(store, 'results', 'old-1.json.tmp');
    folderAt(blocked);
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    assert.match(jobs.get('old-1')?.saveError ?? '', /^its route results could not be saved: /);
    assert.equal(logged.length, 1);
    assert.deepEqual(jobs.full('old-1')?.geojson, GEOJSON, 'in memory');
    assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).geojson, GEOJSON, 'still in its file');
    // A second start, the way still blocked: the old file still holds them.
    const second: string[] = [];
    const still = new JobManager(dir, 50, '/p', m => second.push(m));
    assert.match(still.get('old-1')?.saveError ?? '', /^its route results could not be saved: /);
    assert.equal(second.length, 1);
    assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).geojson, GEOJSON, 'still in its file');
    // A later start, the way clear: moved.
    fs.rmSync(blocked, { recursive: true });
    const again = new JobManager(dir, 50, '/p', m => assert.fail(`unexpected log: ${m}`));
    assert.deepEqual(again.full('old-1')?.geojson, GEOJSON);
    assert.ok(!('geojson' in (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delete: a job file that cannot be removed keeps its route results, and the job comes back whole after a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  try {
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    const j = jobs.submit(ROUTE);
    jobs.onDone(j.id, GEOJSON, {}, SUMMARY);
    const file = path.join(dir, 'jobs', `${j.id}.json`);
    const results = path.join(dir, 'jobs', 'results', `${j.id}.json`);
    const saved = fs.readFileSync(file, 'utf8');
    folderAt(file);
    assert.equal(jobs.delete(j.id), true);
    assert.ok(logged.some(m => m.startsWith(`route job ${j.id}: its file could not be deleted (`) && m.endsWith('with its route results')));
    assert.ok(fs.existsSync(results), 'the results stay with the job file');
    // The file survived (here: put back as it was): the job is back with its route.
    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, saved);
    const again = new JobManager(dir, 50, '/p', m => assert.fail(`unexpected log: ${m}`));
    assert.deepEqual(again.get(j.id)?.geojson, GEOJSON);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a done job saved without its summary, or results that hold no route, are refused where they are loaded, not met later', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jobs-'));
  const store = path.join(dir, 'jobs');
  try {
    fs.mkdirSync(path.join(store, 'results'), { recursive: true });
    const base = { request: ROUTE, createdAt: '2026-11-06T12:00:00.000Z', finishedAt: '2026-11-06T12:05:00.000Z', nextEventId: 2 };
    // A done job without its summary; one in the old layout whose route has no line.
    fs.writeFileSync(path.join(store, 'nosummary.json'), JSON.stringify({ ...base, id: 'nosummary', status: 'done' }));
    fs.writeFileSync(
      path.join(store, 'noline.json'),
      JSON.stringify({
        ...base,
        id: 'noline',
        status: 'done',
        summary: SUMMARY,
        geojson: { type: 'FeatureCollection', features: [] },
        events: [],
        progress: [],
      })
    );
    // A window's done job whose results file holds no route.
    fs.writeFileSync(
      path.join(store, 'bare.json'),
      JSON.stringify({ ...base, id: 'bare', status: 'done', summary: SUMMARY, windowId: 'win-1' })
    );
    fs.writeFileSync(path.join(store, 'results', 'bare.json'), JSON.stringify({ events: [], progress: [] }));
    // One whose route has a point without properties.
    fs.writeFileSync(
      path.join(store, 'nullprops.json'),
      JSON.stringify({ ...base, id: 'nullprops', status: 'done', summary: SUMMARY, windowId: 'win-1' })
    );
    fs.writeFileSync(
      path.join(store, 'results', 'nullprops.json'),
      JSON.stringify({
        events: [],
        progress: [],
        geojson: {
          type: 'FeatureCollection',
          features: [...GEOJSON.features, { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: null }],
        },
      })
    );
    const logged: string[] = [];
    const jobs = new JobManager(dir, 50, '/p', m => logged.push(m));
    assert.equal(jobs.get('nosummary'), undefined);
    assert.equal(jobs.get('noline'), undefined);
    assert.ok(logged.includes('route job file nosummary.json does not hold a route job; left as it is, not restored'));
    assert.ok(logged.includes('route job file noline.json does not hold a route job; left as it is, not restored'));
    assert.ok(jobs.get('bare'), 'its own file is sound: restored');
    assert.equal(jobs.full('bare')?.geojson, undefined, 'answered without its results');
    assert.ok(logged.includes('route job bare: its route results file does not hold route results; answered without them'));
    assert.equal(jobs.full('nullprops')?.geojson, undefined);
    assert.ok(logged.includes('route job nullprops: its route results file does not hold route results; answered without them'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
