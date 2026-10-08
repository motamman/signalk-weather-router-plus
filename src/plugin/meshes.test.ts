/**
 * Managed meshes: the catalogue description, the folder rules, and the
 * whole download path against a local HTTP server serving a tiny mesh
 * (catalogue → child download → marker → ready; an unticked mesh removed;
 * a newer catalogue build re-downloaded).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  describeMesh,
  localMeshes,
  meshBaseUrl,
  meshClusterDirs,
  MeshManager,
  readMarker,
  readyMeshDirs,
  type CatalogMesh,
} from './meshes';

const ENTRY: CatalogMesh = {
  name: '01CGD',
  dir: 'mesh/01CGD/',
  archive: '01CGD_mesh.tar.zst',
  sidecar: '01CGD_mesh.json',
  build_date: '2026-10-08T15:55:27Z',
  chart_build_date: '2026-09-07T04:10:00Z',
  format: { magic: 'WRPMESH1', index_version: 1, tile_deg: 0.25, multi_cluster: false },
  triangles: 35520554,
  bytes: 2841659040,
  clusters: [{ dir: '.', box: [-74.749875, 40.000125, -65.749875, 45.750125] }],
};

test('describeMesh and meshBaseUrl', () => {
  assert.equal(describeMesh(ENTRY), '40.0°N–45.8°N, 74.7°W–65.7°W · chart 2026-09-07 · mesh 2026-10-08 · 2.8 GB · 35.5 M triangles');
  assert.equal(meshBaseUrl('https://pub-x.r2.dev/US-ENC/charts/mesh/index.json', ENTRY), 'https://pub-x.r2.dev/US-ENC/charts/mesh/01CGD/');
  const two = {
    ...ENTRY,
    clusters: [ENTRY.clusters[0], { dir: 'w158n20', box: [-158, 20, -154, 22] as [number, number, number, number] }],
  };
  assert.match(describeMesh(two), /20\.0°N–45\.8°N, 158\.0°W–65\.7°W in 2 parts/);
});

test('readyMeshDirs: a complete marker makes a mesh ready; clusters are listed from meshes.json; .new folders are ignored', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  const one = path.join(store, '01CGD');
  fs.mkdirSync(one);
  fs.writeFileSync(path.join(one, 'index.json'), '{}');
  assert.deepEqual(readyMeshDirs(store), [], 'no marker: not ready');
  fs.writeFileSync(path.join(one, '.wrp-mesh.json'), JSON.stringify({ name: '01CGD', build_date: 'x' }));
  const multi = path.join(store, '14CGD');
  fs.mkdirSync(path.join(multi, 'w158n20'), { recursive: true });
  fs.mkdirSync(path.join(multi, 'w145n13'), { recursive: true });
  fs.writeFileSync(
    path.join(multi, 'meshes.json'),
    JSON.stringify({ version: 1, name: '14CGD', meshes: [{ dir: 'w158n20' }, { dir: 'w145n13' }] })
  );
  fs.writeFileSync(path.join(multi, '.wrp-mesh.json'), JSON.stringify({ name: '14CGD', build_date: 'y' }));
  fs.mkdirSync(path.join(store, '07CGD.new'));
  assert.deepEqual(readyMeshDirs(store), [
    { name: '01CGD', dirs: [one] },
    { name: '14CGD', dirs: [path.join(multi, 'w158n20'), path.join(multi, 'w145n13')] },
  ]);
  assert.deepEqual(meshClusterDirs(one), [one]);
  fs.rmSync(store, { recursive: true, force: true });
});

/** A tiny published layout served over HTTP: charts/mesh/index.json and charts/mesh/<D>/ with an index and two tiles. */
function serve(root: string): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent((req.url ?? '/').split('?')[0]));
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-length': st.size });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}/`, close: () => srv.close() });
    });
  });
}

function publish(root: string, buildDate: string, tileBytes: number): void {
  const dir = path.join(root, 'charts', 'mesh', '01CGD');
  fs.mkdirSync(dir, { recursive: true });
  const tiles = [
    { i: 1, j: 2, file: 'mesh_001_002.bin', first: 0, n: 1, bbox: [0, 0, 1, 1] },
    { i: 2, j: 2, file: 'mesh_002_002.bin', first: 1, n: 1, bbox: [1, 0, 2, 1] },
  ];
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ version: 1, west: 0, south: 0, east: 2, north: 1, tileDeg: 1, xScale: 1, triangles: 2, tiles })
  );
  for (const t of tiles) fs.writeFileSync(path.join(dir, t.file), Buffer.alloc(tileBytes, 7));
  const entry = { ...ENTRY, build_date: buildDate, bytes: 2 * tileBytes, triangles: 2 };
  fs.writeFileSync(path.join(root, 'charts', 'mesh', 'index.json'), JSON.stringify({ version: 1, updated: buildDate, meshes: [entry] }));
}

test('MeshManager: downloads a ticked mesh, marks it ready, re-downloads a newer build, removes an unticked one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-08T15:55:27Z', 1000);
  const { url, close } = await serve(root);
  const logs: string[] = [];
  const mgr = new MeshManager(m => logs.push(m));
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    await mgr.reconcile();
    const st = mgr.status();
    const row = st.meshes.find(r => r.name === '01CGD')!;
    assert.equal(st.catalog_error, null);
    assert.equal(row.state, 'ready', JSON.stringify(row));
    assert.equal(row.title, 'District 1 — New England (ME, NH, MA, RI, CT, eastern NY)');
    const marker = readMarker(path.join(store, '01CGD'))!;
    assert.equal(marker.build_date, '2026-10-08T15:55:27Z');
    assert.equal(marker.files, 2);
    assert.equal(marker.bytes, 2000);
    assert.equal(fs.statSync(path.join(store, '01CGD', 'mesh_002_002.bin')).size, 1000);
    assert.deepEqual(readyMeshDirs(store), [{ name: '01CGD', dirs: [path.join(store, '01CGD')] }]);
    // A newer build in the catalogue: update, then re-download replaces the copy.
    publish(root, '2026-10-09T00:00:00Z', 1200);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-09T00:00:00Z');
    assert.equal(fs.statSync(path.join(store, '01CGD', 'mesh_001_002.bin')).size, 1200);
    assert.ok(!fs.existsSync(path.join(store, '01CGD.new')) && !fs.existsSync(path.join(store, '01CGD.old')));
    // Unticked: removed.
    mgr.configure(url + 'charts/mesh/index.json', [], store);
    await mgr.reconcile();
    assert.ok(!fs.existsSync(path.join(store, '01CGD')));
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'absent');
    // A ticked name the catalogue lacks is reported, not fetched.
    mgr.configure(url + 'charts/mesh/index.json', ['99CGD'], store);
    await mgr.reconcile();
    const bad = mgr.status().meshes.find(r => r.name === '99CGD')!;
    assert.equal(bad.state, 'error');
    assert.match(bad.error!, /not in the catalogue/);
  } finally {
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('localMeshes: a mesh folder, or a folder of mesh folders, each described from its index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-local-'));
  const ix = (w: number, e: number, tri: number): string =>
    JSON.stringify({ version: 1, west: w, south: 40, east: e, north: 45, tileDeg: 0.25, xScale: 0.73, triangles: tri, tiles: [] });
  // One mesh at the folder itself.
  const single = path.join(root, 'mesh-bin');
  fs.mkdirSync(single);
  fs.writeFileSync(path.join(single, 'index.json'), ix(-75, -66, 33_044_145));
  const one = localMeshes(single);
  assert.equal(one.length, 1);
  assert.equal(one[0].name, 'mesh-bin');
  assert.deepEqual(one[0].dirs, [single]);
  assert.match(one[0].description, /40\.0°N–45\.0°N, 75\.0°W–66\.0°W · 33\.0 M triangles/);
  // A folder of meshes, one of them multi-cluster, one with a sidecar beside it.
  const many = path.join(root, 'meshes');
  fs.mkdirSync(path.join(many, '01CGD_mesh'), { recursive: true });
  fs.writeFileSync(path.join(many, '01CGD_mesh', 'index.json'), ix(-75, -66, 35_520_554));
  fs.writeFileSync(
    path.join(many, '01CGD_mesh.json'),
    JSON.stringify({ build_date: '2026-10-08T15:55:27Z', chart_build_date: '2026-09-07T04:10:00Z' })
  );
  fs.mkdirSync(path.join(many, '14CGD', 'w158n20'), { recursive: true });
  fs.mkdirSync(path.join(many, '14CGD', 'w145n13'), { recursive: true });
  fs.writeFileSync(path.join(many, '14CGD', 'w158n20', 'index.json'), ix(-158, -154, 1_000_000));
  fs.writeFileSync(path.join(many, '14CGD', 'w145n13', 'index.json'), ix(-145, -144, 500_000));
  fs.writeFileSync(
    path.join(many, '14CGD', 'meshes.json'),
    JSON.stringify({ version: 1, name: '14CGD', meshes: [{ dir: 'w158n20' }, { dir: 'w145n13' }] })
  );
  fs.mkdirSync(path.join(many, 'notes'));
  const rows = localMeshes(many);
  assert.deepEqual(
    rows.map(r => [r.name, r.dirs.length, r.error]),
    [
      ['01CGD', 1, null],
      ['14CGD', 2, null],
    ]
  );
  assert.match(rows[0].description, /chart 2026-09-07 · mesh 2026-10-08/);
  assert.match(rows[1].description, /in 2 parts · 1\.5 M triangles/);
  assert.deepEqual(localMeshes(null), []);
  fs.rmSync(root, { recursive: true, force: true });
});
