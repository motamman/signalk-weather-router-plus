/**
 * The mesh router on a small synthetic mesh: a 4 × 3 strip of squares
 * split into triangles, one column blocked except its top row, so the
 * route has to go round. Checks the funnel on hand-made portals, the
 * search's choice of the open passage, the blocking rules and the tile
 * reader (a tile written in the on-disk format, read back and joined).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { funnel, type XY } from './funnel';
import { meshAstar } from './astar';
import { blockedTriangles, meshRoute } from './route';
import { MAX_SCAN_M, passageWidths } from './width';
import {
  FLAG_CHANNEL_MARK,
  FLAG_DREDGED,
  FLAG_HAZARD,
  FLAG_MARK,
  FLAG_NAVIGABLE,
  FLAG_STRUCTURE,
  HAZARD_DEPTH_UNKNOWN,
  type LoadedMesh,
  M_PER_DEG_MESH,
  MeshStore,
  NO_HAZARD,
  NO_VALUE,
} from './store';

/**
 * A W × H grid of unit squares, each split along its diagonal into two
 * counter-clockwise triangles (lower: (x,y) (x+1,y) (x+1,y+1); upper:
 * (x,y) (x+1,y+1) (x,y+1)), with neighbours and reverse edges, in a
 * metres frame with cl = 1.
 */
function gridMesh(W: number, H: number): LoadedMesh {
  const n = W * H * 2;
  const m: LoadedMesh = {
    n,
    x: new Float64Array(n * 3),
    y: new Float64Array(n * 3),
    cl: 1,
    neighbours: new Int32Array(n * 3).fill(-1),
    rev: new Int8Array(n * 3).fill(-1),
    mult: new Float32Array(n).fill(1),
    depth: new Float32Array(n).fill(NO_VALUE),
    clear: new Float32Array(n).fill(NO_VALUE),
    hazv: new Float32Array(n).fill(NO_HAZARD),
    flags: new Uint8Array(n),
    tiles: [],
  };
  const lower = (cx: number, cy: number): number => (cy * W + cx) * 2;
  const upper = (cx: number, cy: number): number => (cy * W + cx) * 2 + 1;
  const set = (t: number, pts: [number, number][]): void => {
    for (let k = 0; k < 3; k++) {
      m.x[t * 3 + k] = pts[k][0];
      m.y[t * 3 + k] = pts[k][1];
    }
  };
  const link = (a: number, ka: number, b: number, kb: number): void => {
    m.neighbours[a * 3 + ka] = b;
    m.rev[a * 3 + ka] = kb;
    m.neighbours[b * 3 + kb] = a;
    m.rev[b * 3 + kb] = ka;
  };
  for (let cy = 0; cy < H; cy++)
    for (let cx = 0; cx < W; cx++) {
      const lo = lower(cx, cy);
      const up = upper(cx, cy);
      // lower: edge 0 bottom, edge 1 right, edge 2 diagonal; upper: edge 0 diagonal, edge 1 top, edge 2 left.
      set(lo, [
        [cx, cy],
        [cx + 1, cy],
        [cx + 1, cy + 1],
      ]);
      set(up, [
        [cx, cy],
        [cx + 1, cy + 1],
        [cx, cy + 1],
      ]);
      link(lo, 2, up, 0);
      if (cx > 0) link(up, 2, lower(cx - 1, cy), 1);
      if (cy > 0) link(lo, 0, upper(cx, cy - 1), 1);
    }
  return m;
}

test('funnel pulls the string tight through a bent corridor', () => {
  // Portals along a corridor that turns a corner at (2, 2): the shortest path is start → corner → goal.
  const portals: [XY, XY][] = [
    [
      [1, 2],
      [1, 0],
    ],
    [
      [2, 2],
      [2, 0],
    ],
    [
      [2, 2],
      [4, 0],
    ],
    [
      [2, 2],
      [4, 1],
    ],
    [
      [2, 3],
      [4, 3],
    ],
  ];
  const p = funnel(portals, [0, 1], [3, 4]);
  assert.deepEqual(p, [
    [0, 1],
    [2, 2],
    [3, 4],
  ]);
});

test('A* goes round a blocked column and the funnel straightens the path', () => {
  const W = 4;
  const H = 3;
  const m = gridMesh(W, H);
  const blocked = new Uint8Array(m.n);
  // Column 2 blocked except its top row (cy = 2): the passage is over the top.
  for (let cy = 0; cy < H - 1; cy++) {
    blocked[(cy * W + 2) * 2] = 1;
    blocked[(cy * W + 2) * 2 + 1] = 1;
  }
  const sx = 0.5;
  const sy = 0.25; // lower triangle of cell (0, 0)
  const ex = 3.5;
  const ey = 0.25; // lower triangle of cell (3, 0)
  const st = 0;
  const et = 3 * 2;
  const r = meshAstar(m, blocked, st, et, sx, sy, ex, ey, 1);
  assert.ok(r.goalNode >= 0, 'a route exists');
  // Follow the crossings back: every triangle on the way is open, and the route reaches row 2.
  let top = false;
  for (let node = r.goalNode; node >= 0; node = r.came[node]) {
    const t = Math.floor(r.via[node] / 3);
    assert.equal(blocked[t], 0);
    if (Math.floor(t / 2) >= 2 * W) top = true;
  }
  assert.ok(top, 'the route went over the blocked column');
  // The straight line is 3 m; going over the top at least reaches y = 2 and back: longer than 3 and under 3 + 2 * 2.
  assert.ok(r.goalG > 3 && r.goalG < 7, `cost ${r.goalG}`);
});

test('blocking rules: clearance, depth off a fairway, hazards, marks, structures, avoid areas', () => {
  const m = gridMesh(8, 1);
  const rules = { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 };
  m.clear[0] = 18.5; // under air draft + 1
  m.depth[1] = 2.4; // under draught + 0.5, not navigable
  m.depth[2] = 2.4;
  m.flags[2] = FLAG_NAVIGABLE; // the same depth inside a fairway passes
  m.flags[3] = FLAG_HAZARD; // no charted depth
  m.hazv[3] = HAZARD_DEPTH_UNKNOWN;
  m.flags[4] = FLAG_HAZARD;
  m.hazv[4] = 3; // a rock with 3 m over it passes
  m.flags[5] = FLAG_MARK;
  m.flags[6] = FLAG_MARK | FLAG_CHANNEL_MARK | FLAG_DREDGED; // a channel mark in a dredged area passes
  m.flags[7] = FLAG_STRUCTURE;
  const b = blockedTriangles(m, rules);
  assert.deepEqual(Array.from(b.subarray(0, 8)), [1, 1, 0, 1, 0, 1, 0, 1]);
  // An avoid area: the centroid of triangle 8 (cell 4 lower, centroid (4.67, 0.33) m) within 1 m of (4.5, 0.5) m.
  const lonPerM = 1 / M_PER_DEG_MESH;
  const b2 = blockedTriangles(m, { ...rules, avoid: [{ lon: 4.5 * lonPerM, lat: 0.5 * lonPerM, radiusM: 1 }] });
  assert.equal(b2[8], 1);
  assert.equal(b2[9], 1);
  assert.equal(b2[12], 0);
});

test('tile files: written in the on-disk format, read back, joined and routed', () => {
  // Two 1° tiles side by side, each one square split in two, sharing the vertex column at lon 1.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
  const K = 1;
  const writeTile = (file: string, first: number, tris: number[][][], nb: number[][], rev: number[][]): void => {
    const n = tris.length;
    const buf = Buffer.alloc(32 + n * (48 + 12 + 16 + 3 + 1));
    buf.write('WRPMESH1', 0, 'latin1');
    buf.writeUInt32LE(n, 8);
    let at = 32;
    for (const t of tris)
      for (const p of t)
        for (const v of p) {
          buf.writeDoubleLE(v, at);
          at += 8;
        }
    for (const t of nb)
      for (const v of t) {
        buf.writeInt32LE(v, at);
        at += 4;
      }
    for (let i = 0; i < n; i++) {
      buf.writeFloatLE(1, at); // mult
      at += 4;
    }
    for (let i = 0; i < n * 3; i++) {
      buf.writeFloatLE(NO_VALUE, at); // depth, clear, and then hazv below
      at += 4;
    }
    at -= n * 4;
    for (let i = 0; i < n; i++) {
      buf.writeFloatLE(NO_HAZARD, at);
      at += 4;
    }
    for (const t of rev)
      for (const v of t) {
        buf.writeInt8(v, at);
        at += 1;
      }
    at += n; // flags 0
    assert.equal(at, buf.length);
    fs.writeFileSync(path.join(dir, file), buf);
    void first;
  };
  // Tile A (ids 0, 1): square [0,1]×[0,1]; tile B (ids 2, 3): square [1,2]×[0,1]. A's lower triangle's right edge (k=1) meets B's upper triangle's left edge (k=2).
  writeTile(
    'a.bin',
    0,
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      [
        [0, 0],
        [1, 1],
        [0, 1],
      ],
    ],
    [
      [-1, 3, 1],
      [0, -1, -1],
    ],
    [
      [-1, 2, 0],
      [2, -1, -1],
    ]
  );
  writeTile(
    'b.bin',
    2,
    [
      [
        [1, 0],
        [2, 0],
        [2, 1],
      ],
      [
        [1, 0],
        [2, 1],
        [1, 1],
      ],
    ],
    [
      [-1, -1, 3],
      [2, -1, 0],
    ],
    [
      [-1, -1, 0],
      [2, -1, 1],
    ]
  );
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      west: 0,
      south: 0,
      east: 2,
      north: 1,
      tileDeg: 1,
      xScale: K,
      triangles: 4,
      tiles: [
        { i: 0, j: 0, file: 'a.bin', first: 0, n: 2, bbox: [0, 0, 1, 1] },
        { i: 1, j: 0, file: 'b.bin', first: 2, n: 2, bbox: [1, 0, 2, 1] },
      ],
    })
  );
  const store = MeshStore.open(dir);
  assert.ok(store.covers(0.5, 0.5));
  assert.ok(!store.covers(2.5, 0.5));
  const m = store.load({ west: 0, south: 0, east: 2, north: 1 });
  assert.equal(m.n, 4);
  assert.deepEqual(Array.from(m.neighbours), [-1, 3, 1, 0, -1, -1, -1, -1, 3, 2, -1, 0]);
  // The seam vertex (1, 0) is bit-identical in both tiles.
  assert.equal(m.x[1], m.x[6]); // triangle 0 corner 1 and triangle 2 corner 0
  const r = meshRoute(store, [0.25, 0.1], [1.75, 0.1], { draughtM: 2, airDraftM: 18, motorSpeedMs: 1 });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    assert.equal(r.path.length, 2, 'a straight line across the seam');
    assert.ok(r.stats.trianglesLoaded === 4);
  }
  // Outside the mesh: no triangle.
  const r2 = meshRoute(store, [0.25, 0.1], [2.5, 0.5], { draughtM: 2, airDraftM: 18, motorSpeedMs: 1 });
  assert.ok(!r2.ok && /end point is not in a mesh triangle/.test(r2.reason));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('passageWidths: water to each side of the track up to the first blocked triangle or the mesh edge', () => {
  // 10 × 6 m strip; rows 4 and 5 blocked over columns 3–6: a track along y = 1.5 sees 1.5 m of water to the
  // right (the bottom edge) everywhere, and to the left 4.5 m where open and 2.5 m under the blocked rows.
  const W = 10;
  const H = 6;
  const m = gridMesh(W, H);
  const blocked = new Uint8Array(m.n);
  for (const cy of [4, 5]) for (let cx = 3; cx <= 6; cx++) blocked[(cy * W + cx) * 2] = blocked[(cy * W + cx) * 2 + 1] = 1;
  const path: [number, number][] = [
    [0.5, 1.5],
    [2, 1.5],
    [5, 1.5],
    [8, 1.5],
  ];
  const startTri = 1 * W * 2 + 1; // upper triangle of cell (0, 1): holds (0.5, 1.5)
  const w = passageWidths(m, blocked, path, startTri);
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  assert.ok(near(w[0][0], 4.5) && near(w[0][1], 1.5), `point 0: ${w[0]}`);
  assert.ok(near(w[1][0], 4.5) && near(w[1][1], 1.5), `point 1: ${w[1]}`);
  assert.ok(near(w[2][0], 2.5) && near(w[2][1], 1.5), `point 2 under the blocked rows: ${w[2]}`);
  assert.ok(near(w[3][0], 4.5) && near(w[3][1], 1.5), `point 3: ${w[3]}`);
  // A very wide strip caps at MAX_SCAN_M.
  const big = gridMesh(2, 1);
  for (let k = 0; k < big.n * 3; k++) {
    big.x[k] *= 10000;
    big.y[k] *= 10000;
  }
  const wb = passageWidths(
    big,
    new Uint8Array(big.n),
    [
      [100, 100],
      [19000, 100],
    ],
    0
  );
  assert.ok(near(wb[0][0], MAX_SCAN_M) && near(wb[0][1], 100), `cap: ${wb[0]}`);
});
