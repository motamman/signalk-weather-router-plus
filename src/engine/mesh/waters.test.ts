/**
 * A leg across the limits of the charts (waters.ts, part 5), on meshes of 1° tiles written to disk (fixture.ts), each
 * with its rough cut and its joins to the others built as the plugin builds them (coarse.ts buildCoarseMap with
 * joins.ts JoinFinder on each tile), and coastline land made of rectangles: one mesh holding the leg, open water
 * joining its ends, a leg leaving the charts, entering them, leaving and entering again (out-in-out, in-out-in), from
 * one district's mesh to another's in their overlap or across open water between them, through a third, two ways
 * that tie, an area to avoid over the overlap, and the legs that cannot be made.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ShapePolygon } from '../../geo/shapefile';
import { cellOf, LandMask, moveMeetsCells } from '../../geo/landmask';
import { DEG } from '../../geo/geodesy';
import { M_PER_DEG } from '../../geo/units';
import { emptyMask } from './exit';
import { boundarySeeds, buildCoarseMap, type CoarseMap, type CoarseRules, meshRulesOf, tilePieces } from './coarse';
import { writeGridMesh } from './fixture';
import { JoinFinder } from './joins';
import { type BoundarySeeds, PagedMesh } from './paged';
import type { MeshRules } from './route';
import { MeshStore } from './store';
import { planWaters, waterField, type WaterMesh, type WatersPlan } from './waters';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber,
    minLon: lon0,
    minLat: lat0,
    maxLon: lon1,
    maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}

const RULES: MeshRules = { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 };
const COARSE: CoarseRules = {
  draughtM: 2,
  airDraftM: 18,
  underKeelClearanceM: 0.5,
  overheadClearanceM: 1,
  bufferM: 0,
  openingBridges: 'open',
};
const BOX = { west: -1, south: -1, east: 7, north: 3 };
const NAMES = { start: 'the start', end: 'the end' };
type Cells = { i: number; j: number; depth?: number }[];

/** Cells of lon i0 … i1 - 1, lat j0 … j1 - 1, 10 m deep unless `depth` says otherwise. */
function cells(i0: number, i1: number, j0 = 0, j1 = 1, depth: (i: number, j: number) => number = () => 10): Cells {
  const out: Cells = [];
  for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) out.push({ i, j, depth: depth(i, j) });
  return out;
}

/** Each mesh's rough cut and its joins to every other, as the build makes them (piece numbers per tile). */
function prepare(stores: MeshStore[]): WaterMesh[] {
  const built: { map: CoarseMap; boundary: BoundarySeeds }[] = stores.map(store => {
    const boundary = boundarySeeds(store, COARSE);
    return { map: buildCoarseMap(store, COARSE, new PagedMesh(store, meshRulesOf(COARSE), 1, boundary)), boundary };
  });
  return stores.map((store, i) => {
    const joins: WaterMesh['joins'] = [];
    stores.forEach((other, j) => {
      if (i === j) return;
      const pa = new PagedMesh(store, meshRulesOf(COARSE), 1, built[i].boundary);
      const pb = new PagedMesh(other, meshRulesOf(COARSE), 1, built[j].boundary);
      const finder = new JoinFinder({ store, pm: pa }, { store: other, pm: pb });
      const out: number[] = [];
      const seen = new Set<string>();
      const local = (pm: PagedMesh, t: number): [number, number] => {
        const T = pm.tileOf(t);
        return [T.idx, tilePieces(T).pieceOf[t - T.first]];
      };
      for (let idx = 0; idx < pa.tileCount; idx++) {
        const T = pa.tile(idx);
        if (finder.meetsB(T.bbox))
          finder.scanTile(T, (a, u) => {
            const k = [...local(pa, a), ...local(pb, u)];
            if (!seen.has(k.join())) {
              seen.add(k.join());
              out.push(...k);
            }
          });
      }
      if (out.length) joins.push({ to: j, data: Int32Array.from(out) });
    });
    return { store, map: built[i].map, boundary: built[i].boundary, joins, name: 'ABC'[i] };
  });
}

/** Plan a leg on these meshes over land made of these rectangles. */
function plan(
  meshes: Cells[],
  land: [number, number, number, number][],
  start: [number, number],
  end: [number, number],
  rules: MeshRules = RULES
): WatersPlan {
  const dirs = meshes.map(c => writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-waters-')), c));
  try {
    const ms = prepare(dirs.map(d => MeshStore.open(d)));
    const mask = LandMask.fromPolygons(
      land.map((r, k) => rect(k + 1, ...r)),
      BOX,
      0.05
    );
    return planWaters(ms, rules, '', () => mask, start, end, NAMES);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

const kinds = (r: WatersPlan): string[] =>
  r.ok && r.kind === 'chain' ? r.stretches.map(s => (s.kind === 'mesh' ? `mesh ${'ABC'[s.mesh]}` : 'open')) : [];
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

test('planWaters: both ends in one connected water of one mesh: the leg is that mesh alone, no raster built', () => {
  const r = plan([cells(0, 3)], [], [0.5, 0.5], [2.5, 0.5]);
  assert.deepEqual(r, { ok: true, kind: 'one-mesh', mesh: 0 });
});

test('planWaters: in-out: on the mesh to its edge facing the open water that reaches the end, never a shoreline', () => {
  // Land south (lat < 0), west (lon < 0) and north of the mesh: only its east edge meets open water.
  const r = plan(
    [cells(0, 2)],
    [
      [-1, -1, 7, 0],
      [-1, -1, 0, 3],
      [-1, 1, 2, 3],
    ],
    [0.5, 0.5],
    [3.5, 0.5]
  );
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.deepEqual(kinds(r), ['mesh A', 'open']);
  const exit = r.stretches[0].to;
  assert.ok(near(exit[0], 2) && exit[1] > 0 && exit[1] < 1, `leaves through the east edge: ${exit}`);
  assert.deepEqual(r.stretches[1].from, exit);
  assert.equal(r.changes, 1);
  assert.equal(moveMeetsCells(r.mask!, 1.5, 0.3, 1.5, 0.7), true, "the mesh's water is land to the coastline part");
  assert.equal(moveMeetsCells(r.mask!, 3, 0.5, 4, 0.5), false, 'beyond it is not');
});

test('planWaters: open water joining the ends outside every mesh: the coastline search, the charts as land', () => {
  const r = plan([cells(2, 3)], [], [0.5, 0.5], [5.5, 0.5]);
  assert.equal(r.ok && r.kind, 'open');
  if (r.ok && r.kind === 'open') assert.equal(moveMeetsCells(r.mask!, 2.3, 0.5, 2.7, 0.5), true);
});

test('planWaters: out-in-out: open water on either side of the charts, joined only through them', () => {
  // The mesh spans the channel (lat 0–2) at lon 2–3; land north and south: the seas west and east meet only through it.
  const r = plan(
    [cells(2, 3, 0, 2)],
    [
      [-1, -1, 7, 0],
      [-1, 2, 7, 3],
    ],
    [0.5, 1],
    [5.5, 1]
  );
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.deepEqual(kinds(r), ['open', 'mesh A', 'open']);
  assert.ok(near(r.stretches[1].from[0], 2), `enters at the west edge: ${r.stretches[1].from}`);
  assert.ok(near(r.stretches[1].to[0], 3), `leaves at the east edge: ${r.stretches[1].to}`);
  assert.equal(r.changes, 2);
});

test('planWaters: in-out-in: two waters of one mesh that only open water joins', () => {
  // A row of three cells, the middle 1 m deep; open water north of the row (lat 1–2) joins the ends; land elsewhere.
  const r = plan(
    [cells(0, 3, 0, 1, i => (i === 1 ? 1 : 10))],
    [
      [-1, -1, 7, 0],
      [-1, -1, 0, 3],
      [3, -1, 7, 3],
      [-1, 2, 7, 3],
    ],
    [0.5, 0.5],
    [2.5, 0.5]
  );
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.deepEqual(kinds(r), ['mesh A', 'open', 'mesh A']);
  const [out, , back] = r.stretches;
  assert.ok(near(out.to[1], 1) && out.to[0] < 1, `leaves the first water through its north edge: ${out.to}`);
  assert.ok(near(back.from[1], 1) && back.from[0] > 2, `enters the second through its north edge: ${back.from}`);
});

test('planWaters: from one mesh to another in their overlap, on water both call usable, no open water', () => {
  // A over lon 0–3, B over lon 2–5, both lat 0–2; land all round. B charts the overlap's southern cell at 1 m.
  const r = plan([cells(0, 3, 0, 2), cells(2, 5, 0, 2, (i, j) => (i === 2 && j === 0 ? 1 : 10))], [[-1, -1, 7, 3]], [0.5, 0.5], [4.5, 0.5]);
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.deepEqual(kinds(r), ['mesh A', 'mesh B']);
  const t = r.stretches[0].to;
  assert.ok(t[0] > 2 && t[0] < 3 && t[1] > 1 && t[1] < 2, `in the overlap's northern cell, which both call usable: ${t}`);
  assert.deepEqual(r.stretches[1].from, t);
  assert.equal(r.changes, 0);
  assert.equal(r.transfers, 1);
  assert.equal(r.mask, null, 'on the charts the whole way: no open-water map built');
});

test('planWaters: from one mesh to another across open water between them', () => {
  // A over lon 0–2, B over lon 3–6; open water between (lon 2–3); land north, south, west and east.
  const r = plan(
    [cells(0, 2), cells(3, 6)],
    [
      [-1, -1, 7, 0],
      [-1, 1, 7, 3],
      [-1, -1, 0, 3],
      [6, -1, 7, 3],
    ],
    [0.5, 0.5],
    [5.5, 0.5]
  );
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.deepEqual(kinds(r), ['mesh A', 'open', 'mesh B']);
  assert.ok(near(r.stretches[0].to[0], 2), `out of A at its east edge: ${r.stretches[0].to}`);
  assert.ok(near(r.stretches[2].from[0], 3), `into B at its west edge: ${r.stretches[2].from}`);
  assert.equal(moveMeetsCells(r.mask!, 4.5, 0.3, 4.5, 0.7), true, "B's water is land to the coastline part");
  assert.equal(moveMeetsCells(r.mask!, 2.3, 0.5, 2.7, 0.5), false, 'the water between is not');
});

test('planWaters: through a third mesh between two others, district to district', () => {
  // A lon 0–2, B lon 1–4, C lon 3–6, all lat 0–1, land all round: A and C meet only through B.
  const r = plan([cells(0, 2), cells(1, 4), cells(3, 6)], [[-1, -1, 7, 3]], [0.5, 0.5], [5.5, 0.5]);
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (r.ok && r.kind === 'chain') assert.deepEqual(kinds(r), ['mesh A', 'mesh B', 'mesh C']);
});

test('planWaters: of the ways with as few changes, the ones with fewest transfers: no detour through a third mesh', () => {
  // A lon 0–3, B lon 1–4, C lon 2–5, all lat 0–1, land all round: A joins C directly, and through B. Every way is on
  // the charts (no change); A → C has one transfer, A → B → C two (PR #39 review: both tied and both were planned).
  const r = plan([cells(0, 3), cells(1, 4), cells(2, 5)], [[-1, -1, 7, 3]], [0.5, 0.5], [4.5, 0.5]);
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.equal(r.changes, 0);
  assert.equal(r.ways, 1, 'only the way with one transfer is planned');
  assert.equal(r.transfers, 1);
  assert.deepEqual(kinds(r), ['mesh A', 'mesh C']);
});

test('planWaters: two ways with as few changes: each planned, the cheaper taken', () => {
  // Open sea west and east of lon 2–3, joined only through two separate charted channels there: cell (2, 0) in the
  // south and cell (2, 2) in the north, land between them (lat 1–2) and beyond (lat < 0, lat > 3). Both ways have two
  // changes; the leg along lat 0.5 is cheaper through the southern one.
  const r = plan(
    [
      [
        { i: 2, j: 0 },
        { i: 2, j: 2 },
      ],
    ],
    [
      [-1, -1, 7, 0],
      [-1, 3, 7, 4],
      [2, 1, 3, 2],
    ],
    [0.5, 0.5],
    [5.5, 0.5]
  );
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.equal(r.changes, 2);
  assert.equal(r.ways, 2);
  assert.deepEqual(kinds(r), ['open', 'mesh A', 'open']);
  const m = r.stretches[1];
  assert.ok(m.from[1] < 1 && m.to[1] < 1, `through the southern channel: ${JSON.stringify(m)}`);
});

test('planWaters: an area to avoid over the overlap: the join there is recomputed under the request, the transfer elsewhere', () => {
  // A over lon 0–3, B over lon 2–5, lat 0–2; land all round. An area to avoid over the overlap's southern cell.
  const r = plan([cells(0, 3, 0, 2), cells(2, 5, 0, 2)], [[-1, -1, 7, 3]], [0.5, 0.5], [4.5, 0.5], {
    ...RULES,
    avoid: [{ lon: 2.5, lat: 0.5, radiusM: 60_000 }],
  });
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  const t = r.stretches[0].to;
  assert.ok(t[0] > 2 && t[0] < 3 && t[1] > 1, `the transfer is in the overlap's northern cell, out of the area: ${t}`);
  // An area over the whole overlap: the stored joins say the meshes join there, the request's do not.
  const all = plan([cells(0, 3, 0, 2), cells(2, 5, 0, 2)], [[-1, -1, 7, 3]], [0.5, 0.5], [4.5, 0.5], {
    ...RULES,
    avoid: [{ lon: 2.5, lat: 1, radiusM: 100_000 }],
  });
  assert.ok(!all.ok, JSON.stringify(all));
  if (!all.ok) assert.match(all.reason, /^the start's water and the end's water do not connect for this boat/);
});

test('planWaters: waters that nothing joins are refused with the true reason; an end on land too', () => {
  // The start's water (lon 0–1) is cut off from the end's by a 1 m cell, with land all round: no way at all.
  const cut = plan([cells(0, 3, 0, 1, i => (i === 1 ? 1 : 10))], [[-1, -1, 7, 3]], [0.5, 0.5], [2.5, 0.5]);
  assert.ok(!cut.ok);
  if (!cut.ok)
    assert.equal(
      cut.reason,
      "the start's water and the end's water do not connect for this boat (draught {depth:2}, air draft {length:18}), on the charts or through open water beyond them, within the area"
    );
  const onLand = plan([cells(0, 2)], [[3, -1, 7, 3]], [0.5, 0.5], [4.5, 0.5]);
  assert.ok(!onLand.ok);
  if (!onLand.ok)
    assert.equal(
      onLand.reason,
      'the end is neither on water this boat can use on the charts nor on open water of the coastline data outside them'
    );
});

test('planWaters: without the draught and air draft only open water can join the ends', () => {
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-waters-')), cells(2, 3, 0, 2));
  try {
    const m: WaterMesh = { store: MeshStore.open(dir), map: null, boundary: null, joins: [], name: 'A' };
    const why = "the vessel's draught is not set";
    const open = planWaters([m], null, why, () => LandMask.fromPolygons([], BOX, 0.05), [0.5, 1], [5.5, 1], NAMES);
    assert.equal(open.ok && open.kind, 'open');
    const land = LandMask.fromPolygons([rect(1, -1, -1, 7, 0), rect(2, -1, 2, 7, 3)], BOX, 0.05);
    const shut = planWaters([m], null, why, () => land, [0.5, 1], [5.5, 1], NAMES);
    assert.ok(!shut.ok);
    if (!shut.ok)
      assert.equal(shut.reason, `the leg's ends are not joined by open water outside the charts, and the charts cannot be used: ${why}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planWaters: the entry is the nearest by water, not the nearest as the crow flies behind land', () => {
  // The mesh is one cell (lon 3–4, lat 0–1), the end inside it; land south of lat 0, and a wall at lat 1.2–1.4 from the
  // west edge to lon 4.6. The start, north of the wall at (2, 2.5), is nearest the mesh's west edge as the crow flies,
  // but by water it must round the wall's east end, which brings it to the east edge first (brain, 2026-10-30: from
  // Greenland the entry nearest in a straight line was off Grand Manan, the long way round Nova Scotia).
  const r = plan(
    [cells(3, 4)],
    [
      [-1, -1, 7, 0],
      [-1, 1.2, 4.6, 1.4],
    ],
    [2, 2.5],
    [3.5, 0.5]
  );
  assert.ok(r.ok && r.kind === 'chain', JSON.stringify(r));
  if (!r.ok || r.kind !== 'chain') return;
  assert.deepEqual(kinds(r), ['open', 'mesh A']);
  const entry = r.stretches[1].from;
  assert.ok(near(entry[0], 4), `enters through the east edge, reached first by water: ${entry}`);
  assert.ok(r.water && r.water.fields >= 1 && r.water.cells > 0, JSON.stringify(r.water));
});

test('waterField: in open water the distance is the straight one, within the raster; land is walked round, and a pocket not reached', () => {
  const box = { west: 0, south: 0, east: 2, north: 1 };
  const open = LandMask.fromPolygons([], box, 0.05);
  const at = (m: LandMask, lon: number, lat: number): number => cellOf(emptyMask(m), lon, lat);
  const f = waterField(open, emptyMask(open), at(open, 0.125, 0.525))!;
  const dx = 0.05 * M_PER_DEG * Math.cos(0.525 * DEG);
  assert.ok(Math.abs(f[at(open, 1.125, 0.525)] - 20 * dx) < 1, 'twenty cells east: twenty cell widths');
  const diag = Math.hypot(dx, 0.05 * M_PER_DEG);
  assert.ok(Math.abs(f[at(open, 0.325, 0.725)] - 4 * diag) / (4 * diag) < 0.01, 'four cells diagonally');
  // A wall at lon 1–1.05 from lat 0 to 0.9: the far side is reached round its north end, longer than straight.
  const walled = LandMask.fromPolygons([rect(1, 1, 0, 1.05, 0.9)], box, 0.05);
  const g = waterField(walled, emptyMask(walled), at(walled, 0.525, 0.125))!;
  assert.ok(g[at(walled, 1.525, 0.125)] > f[at(open, 1.125, 0.525)] + 10 * dx, 'round the wall, not through it');
  // A pocket walled all round is not reached.
  const pocket = LandMask.fromPolygons([rect(1, 1, 0, 2, 1), rect(2, 0, 0.5, 1, 1)], box, 0.05);
  const h = waterField(pocket, emptyMask(pocket), at(pocket, 0.525, 0.125))!;
  assert.equal(h[at(pocket, 1.525, 0.725)], Infinity);
});
