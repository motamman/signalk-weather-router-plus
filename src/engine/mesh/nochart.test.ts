/**
 * A tile without chart data (every triangle of unknown depth) is left out of the mesh as read (store.ts MeshStore.open):
 * not covered, not located, not mesh water for the coastline search, and a side facing it is the mesh's outer edge,
 * where a leg may change between the mesh and open water. The set is kept beside index.json (NOCHART_FILE).
 * Fixture: two 1° tiles side by side (fixture.ts writeGridMesh), A at (0,0) charted, B at (1,0) with no charted depth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LandMask } from '../../geo/landmask';
import { emptyMask, forEachEdgeSide, markMeshWater } from './exit';
import { writeGridMesh } from './fixture';
import { PagedMesh } from './paged';
import { meshRoute } from './route';
import { MeshStore, NOCHART_FILE, NO_VALUE } from './store';

const RULES = { draughtM: 2, airDraftM: 18, motorSpeedMs: 1 };

function withMesh(fn: (dir: string) => void): void {
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-nochart-')), [
    { i: 0, j: 0 },
    { i: 1, j: 0, depth: NO_VALUE },
  ]);
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('no chart data: the tile is left out; it is not covered or located, and the side facing it has no neighbour', () => {
  withMesh(dir => {
    const store = MeshStore.open(dir);
    assert.equal(store.tilesWithoutCharts, 1);
    assert.deepEqual(
      store.index.tiles.map(t => t.file),
      ['t_0_0.bin']
    );
    assert.ok(store.covers(0.5, 0.5));
    assert.ok(!store.covers(1.5, 0.5), 'no chart data: not covered');
    // A's lower triangle's right edge (k = 1) faced B's upper triangle (id 3): now the outer edge.
    const m = store.load({ west: 0, south: 0, east: 2, north: 1 });
    assert.equal(m.n, 2);
    assert.equal(m.neighbours[1], -1);
    const pm = new PagedMesh(store, RULES, 1, null);
    assert.ok(pm.locate(...pm.toXY(0.75, 0.25)) >= 0);
    assert.equal(pm.locate(...pm.toXY(1.5, 0.5)), -1);
    assert.deepEqual(pm.locateAll(...pm.toXY(1.5, 0.5)), []);
    // The search stops at the edge: the far end is in no mesh triangle.
    const r = meshRoute(store, [0.75, 0.25], [1.5, 0.5], RULES);
    assert.ok(!r.ok && /end point is not in a mesh triangle/.test(r.reason));
  });
});

test('no chart data: not mesh water for the coastline search, and the side facing it is a joining point', () => {
  withMesh(dir => {
    const store = MeshStore.open(dir);
    const land = LandMask.fromPolygons([], { west: -0.5, south: -0.5, east: 2.5, north: 1.5 }, 0.1);
    const mask = emptyMask(land);
    markMeshWater(store, mask);
    const marked = (lon: number, lat: number): number =>
      mask.cells[
        Math.floor((lat - mask.bbox.south) / mask.resolutionDeg) * mask.nx + Math.floor((lon - mask.bbox.west) / mask.resolutionDeg)
      ];
    assert.equal(marked(0.55, 0.45), 1, 'the charted tile is mesh water');
    assert.equal(marked(1.55, 0.45), 0, 'the tile without chart data is not');
    const pm = new PagedMesh(store, RULES, 1, null);
    const atSeam: number[] = [];
    forEachEdgeSide(pm, mask, (_g, mx, my, cell) => {
      const [lon] = pm.fromXY(mx, my);
      if (Math.abs(lon - 1) < 1e-9) atSeam.push(cell);
    });
    assert.equal(atSeam.length, 1, "A's side at lon 1 is an outer side");
    assert.ok(atSeam[0] >= 0 && mask.cells[atSeam[0]] === 0, 'its outside lies in water that is not mesh water');
  });
});

test('no chart data: the set is kept beside index.json, reused while index.json is the same and found again when it changes', () => {
  withMesh(dir => {
    const file = path.join(dir, NOCHART_FILE);
    const idx = path.join(dir, 'index.json');
    assert.equal(MeshStore.open(dir).tilesWithoutCharts, 1);
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(kept.files, ['t_1_0.bin']);
    // index.json at a date this process has not seen, and a kept set written for it naming no tile: the set is used
    // as it stands, not scanned again (both tiles stay in).
    const st = fs.statSync(idx);
    fs.utimesSync(idx, st.atime, new Date(st.mtimeMs + 10_000));
    const t2 = fs.statSync(idx).mtimeMs;
    fs.writeFileSync(file, JSON.stringify({ ...kept, indexMtimeMs: t2, files: [] }));
    assert.equal(MeshStore.open(dir).tilesWithoutCharts, 0, 'the kept set is reused');
    // index.json changes again: the kept set (for the date before) is stale; the tiles are scanned and the set written anew.
    fs.utimesSync(idx, st.atime, new Date(st.mtimeMs + 20_000));
    const t3 = fs.statSync(idx).mtimeMs;
    assert.equal(MeshStore.open(dir).tilesWithoutCharts, 1, 'index.json changed: found again');
    const again = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(again.indexMtimeMs, t3);
    assert.deepEqual(again.files, ['t_1_0.bin']);
  });
});
