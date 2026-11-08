/**
 * The route worker's mesh leg runner (worker/route.ts meshLegRunner): a leg a mesh covers asks the route for its
 * forecast run once, after its rough cut, and an error from the route's run reaches the caller; a leg no mesh covers
 * is refused before the run is asked for, and a route with no forecast does not ask on it. A covered leg of a route
 * with no forecast is not run here: past the run it starts the mesh process (runChildTask), which a unit test does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { meshLegRunner, type OpenMesh } from './route';
import { coarseFile, coarseRulesOf } from '../meshcoarse';
import type { WorkerState } from './state';
import type { ResolvedConfig } from '../config';
import type { RouteRequest } from '../protocol';
import type { MeshLegArgs } from '../../engine/mesh/leg';
import type { MeshRules } from '../../engine/mesh/route';
import type { MeshStore } from '../../engine/mesh/store';
import type { DecodedRun } from '../../data/decoded';

const request: RouteRequest = { start: { lat: 41, lon: -71 }, end: { lat: 41.1, lon: -71.1 } };
const rules: MeshRules = {
  draughtM: 2,
  airDraftM: 15,
  underKeelClearanceM: 0.5,
  overheadClearanceM: 1,
  bufferM: 0,
  openingBridges: 'open',
  motorSpeedMs: 3,
};
const args = {
  legStart: [-71, 41],
  plan: { vias: [], end: [-71.1, 41.1] },
  legIndex: 0,
  legDeparture: new Date(Date.UTC(2026, 10, 7, 12)),
  rules,
  tag: '',
  progress: () => undefined,
  shouldCancel: () => false,
} as unknown as MeshLegArgs;

/** A route's run that fails, counting the times it is asked for. */
function failingRun(): { run: () => DecodedRun; asked: () => number } {
  let n = 0;
  return {
    run: () => {
      n++;
      throw new Error('no run for the leg');
    },
    asked: () => n,
  };
}

test("a leg a mesh covers asks for the route's run once, after its rough cut, and the run's error reaches the caller", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshlegrun-'));
  try {
    // A mesh holding the leg (its folder: the index a rough cut is keyed by), its rough cut for these rules on disk
    // (ensureRoughCut finds it and builds nothing).
    const meshDir = path.join(dataDir, 'mesh-a');
    fs.mkdirSync(meshDir);
    fs.writeFileSync(path.join(meshDir, 'index.json'), '{}');
    const stores: OpenMesh[] = [{ name: 'm', dir: meshDir, store: { covers: () => true } as unknown as MeshStore }];
    const cut = coarseFile(dataDir, meshDir, coarseRulesOf(rules));
    fs.mkdirSync(path.dirname(cut), { recursive: true });
    fs.writeFileSync(cut, '{}');
    const f = failingRun();
    const runner = meshLegRunner({ cacheRoot: dataDir } as WorkerState, {} as ResolvedConfig, 'j1', request, stores, () => null, f.run);
    await assert.rejects(runner!.leg(args), /^Error: no run for the leg$/);
    assert.equal(f.asked(), 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a leg no mesh covers is refused before the run is asked for, with a forecast or without', async () => {
  const stores: OpenMesh[] = [{ name: 'm', dir: '/nonexistent', store: { covers: () => false } as unknown as MeshStore }];
  const f = failingRun();
  const runner = meshLegRunner({} as WorkerState, {} as ResolvedConfig, 'j1', request, stores, () => null, f.run);
  assert.deepEqual(await runner!.leg(args), { refused: 'no mesh covers the leg' });
  const calm = meshLegRunner({} as WorkerState, {} as ResolvedConfig, 'j1', { ...request, no_forecast: true }, stores, () => null, f.run);
  assert.deepEqual(await calm!.leg(args), { refused: 'no mesh covers the leg' });
  assert.equal(f.asked(), 0);
});
