import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENSEMBLE_DOWNLOAD_NOTE, ENSEMBLE_MEMBER_COST, resolveEnsemble } from './config';

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

test('ensemble downloads: models that are not a list (an options file edited by hand) are refused naming the setting', () => {
  // (Absent or null: the default, IFS ENS; that is not this case.)
  for (const models of ['ifs-ens', {}, 7] as unknown[])
    assert.throws(
      () => resolveEnsemble({ enabled: true, models: models as string[], members: 5 }),
      /^Error: config forecast\.ensemble\.models: .* is not a list of ensembles/,
      JSON.stringify(models)
    );
});

test("the ensembles' cost note says which figures were measured and which are arithmetic, as ENSEMBLE_MEMBER_COST's are", () => {
  assert.match(
    ENSEMBLE_DOWNLOAD_NOTE,
    /on disk: measured on the (plugin's )?test box, Pi 5, 2026-11-06; downloaded: arithmetic, per member from the totals? measured there on 2026-11-05\)\.$/
  );
  assert.ok(
    !/\(measured on the test box, Pi 5, 2026-11-05 and 2026-11-06\)/.test(ENSEMBLE_DOWNLOAD_NOTE),
    'not every figure is said to be measured'
  );
  // An AIFS ENS member's download is the total measured for the six members downloaded (the control and five) over six.
  assert.equal(ENSEMBLE_MEMBER_COST.downloadBytes['aifs-ens'], 206_788_659 / 6);
});
