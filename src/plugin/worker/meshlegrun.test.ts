/**
 * The route worker's mesh leg runner (worker/route.ts meshLegRunner): a leg that reads the forecast cannot be planned
 * on the mesh while the worker has no decoded run, and the refusal says that, not when one will be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshLegRunner, NO_DECODED_RUN_FOR_MESH, type OpenMesh } from './route';
import type { WorkerState } from './state';
import type { ResolvedConfig } from '../config';
import type { RouteRequest } from '../protocol';
import type { MeshLegArgs } from '../../engine/mesh/leg';
import type { MeshStore } from '../../engine/mesh/store';

test('a mesh leg without a decoded forecast run is refused with what the worker knows: no run yet, the mesh reads only a decoded run', async () => {
  // A mesh whose index covers nothing: a leg that gets past the forecast check is refused for want of a mesh.
  const stores: OpenMesh[] = [{ name: 'm', dir: '/nonexistent', store: { covers: () => false } as unknown as MeshStore }];
  const request: RouteRequest = { start: { lat: 41, lon: -71 }, end: { lat: 41.1, lon: -71.1 } };
  const runner = meshLegRunner({} as WorkerState, {} as ResolvedConfig, 'j1', request, stores, () => null, null);
  assert.ok(runner);
  const r = await runner.leg({ legStart: [-71, 41], plan: { vias: [], end: [-71.1, 41.1] } } as unknown as MeshLegArgs);
  assert.deepEqual(r, { refused: NO_DECODED_RUN_FOR_MESH });
  assert.match(NO_DECODED_RUN_FOR_MESH, /^no decoded forecast run yet: /);
  assert.ok(!/shortly|still being decoded/.test(NO_DECODED_RUN_FOR_MESH), 'nothing the worker cannot know');
  // A route with no forecast at all never needs the run.
  const calm = meshLegRunner({} as WorkerState, {} as ResolvedConfig, 'j1', { ...request, no_forecast: true }, stores, () => null, null);
  const r2 = await calm!.leg({ legStart: [-71, 41], plan: { vias: [], end: [-71.1, 41.1] } } as unknown as MeshLegArgs);
  assert.deepEqual(r2, { refused: 'no mesh covers the leg' }, 'past the forecast check, refused by the mesh instead');
});
