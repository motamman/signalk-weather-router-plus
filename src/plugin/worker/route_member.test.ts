/**
 * The route worker's choice of an ensemble member's run (worker/route.ts memberRun): the ensemble's cycle in use
 * (current.json) and the member's decoded run, each refusal naming what is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { memberRun } from './route';
import type { WorkerState } from './state';
import { RouteError } from '../../engine/errors';
import { ENSEMBLE_DECODED_DIR } from '../../data/ensemble';
import { decodedMember } from './ensemblefixture';

const CYCLE = new Date('2026-11-06T00:00:00Z');

test('memberRun: no record, another cycle pinned, a member not on disk, a run that is not usable, and a member that is', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-member-'));
  try {
    const st = { cacheRoot: root } as unknown as WorkerState;
    const refused = (want: Parameters<typeof memberRun>[1], re: RegExp): void =>
      assert.throws(
        () => memberRun(st, want),
        (e: unknown) => e instanceof RouteError && re.test(e.message),
        String(re)
      );
    refused({ model: 'ifs-ens', member: 1 }, /^ECMWF IFS ENS: no ensemble on disk yet \(it downloads after each forecast cycle\)$/);
    fs.mkdirSync(path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens'), { recursive: true });
    fs.writeFileSync(
      path.join(root, ENSEMBLE_DECODED_DIR, 'ifs-ens', 'current.json'),
      JSON.stringify({ model: 'ifs-ens', cycle: '2026110600', cycleTimeMs: CYCLE.getTime(), members: [1, 2], horizonHours: 6, at: '' })
    );
    // A set pinned to the cycle before: never routed on another cycle's member.
    refused(
      { model: 'ifs-ens', member: 1, cycle: '2026110518' },
      /^ECMWF IFS ENS: the run of 2026110518 is no longer on disk \(now 2026110600\); start the ensemble again$/
    );
    refused({ model: 'ifs-ens', member: 9 }, /^ECMWF IFS ENS: member 9 is not on disk$/);
    // Recorded, but its run is not there (or not whole).
    refused({ model: 'ifs-ens', member: 2 }, /^ECMWF IFS ENS member 2: not usable \(/);
    decodedMember(root, 1, CYCLE);
    const got = memberRun(st, { model: 'ifs-ens', member: 1, cycle: '2026110600' });
    assert.deepEqual(
      { model: got.model, name: got.name, cycle: got.cycle, member: got.member, dir: got.run.dir },
      { model: 'ifs-ens', name: 'ECMWF IFS ENS', cycle: CYCLE.toISOString(), member: 1, dir: decodedMember(root, 1, CYCLE) }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
