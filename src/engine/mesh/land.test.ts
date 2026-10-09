/**
 * The chart mesh as the router's land (land.ts): points, straight moves,
 * the bulk form, the index, and depth at a contour corner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshLand } from './land';
import { fromMeshXY, type LoadedMesh, M_PER_DEG_MESH, NO_HAZARD, NO_VALUE } from './store';

/**
 * A W × H grid of unit squares (side `side` metres), each split on its
 * rising diagonal into a lower triangle (id (cy*W+cx)*2) and an upper one
 * (+1), with neighbours and reverse edges, in the metres frame with cl = 1.
 */
function gridMesh(W: number, H: number, side: number): LoadedMesh {
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
      m.x[t * 3 + k] = pts[k][0] * side;
      m.y[t * 3 + k] = pts[k][1] * side;
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

/** lon/lat of a point given in grid units. */
function ll(m: LoadedMesh, gx: number, gy: number, side: number): [number, number] {
  return fromMeshXY(m, gx * side, gy * side);
}

test('MeshLand: points and moves against blocked triangles, the mesh edge, and the index', () => {
  // 10 × 10 squares of 100 m; column 5 (both triangles of every square) blocked: a wall from y = 0 to 10,
  // except the square at row 7, which is open (a 100 m gap).
  const side = 100;
  const m = gridMesh(10, 10, side);
  const blocked = new Uint8Array(m.n);
  for (let cy = 0; cy < 10; cy++) {
    if (cy === 7) continue;
    blocked[(cy * 10 + 5) * 2] = 1;
    blocked[(cy * 10 + 5) * 2 + 1] = 1;
  }
  const land = new MeshLand(m, blocked, 250);
  assert.ok(land.indexBytes() > 0);
  // Points.
  assert.equal(land.isLand(...ll(m, 2.5, 2.5, side)), false);
  assert.equal(land.isLand(...ll(m, 5.5, 2.5, side)), true, 'in the wall');
  assert.equal(land.isLand(...ll(m, 5.5, 7.5, side)), false, 'in the gap');
  assert.equal(land.isLand(...ll(m, 12, 2, side)), true, 'outside the mesh');
  assert.equal(land.isLandExact(...ll(m, 5.5, 2.5, side)), true);
  // Moves.
  const cross = (x0: number, y0: number, x1: number, y1: number): boolean =>
    land.legCrossesLandExact(...ll(m, x0, y0, side), ...ll(m, x1, y1, side));
  assert.equal(cross(2.5, 2.5, 8.5, 2.5), true, 'through the wall');
  assert.equal(cross(2.5, 7.5, 8.5, 7.5), false, 'through the gap');
  assert.equal(cross(2.5, 2.5, 4.5, 2.5), false, 'short of the wall');
  assert.equal(cross(2.5, 2.5, 2.5, 8.5), false, 'along the wall, west of it');
  assert.equal(cross(2.5, 2.5, 4.5, 8.5), false, 'a diagonal west of the wall');
  assert.equal(cross(2.5, 8.5, 8.5, 6.5), false, 'a diagonal that threads the gap');
  assert.equal(cross(2.5, 9.5, 8.5, 3.5), true, 'a diagonal into the wall below the gap');
  assert.equal(cross(2.5, 2.5, 12, 2.5), true, 'off the mesh');
  assert.equal(cross(2.5, 2.5, 2.5, 2.5), false, 'no move');
  // Bulk.
  const a = ll(m, 2.5, 2.5, side);
  const b = ll(m, 8.5, 2.5, side);
  const c = ll(m, 4.5, 2.5, side);
  assert.deepEqual(Array.from(land.legsCrossLandBulk([a[0], a[0]], [a[1], a[1]], [b[0], c[0]], [b[1], c[1]])), [1, 0]);
  // Every triangle is found by the index exactly where store.ts locate would find it (the point's own square).
  for (let cy = 0; cy < 10; cy++)
    for (let cx = 0; cx < 10; cx++) {
      const [px, py] = [(cx + 0.75) * side, (cy + 0.25) * side]; // in the lower triangle
      assert.equal(land.locate(px, py), (cy * 10 + cx) * 2, `lower of ${cx},${cy}`);
      const [qx, qy] = [(cx + 0.25) * side, (cy + 0.75) * side]; // in the upper triangle
      assert.equal(land.locate(qx, qy), (cy * 10 + cx) * 2 + 1, `upper of ${cx},${cy}`);
    }
});

test('MeshLand: depth at a contour corner reports the usable side; a blocked point reports its own triangle when nothing usable holds it', () => {
  const side = 100;
  const m = gridMesh(2, 1, side);
  // Square 0: lower 1.5 m (blocked), upper 8 m; square 1: both 12 m.
  m.depth.set([1.5, 8, 12, 12]);
  const blocked = Uint8Array.of(1, 0, 0, 0);
  const land = new MeshLand(m, blocked, 250);
  // On the shared diagonal of square 0: locate (first met) gives the blocked lower triangle; preferUsable gives the upper.
  const [dx, dy] = [50, 50];
  assert.equal(land.locate(dx, dy), 0);
  assert.equal(land.locate(dx, dy, true), 1);
  assert.equal(land.depthAt(...fromMeshXY(m, dx, dy)), 8);
  assert.equal(land.depthAt(...fromMeshXY(m, 75, 25)), 1.5, 'inside the blocked triangle, nothing usable holds the point');
  assert.equal(land.depthAt(...fromMeshXY(m, 150, 50)), 12);
  assert.equal(land.depthAt(...fromMeshXY(m, 500, 500)), null, 'outside the mesh');
  m.depth[2] = NO_VALUE;
  assert.equal(land.depthAt(...fromMeshXY(m, 175, 25)), null, 'no charted depth');
  // A move that starts on the contour and runs into the usable side is clear; one into the blocked side is not.
  const a = fromMeshXY(m, dx, dy);
  const up = fromMeshXY(m, 25, 75);
  const down = fromMeshXY(m, 75, 25);
  assert.equal(land.legCrossesLandExact(a[0], a[1], up[0], up[1]), false);
  assert.equal(land.legCrossesLandExact(a[0], a[1], down[0], down[1]), true);
  void M_PER_DEG_MESH;
});
