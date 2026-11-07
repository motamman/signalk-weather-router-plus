import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from './landmask';
import type { ShapePolygon } from './shapefile';
import { pointInShape } from './shapefile';
import { Chokepoints, SplitCells, WaterGrid, SIDE_E, SIDE_W } from './watergrid';
import {
  canalRecords,
  coarseBitsFromFine,
  distanceToLandM,
  edgesCrossedBySegment,
  mergeTreeSaddles,
  DEFAULT_CHOKEPOINT_PARAMS,
} from './watergrid_build';
import { R_EARTH_M, DEG } from './geodesy';

/** Fine raster (1 = land) from rows of '#' (land) and '.' (water), top row = north. */
function raster(rows: string[]): { fine: Uint8Array; nx: number; ny: number } {
  const ny = rows.length;
  const nx = rows[0].length;
  const fine = new Uint8Array(nx * ny);
  rows.forEach((row, k) => {
    const y = ny - 1 - k;
    for (let x = 0; x < nx; x++) fine[y * nx + x] = row[x] === '#' ? 1 : 0;
  });
  return { fine, nx, ny };
}

/** Coarse 4-connected flood over a CoarseBits (no split handling): cells reachable from `from`. */
function coarseReach(bits: ReturnType<typeof coarseBitsFromFine>, from: number): Set<number> {
  const seen = new Set<number>([from]);
  const st = [from];
  const { cnx, cny } = bits;
  while (st.length) {
    const c = st.pop()!;
    const x = c % cnx;
    const y = Math.floor(c / cnx);
    const nb: number[] = [];
    if (x + 1 < cnx && bits.east[c]) nb.push(c + 1);
    if (x > 0 && bits.east[c - 1]) nb.push(c - 1);
    if (y + 1 < cny && bits.north[c]) nb.push(c + cnx);
    if (y > 0 && bits.north[c - cnx]) nb.push(c - cnx);
    for (const n of nb)
      if (!seen.has(n)) {
        seen.add(n);
        st.push(n);
      }
  }
  return seen;
}

test('edge rule: a one-cell staircase thread crossing coarse cells corner to corner stays open', () => {
  // 2×2 coarse cells of 4×4 fine cells. The thread runs from the SW cell to
  // the NE cell; near the coarse corner it steps through the SE cell (a
  // 4-connected staircase), which the any-water *cell* rule would also see,
  // but the point is that the edges it crosses are open and nothing else is.
  const r = raster(['######..', '#####..#', '####..##', '####.###', '###..###', '##..####', '#..#####', '..######']);
  const bits = coarseBitsFromFine(r.fine, r.nx, r.ny, 4);
  // SW = 0, SE = 1, NW = 2 (all land), NE = 3.
  assert.deepEqual([...bits.water], [1, 1, 0, 1]);
  const reach = coarseReach(bits, 0);
  assert.ok(reach.has(3), 'SW connects to NE through the thread');
  // The thread crosses SW→SE (east edge of 0) and SE→NE (north edge of 1), nothing else.
  assert.equal(bits.east[0], 1);
  assert.equal(bits.north[1], 1);
  assert.equal(bits.north[0], 0);
  assert.equal(bits.east[2], 0);
});

test('edge rule: a diagonal-only fine contact does not open an edge (no leak through a land corner)', () => {
  const r = raster(['########', '########', '########', '####.###', '###.####', '########', '########', '########']);
  const bits = coarseBitsFromFine(r.fine, r.nx, r.ny, 4);
  // Water only in SW (fine 3,3) and NE (fine 4,4), touching at the coarse corner.
  assert.deepEqual([...bits.water], [1, 0, 0, 1]);
  assert.equal(bits.east[0] + bits.north[0] + bits.east[2] + bits.north[1], 0);
  assert.ok(!coarseReach(bits, 0).has(3));
});

test('edge rule: a sliver touching one side only, or offset rows, keeps the edge closed', () => {
  // West cell has water along its east border in rows 0-1, east cell along
  // its west border in rows 2-3: they meet only at a corner.
  const r = raster(['####.###', '####.###', '###.####', '###.####']);
  const bits = coarseBitsFromFine(r.fine, r.nx, r.ny, 4);
  assert.deepEqual([...bits.water], [1, 1]);
  assert.equal(bits.east[0], 0);
  // Same rows on both sides → open.
  const r2 = raster(['########', '###..###', '########', '########']);
  assert.equal(coarseBitsFromFine(r2.fine, r2.nx, r2.ny, 4).east[0], 1);
  // Water reaching the border on one side only (land on the other side) → closed.
  const r3 = raster(['########', '###.####', '########', '########']);
  assert.equal(coarseBitsFromFine(r3.fine, r3.nx, r3.ny, 4).east[0], 0);
});

test('split cells: two shores of a land strip thinner than a cell do not leak', () => {
  // 3×1 coarse cells; the middle cell has a one-fine-cell land strip down its
  // middle with water on both sides: west water belongs to the west cell's
  // sea, east water to the east cell's sea.
  const rr = raster(['.....#......', '.....#......', '.....#......', '.....#......']);
  const bits = coarseBitsFromFine(rr.fine, rr.nx, rr.ny, 4);
  assert.deepEqual([...bits.water], [1, 1, 1]);
  // The plain edge planes connect 0–1 and 1–2 …
  assert.equal(bits.east[0], 1);
  assert.equal(bits.east[1], 1);
  // … but the middle cell is split into two components touching W and E.
  assert.equal(bits.splits.length, 1);
  const sp = bits.splits[0];
  assert.equal(sp.cell, 1);
  // Put the three cells into a tiny WaterGrid and check component-aware moves.
  const g = WaterGrid.empty(3, 1, 0.02);
  for (let c = 0; c < 3; c++) g.water[c >> 3] |= 1 << c;
  g.east[0] |= 1 | 2; // east edges of cells 0 and 1
  const grid = new WaterGrid(
    g.header,
    g.water,
    g.east,
    g.north,
    g.chokepoints,
    new SplitCells(Uint32Array.of(1), sp.labels, Uint16Array.of(sp.cross))
  );
  const wLabel = grid.splits.label(0, SIDE_W, 0);
  const eLabel = grid.splits.label(0, SIDE_E, 0);
  assert.ok(wLabel > 0 && eLabel > 0 && wLabel !== eLabel);
  // From cell 0 (ordinary) eastwards we enter the west component only.
  const entered: number[] = [];
  grid.neighbours(0, 0, 0, (_dr, dc, comp) => {
    if (dc === 1) entered.push(comp);
  });
  assert.deepEqual(entered, [wLabel]);
  // From the west component we cannot move on east; from the east one we can.
  const fromW: number[] = [];
  grid.neighbours(0, 1, wLabel, (_dr, dc) => fromW.push(dc));
  assert.ok(!fromW.includes(1));
  const fromE: number[] = [];
  grid.neighbours(0, 1, eLabel, (_dr, dc) => fromE.push(dc));
  assert.ok(fromE.includes(1));
  // Diagonals never pass a split cell.
  assert.equal(grid.diagOpen(0, 0, 1, 1), false);
});

test('water grid file round trip keeps planes, chokepoints, split cells and canals', () => {
  const g0 = WaterGrid.empty(16, 8, 22.5);
  const cells = Uint32Array.of(3, 9);
  const labels = new Uint8Array(32);
  labels[0] = 1;
  labels[5] = 2;
  labels[16 + 12] = 3;
  const splits = new SplitCells(cells, labels, Uint16Array.of(0x0f0f, 0x1234));
  const cp = new Chokepoints(
    Float32Array.of(36.0, -53.5),
    Float32Array.of(-5.6, -70.5),
    Uint16Array.of(14000, 700),
    Uint8Array.of(75, 125)
  );
  const g = new WaterGrid({ ...g0.header, canals: [{ name: 'Test Canal', edges: [4, 7] }] }, g0.water, g0.east, g0.north, cp, splits);
  g.water[0] = 0xa5;
  g.east[1] = 0x3c;
  g.north[2] = 0x81;
  g.east[0] |= 1 << 2; // edge id 4 = east edge of cell 2
  g.north[0] |= 1 << 3; // edge id 7 = north edge of cell 3
  g.setCanalsAllowed(false);
  const back = WaterGrid.fromBuffer(g.toBuffer());
  assert.deepEqual([...back.water], [...g.water]);
  // Saved as built (canals open), loaded open.
  assert.equal(back.canalsAreAllowed, true);
  assert.ok(back.eastOpen(0, 2) && back.northOpen(0, 3));
  assert.deepEqual(
    [...back.north],
    [...g.north].map((b, i) => (i === 0 ? b | 8 : b))
  );
  assert.deepEqual([...back.chokepoints.widthM], [14000, 700]);
  assert.deepEqual([...back.chokepoints.axisDeg], [75, 125]);
  assert.ok(Math.abs(back.chokepoints.lat[1] + 53.5) < 1e-5);
  assert.deepEqual([...back.splits.cells], [3, 9]);
  assert.deepEqual([...back.splits.labels], [...labels]);
  assert.deepEqual([...back.splits.cross], [0x0f0f, 0x1234]);
  assert.equal(back.header.canals[0].name, 'Test Canal');
});

test('canals: closed by setCanalsAllowed(false) (the default setting), reopened when allowed; cuts record only open edges', () => {
  // A 10×5 globe of 36° cells.
  const g = WaterGrid.empty(10, 5, 36);
  // Two basins joined only through a canal: water everywhere in row 2, with the only link between col 4 and col 5.
  for (let c = 0; c < 10; c++) {
    const i = 2 * 10 + c;
    g.water[i >> 3] |= 1 << (i & 7);
    if (c !== 9) g.east[i >> 3] |= 1 << (i & 7);
  }
  // The canal cut crosses the border between col 4 and col 5 of row 2 (lon -180 + 5·36 = 0°, lat -90 + 2.5·36 = 0°).
  const cut = edgesCrossedBySegment(-1, -10, 1, 10, 36, 10, 5);
  const idx45 = 2 * 10 + 4;
  assert.ok(cut.includes(idx45 * 2), 'the cut crosses the east edge of (2,4)');
  const grid = new WaterGrid({ ...g.header }, g.water, g.east, g.north, g.chokepoints);
  grid.header.canals = canalRecords(grid, [
    {
      name: 'Mid Canal',
      cuts: [
        [
          [-10, -1],
          [10, 1],
        ],
      ],
    },
  ]);
  assert.deepEqual(grid.header.canals[0].edges, [idx45 * 2]);
  assert.ok(grid.eastOpen(2, 4));
  grid.setCanalsAllowed(false);
  assert.ok(!grid.eastOpen(2, 4));
  assert.ok(grid.eastOpen(2, 3), 'other edges untouched');
  grid.setCanalsAllowed(true);
  assert.ok(grid.eastOpen(2, 4));
  // A cut through land records nothing.
  assert.deepEqual(
    canalRecords(grid, [
      {
        name: 'Dry',
        cuts: [
          [
            [50, 0],
            [60, 0],
          ],
        ],
      },
    ])[0].edges,
    []
  );
});

test('edgesCrossedBySegment: a corner crossing returns both L-paths (blocks the diagonal)', () => {
  // Segment through the exact corner at lon 0, lat 0 on a 36° globe: cells (2,4),(2,5),(3,4),(3,5) meet at (lon 0, lat 18)? use lat 18.
  const e = edgesCrossedBySegment(-18, 0, 18, 36, 36, 10, 5);
  // Diagonal SW→NE through the corner (lon 0, lat 18) between rows 2/3 and cols 4/5.
  const ids = new Set(e);
  assert.ok(ids.has((2 * 10 + 4) * 2), 'east edge of (2,4)');
  assert.ok(ids.has((2 * 10 + 5) * 2 + 1), 'north edge of (2,5)');
  assert.ok(ids.has((2 * 10 + 4) * 2 + 1), 'north edge of (2,4)');
  assert.ok(ids.has((3 * 10 + 4) * 2), 'east edge of (3,4)');
});

test('edgesCrossedBySegment wraps at the antimeridian', () => {
  const e = edgesCrossedBySegment(170, 0, -170, 0, 36, 10, 5);
  // Crossing lon 180 = border between col 9 and col 0 → east edge of col 9.
  assert.ok(e.includes((2 * 10 + 9) * 2));
});

test('chokepoints: merge tree finds the narrowest point between two basins, only when local', () => {
  // 30×9 clearance grid: two basins (clearance 5000 m) joined by a channel
  // (clearance 800 m, narrowest 400 m in the middle); all edges open where water.
  const nx = 30;
  const ny = 9;
  const clear = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (x < 10 || x >= 20) clear[i] = 2000 + 3000 * (1 - Math.abs(y - 4) / 4);
      else if (y === 4) clear[i] = x === 15 ? 400 : 800;
    }
  const east = new Uint8Array(nx * ny);
  const north = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (clear[i] > 0 && x + 1 < nx && clear[i + 1] > 0) east[i] = 1;
      if (clear[i] > 0 && y + 1 < ny && clear[i + nx] > 0) north[i] = 1;
    }
  const full = { x0: 0, y0: 0, x1: nx, y1: ny };
  const ev = mergeTreeSaddles(clear, east, north, nx, ny, full, full, DEFAULT_CHOKEPOINT_PARAMS);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].cell, 4 * nx + 15);
  assert.equal(ev[0].clearanceM, 400);
  // Core excluding the channel: no event reported.
  assert.equal(mergeTreeSaddles(clear, east, north, nx, ny, full, { x0: 0, y0: 0, x1: 10, y1: ny }).length, 0);
  // A wider parallel channel (row 0) inside the window: the basins connect there first → no event at the narrow one…
  const c2 = Float32Array.from(clear);
  const e2 = Uint8Array.from(east);
  for (let x = 10; x < 20; x++) c2[x] = 1500;
  for (let x = 9; x < 20; x++) e2[x] = 1;
  const ev2 = mergeTreeSaddles(c2, e2, north, nx, ny, full, full, DEFAULT_CHOKEPOINT_PARAMS);
  assert.ok(!ev2.some(e => e.cell === 4 * nx + 15), 'the narrow channel is not a saddle when a wider way exists in the window');
  // …but with a window that leaves the parallel channel out, it is (locality: Messina vs the way round Sicily).
  const win = { x0: 0, y0: 2, x1: nx, y1: ny };
  const ev3 = mergeTreeSaddles(c2, e2, north, nx, ny, win, win, DEFAULT_CHOKEPOINT_PARAMS);
  assert.ok(ev3.some(e => e.cell === 4 * nx + 15));
});

test('distance to land in metres follows latitude (anisotropic EDT)', () => {
  // 21×21 cells of 0.01° at 60°N with one land cell in the middle.
  const n = 21;
  const land = new Uint8Array(n * n);
  land[10 * n + 10] = 1;
  const d = distanceToLandM(land, n, n, 60 - 0.105, 0.01, 1e6);
  const dy = 0.01 * R_EARTH_M * DEG;
  const dx = dy * Math.cos(60 * DEG);
  assert.equal(d[10 * n + 10], 0);
  assert.ok(Math.abs(d[11 * n + 10] - dy) < 1, 'north neighbour one row away');
  assert.ok(Math.abs(d[10 * n + 11] - dx) / dx < 0.01, 'east neighbour narrower at 60°N');
  assert.ok(Math.abs(d[13 * n + 14] - Math.hypot(3 * dy, 4 * dx)) / Math.hypot(3 * dy, 4 * dx) < 0.01);
  // No land at all → capped.
  const d2 = distanceToLandM(new Uint8Array(9), 3, 3, 0, 0.01, 5000);
  assert.ok([...d2].every(v => v === 5000));
});

function poly(coords: number[]): ShapePolygon {
  const xs = coords.filter((_v, i) => i % 2 === 0);
  const ys = coords.filter((_v, i) => i % 2 === 1);
  const c = Float64Array.from([...coords, coords[0], coords[1]]);
  const b = { minLon: Math.min(...xs), maxLon: Math.max(...xs), minLat: Math.min(...ys), maxLat: Math.max(...ys) };
  return { recordNumber: 1, ...b, rings: [{ coords: c, ...b }] };
}

test('conservative raster is exact: a water cell never contains polygon boundary (supercover)', () => {
  // Thin slanted slivers and a spiky star, at a resolution where half-cell stepping would miss corners.
  let seed = 7;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const shapes: ShapePolygon[] = [];
  for (let k = 0; k < 12; k++) {
    const cx = 0.1 + rnd() * 0.8;
    const cy = 0.1 + rnd() * 0.8;
    const pts: number[] = [];
    for (let a = 0; a < 7; a++) {
      const r = a % 2 ? 0.003 + rnd() * 0.01 : 0.02 + rnd() * 0.06;
      pts.push(cx + r * Math.cos(a * 0.9 + k), cy + r * Math.sin(a * 0.9 + k));
    }
    shapes.push(poly(pts));
  }
  const bbox = { west: 0, south: 0, east: 1, north: 1 };
  const m = LandMask.fromPolygons(shapes, bbox, 0.01);
  let checked = 0;
  for (let y = 0; y < m.ny; y++)
    for (let x = 0; x < m.nx; x++) {
      if (m.raster[y * m.nx + x]) continue;
      // Sample the whole cell densely: no point may be inside a polygon.
      for (let sy = 0; sy <= 6; sy++)
        for (let sx = 0; sx <= 6; sx++) {
          const lon = (x + sx / 6) * 0.01;
          const lat = (y + sy / 6) * 0.01;
          for (const s of shapes) assert.ok(!pointInShape(s, lon, lat), `water cell ${x},${y} contains land at ${lon},${lat}`);
          checked++;
        }
    }
  assert.ok(checked > 10000);
  // isLandExact's raster shortcut agrees with the polygons everywhere.
  for (let k = 0; k < 20000; k++) {
    const lon = rnd();
    const lat = rnd();
    assert.equal(m.isLandExact(lon, lat), m.isLandPolygons(lon, lat));
  }
});

test('refine: a finer patch opens a channel the base raster closes and answers isLand inside it', () => {
  // Two land blocks with a 0.012° channel between them (lon 0.494–0.506).
  const shapes = [poly([0, 0.3, 0.494, 0.3, 0.494, 0.7, 0, 0.7]), poly([0.506, 0.3, 1, 0.3, 1, 0.7, 0.506, 0.7])];
  const m = LandMask.fromPolygons(shapes, { west: 0, south: 0, east: 1, north: 1 }, 0.01);
  const across = (mask: LandMask = m): boolean => {
    for (let k = 0; k <= 200; k++) {
      const lon = 0.49 + (k / 200) * 0.02;
      if (!mask.isLand(lon, 0.5)) return true;
    }
    return false;
  };
  assert.equal(across(), false, 'closed at 0.01°');
  const p = m.refine({ west: 0.45, south: 0.25, east: 0.55, north: 0.75 }, 0.0025);
  assert.ok(p);
  assert.equal(p!.resolutionDeg, 0.0025);
  assert.equal(across(), true, 'open in the 0.0025° patch');
  assert.equal(m.resolutionAt(0.5, 0.5), 0.0025);
  assert.equal(m.resolutionAt(0.1, 0.1), 0.01);
  // Patch water contains base water (nested conservative rasters).
  for (let k = 0; k < 2000; k++) {
    const lon = 0.45 + (k % 50) * 0.002;
    const lat = 0.25 + Math.floor(k / 50) * 0.0125;
    const base = m.raster[m.cellIndex(lon, lat)];
    if (!base) assert.equal(m.isLand(lon, lat), false);
  }
  // A covered request is a no-op.
  assert.equal(m.refine({ west: 0.46, south: 0.3, east: 0.54, north: 0.7 }, 0.0025), null);
  // A route's view of a mask (routeView: a worker's cached mask) draws its own patches; the mask it views gains none.
  const cached = LandMask.fromPolygons(shapes, { west: 0, south: 0, east: 1, north: 1 }, 0.01);
  const view = cached.routeView();
  assert.ok(view.refine({ west: 0.45, south: 0.25, east: 0.55, north: 0.75 }, 0.0025));
  assert.equal(across(view), true, 'open in the view');
  assert.equal(cached.patches.length, 0);
  assert.equal(across(cached), false, 'the cached mask as it was');
  assert.equal(cached.routeView().patches.length, 0, "the next route's view starts with none");
});
