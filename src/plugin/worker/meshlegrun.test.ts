/**
 * The route worker's mesh leg runner (worker/route.ts meshLegRunner): a leg that reads the forecast asks the route for
 * its run once the leg's areas are loaded, and a route with no forecast never does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshLegRunner, type OpenMesh } from './route';
import type { WorkerState } from './state';
import type { ResolvedConfig } from '../config';
import type { RouteRequest } from '../protocol';
import type { MeshLegArgs } from '../../engine/mesh/leg';
import type { MeshStore } from '../../engine/mesh/store';
import type { DecodedRun } from '../../data/decoded';

test("a mesh leg that reads the forecast takes the route's run, failing as the route's run fails; a calm route never asks", async () => {
  // A mesh whose index covers nothing: a leg that gets past the forecast is refused for want of a mesh.
  const stores: OpenMesh[] = [{ name: 'm', dir: '/nonexistent', store: { covers: () => false } as unknown as MeshStore }];
  const request: RouteRequest = { start: { lat: 41, lon: -71 }, end: { lat: 41.1, lon: -71.1 } };
  const args = { legStart: [-71, 41], plan: { vias: [], end: [-71.1, 41.1] } } as unknown as MeshLegArgs;
  const asked: string[] = [];
  const failing = (): DecodedRun => {
    asked.push('run');
    throw new Error('no run for the leg');
  };
  const runner = meshLegRunner({} as WorkerState, {} as ResolvedConfig, 'j1', request, stores, () => null, failing);
  assert.ok(runner);
  // No mesh holds the leg's points: refused before any child process starts, and the run is not asked for.
  assert.deepEqual(await runner.leg(args), { refused: 'no mesh covers the leg' });
  assert.deepEqual(asked, []);
  // A route with no forecast at all never needs the run.
  const calm = meshLegRunner({} as WorkerState, {} as ResolvedConfig, 'j1', { ...request, no_forecast: true }, stores, () => null, failing);
  assert.deepEqual(await calm!.leg(args), { refused: 'no mesh covers the leg' });
  assert.deepEqual(asked, []);
});
