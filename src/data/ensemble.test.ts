/**
 * The ensembles' members, step ladders, index records and prune (data/ensemble.ts). The download and decode were run on
 * brain against data.ecmwf.int (not here: they need the server).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ENSEMBLES, type IndexRecord } from './ecmwf';
import {
  ENSEMBLE_DECODED_DIR,
  ENSEMBLE_GRIB_DIR,
  ensembleMembers,
  ensembleSteps,
  memberDir,
  memberRecords,
  pruneEnsembles,
} from './ensemble';

test('members: the control first where the model publishes one (AIFS ENS), then 1 to n', () => {
  assert.deepEqual(ensembleMembers(ENSEMBLES['ifs-ens'], 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(ensembleMembers(ENSEMBLES['aifs-ens'], 5), [0, 1, 2, 3, 4, 5]);
  assert.equal(memberDir(0), 'm00');
  assert.equal(memberDir(7), 'm07');
  assert.equal(memberDir(50), 'm50');
});

test('steps: the model step to 144 h, then 6-hourly, to the horizon and never past the cycle', () => {
  const ifs = ensembleSteps(ENSEMBLES['ifs-ens'], { maxStep: 360 }, 168);
  assert.equal(ifs[0], 0);
  assert.equal(ifs[1], 3);
  assert.ok(ifs.includes(144) && !ifs.includes(147));
  assert.deepEqual(ifs.slice(-4), [150, 156, 162, 168]);
  assert.equal(ifs.length, 49 + 4);
  const aifs = ensembleSteps(ENSEMBLES['aifs-ens'], { maxStep: 360 }, 72);
  assert.deepEqual(aifs, [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72]);
  // A 06z/18z cycle ends at 144 h.
  assert.equal(ensembleSteps(ENSEMBLES['ifs-ens'], { maxStep: 144 }, 240).at(-1), 144);
});

test('index records: a member by its number, the control by having none; one record per field', () => {
  const rec = (param: string, number?: string, levtype = 'sfc', offset = 0): IndexRecord => ({
    param,
    step: '24',
    levtype,
    _offset: offset,
    _length: 10,
    ...(number === undefined ? {} : { number }),
  });
  const pf = [
    rec('10u', '1', 'sfc', 0),
    rec('10u', '2', 'sfc', 10),
    rec('10v', '1', 'sfc', 20),
    rec('10v', '2', 'sfc', 30),
    rec('10u', '2', 'pl', 40),
  ];
  assert.deepEqual(
    memberRecords(pf, 2, false, ['10u', '10v']).map(r => r._offset),
    [10, 30],
    'member 2 at the surface, not the pressure-level record'
  );
  const cf = [rec('10u', undefined, 'sfc', 50), rec('10v', undefined, 'sfc', 60)];
  assert.deepEqual(
    memberRecords(cf, 0, true, ['10u', '10v']).map(r => r._offset),
    [50, 60]
  );
  assert.throws(() => memberRecords(pf, 3, false, ['10u']), /member 3: 0 records of 10u/);
  assert.throws(() => memberRecords([...pf, rec('10u', '1', 'sfc', 70)], 1, false, ['10u']), /member 1: 2 records of 10u/);
  assert.throws(() => memberRecords(pf, 0, true, ['10u']), /the control: 0 records of 10u/);
});

test('prune: keeps the members wanted in the cycles kept and the pending GRIB cache; removes the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-'));
  try {
    const mk = (...p: string[]) => fs.mkdirSync(path.join(root, ...p), { recursive: true });
    // ifs-ens: m01 and m02 in 2026110500, m03 (no longer wanted); GRIB of the cycle in use and of the pending one.
    mk(ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm01', '2026110500');
    mk(ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm02', '2026110500');
    mk(ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm03', '2026110500');
    fs.writeFileSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json'), '{}');
    mk(ENSEMBLE_GRIB_DIR, 'ifs-ens', '2026110500', 'm01');
    mk(ENSEMBLE_GRIB_DIR, 'ifs-ens', '2026110512', 'm01');
    // aifs-ens: no longer chosen.
    mk(ENSEMBLE_DECODED_DIR, 'aifs-ens', 'm00', '2026110500');
    mk(ENSEMBLE_GRIB_DIR, 'aifs-ens', '2026110500');
    const removed = pruneEnsembles(root, { 'ifs-ens': { members: [1, 2], cycles: ['2026110500'], pending: '2026110512' } });
    const has = (...p: string[]) => fs.existsSync(path.join(root, ...p));
    assert.ok(has(ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json'));
    assert.ok(!has(ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm03'));
    assert.ok(!has(ENSEMBLE_GRIB_DIR, 'ifs-ens', '2026110500'), "a completed cycle's GRIB cache goes");
    assert.ok(has(ENSEMBLE_GRIB_DIR, 'ifs-ens', '2026110512'), "the pending cycle's GRIB cache stays");
    assert.ok(!has(ENSEMBLE_DECODED_DIR, 'aifs-ens'));
    assert.ok(!has(ENSEMBLE_GRIB_DIR, 'aifs-ens'));
    assert.ok(removed.includes('ifs-ens m03'));
    assert.ok(removed.includes('aifs-ens (decoded)'));
    // Off: nothing kept, everything goes.
    pruneEnsembles(root, {});
    assert.ok(!has(ENSEMBLE_DECODED_DIR, 'ifs-ens'));
    assert.ok(!has(ENSEMBLE_GRIB_DIR, 'ifs-ens'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
