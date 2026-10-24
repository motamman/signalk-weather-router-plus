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
  catalogEntryProblem,
  describeMesh,
  localMeshes,
  localWins,
  meshArchiveTop,
  meshArchiveUrl,
  meshClusterDirs,
  meshesToOpen,
  MeshManager,
  readMarker,
  readyMeshDirs,
  type CatalogMesh,
} from './meshes';
import { downloadWorkDir } from './mesharchive';
import { tarOf, zstd } from './tarfixture';

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

test('describeMesh, meshArchiveUrl and meshArchiveTop', () => {
  assert.equal(describeMesh(ENTRY), '40.0°N–45.8°N, 74.7°W–65.7°W · chart 2026-09-07 · mesh 2026-10-08 · 2.8 GB · 35.5 M triangles');
  // The archive is published in charts/, beside the catalogue's charts/mesh/ (as R2 has it, 2026-10-18).
  assert.equal(
    meshArchiveUrl('https://pub-x.r2.dev/US-ENC/charts/mesh/index.json', ENTRY),
    'https://pub-x.r2.dev/US-ENC/charts/01CGD_mesh.tar.zst'
  );
  assert.equal(meshArchiveTop(ENTRY), '01CGD_mesh');
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
  // A copy a swap replaced, not yet cleaned up: not a mesh of its own.
  fs.mkdirSync(path.join(store, '01CGD.old'));
  fs.writeFileSync(path.join(store, '01CGD.old', '.wrp-mesh.json'), JSON.stringify({ name: '01CGD', build_date: 'w' }));
  assert.deepEqual(readyMeshDirs(store), [
    { name: '01CGD', dirs: [one], build_date: 'x' },
    { name: '14CGD', dirs: [path.join(multi, 'w158n20'), path.join(multi, 'w145n13')], build_date: 'y' },
  ]);
  assert.deepEqual(meshClusterDirs(one), [one]);
  fs.rmSync(store, { recursive: true, force: true });
});

/**
 * A tiny published layout served over HTTP: the catalogue charts/mesh/index.json and each mesh's archive
 * charts/<D>_mesh.tar.zst, with Range requests answered as R2 answers them (206, content-range). `hold`: a promise an
 * archive's answer waits for before its body is sent (a stalled download). `holdCatalog`: the same for the catalogue
 * (a slow read); `hits` counts the catalogue requests.
 */
function serve(
  root: string,
  hold?: () => Promise<void>,
  holdCatalog?: () => Promise<void>,
  hits: { catalog: number } = { catalog: 0 }
): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent((req.url ?? '/').split('?')[0]));
      if (p.endsWith(path.join('charts', 'mesh', 'index.json'))) hits.catalog++;
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        res.writeHead(404).end();
        return;
      }
      const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
      const from = m && req.method !== 'HEAD' ? Number(m[1]) : 0;
      if (from > 0) res.writeHead(206, { 'content-length': st.size - from, 'content-range': `bytes ${from}-${st.size - 1}/${st.size}` });
      else res.writeHead(200, { 'content-length': st.size, 'accept-ranges': 'bytes' });
      const body = (): void => void fs.createReadStream(p, { start: from }).pipe(res);
      if (req.method === 'HEAD') res.end();
      else if (hold && p.endsWith('.tar.zst')) void hold().then(body);
      else if (holdCatalog && p.endsWith(path.join('charts', 'mesh', 'index.json'))) void holdCatalog().then(body);
      else body();
    });
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}/`, close: () => srv.close() });
    });
  });
}

/** Publish mesh `name` (default 01CGD) as its archive and list it in the catalogue (beside meshes already listed). */
function publish(root: string, buildDate: string, tileBytes: number, fill = 7, opts: { name?: string; omit?: string } = {}): void {
  const name = opts.name ?? '01CGD';
  const tiles = [
    { i: 1, j: 2, file: 'mesh_001_002.bin', first: 0, n: 1, bbox: [0, 0, 1, 1] },
    { i: 2, j: 2, file: 'mesh_002_002.bin', first: 1, n: 1, bbox: [1, 0, 2, 1] },
  ];
  const top = `${name}_mesh`;
  const index = JSON.stringify({ version: 1, west: 0, south: 0, east: 2, north: 1, tileDeg: 1, xScale: 1, triangles: 2, tiles });
  const tar = tarOf([
    { name: top },
    ...tiles.filter(t => t.file !== opts.omit).map(t => ({ name: `${top}/${t.file}`, data: Buffer.alloc(tileBytes, fill) })),
    { name: `${top}/index.json`, data: Buffer.from(index) },
  ]);
  fs.mkdirSync(path.join(root, 'charts', 'mesh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'charts', `${top}.tar.zst`), zstd(tar));
  const entry = {
    ...ENTRY,
    name,
    dir: `mesh/${name}/`,
    archive: `${top}.tar.zst`,
    build_date: buildDate,
    bytes: 2 * tileBytes,
    triangles: 2,
  };
  const catFile = path.join(root, 'charts', 'mesh', 'index.json');
  let meshes: CatalogMesh[] = [];
  try {
    meshes = (JSON.parse(fs.readFileSync(catFile, 'utf8')) as { meshes: CatalogMesh[] }).meshes.filter(m => m.name !== name);
  } catch {
    // first mesh
  }
  fs.writeFileSync(catFile, JSON.stringify({ version: 1, updated: buildDate, meshes: [...meshes, entry] }));
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
    assert.deepEqual(readyMeshDirs(store), [{ name: '01CGD', dirs: [path.join(store, '01CGD')], build_date: '2026-10-08T15:55:27Z' }]);
    // A newer build in the catalogue: update, then re-download replaces the copy.
    publish(root, '2026-10-09T00:00:00Z', 1200);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-09T00:00:00Z');
    assert.equal(fs.statSync(path.join(store, '01CGD', 'mesh_001_002.bin')).size, 1200);
    assert.ok(!fs.existsSync(path.join(store, '01CGD.new')) && !fs.existsSync(path.join(store, '01CGD.old')));
    assert.ok(!fs.existsSync(downloadWorkDir(store, '01CGD')), 'the archive goes once the mesh is in place');
    // A part started for another build is not resumed: its state names the old build, so the download starts over.
    const work = downloadWorkDir(store, '01CGD');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'state.json'), JSON.stringify({ url: 'x', build: '2026-10-09T00:00:00Z', size: 99, etag: null }));
    fs.writeFileSync(path.join(work, 'archive.part'), Buffer.alloc(40, 1));
    publish(root, '2026-10-10T00:00:00Z', 1300, 9);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-10T00:00:00Z');
    assert.equal(fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0], 9, 'the stale part was dropped, not resumed');
    // Unticked: removed, a leftover .old folder and a download's working folder too.
    fs.mkdirSync(path.join(store, '01CGD.old'));
    fs.mkdirSync(work);
    mgr.configure(url + 'charts/mesh/index.json', [], store);
    await mgr.reconcile();
    assert.ok(!fs.existsSync(path.join(store, '01CGD')));
    assert.ok(!fs.existsSync(path.join(store, '01CGD.old')));
    assert.ok(!fs.existsSync(work));
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

test('catalogEntryProblem: every field the plugin reads is checked', () => {
  assert.equal(catalogEntryProblem(ENTRY), null);
  const { archive: _a, ...noArchive } = ENTRY;
  assert.match(catalogEntryProblem(noArchive)!, /no archive/);
  assert.match(catalogEntryProblem({ ...ENTRY, archive: '01CGD_mesh.zip' })!, /not a \.tar\.zst/);
  // A bare file name only: no URL to another address, no path out of the catalogue's folder.
  for (const archive of ['http://127.0.0.1:8080/x.tar.zst', '../private/x.tar.zst', 'sub/x.tar.zst', '/etc/x.tar.zst', '.x.tar.zst'])
    assert.match(catalogEntryProblem({ ...ENTRY, archive })!, /no path or URL/, archive);
  assert.equal(catalogEntryProblem({ ...ENTRY, archive: '14CGD_mesh.v2.tar.zst' }), null);
  assert.match(catalogEntryProblem({ ...ENTRY, name: '../x' })!, /not letters, digits/);
  assert.match(catalogEntryProblem({ ...ENTRY, build_date: 'soon' })!, /build_date/);
  assert.match(catalogEntryProblem({ ...ENTRY, bytes: '2 GB' })!, /bytes/);
  assert.match(catalogEntryProblem({ ...ENTRY, clusters: [] })!, /no clusters/);
  assert.match(catalogEntryProblem({ ...ENTRY, clusters: [{ dir: '.', box: [1, 2, 3] }] })!, /valid box/);
  assert.equal(catalogEntryProblem({ ...ENTRY, chart_build_date: null }), null);
  assert.match(catalogEntryProblem(null)!, /not an object/);
});

test('MeshManager: an unusable catalogue row is set aside with its reason; the status still answers; the good rows download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-10T00:00:00Z', 300);
  // Add rows the plugin cannot use: no archive (an older build), no clusters, and one with no name at all.
  const catFile = path.join(root, 'charts', 'mesh', 'index.json');
  const cat = JSON.parse(fs.readFileSync(catFile, 'utf8')) as { meshes: unknown[] };
  const { archive: _a, ...noArchive } = { ...ENTRY, name: '05CGD' };
  cat.meshes.push(noArchive, { ...ENTRY, name: '07CGD', clusters: undefined }, { archive: 'x.tar.zst' });
  fs.writeFileSync(catFile, JSON.stringify(cat));
  const { url, close } = await serve(root);
  const logs: string[] = [];
  const mgr = new MeshManager(m => logs.push(m));
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD', '05CGD'], store);
    await mgr.reconcile();
    const st = mgr.status();
    assert.equal(st.catalog_error, null, 'the catalogue itself was read');
    assert.equal(st.meshes.find(r => r.name === '01CGD')!.state, 'ready');
    const noArch = st.meshes.find(r => r.name === '05CGD')!;
    assert.equal(noArch.state, 'error');
    assert.match(noArch.error!, /the catalogue entry is unusable: no archive/);
    assert.equal(noArch.description, 'the catalogue entry is unusable');
    assert.ok(!fs.existsSync(path.join(store, '05CGD')) && !fs.existsSync(downloadWorkDir(store, '05CGD')), 'not fetched');
    assert.match(st.meshes.find(r => r.name === '07CGD')!.error!, /no clusters/);
    assert.deepEqual(st.catalog_problems, ['row 4: no name']);
    assert.ok(logs.some(l => /05CGD: unusable entry \(no archive/.test(l)));
  } finally {
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

for (const order of ['unusable row first', 'unusable row after'] as const) {
  test(`MeshManager: a usable row serves its name beside an unusable row of the same name (${order})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
    publish(root, '2026-10-10T00:00:00Z', 300);
    const catFile = path.join(root, 'charts', 'mesh', 'index.json');
    const cat = JSON.parse(fs.readFileSync(catFile, 'utf8')) as { meshes: unknown[] };
    const { archive: _a, ...noArchive } = ENTRY;
    if (order === 'unusable row first') cat.meshes.unshift(noArchive);
    else cat.meshes.push(noArchive);
    fs.writeFileSync(catFile, JSON.stringify(cat));
    const { url, close } = await serve(root);
    const mgr = new MeshManager(() => {});
    try {
      mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
      await mgr.reconcile();
      const row = mgr.status().meshes.find(r => r.name === '01CGD')!;
      assert.equal(row.state, 'ready', JSON.stringify(row));
      assert.equal(row.error, null);
      assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-10T00:00:00Z');
    } finally {
      mgr.stop();
      close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
}

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

test('MeshManager.refresh: a catalogue that appears after start is listed on refresh, and the pass downloads what is ticked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  const { url, close } = await serve(root);
  const mgr = new MeshManager(() => {});
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    await mgr.reconcile();
    assert.equal(mgr.status().catalog_error, 'HTTP 404');
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'absent'); // ticked, no catalogue to fetch it from
    publish(root, '2026-10-09T06:43:40Z', 500);
    await mgr.refresh();
    const st = mgr.status();
    assert.equal(st.catalog_error, null);
    assert.equal(st.catalog_updated, '2026-10-09T06:43:40Z');
    const row = st.meshes.find(r => r.name === '01CGD')!;
    assert.ok(row.catalog_build_date === '2026-10-09T06:43:40Z', JSON.stringify(row));
    // The pass started by refresh runs on; wait for it through reconcile (shared, not doubled).
    await mgr.reconcile();
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'ready');
  } finally {
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('MeshManager.refresh: during a pass that is downloading, answers after the catalogue read, not after the download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-09T06:43:40Z', 500);
  let release: () => void = () => {};
  const held = new Promise<void>(r => (release = r));
  const { url, close } = await serve(root, () => held);
  const mgr = new MeshManager(() => {});
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    const pass = mgr.reconcile(); // reads the catalogue, then stalls on the first tile
    while (mgr.status().meshes.find(r => r.name === '01CGD')?.state !== 'downloading') await new Promise(r => setTimeout(r, 20));
    const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 5000));
    const refreshed = await Promise.race([mgr.refresh().then(() => 'read' as const), timeout]);
    assert.equal(refreshed, 'read', 'refresh waited for the running download');
    assert.equal(mgr.status().catalog_updated, '2026-10-09T06:43:40Z');
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'downloading');
    release();
    await pass;
    await mgr.reconcile(); // the pass refresh queued after it: nothing left to download
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'ready');
  } finally {
    release();
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('MeshManager.refresh: during a pass whose catalogue read is still in flight, joins that read instead of starting a second', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-09T06:43:40Z', 500);
  let release: () => void = () => {};
  const held = new Promise<void>(r => (release = r));
  const hits = { catalog: 0 };
  const { url, close } = await serve(root, undefined, () => held, hits);
  const mgr = new MeshManager(() => {});
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    const pass = mgr.reconcile(); // its catalogue read stalls on the server
    while (hits.catalog < 1) await new Promise(r => setTimeout(r, 20));
    let refreshed = false;
    const refresh = mgr.refresh().then(() => (refreshed = true));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(hits.catalog, 1, 'refresh joined the read in flight; no second request');
    assert.equal(refreshed, false, 'refresh waits for that read');
    assert.equal(mgr.status().catalog_updated, null);
    release();
    await refresh;
    const st = mgr.status();
    assert.equal(st.catalog_error, null);
    assert.equal(st.catalog_updated, '2026-10-09T06:43:40Z');
    await pass;
    await mgr.reconcile(); // the pass refresh queued after it (before `run`, on its own signal), then this one
    assert.equal(hits.catalog, 3, 'one read per pass; the refresh added none');
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'ready');
  } finally {
    release();
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('localWins: a local mesh is used over a published copy of the same name only when built at the same time or later', () => {
  assert.equal(localWins('2026-10-09T10:10:54Z', '2026-10-09T00:27:16Z'), true, 'local newer');
  assert.equal(localWins('2026-10-09T00:27:16Z', '2026-10-09T00:27:16Z'), true, 'same build');
  assert.equal(localWins('2026-10-08T00:00:00Z', '2026-10-09T00:27:16Z'), false, 'published newer');
  assert.equal(localWins(null, '2026-10-09T00:27:16Z'), false, 'local without a date loses');
  assert.equal(localWins(null, null), false);
  assert.equal(localWins('2026-10-08T00:00:00Z', null), true, 'a dated local beats an undated copy');
});

test('meshesToOpen: downloads first; where a download and a local mesh share a name, only the newer; Use off drops both', () => {
  const dl = (name: string, build_date: string | null) => ({ name, dirs: [`/store/${name}`], build_date });
  const loc = (name: string, build_date: string | null) => ({ name, dirs: [`/mine/${name}`], build_date });
  const names = (r: ReturnType<typeof meshesToOpen>) => r.map(m => `${m.source}:${m.name}`);
  // Different names: both, downloads first.
  assert.deepEqual(names(meshesToOpen([dl('01CGD', '2026-10-09T00:27:16Z')], [loc('mesh-bin', null)], [])), [
    'download:01CGD',
    'local:mesh-bin',
  ]);
  // Same name, download newer: the download only.
  assert.deepEqual(names(meshesToOpen([dl('09CGD', '2026-10-10T00:00:00Z')], [loc('09CGD', '2026-10-09T10:10:54Z')], [])), [
    'download:09CGD',
  ]);
  // Same name, local newer: the local folder only.
  assert.deepEqual(names(meshesToOpen([dl('09CGD', '2026-10-09T00:00:00Z')], [loc('09CGD', '2026-10-09T10:10:54Z')], [])), ['local:09CGD']);
  // Same name, local without a date: the download.
  assert.deepEqual(names(meshesToOpen([dl('09CGD', '2026-10-09T00:00:00Z')], [loc('09CGD', null)], [])), ['download:09CGD']);
  // Use switched off: neither copy.
  assert.deepEqual(names(meshesToOpen([dl('09CGD', '2026-10-09T00:00:00Z')], [loc('09CGD', '2026-10-09T10:10:54Z')], ['09CGD'])), []);
  // The owner's choice: "my folder" wins over a newer download; it says nothing about other names.
  assert.deepEqual(
    names(
      meshesToOpen(
        [dl('09CGD', '2026-10-10T00:00:00Z'), dl('01CGD', '2026-10-10T00:00:00Z')],
        [loc('09CGD', '2026-10-09T10:10:54Z')],
        [],
        ['09CGD']
      )
    ),
    ['download:01CGD', 'local:09CGD']
  );
  assert.deepEqual(names(meshesToOpen([dl('09CGD', '2026-10-10T00:00:00Z')], [loc('09CGD', '2026-10-09T10:10:54Z')], [], ['01CGD'])), [
    'download:09CGD',
  ]);
  // "downloaded" chosen while the folder's copy is newer: the download.
  assert.deepEqual(names(meshesToOpen([dl('09CGD', '2026-10-09T00:00:00Z')], [loc('09CGD', '2026-10-09T10:10:54Z')], [], [], ['09CGD'])), [
    'download:09CGD',
  ]);
});

test('MeshManager: a local mesh of the same name stops the download only when it is the newer; one panel row says which copy is used', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-mine-'));
  // A local 01CGD in a folder of meshes, with a sidecar giving its build date.
  fs.mkdirSync(path.join(mine, '01CGD_mesh'));
  fs.writeFileSync(
    path.join(mine, '01CGD_mesh', 'index.json'),
    JSON.stringify({ version: 1, west: 0, south: 0, east: 2, north: 1, tileDeg: 1, xScale: 1, triangles: 2, tiles: [] })
  );
  const sidecar = (build_date: string | null): void =>
    build_date === null
      ? fs.rmSync(path.join(mine, '01CGD_mesh.json'), { force: true })
      : fs.writeFileSync(path.join(mine, '01CGD_mesh.json'), JSON.stringify({ build_date }));
  publish(root, '2026-10-09T00:27:16Z', 400);
  const { url, close } = await serve(root);
  const mgr = new MeshManager(() => {});
  const row = () => {
    const rows = mgr.status().meshes.filter(r => r.name === '01CGD');
    assert.equal(rows.length, 1, `one row for the name: ${JSON.stringify(rows)}`);
    return rows[0];
  };
  try {
    // Local newer than the catalogue: no download; the row routes on the local copy.
    sidecar('2026-10-09T10:10:54Z');
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store, [], mine);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD')), null, 'not downloaded');
    assert.equal(row().using, 'local');
    assert.equal(row().local_dir, path.join(mine, '01CGD_mesh'));
    assert.equal(row().local_build_date, '2026-10-09T10:10:54Z');
    assert.equal(row().error, null);
    // A newer build published: downloaded despite the local folder, and the row routes on the download.
    publish(root, '2026-10-11T00:00:00Z', 400);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-11T00:00:00Z');
    assert.equal(row().state, 'ready');
    assert.deepEqual([row().using, row().using_why, row().copy_choice], ['download', 'newer', 'auto'], 'the download is newer');
    // The owner's choice: the folder's copy, whatever the dates; the row says so.
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store, [], mine, ['01CGD']);
    assert.deepEqual([row().using, row().using_why, row().copy_choice], ['local', 'choice', 'local']);
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store, [], mine, [], ['01CGD']);
    assert.deepEqual([row().using, row().using_why, row().copy_choice], ['download', 'choice', 'download']);
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store, [], mine);
    assert.equal(row().using, 'download');
    // A local folder without a date never stops a download nor wins.
    fs.rmSync(path.join(store, '01CGD'), { recursive: true, force: true });
    sidecar(null);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-11T00:00:00Z');
    assert.equal(row().using, 'download');
    assert.equal(row().local_build_date, null);
  } finally {
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(mine, { recursive: true, force: true });
  }
});

test('MeshManager: redownload fetches the current build afresh; cancel stops a running download; setDownloads changes the list without a restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-10T00:00:00Z', 900, 5);
  const { url, close } = await serve(root);
  const mgr = new MeshManager(() => {});
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    await mgr.reconcile();
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'ready');
    // The published files change under the same build (a corrupt or repaired tile, same size): a plain pass keeps the copy...
    publish(root, '2026-10-10T00:00:00Z', 900, 6);
    await mgr.reconcile();
    assert.equal(fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0], 5, 'same build: not fetched again');
    // ...and "Download again" fetches every file afresh and swaps the copy in.
    mgr.redownload('01CGD');
    await mgr.reconcile();
    assert.equal(fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0], 6, 'fetched afresh');
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-10T00:00:00Z');
    // "Download again" fetches even when the folder's copy is newer than the published build...
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-mine-'));
    fs.mkdirSync(path.join(mine, '01CGD_mesh'));
    fs.writeFileSync(
      path.join(mine, '01CGD_mesh', 'index.json'),
      JSON.stringify({ version: 1, west: 0, south: 0, east: 2, north: 1, tileDeg: 1, xScale: 1, triangles: 2, tiles: [] })
    );
    fs.writeFileSync(path.join(mine, '01CGD_mesh.json'), JSON.stringify({ build_date: '2026-10-11T00:00:00Z' }));
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store, [], mine);
    publish(root, '2026-10-10T00:00:00Z', 900, 7);
    mgr.redownload('01CGD');
    await mgr.reconcile();
    assert.equal(fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0], 7, 'fetched despite the newer folder copy');
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    // ...and a fresh request that fails (a tile the index lists missing from the archive) stands until a pass succeeds.
    publish(root, '2026-10-10T00:00:00Z', 900, 8, { omit: 'mesh_002_002.bin' });
    mgr.redownload('01CGD');
    await mgr.reconcile();
    const failed = mgr.status().meshes.find(r => r.name === '01CGD')!;
    assert.equal(failed.state, 'error', 'the fresh fetch failed');
    assert.match(failed.error!, /mesh_002_002\.bin: listed in the index, missing from the archive/);
    assert.equal(fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0], 7, 'the served copy is untouched');
    publish(root, '2026-10-10T00:00:00Z', 900, 8);
    await mgr.reconcile();
    assert.equal(fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0], 8, 'retried at the next pass');
    // cancel: only a download of that mesh is stopped.
    assert.equal(mgr.cancel('01CGD'), false, 'nothing running');
    // setDownloads: the list alone; the next pass removes what is no longer listed.
    mgr.setDownloads([]);
    await mgr.reconcile();
    assert.ok(!fs.existsSync(path.join(store, '01CGD')));
  } finally {
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('MeshManager: a list change while the loop is downloading is applied by one more pass straight after', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-10T00:00:00Z', 600);
  // Tiles are served only once released, so the loop's first pass sits in its download while the list changes.
  let release: () => void = () => {};
  const gate = new Promise<void>(r => (release = r));
  const { url, close } = await serve(root, () => gate);
  const mgr = new MeshManager(() => {});
  const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(ok(), what);
  };
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    mgr.run();
    await until(() => mgr.status().meshes.some(r => r.name === '01CGD' && r.state === 'downloading'), 'the loop is downloading');
    // The panel removes the mesh while that download runs: the list changes, the refresh joins the running pass.
    mgr.setDownloads([]);
    const refreshed = mgr.refresh();
    release();
    await refreshed;
    await until(
      () => !fs.existsSync(path.join(store, '01CGD')) && !fs.existsSync(path.join(store, '01CGD.new')),
      'the follow-up pass removed the copy the first pass had just finished'
    );
  } finally {
    release();
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('MeshManager: Download or Update pressed fetches past a newer copy in the folder; a daily pass does not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-mine-'));
  fs.mkdirSync(path.join(mine, '01CGD_mesh'));
  fs.writeFileSync(
    path.join(mine, '01CGD_mesh', 'index.json'),
    JSON.stringify({ version: 1, west: 0, south: 0, east: 2, north: 1, tileDeg: 1, xScale: 1, triangles: 2, tiles: [] })
  );
  fs.writeFileSync(path.join(mine, '01CGD_mesh.json'), JSON.stringify({ build_date: '2026-10-12T00:00:00Z' }));
  publish(root, '2026-10-10T00:00:00Z', 500);
  const { url, close } = await serve(root);
  const mgr = new MeshManager(() => {});
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store, [], mine);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD')), null, 'the daily pass leaves a newer folder copy alone');
    mgr.request('01CGD'); // the panel's Download
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-10T00:00:00Z', 'pressed: fetched');
    // The request is spent: a later pass with a newer published build still defers to the newer folder copy.
    publish(root, '2026-10-11T00:00:00Z', 500);
    await mgr.reconcile();
    assert.equal(readMarker(path.join(store, '01CGD'))!.build_date, '2026-10-10T00:00:00Z');
  } finally {
    mgr.stop();
    close();
    for (const d of [root, store, mine]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('MeshManager: two meshes download at the same time, a third waits for one of them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  for (const name of ['01CGD', '05CGD', '07CGD']) publish(root, '2026-10-10T00:00:00Z', 300, 7, { name });
  let release: () => void = () => {};
  const gate = new Promise<void>(r => (release = r));
  const { url, close } = await serve(root, () => gate);
  const mgr = new MeshManager(() => {});
  const downloading = (): string[] =>
    mgr
      .status()
      .meshes.filter(r => r.state === 'downloading')
      .map(r => r.name);
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD', '05CGD', '07CGD'], store);
    const pass = mgr.reconcile();
    for (let i = 0; i < 200 && downloading().length < 2; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(downloading(), ['01CGD', '05CGD'], 'two at once, the third waiting');
    release();
    await pass;
    assert.deepEqual(
      mgr.status().meshes.map(r => [r.name, r.state]),
      [
        ['01CGD', 'ready'],
        ['05CGD', 'ready'],
        ['07CGD', 'ready'],
      ]
    );
  } finally {
    release();
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('MeshManager: a Download again pressed while that mesh is downloading is kept for the next pass', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-10T00:00:00Z', 500, 3);
  let release: () => void = () => {};
  const gate = new Promise<void>(r => (release = r));
  let holds = 0;
  const { url, close } = await serve(root, () => (++holds <= 2 ? gate : Promise.resolve()));
  const mgr = new MeshManager(() => {});
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    mgr.redownload('01CGD');
    const pass = mgr.reconcile(); // the fetch sits on the first tiles
    while (holds < 1) await new Promise(r => setTimeout(r, 20));
    publish(root, '2026-10-10T00:00:00Z', 500, 4); // the files change on the server, same build
    mgr.redownload('01CGD'); // pressed again while downloading
    release();
    await pass;
    const got = fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0];
    await mgr.reconcile();
    assert.equal(
      fs.readFileSync(path.join(store, '01CGD', 'mesh_001_002.bin'))[0],
      4,
      `the second request fetched afresh (first pass got ${got})`
    );
    await mgr.reconcile();
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'ready');
  } finally {
    release();
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('MeshManager.run: while the internet state holds downloads the daily pass waits; the panel refresh still reads the catalogue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-09T06:43:40Z', 500);
  const hits = { catalog: 0 };
  const { url, close } = await serve(root, undefined, undefined, hits);
  const logs: string[] = [];
  const mgr = new MeshManager(
    m => logs.push(m),
    () => undefined,
    { active: true, holdNow: async () => 'the internet connection is metered (network.internet.state)' }
  );
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    mgr.run();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(hits.catalog, 0, 'the catalogue is not read');
    assert.ok(!fs.existsSync(path.join(store, '01CGD')), 'nothing is downloaded');
    assert.ok(logs.some(l => /wait: the internet connection is metered/.test(l)));
    await mgr.refresh();
    assert.equal(hits.catalog, 1, 'Read the catalogue now is the owner asking: it reads');
  } finally {
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('MeshManager.run: a daily pass stops when the internet state starts holding mid-download; a refresh by the owner still downloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshsrv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meshstore-'));
  publish(root, '2026-10-09T06:43:40Z', 500);
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let archives = 0;
  const { url, close } = await serve(root, () => (++archives === 1 ? gate : Promise.resolve()));
  let state: string | null = null;
  const mgr = new MeshManager(
    () => undefined,
    () => undefined,
    { active: true, holdNow: async () => state }
  );
  (mgr as unknown as { holdCheckMs: number }).holdCheckMs = 20;
  try {
    mgr.configure(url + 'charts/mesh/index.json', ['01CGD'], store);
    mgr.run();
    while (archives < 1) await new Promise(r => setTimeout(r, 10));
    state = 'the internet connection is metered (network.internet.state)';
    await new Promise(r => setTimeout(r, 200));
    release();
    await new Promise(r => setTimeout(r, 200));
    assert.notEqual(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'ready', 'the held pass did not finish the download');
    // The owner asks: the pass runs whatever the state.
    await mgr.refresh();
    await mgr.reconcile();
    assert.equal(mgr.status().meshes.find(r => r.name === '01CGD')!.state, 'ready');
  } finally {
    release();
    mgr.stop();
    close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});
