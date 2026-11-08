/**
 * A complete decoded run of an ensemble member, for the tests (worker/ensemblerefresh.test.ts,
 * worker/route_member.test.ts): the decoded-run format (data/decoded.ts) on a 2 × 2 grid, its index and one float32
 * file per field and step (openDecodedRun checks every file's size against the grid).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cycleName, DECODED_FORMAT, DECODED_VERSION, fieldFile, INDEX_FILE } from '../../data/decoded';
import type { EnsembleModelId } from '../../data/ecmwf';
import { ENSEMBLE_FIELDS, memberRunDir } from '../../data/ensemble';

/** Member `member`'s run of `cycle` under `root`, complete for `horizonHours` with `steps`; its folder. */
export function decodedMember(
  root: string,
  member: number,
  cycle: Date,
  model: EnsembleModelId = 'ifs-ens',
  horizonHours = 6,
  steps: number[] = [0, 3, 6]
): string {
  const name = cycleName(cycle);
  const dir = memberRunDir(root, model, member, name);
  fs.mkdirSync(dir, { recursive: true });
  const grid = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2, wrapLon: false };
  for (const h of steps)
    for (const p of ENSEMBLE_FIELDS) fs.writeFileSync(path.join(dir, fieldFile(h, p)), Buffer.alloc(grid.nLat * grid.nLon * 4));
  fs.writeFileSync(
    path.join(dir, INDEX_FILE),
    JSON.stringify({
      format: DECODED_FORMAT,
      version: DECODED_VERSION,
      byteOrder: 'LE',
      cycle: name,
      cycleTimeMs: cycle.getTime(),
      request: { horizonHours, params: ENSEMBLE_FIELDS },
      stepHours: steps,
      grid,
      steps: steps.map(h => ({ stepHours: h, validMs: cycle.getTime() + h * 3600_000, params: ENSEMBLE_FIELDS })),
      bytes: steps.length * ENSEMBLE_FIELDS.length * grid.nLat * grid.nLon * 4,
      decodedAt: cycle.toISOString(),
      decodeMs: 1,
      complete: true,
    })
  );
  return dir;
}
