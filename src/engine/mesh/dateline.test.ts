/**
 * A chart mesh across the date line (store.ts, the file's comment; paged.ts): a mesh of 1° tiles from 178°E to 178°W
 * written to disk as the format stores it (the tiles east of the date line with longitudes from -180, the index's box
 * with its west greater than its east), read by the tile reader, the paged mesh, the search, the mesh's water on a
 * coastline raster, the final depth check and the change from one mesh to another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bboxUnion, boxesMeet, haversineDistanceM, wrapEdge } from '../../geo/geodesy';
import { cellOf, type CellMask } from '../../geo/landmask';
import { checkRouteOnMeshes } from './check';
import { boundarySeeds, buildCoarseMap, type CoarseRules, meshRulesOf, PieceGraph } from './coarse';
import { markMeshWater } from './exit';
import { writeGridMesh } from './fixture';
import { MeshLand } from './land';
import { PagedMesh } from './paged';
import { searchMesh } from './route';
import { M_PER_DEG_MESH, MeshStore, tileExtentsMeet } from './store';
import { findMeshTransfer } from './transfer';

const RULES = { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 };
const COARSE: CoarseRules = {
  draughtM: 2,
  airDraftM: 18,
  underKeelClearanceM: 0.5,
  overheadClearanceM: 1,
  bufferM: 0,
  openingBridges: 'open',
};

/** Columns 0 to `n` - 1 from `west`, rows 0 and 1; 10 m deep unless `depth` says otherwise. */
function cells(n: number, depth: (i: number, j: number) => number = () => 10): { i: number; j: number; depth: number }[] {
  const out: { i: number; j: number; depth: number }[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) out.push({ i, j, depth: depth(i, j) });
  return out;
}

/** The mesh from 178°E to 178°W (columns 0, 1 west of the date line, 2, 3 east of it), lat 0 to 2. */
function withMesh(fn: (store: MeshStore) => void, depth?: (i: number, j: number) => number): void {
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-dateline-')), cells(4, depth), 178);
  try {
    fn(MeshStore.open(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('boxes round the earth: boxesMeet, bboxUnion and wrapEdge across the date line; boxes that do not cross answer as plain numbers', () => {
  const across = { west: 178, south: 0, east: -178, north: 2 };
  assert.equal(boxesMeet(across, { west: -179.5, south: 0.2, east: -179, north: 0.4 }), true, 'a box east of the date line');
  assert.equal(boxesMeet(across, { west: 179, south: 0.2, east: 179.5, north: 0.4 }), true, 'a box west of it');
  assert.equal(boxesMeet(across, { west: 170, south: 0, east: 177, north: 2 }), false);
  assert.equal(boxesMeet(across, { west: -177, south: 0, east: -170, north: 2 }), false);
  assert.equal(boxesMeet(across, { west: -179.5, south: 3, east: -179, north: 4 }), false, 'north of it');
  assert.equal(boxesMeet(across, { west: 179, south: 1, east: -179, north: 3 }), true, 'two boxes across the date line');
  assert.equal(
    boxesMeet({ west: 170, south: 0, east: 180, north: 1 }, { west: -180, south: 0, east: -170, north: 1 }),
    true,
    'one meridian'
  );
  // Plain boxes: as plain numbers.
  assert.equal(boxesMeet({ west: 0, south: 0, east: 2, north: 1 }, { west: 2, south: 1, east: 3, north: 2 }), true);
  assert.equal(boxesMeet({ west: 0, south: 0, east: 2, north: 1 }, { west: 2.5, south: 0, east: 3, north: 1 }), false);
  assert.deepEqual(bboxUnion({ west: 178, south: 0, east: 179, north: 1 }, { west: -180, south: 0.5, east: -179, north: 2 }), {
    west: 178,
    south: 0,
    east: -179,
    north: 2,
  });
  assert.deepEqual(bboxUnion({ west: -3, south: 0, east: 1, north: 1 }, { west: -5, south: -1, east: 0.5, north: 0.5 }), {
    west: -5,
    south: -1,
    east: 1,
    north: 1,
  });
  // A box that holds the other is their union, whichever is given first (the wide one's west is more than half a turn
  // from the narrow one's middle).
  const narrow = { west: 170, south: 0, east: 175, north: 1 };
  const wide = { west: -20, south: 0, east: 175, north: 1 };
  assert.deepEqual(bboxUnion(narrow, wide), wide);
  assert.deepEqual(bboxUnion(wide, narrow), wide);
  // Two plain boxes nearer each other across the date line than round the front: the box across it, in either order.
  const eastOfIt = { west: -175, south: 0, east: -170, north: 1 };
  assert.deepEqual(bboxUnion(narrow, eastOfIt), { west: 170, south: 0, east: -170, north: 1 });
  assert.deepEqual(bboxUnion(eastOfIt, narrow), { west: 170, south: 0, east: -170, north: 1 });
  assert.deepEqual([wrapEdge(181), wrapEdge(-181), wrapEdge(180), wrapEdge(-180), wrapEdge(12.5)], [-179, 179, 180, -180, 12.5]);
});

test('the tile reader: a point either side of the date line is in its tile, by the usual longitude; outside the mesh is not covered', () => {
  withMesh(store => {
    assert.deepEqual([store.index.west, store.index.east], [178, -178]);
    assert.deepEqual(store.tileIJ(178.5, 0.5), [0, 0]);
    assert.deepEqual(store.tileIJ(179.5, 1.5), [1, 1]);
    assert.deepEqual(store.tileIJ(-179.5, 0.5), [2, 0]);
    assert.deepEqual(store.tileIJ(-178.5, 0.5), [3, 0]);
    for (const lon of [178.5, 179.999, 180, -180, -179.999, -178.5]) assert.equal(store.covers(lon, 0.5), true, `${lon}`);
    for (const lon of [177.5, -177.5, 0, -90]) assert.equal(store.covers(lon, 0.5), false, `${lon}`);
    // The tiles east of the date line are stored from -180.
    assert.deepEqual(store.tile(2, 0)!.bbox, [-180, 0, -179, 1]);
    assert.deepEqual(store.tile(1, 0)!.bbox, [179, 0, 180, 1]);
  });
});

test('a box of tiles: every tile the box meets, for a box across the date line, a box round the far side and the whole earth', () => {
  withMesh(store => {
    const tiles = (west: number, east: number, south = 0, north = 2): number[] =>
      store
        .load({ west, south, east, north })
        .tiles.map(t => t.info.i * 10 + t.info.j)
        .sort((p, q) => p - q);
    const all = [0, 1, 10, 11, 20, 21, 30, 31];
    // The whole earth, by its usual box and as any other full turn.
    assert.deepEqual(tiles(-180, 180), all);
    assert.equal(store.countTriangles({ west: -180, south: 0, east: 180, north: 2 }), 16);
    assert.equal(store.load({ west: -180, south: 0, east: 180, north: 2 }).n, 16);
    assert.deepEqual(tiles(-180, 180, 0.2, 0.8), [0, 10, 20, 30]);
    // All of it but the half degree either side of the date line: the mesh's two ends, met at the two ends of the box.
    assert.deepEqual(tiles(-179.5, 179.5), all);
    assert.equal(store.countTriangles({ west: -179.5, south: 0, east: 179.5, north: 2 }), 16);
    // From the far side of the earth eastwards to the mesh's west columns, and from its east columns on round.
    assert.deepEqual(tiles(0, 178.5), [0, 1]);
    assert.deepEqual(tiles(-178.5, 0), [30, 31]);
    assert.deepEqual(tiles(-90, 90), []);
    // Across the date line, and either side of it.
    assert.deepEqual(tiles(179.5, -179.5), [10, 11, 20, 21]);
    assert.deepEqual(tiles(179.5, -179.5, 0.2, 0.8), [10, 20]);
    assert.deepEqual(tiles(178.2, 178.8), [0, 1]);
    assert.deepEqual(tiles(-179.8, -179.2), [20, 21]);
    assert.equal(store.countTriangles({ west: 179.5, south: 0.2, east: -179.5, north: 0.8 }), 4);
    // A box nearly all the way round, from 179.75 eastwards to 179.5: its run comes back over the mesh, and each of
    // the four tiles of the row is there once (8 triangles), not the column at 179 twice.
    assert.deepEqual(tiles(179.75, 179.5, 0.25, 0.75), [0, 10, 20, 30]);
    assert.equal(store.countTriangles({ west: 179.75, south: 0.25, east: 179.5, north: 0.75 }), 8);
    assert.equal(store.load({ west: 179.75, south: 0.25, east: 179.5, north: 0.75 }).n, 8);
  });
});

test('two tiles that share the date line meet, as two tiles that share an edge anywhere else do', () => {
  assert.equal(tileExtentsMeet([179, 0, 180, 1], [-180, 0, -179, 1]), true, 'either side of the date line');
  assert.equal(tileExtentsMeet([1, 0, 2, 1], [2, 0, 3, 1]), true, 'either side of 2°E');
  assert.equal(tileExtentsMeet([178, 0, 179, 1], [-180, 0, -179, 1]), false, 'a degree apart across the date line');
  assert.equal(tileExtentsMeet([179, 0, 180, 1], [-180, 2, -179, 3]), false, 'apart in latitude');
  // Two meshes side by side, sharing only a meridian, are the same case wherever the meridian is: the leg cannot change
  // meshes in an overlap they do not have, and says the same of both pairs (not "do not overlap" for the pair at the
  // date line alone).
  const reasonAt = (westA: number, westB: number, start: [number, number], end: [number, number]): string => {
    const da = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-touch-a-')), cells(2), westA);
    const db = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-touch-b-')), cells(2), westB);
    try {
      const open = (dir: string, name: string) => {
        const store = MeshStore.open(dir);
        const boundary = boundarySeeds(store, COARSE);
        return { store, boundary, map: buildCoarseMap(store, COARSE, new PagedMesh(store, meshRulesOf(COARSE), 1, boundary)), name };
      };
      const r = findMeshTransfer(open(da, 'A'), open(db, 'B'), RULES, start, end, { start: 'the start', end: 'the end' });
      assert.equal(r.ok, false);
      return r.ok ? '' : r.reason;
    } finally {
      fs.rmSync(da, { recursive: true, force: true });
      fs.rmSync(db, { recursive: true, force: true });
    }
  };
  const elsewhere = reasonAt(0, 2, [0.5, 0.5], [3.5, 0.5]);
  const onDateLine = reasonAt(178, -180, [178.5, 0.5], [-178.5, 0.5]);
  assert.equal(
    elsewhere,
    'no water on A connects the start to water that both A and B call usable for this boat and that connects on B to the end'
  );
  assert.equal(onDateLine, elsewhere);
});

test('the paged mesh: one frame across the date line; points either side are found and come back as usual longitudes', () => {
  withMesh(store => {
    const pm = new PagedMesh(store, RULES, 1);
    const [xw] = pm.toXY(179.5, 0.5);
    const [xe, ye] = pm.toXY(-179.5, 0.5);
    assert.ok(Math.abs(xe - xw - M_PER_DEG_MESH) < 1e-6, `one degree apart in the frame: ${xe - xw}`);
    // Each cell's lower triangle holds (lon + 0.5, 0.25): ids 0 (178), 4 (179), 8 (-180), 12 (-179).
    const at = (lon: number): number => pm.locate(...pm.toXY(lon, 0.25));
    assert.deepEqual([at(178.5), at(179.5), at(-179.5), at(-178.5)], [0, 4, 8, 12]);
    assert.equal(at(177.5), -1);
    assert.equal(at(-177.5), -1);
    // On the date line itself, by either name: a triangle of the mesh.
    assert.ok(pm.locate(...pm.toXY(180, 0.25)) >= 0 && pm.locate(...pm.toXY(-180, 0.25)) >= 0);
    assert.deepEqual(pm.toXY(180, 0.25), pm.toXY(-180, 0.25));
    assert.deepEqual(pm.fromXY(xe, ye), [-179.5, 0.5]);
    // The tiles read: either side of the date line, so their box crosses it.
    assert.deepEqual(pm.touchedBox(), { west: 178, south: 0, east: -178, north: 1 });
    // The nearest usable water to a point west of the mesh is on its west edge, not a turn away.
    const nu = pm.nearestUsable(...pm.toXY(177.5, 0.5))!;
    assert.ok(Math.abs(nu.distM - 0.5 * M_PER_DEG_MESH) < 1e-6, `${nu.distM}`);
    assert.deepEqual(pm.fromXY(nu.x, nu.y), [178, 0.5]);
  });
});

test('the box of the tiles read is the narrowest that holds them, also in a frame laid out about a longitude far from the mesh', () => {
  withMesh(store => {
    // A frame about 1°E is cut on the meridian opposite, 181 = 179°W: the tile from 180 to 179°W is a turn on in it
    // (180 to 181) and the tile from 179°W to 178°W is where it is stored. The two are side by side on the earth: their
    // box is those two degrees, not the whole turn between their places in the frame.
    const pm = new PagedMesh(store, RULES, 1).centred(1);
    assert.equal(pm.frameLon, 1);
    assert.equal(pm.locate(...pm.toXY(-179.5, 0.25)), 8);
    assert.equal(pm.locate(...pm.toXY(-178.5, 0.25)), 12);
    assert.deepEqual(pm.touchedBox(), { west: -180, south: 0, east: -178, north: 1 });
    // The same for a leg's reach on the rough cut, in that frame.
    const boundary = boundarySeeds(store, COARSE);
    const map = buildCoarseMap(store, COARSE, new PagedMesh(store, meshRulesOf(COARSE), 1, boundary));
    const far = new PagedMesh(store, meshRulesOf(COARSE), 1, boundary).centred(1);
    const graph = new PieceGraph(map, far);
    const reach = graph.reach([
      [graph.pieceOf(far.locate(...far.toXY(-179.5, 0.25)))!, graph.pieceOf(far.locate(...far.toXY(-178.5, 0.25)))!],
    ]);
    assert.deepEqual(reach.box, { west: -180, south: 0, east: -178, north: 1 });
    assert.throws(() => graph.reach([]), /the reach of no pieces has no box/);
  });
});

test("a tile the frame's cut runs through is not read into the frame, and the read says why; a tile beside the cut is", () => {
  withMesh(store => {
    // A frame about 0.2°E is cut on 179.8°W, inside the tile from 180 to 179°W: its points west of the cut would lie a
    // turn from its points east of it. Nothing is answered from such a tile: not a lookup, not a leg's land test.
    const pm = new PagedMesh(store, RULES, 1).centred(0.2);
    const cut =
      /mesh tile t_2_0\.bin \(-180° to -179°\) lies across the meridian opposite the frame's middle \(0\.2°\), where a flat frame is cut/;
    assert.throws(() => pm.locate(...pm.toXY(-179.9, 0.05)), cut);
    assert.throws(() => pm.locate(...pm.toXY(-179.3, 0.25)), cut);
    assert.throws(() => pm.locateAll(...pm.toXY(-179.9, 0.05)), cut);
    const land = new MeshLand(pm);
    // The legs the review named: from beyond the cut back across it, and away from it. Neither is called clear or blocked.
    assert.throws(() => land.legCrossesLandExact(-179.95, 0.3, 178.5, 0.3), cut);
    assert.throws(() => land.legCrossesLandExact(-179.3, 0.3, -179.95, 0.3), cut);
    // A leg that walks into the tile from its neighbour: refused where it reaches the tile.
    assert.throws(() => land.legCrossesLandExact(-178.5, 0.3, -179.5, 0.3), cut);
    // The tiles beside it are read and answer: the one east of it where it is stored, the ones west of the cut a turn on.
    assert.equal(pm.locate(...pm.toXY(-178.5, 0.25)), 12);
    assert.equal(pm.locate(...pm.toXY(179.5, 0.25)), 4);
    assert.equal(land.legCrossesLandExact(178.2, 0.3, 179.8, 0.3), false);
    assert.equal(land.legCrossesLandExact(-178.9, 0.3, -178.1, 0.3), false);
  });
  // The nearest usable water in that frame. The column from 180 to 179°W (ids 8 to 11, both rows) is cut. A filter that
  // accepts nothing ends in null, the cut tiles unread; one that accepts none of their triangles passes over them to
  // the water it accepts; one that accepts a triangle of theirs is refused, since they may hold the nearest.
  withMesh(store => {
    const pm = new PagedMesh(store, RULES, 1).centred(0.2);
    const cut = /lies across the meridian opposite the frame's middle \(0\.2°\), where a flat frame is cut/;
    const inCut = (g: number): boolean => g >= 8 && g < 12;
    const none = (): boolean => false;
    assert.equal(pm.nearestUsable(...pm.toXY(177.5, 0.5), none), null);
    assert.equal(pm.nearestUsable(...pm.toXY(-177.5, 0.5), none), null);
    assert.deepEqual(pm.heldTiles(), [], 'no tile of the scan stays held');
    // From east of the mesh, only the water west of the date line accepted: the cut column, nearer, is passed over. That
    // water is a turn on in the frame, west of the point, so its nearest is the column from 178°E.
    const west = pm.nearestUsable(...pm.toXY(-177.5, 0.5), g => g < 8)!;
    assert.ok(west.tri >= 0 && west.tri < 4, `${west.tri}`);
    assert.deepEqual(pm.fromXY(west.x, west.y), [178, 0.5]);
    assert.throws(() => pm.nearestUsable(...pm.toXY(177.5, 0.5), inCut), cut);
    assert.throws(() => pm.nearestUsable(...pm.toXY(-177.5, 0.5), g => g < 12), cut);
    // No filter: the water beside the point, nearer than the cut column, as before.
    const beside = pm.nearestUsable(...pm.toXY(177.5, 0.5))!;
    assert.deepEqual(pm.fromXY(beside.x, beside.y), [178, 0.5]);
  });
  // The frame of one mesh is laid out about the mesh's middle: its cut is outside the mesh, and every tile is read.
  withMesh(store => {
    const pm = new PagedMesh(store, RULES, 1);
    for (let idx = 0; idx < pm.tileCount; idx++) pm.tile(idx);
    const land = new MeshLand(pm);
    assert.equal(land.legCrossesLandExact(-179.95, 0.3, 178.5, 0.3), false);
    assert.equal(land.legCrossesLandExact(178.5, 0.3, -179.95, 0.3), false);
  });
  // The same legs across a column the boat cannot use (179°E to 180): crossing, from either end.
  withMesh(
    store => {
      const land = new MeshLand(new PagedMesh(store, RULES, 1));
      assert.equal(land.legCrossesLandExact(-179.95, 0.3, 178.5, 0.3), true);
      assert.equal(land.legCrossesLandExact(178.5, 0.3, -179.95, 0.3), true);
    },
    i => (i === 1 ? 1 : 10)
  );
});

test('a mesh all the way round the earth: the tiles either side of the date line are found, and a point on it', () => {
  // 360 tiles of 1° from 180°W round to 180°E, one row: the index's box is -180 to 180, its middle 0, and the tiles at
  // its two ends lie on the meridian opposite its middle.
  const dir = writeGridMesh(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-round-')),
    Array.from({ length: 360 }, (_, i) => ({ i, j: 0 })),
    -180
  );
  try {
    const store = MeshStore.open(dir);
    assert.deepEqual([store.index.west, store.index.east], [-180, 180]);
    const pm = new PagedMesh(store, RULES, 1);
    // Each cell's lower triangle holds (lon + 0.5, 0.25): the first tile's is 0, the last tile's 718.
    assert.equal(pm.locate(...pm.toXY(-179.5, 0.25)), 0);
    assert.equal(pm.locate(...pm.toXY(179.5, 0.25)), 718);
    assert.equal(pm.locate(...pm.toXY(0.5, 0.25)), 360);
    // On the date line, by either name: a triangle of one of the two tiles that meet there.
    for (const lon of [180, -180]) assert.ok([0, 1, 718, 719].includes(pm.locate(...pm.toXY(lon, 0.5))), `${lon}`);
    for (const lon of [-180, -179.5, 179.5, 180, 0]) assert.equal(store.covers(lon, 0.5), true, `${lon}`);
    // A column a whole turn on is the same column, and a run across the date line is its columns in a row.
    assert.deepEqual(store.tileIJ(-179.5, 0.5), [0, 0]);
    assert.deepEqual(store.tileIJ(179.5, 0.5), [359, 0]);
    assert.deepEqual(store.columnsOf(179.5, 1), [359, 0]);
    assert.deepEqual(store.columnsOf(-180.5, 1.5), [359, 0, 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the search: a leg across the date line is one short route on the mesh', () => {
  withMesh(store => {
    const s = searchMesh(store, [178.5, 0.5], [-178.5, 0.5], RULES);
    assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
    if (!s.result.ok) return;
    const straight = haversineDistanceM(178.5, 0.5, -178.5, 0.5);
    assert.ok(Math.abs(s.result.lengthM - straight) < 1, `${s.result.lengthM} m against ${straight} m straight`);
    assert.deepEqual(s.result.path[0], [178.5, 0.5]);
    assert.deepEqual(s.result.path[s.result.path.length - 1], [-178.5, 0.5]);
    for (const [lon] of s.result.path) assert.ok(lon >= -180 && lon <= 180, `${lon}`);
    // The area the search read (for the currents): across the date line.
    assert.deepEqual([s.box.west, s.box.east], [178, -178]);
    // The other way, and a leg that ends on the date line.
    const back = searchMesh(store, [-178.5, 1.5], [178.5, 1.5], RULES);
    assert.ok(back.result.ok && Math.abs(back.result.lengthM - haversineDistanceM(178.5, 1.5, -178.5, 1.5)) < 1);
    const to = searchMesh(store, [178.5, 0.5], [180, 0.5], RULES);
    assert.ok(to.result.ok && Math.abs(to.result.lengthM - haversineDistanceM(178.5, 0.5, 180, 0.5)) < 1);
  });
});

test('the search goes round water the boat cannot use on the date line', () => {
  // Row 0 is 1 m deep in the two columns beside the date line: the route from row 0 to row 0 goes through row 1.
  withMesh(
    store => {
      const s = searchMesh(store, [178.5, 0.5], [-178.5, 0.5], RULES);
      assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
      if (!s.result.ok) return;
      assert.ok(Math.max(...s.result.path.map(p => p[1])) >= 1, 'through the northern row');
      assert.ok(s.result.lengthM > haversineDistanceM(178.5, 0.5, -178.5, 0.5) + 1000);
    },
    (i, j) => (j === 0 && (i === 1 || i === 2) ? 1 : 10)
  );
});

test("the mesh's water on a coastline raster across the date line: the cells either side of it are marked, those beyond the mesh are not", () => {
  withMesh(store => {
    // A raster from 177°E to 177°W, lat -1 to 3, cells of 0.25°.
    const res = 0.25;
    const mask: CellMask = {
      bbox: { west: 177, south: -1, east: -177, north: 3 },
      resolutionDeg: res,
      nx: 24,
      ny: 16,
      cells: new Uint8Array(24 * 16),
    };
    markMeshWater(store, mask);
    const marked = (lon: number, lat: number): number => mask.cells[cellOf(mask, lon, lat)];
    for (const lon of [178.1, 179.9, -179.9, -178.1]) assert.equal(marked(lon, 0.6), 1, `${lon}`);
    for (const lon of [177.4, -177.4]) assert.equal(marked(lon, 0.6), 0, `${lon}`);
    assert.equal(marked(179.9, 2.6), 0, 'north of the mesh');
    // 16 columns (4°) by 8 rows (2°) of the mesh.
    assert.equal(
      mask.cells.reduce((a, b) => a + b, 0),
      16 * 8
    );
  });
});

test('the final depth check walks a route across the date line the short way, and finds water the boat cannot use east of it', () => {
  withMesh(store => {
    const path: [number, number][] = [
      [178.5, 0.5],
      [-178.5, 0.5],
    ];
    const r = checkRouteOnMeshes([store], path, [0], 1, RULES);
    const len = haversineDistanceM(178.5, 0.5, -178.5, 0.5);
    assert.equal(r.violations.length, 0);
    assert.ok(Math.abs(r.legs[0].onMeshM - len) < 5, `${r.legs[0].onMeshM} m on the mesh of ${len} m`);
    assert.ok(r.legs[0].outsideMeshM < 5, `${r.legs[0].outsideMeshM} m outside it`);
  });
  withMesh(
    store => {
      const r = checkRouteOnMeshes(
        [store],
        [
          [178.5, 0.5],
          [-178.5, 0.5],
        ],
        [0],
        1,
        RULES
      );
      assert.equal(r.violations.length, 1);
      const v = r.violations[0];
      assert.equal(v.kind, 'depth');
      // The shallow column is the first east of the date line: the route enters it on the date line.
      assert.ok(Math.abs(v.lon) > 179.99 && Math.abs(v.lat - 0.5) < 1e-6, `${v.lon}, ${v.lat}`);
    },
    i => (i === 2 ? 1 : 10)
  );
});

test('two meshes in one frame: a leg from a mesh west of the date line changes to a mesh across it in their overlap', () => {
  // A: 176°E to 180°; B: 179°E to 177°W; they overlap from 179°E to 180°. The leg runs from A's west to B's east.
  const da = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-dateline-a-')), cells(4), 176);
  const db = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-dateline-b-')), cells(4), 179);
  try {
    const sa = MeshStore.open(da);
    const sb = MeshStore.open(db);
    assert.deepEqual([sa.index.west, sa.index.east, sb.index.west, sb.index.east], [176, 180, 179, -177]);
    assert.equal(boxesMeet(sa.index, sb.index), true);
    const ba = boundarySeeds(sa, COARSE);
    const bb = boundarySeeds(sb, COARSE);
    const ma = buildCoarseMap(sa, COARSE, new PagedMesh(sa, meshRulesOf(COARSE), 1, ba));
    const mb = buildCoarseMap(sb, COARSE, new PagedMesh(sb, meshRulesOf(COARSE), 1, bb));
    // The rough cut's piece centres are usual longitudes.
    for (const p of mb.pieces) assert.ok(p[0] >= -180 && p[0] <= 180, `${p[0]}`);
    // B's reach from its west to its east: a box across the date line.
    const pb = new PagedMesh(sb, meshRulesOf(COARSE), 1, bb);
    const graph = new PieceGraph(mb, pb);
    const reach = graph.reach([[graph.pieceOf(pb.locate(...pb.toXY(179.5, 0.25)))!, graph.pieceOf(pb.locate(...pb.toXY(-177.5, 0.25)))!]]);
    assert.deepEqual([reach.box.west, reach.box.east], [179, -177]);
    const r = findMeshTransfer(
      { store: sa, boundary: ba, map: ma, name: 'A' },
      { store: sb, boundary: bb, map: mb, name: 'B' },
      RULES,
      [176.5, 0.5],
      [-177.5, 0.5],
      { start: 'the start', end: 'the end' }
    );
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (!r.ok) return;
    assert.ok(r.point[0] > 179 && r.point[0] < 180 && r.point[1] > 0 && r.point[1] < 2, `in the overlap: ${r.point}`);
    assert.ok(r.transfers > 0);
    // The other way: from B, east of the date line, to A.
    const back = findMeshTransfer(
      { store: sb, boundary: bb, map: mb, name: 'B' },
      { store: sa, boundary: ba, map: ma, name: 'A' },
      RULES,
      [-177.5, 0.5],
      [176.5, 0.5],
      { start: 'the start', end: 'the end' }
    );
    assert.ok(back.ok, back.ok ? '' : back.reason);
    if (back.ok) assert.ok(back.point[0] > 179 && back.point[0] < 180, `in the overlap: ${back.point}`);
  } finally {
    fs.rmSync(da, { recursive: true, force: true });
    fs.rmSync(db, { recursive: true, force: true });
  }
});
