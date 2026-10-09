/** POST /api/meshes/refresh reads the catalogue before answering and answers with the mesh list. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerApi, type ApiDeps } from './api';

test('POST /api/meshes/refresh: read-write only; awaits the read; answers the list', async () => {
  const routes = new Map<string, { access: string; h: (req: unknown, res: unknown) => unknown }>();
  const router = (access: string) => ({
    get: (p: string, h: never) => routes.set(`GET ${p}`, { access, h }),
    post: (p: string, h: never) => routes.set(`POST ${p}`, { access, h }),
    put: (p: string, h: never) => routes.set(`PUT ${p}`, { access, h }),
    delete: (p: string, h: never) => routes.set(`DELETE ${p}`, { access, h }),
  });
  const base = router('readonly');
  let listed = { catalog_error: 'HTTP 404', meshes: [] as unknown[] };
  let reads = 0;
  registerApi(
    { ...base, access: (a: string) => router(a) } as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: '/nonexistent',
      tiles: () => ({ get: async () => ({ gz: Buffer.from([]), cached: true }) }),
      notReady: () => null,
      noteTileRequest: () => {},
      meshes: () => listed,
      refreshMeshes: async () => {
        reads++;
        listed = { catalog_error: null as unknown as string, meshes: [{ name: '01CGD' }] };
      },
    } as unknown as ApiDeps
  );
  const r = routes.get('POST /api/meshes/refresh')!;
  assert.equal(r.access, 'readwrite');
  let out: unknown = null;
  const res = { status: () => res, json: (b: unknown) => { out = b; return res; }, setHeader: () => res };
  await r.h({ query: {} }, res);
  assert.equal(reads, 1);
  assert.deepEqual(out, { catalog_error: null, meshes: [{ name: '01CGD' }] });
});

test('POST /api/meshes/refresh: a catalogue read that failed is a 502 whose body is still the list', async () => {
  const routes = new Map<string, { access: string; h: (req: unknown, res: unknown) => unknown }>();
  const router = (access: string) => ({
    get: (p: string, h: never) => routes.set(`GET ${p}`, { access, h }),
    post: (p: string, h: never) => routes.set(`POST ${p}`, { access, h }),
    put: (p: string, h: never) => routes.set(`PUT ${p}`, { access, h }),
    delete: (p: string, h: never) => routes.set(`DELETE ${p}`, { access, h }),
  });
  const base = router('readonly');
  // The previous catalogue's rows stay listed; the read's error is recorded beside them.
  const listed = { catalog_error: 'HTTP 404', meshes: [{ name: '01CGD' }] };
  registerApi(
    { ...base, access: (a: string) => router(a) } as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: '/nonexistent',
      tiles: () => null,
      notReady: () => '',
      noteTileRequest: () => {},
      meshes: () => listed,
      refreshMeshes: async () => {},
    } as unknown as ApiDeps
  );
  let code = 0;
  let out: unknown = null;
  const res = {
    status: (c: number) => {
      code = c;
      return res;
    },
    json: (b: unknown) => {
      out = b;
      return res;
    },
    setHeader: () => res,
  };
  await routes.get('POST /api/meshes/refresh')!.h({ query: {} }, res);
  assert.equal(code, 502);
  assert.deepEqual(out, { error: 'catalogue not read: HTTP 404', catalog_error: 'HTTP 404', meshes: [{ name: '01CGD' }] });
});
