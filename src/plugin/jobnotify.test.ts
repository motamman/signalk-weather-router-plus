// The notification a finished route job sends (jobnotify.ts): a route of its own says ready or failed; a cancelled
// route, a departure window's departure and an ensemble set's member say nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobNotification } from './jobnotify';
import type { RouteSummary } from './protocol';

const SUMMARY = { total_distance_m: 52616.3, total_time_s: 9000.4 } as RouteSummary;

test('a route of its own: ready with its distance and time, failed with why, a cancel says nothing', () => {
  assert.deepEqual(jobNotification({}, { kind: 'done', summary: SUMMARY }), { state: 'normal', message: 'route ready: 52616 m, 9000 s' });
  assert.deepEqual(jobNotification({}, { kind: 'error', message: 'no water path', cancelled: false }), {
    state: 'alert',
    message: 'route failed: no water path',
  });
  assert.equal(jobNotification({}, { kind: 'error', message: 'cancelled', cancelled: true }), null);
});

test("an ensemble set's member and a window's departure say nothing, done or failed", () => {
  for (const job of [{ ensembleSetId: 'set-1' }, { windowId: 'win-1' }]) {
    assert.equal(jobNotification(job, { kind: 'done', summary: SUMMARY }), null, JSON.stringify(job));
    assert.equal(jobNotification(job, { kind: 'error', message: 'no water path', cancelled: false }), null, JSON.stringify(job));
  }
});
