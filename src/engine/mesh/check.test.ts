/**
 * The final depth check (check.ts) on a two-tile mesh on disk: tile A
 * (lon 0–1) and tile B (lon 1–2), each two triangles split along the
 * rising diagonal (fixture.ts). A route along lat 0.1 crosses A's lower
 * triangle, B's upper one (lon 1–1.1) and B's lower one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { haversineDistanceM } from '../../geo/geodesy';
import { checkRouteOnMeshes, type CheckRules } from './check';
import { writeTwoTileMesh } from './fixture';
import { FLAG_NAVIGABLE, MeshStore, NO_VALUE } from './store';

const RULES: CheckRules = { draughtM: 2, airDraftM: 18, openingBridges: 'open' };

function withMesh(
  depths: [number, number, number, number],
  flags: [number, number, number, number] | undefined,
  fn: (store: MeshStore) => void
): void {
  const dir = writeTwoTileMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-check-')), depths, flags);
  try {
    fn(MeshStore.open(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const near = (a: number, b: number, rel = 0.01): boolean => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
const ACROSS: [number, number][] = [
  [0.25, 0.1],
  [1.75, 0.1],
];
const ACROSS_M = haversineDistanceM(0.25, 0.1, 1.75, 0.1);

test('check: a route on deep water passes; every metre is on the mesh and the shallowest depth is reported', () => {
  withMesh([10, 10, 12, 12], undefined, store => {
    const r = checkRouteOnMeshes([store], ACROSS, [0], 1, RULES);
    assert.deepEqual(r.violations, []);
    const l = r.legs[0];
    assert.ok(near(l.onMeshM, ACROSS_M), `${l.onMeshM} of ${ACROSS_M}`);
    assert.equal(l.outsideMeshM < 1, true, `${l.outsideMeshM} m outside`);
    assert.equal(l.unknownDepthM, 0);
    assert.equal(l.shallowestM, 10);
  });
});

test('check: water too shallow for the draught is a violation at the place it starts, one per run of blocked triangles', () => {
  // B is 1 m deep: one run from the seam at lon 1 to the end.
  withMesh([10, 10, 1, 1], undefined, store => {
    const r = checkRouteOnMeshes([store], ACROSS, [0], 1, RULES);
    assert.equal(r.violations.length, 1, JSON.stringify(r.violations));
    const v = r.violations[0];
    assert.equal(v.kind, 'depth');
    assert.equal(v.value, 1);
    assert.equal(v.leg, 0);
    assert.equal(v.segment, 0);
    assert.ok(Math.abs(v.lon - 1) < 1e-3 && Math.abs(v.lat - 0.1) < 1e-9, `${v.lat}, ${v.lon}`);
  });
  // The same crossing as three segments: the violation names the segment it is on.
  withMesh([10, 10, 1, 1], undefined, store => {
    const path: [number, number][] = [
      [0.25, 0.1],
      [0.75, 0.1],
      [1.25, 0.1],
      [1.75, 0.1],
    ];
    const r = checkRouteOnMeshes([store], path, [0, 0, 0], 1, RULES);
    assert.deepEqual(
      r.violations.map(v => v.segment),
      [1]
    );
  });
  // Depths are per tile lower, upper. The lower triangles shallow, the upper deep: A's lower from the start, B's upper
  // (lon 1–1.1) deep, B's lower from lon 1.1: two runs.
  withMesh([1, 10, 1, 10], undefined, store => {
    const r = checkRouteOnMeshes([store], ACROSS, [0], 1, RULES);
    assert.deepEqual(
      r.violations.map(v => [Number(v.lon.toFixed(3)), v.kind, v.value]),
      [
        [0.25, 'depth', 1],
        [1.1, 'depth', 1],
      ]
    );
  });
  // A's lower and B's upper shallow: one run from the start across the seam to lon 1.1.
  withMesh([1, 10, 10, 1], undefined, store => {
    const r = checkRouteOnMeshes([store], ACROSS, [0], 1, RULES);
    assert.deepEqual(
      r.violations.map(v => Number(v.lon.toFixed(3))),
      [0.25]
    );
  });
});

test('check: navigable shallow water and water with no charted depth pass, as the blocking rules pass them', () => {
  withMesh([10, 10, 1, 1], [0, 0, FLAG_NAVIGABLE, FLAG_NAVIGABLE], store => {
    const r = checkRouteOnMeshes([store], ACROSS, [0], 1, RULES);
    assert.deepEqual(r.violations, []);
    assert.equal(r.legs[0].shallowestM, 1);
  });
  // No charted depth in A's lower triangle (the route's stretch in A); A's upper triangle is charted, so A has chart
  // data and stays mesh water (a tile with none is left out of the mesh, store.ts).
  withMesh([NO_VALUE, 10, 10, 10], undefined, store => {
    const r = checkRouteOnMeshes([store], ACROSS, [0], 1, RULES);
    assert.deepEqual(r.violations, []);
    const inA = haversineDistanceM(0.25, 0.1, 1, 0.1);
    assert.ok(near(r.legs[0].unknownDepthM, inA), `${r.legs[0].unknownDepthM} of ${inA}`);
    assert.equal(r.legs[0].shallowestM, 10);
  });
});

test('check: the stretch beyond the mesh is counted outside it, not judged; legs are reported apart', () => {
  withMesh([10, 10, 10, 10], undefined, store => {
    const route: [number, number][] = [
      [0.25, 0.1],
      [0.75, 0.1],
      [2.5, 0.1],
    ];
    const r = checkRouteOnMeshes([store], route, [0, 1], 2, RULES);
    assert.deepEqual(r.violations, []);
    const [a, b] = r.legs;
    assert.ok(near(a.onMeshM, haversineDistanceM(0.25, 0.1, 0.75, 0.1)), `${a.onMeshM}`);
    assert.ok(a.outsideMeshM < 1);
    assert.ok(near(b.onMeshM, haversineDistanceM(0.75, 0.1, 2, 0.1)), `${b.onMeshM}`);
    assert.ok(near(b.outsideMeshM, haversineDistanceM(2, 0.1, 2.5, 0.1), 0.02), `${b.outsideMeshM}`);
  });
});

test('check: an area to avoid blocks the triangles whose centroid lies in it', () => {
  withMesh([10, 10, 10, 10], undefined, store => {
    // B's lower triangle has its centroid at (5/3, 1/3).
    const r = checkRouteOnMeshes([store], ACROSS, [0], 1, { ...RULES, avoid: [{ lon: 5 / 3, lat: 1 / 3, radiusM: 1000 }] });
    assert.deepEqual(
      r.violations.map(v => [Number(v.lon.toFixed(3)), v.kind]),
      [[1.1, 'area to avoid']]
    );
  });
});

test('check: where two meshes overlap, a stretch either one blocks is a violation, whichever is walked first', () => {
  withMesh([10, 10, 10, 10], undefined, deep =>
    withMesh([10, 10, 1, 1], undefined, shallow => {
      for (const stores of [
        [deep, shallow],
        [shallow, deep],
      ]) {
        const r = checkRouteOnMeshes(stores, ACROSS, [0], 1, RULES);
        assert.deepEqual(
          r.violations.map(v => [Number(v.lon.toFixed(3)), v.kind, v.value]),
          [[1, 'depth', 1]]
        );
        assert.ok(near(r.legs[0].onMeshM, ACROSS_M), `${r.legs[0].onMeshM} of ${ACROSS_M}`);
      }
    })
  );
});

test('check: the under-keel clearance is the vessel margin, 0.5 m when absent', () => {
  // 2.6 m of water for a 2 m draught: clear at the default 0.5 m, too shallow at 1 m.
  withMesh([2.6, 2.6, 2.6, 2.6], undefined, store => {
    assert.deepEqual(checkRouteOnMeshes([store], ACROSS, [0], 1, RULES).violations, []);
    const deeper = checkRouteOnMeshes([store], ACROSS, [0], 1, { ...RULES, underKeelClearanceM: 1 });
    assert.equal(deeper.violations.length, 1);
    assert.equal(deeper.violations[0].kind, 'depth');
    // Depths are float32 on disk (2.6 reads 2.5999999): 0.55 m still clears.
    assert.deepEqual(checkRouteOnMeshes([store], ACROSS, [0], 1, { ...RULES, underKeelClearanceM: 0.55 }).violations, []);
  });
});
