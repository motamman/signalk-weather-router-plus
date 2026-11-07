/**
 * The ensembles' members, step ladders, index records and prune (data/ensemble.ts). The download and decode were run on
 * brain against data.ecmwf.int (not here: they need the server).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cycleFor, type EcmwfClient, ENSEMBLE_OPTIONAL_PARAMS, ENSEMBLE_PARAMS, ENSEMBLES, type IndexRecord, isGribFile } from './ecmwf';
import { dirBytes } from './decoded';
import { GLOBAL_CELLS } from './loader';
import { asEnsembleMember } from '../grib/grib2fixture';
import {
  ENSEMBLE_DECODED_DIR,
  ENSEMBLE_GRIB_DIR,
  ensembleCurrentFile,
  ensembleGribPath,
  ensembleMembers,
  ensembleSteps,
  memberDir,
  memberRecords,
  pruneEnsembles,
  readEnsembleCurrent,
  runEnsembleCycle,
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
    const { removed, problems } = pruneEnsembles(root, { 'ifs-ens': { members: [1, 2], cycles: ['2026110500'], pending: '2026110512' } });
    assert.deepEqual(problems, []);
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

/**
 * A fake client for IFS ENS member 1: index records for the steps in `published` (none for the others), each the
 * length of `message` (10 bytes of 'GRIB------' unless one is given), and every field it is asked for written to the
 * cache as that message; `fetched` counts those.
 */
function fakeClient(
  published: number[],
  /** The optional wave field in the wave indexes too (IFS ENS publishes mp2; AIFS ENS does not). */
  withOptional = false,
  message: Uint8Array = new Uint8Array(Buffer.from('GRIB------'))
): { client: EcmwfClient; indexed: number[]; fetched: () => number } {
  const indexed: number[] = [];
  let fetched = 0;
  const client = {
    fetchEnsembleIndex: async (_c: unknown, _m: unknown, stream: string, _k: string, step: number) => {
      indexed.push(step);
      if (!published.includes(step)) return null;
      const params = [
        ...ENSEMBLE_PARAMS[stream as keyof typeof ENSEMBLE_PARAMS],
        ...(withOptional ? ENSEMBLE_OPTIONAL_PARAMS[stream as keyof typeof ENSEMBLE_OPTIONAL_PARAMS] : []),
      ];
      return params.map((param, i) => ({
        param,
        step: String(step),
        levtype: 'sfc',
        number: '1',
        _offset: i * message.length,
        _length: message.length,
      }));
    },
    fetchEnsembleField: async (_c: unknown, _m: unknown, _s: string, _k: string, _st: number, _r: unknown, p: string) => {
      fetched++;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, message);
      return message;
    },
  } as unknown as EcmwfClient;
  return { client, indexed, fetched: () => fetched };
}

test('prune: a folder that cannot be read is reported and left, and the rest is still pruned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-prune-'));
  try {
    // A file where member 1's folder of runs belongs: it cannot be listed (on every OS).
    fs.mkdirSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens'), { recursive: true });
    fs.writeFileSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm01'), 'not a folder');
    fs.mkdirSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm09', '2026110500'), { recursive: true });
    const { removed, problems } = pruneEnsembles(root, { 'ifs-ens': { members: [1], cycles: ['2026110500'], pending: null } });
    assert.deepEqual(removed, ['ifs-ens m09']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /m01: /);
    assert.ok(fs.existsSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm01')), 'left as it is');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the GRIB cache and disk-use reads: missing is none; there but unreadable throws', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-reads-'));
  try {
    assert.equal(isGribFile(path.join(root, 'none.grib2')), false);
    fs.writeFileSync(path.join(root, 'a.grib2'), 'GRIB....');
    assert.equal(isGribFile(path.join(root, 'a.grib2')), true);
    fs.mkdirSync(path.join(root, 'folder.grib2'));
    assert.throws(() => isGribFile(path.join(root, 'folder.grib2')));
    assert.equal(dirBytes(path.join(root, 'none')), 0);
    assert.equal(dirBytes(root), 8);
    assert.throws(() => dirBytes(path.join(root, 'a.grib2')), 'a file is not a folder to walk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cycle not finished yet stops the model at its last step, before reading the ladder or fetching anything; the cache kept', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-'));
  try {
    // IFS ENS, 6 h: steps 0, 3, 6; the server has +0 h only. One +0 h message is cached from an earlier round.
    const kept = ensembleGribPath(root, 'ifs-ens', '2026110500', 1, 'enfo', 0, '10u');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, 'GRIB------');
    const { client, indexed, fetched } = fakeClient([0]);
    const [r] = await runEnsembleCycle(client, {
      cacheRoot: root,
      cycle: cycleFor(new Date('2026-11-05T00:00:00Z')),
      horizonS: 6 * 3600,
      models: ['ifs-ens'],
      members: 1,
      log: () => undefined,
      diskCheck: () => null,
    });
    assert.match(r.error ?? '', /\+6 h enfo, the last step, is not published yet; retried next round/);
    assert.deepEqual(r.members, []);
    assert.deepEqual(r.steps, []);
    assert.deepEqual(indexed, [6], 'one index request: the last step');
    assert.equal(fetched(), 0, 'every index is read before any message is fetched');
    assert.equal(readEnsembleCurrent(root, 'ifs-ens'), null, 'no cycle in use');
    assert.ok(!fs.existsSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm01')), 'no member decoded');
    assert.ok(fs.existsSync(kept), 'what an earlier round cached stays');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the disk check is asked about exactly what the pass writes, and a no stops it before anything is fetched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-'));
  try {
    // One message cached already: of the 5 fields × 3 steps of 10 bytes, 14 are still to fetch.
    const kept = ensembleGribPath(root, 'ifs-ens', '2026110500', 1, 'waef', 3, 'swh');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, 'GRIB------');
    const { client, fetched } = fakeClient([0, 3, 6]);
    const asked: number[] = [];
    const [r] = await runEnsembleCycle(client, {
      cacheRoot: root,
      cycle: cycleFor(new Date('2026-11-05T00:00:00Z')),
      horizonS: 6 * 3600,
      models: ['ifs-ens'],
      members: 1,
      log: () => undefined,
      diskCheck: bytes => {
        asked.push(bytes);
        return 'no room';
      },
    });
    // The messages by the indexes' own lengths, and one member's decoded run: 5 fields × 3 steps of one global float32 field.
    assert.deepEqual(asked, [14 * 10 + 1 * 5 * 3 * GLOBAL_CELLS * 4]);
    assert.match(r.error ?? '', /ECMWF IFS ENS 2026110500: not downloaded: no room/);
    assert.equal(fetched(), 0);
    assert.deepEqual(r.members, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the optional wave field is planned, fetched and counted only when the index has it, as IFS ENS does and AIFS ENS does not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-'));
  try {
    const run = async (withOptional: boolean): Promise<{ asked: number[]; fetched: number; error?: string }> => {
      const { client, fetched } = fakeClient([0, 3, 6], withOptional);
      const asked: number[] = [];
      const [r] = await runEnsembleCycle(client, {
        cacheRoot: root,
        cycle: cycleFor(new Date('2026-11-05T00:00:00Z')),
        horizonS: 6 * 3600,
        models: ['ifs-ens'],
        members: 1,
        log: () => undefined,
        diskCheck: bytes => {
          asked.push(bytes);
          return 'no room';
        },
      });
      return { asked, fetched: fetched(), error: r.error };
    };
    // Without mp2 in the indexes: the five required fields, nothing else looked for.
    const without = await run(false);
    assert.deepEqual(without.asked, [5 * 3 * 10 + 1 * 5 * 3 * GLOBAL_CELLS * 4]);
    // With it: a sixth field per step is fetched and decoded for the member.
    const withIt = await run(true);
    assert.deepEqual(withIt.asked, [6 * 3 * 10 + 1 * 6 * 3 * GLOBAL_CELLS * 4]);
    assert.equal(withIt.fetched, 0, 'stopped by the disk check before any message');
    // A member whose required fields are all cached still has its index read, so an optional field it lacks is fetched.
    for (const step of [0, 3, 6])
      for (const [stream, params] of Object.entries(ENSEMBLE_PARAMS))
        for (const p of params) {
          const f = ensembleGribPath(root, 'ifs-ens', '2026110500', 1, stream, step, p);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, 'GRIB------');
        }
    const cachedRequired = await run(true);
    assert.deepEqual(cachedRequired.asked, [1 * 3 * 10 + 1 * 6 * 3 * GLOBAL_CELLS * 4], 'only mp2 is still to fetch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every step published: each index is read once; a step missing inside the ladder still stops it before anything is fetched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-'));
  try {
    const cycle = cycleFor(new Date('2026-11-05T00:00:00Z'));
    const all = fakeClient([0, 3, 6]);
    await runEnsembleCycle(all.client, {
      cacheRoot: root,
      cycle,
      horizonS: 6 * 3600,
      models: ['ifs-ens'],
      members: 1,
      log: () => undefined,
      diskCheck: () => null,
    });
    assert.deepEqual(
      [...all.indexed].sort((a, b) => a - b),
      [0, 0, 3, 3, 6, 6],
      'each step file of each stream once'
    );
    assert.equal(all.fetched(), 15);
    // A cached message that is not its index record's length (cut short on disk) is not a cached message: fetched
    // again, by the one rule the fetch itself applies (ecmwf.ts isGribFile; until 2026-11-07 the pass skipped it by its
    // header and its member failed to decode every round).
    const short = ensembleGribPath(root, 'ifs-ens', '2026110500', 1, 'waef', 3, 'swh');
    fs.writeFileSync(short, 'GRIB--');
    const again = fakeClient([0, 3, 6]);
    await runEnsembleCycle(again.client, {
      cacheRoot: root,
      cycle,
      horizonS: 6 * 3600,
      models: ['ifs-ens'],
      members: 1,
      log: () => undefined,
      diskCheck: () => null,
    });
    assert.equal(again.fetched(), 1, 'the short file alone');
    assert.equal(fs.statSync(short).size, 10, 'written over');
    fs.rmSync(path.join(root, ENSEMBLE_GRIB_DIR), { recursive: true, force: true });
    // The last step is there but +3 h is not: the full read stops at the gap.
    const gap = fakeClient([0, 6]);
    const [r] = await runEnsembleCycle(gap.client, {
      cacheRoot: root,
      cycle,
      horizonS: 6 * 3600,
      models: ['ifs-ens'],
      members: 1,
      log: () => undefined,
      diskCheck: () => null,
    });
    assert.match(r.error ?? '', /\+3 h enfo is not published yet \(to \+0 h so far\); retried next round/);
    assert.equal(gap.fetched(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the record of the cycle in use: none when there is no file; a file that cannot be read, or is not the record, names its problem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-'));
  try {
    assert.deepEqual(ensembleCurrentFile(root, 'ifs-ens'), { current: null, problem: null });
    const file = path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"model": "ifs-ens", "cy');
    assert.match(ensembleCurrentFile(root, 'ifs-ens').problem ?? '', /^current\.json is not JSON: /);
    const good = { model: 'ifs-ens', cycle: '2026110600', cycleTimeMs: 0, members: [1], horizonHours: 6, at: '' };
    // Every field as the record is written: what reads it (the status's `new Date(cycleTimeMs)`, a member route) never
    // meets a value that is not one.
    for (const [bad, reason] of [
      [{ ...good, model: 'aifs-ens' }, 'model aifs-ens'],
      [{ ...good, cycle: '2026-11-06' }, 'cycle 2026-11-06'],
      [{ ...good, cycleTimeMs: undefined }, 'cycleTimeMs undefined'],
      [{ ...good, cycleTimeMs: 'x' }, 'cycleTimeMs x'],
      [{ ...good, members: [1, 'x'] }, 'members [1,"x"]'],
      [{ ...good, members: [51] }, 'members [51]'],
      [{ ...good, horizonHours: null }, 'horizonHours null'],
      [{ ...good, at: 3 }, 'at 3'],
      [[1, 2], 'not an object'],
    ] as const) {
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.equal(ensembleCurrentFile(root, 'ifs-ens').problem, `current.json is not a record of ifs-ens's cycle in use (${reason})`);
    }
    assert.equal(readEnsembleCurrent(root, 'ifs-ens'), null, 'none to use');
    fs.writeFileSync(file, JSON.stringify(good));
    assert.deepEqual(ensembleCurrentFile(root, 'ifs-ens'), { current: good, problem: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a cached message of another member is refused: the member fails with 'expected member', and no run of it is left", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-ens-'));
  try {
    // The server's step files answer member 1's records with member 2's message (template 4.1, member 2 of 50).
    const { client } = fakeClient([0, 3, 6], false, asEnsembleMember(4, 2, 50));
    const [r] = await runEnsembleCycle(client, {
      cacheRoot: root,
      cycle: cycleFor(new Date('2026-11-05T00:00:00Z')),
      horizonS: 6 * 3600,
      models: ['ifs-ens'],
      members: 1,
      log: () => undefined,
      diskCheck: () => null,
    });
    assert.equal(r.error, undefined, 'the download itself went through');
    assert.deepEqual(r.members, []);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].member, 1);
    assert.match(r.failed[0].error, /^10u \+0 h is member 2, expected member 1$/);
    // The member's folder holds no run and no temporary run (the writer removed its own).
    const m01 = path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'm01');
    assert.deepEqual(fs.existsSync(m01) ? fs.readdirSync(m01) : [], [], 'no run of the member is left');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
