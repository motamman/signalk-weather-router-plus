import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnsemble } from './config';

test('ensemble downloads: off unless enabled, and off reads and checks nothing of the setting', () => {
  assert.equal(resolveEnsemble(undefined), null);
  assert.equal(resolveEnsemble({ enabled: false, models: ['aifs-ens'], members: 20 }), null);
  // A count or an ensemble that would be refused while on: off, they are not looked at (the start-up goes on).
  assert.equal(resolveEnsemble({ enabled: false, models: ['gefs'], members: 7 }), null);
});

test('ensemble downloads: on, IFS ENS until another is chosen; at least one while on', () => {
  assert.deepEqual(resolveEnsemble({ enabled: true }), { models: ['ifs-ens'], members: 5 });
  assert.deepEqual(resolveEnsemble({ enabled: true, models: ['aifs-ens', 'ifs-ens', 'aifs-ens'], members: 50 }), {
    models: ['aifs-ens', 'ifs-ens'],
    members: 50,
  });
  assert.throws(() => resolveEnsemble({ enabled: true, models: [] }), /no ensemble is selected/);
  assert.throws(() => resolveEnsemble({ enabled: true, models: ['gefs'] }), /gefs is not one of ifs-ens, aifs-ens/);
});

test('ensemble downloads: members 5 to 50 in fives', () => {
  for (const members of [0, 7, 55]) assert.throws(() => resolveEnsemble({ enabled: true, members }), /is not one of 5, 10/);
});
