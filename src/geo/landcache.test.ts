import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pointInShape, readShapefilePolygons, ShapefileIndex } from './shapefile';
import { LandMask } from './landmask';
import { chooseOverlayResolution, OnDemandLand, snapBBox } from './landcache';
import { PolygonCache, polygonBytes } from './polygoncache';

/** Write a minimal polygon shapefile (type 5); each polygon is a list of rings of [lon, lat]. */
function writeShp(file: string, polys: number[][][][]): void {
  const recs: Buffer[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  polys.forEach((rings, i) => {
    const pts = rings.flat();
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    minX = Math.min(minX, bb[0]);
    minY = Math.min(minY, bb[1]);
    maxX = Math.max(maxX, bb[2]);
    maxY = Math.max(maxY, bb[3]);
    const len = 44 + 4 * rings.length + 16 * pts.length;
    const b = Buffer.alloc(8 + len);
    b.writeInt32BE(i + 1, 0);
    b.writeInt32BE(len / 2, 4);
    b.writeInt32LE(5, 8);
    bb.forEach((v, k) => b.writeDoubleLE(v, 12 + 8 * k));
    b.writeInt32LE(rings.length, 44);
    b.writeInt32LE(pts.length, 48);
    let start = 0;
    rings.forEach((r, k) => {
      b.writeInt32LE(start, 52 + 4 * k);
      start += r.length;
    });
    let o = 52 + 4 * rings.length;
    for (const p of pts) {
      b.writeDoubleLE(p[0], o);
      b.writeDoubleLE(p[1], o + 8);
      o += 16;
    }
    recs.push(b);
  });
  const body = Buffer.concat(recs);
  const h = Buffer.alloc(100);
  h.writeInt32BE(9994, 0);
  h.writeInt32BE((100 + body.length) / 2, 24);
  h.writeInt32LE(1000, 28);
  h.writeInt32LE(5, 32);
  [minX, minY, maxX, maxY].forEach((v, k) => h.writeDoubleLE(v, 36 + 8 * k));
  fs.writeFileSync(file, Buffer.concat([h, body]));
}

const sq = (w: number, s: number, e: number, n: number): number[][] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-land-'));
  const file = path.join(dir, 'land.shp');
  writeShp(file, [
    [sq(-71, 41, -70, 42)], // island off Cape Cod
    [sq(10, 50, 12, 52), sq(10.5, 50.5, 11, 51)], // square with a lake
    [sq(179, -10, 180, -9)], // touching the antimeridian from the west
    [sq(-180, -10, -179, -9)], // and from the east
  ]);
  return file;
}

test('ShapefileIndex.read returns what a full scan returns', () => {
  const file = fixture();
  const ix = ShapefileIndex.open(file);
  assert.equal(ix.count, 4);
  for (const b of [
    { west: -72, south: 40, east: -69, north: 43 },
    { west: 170, south: -20, east: -170, north: 0 },
    { west: -180, south: -90, east: 180, north: 90 },
    { west: 0, south: 0, east: 1, north: 1 },
  ]) {
    const a = readShapefilePolygons(file, b).map(s => s.recordNumber);
    const c = ix.read(b).map(s => s.recordNumber);
    assert.deepEqual(c, a, JSON.stringify(b));
  }
  assert.deepEqual(
    ix.containing(10.7, 50.7).map(s => s.recordNumber),
    [2]
  );
  assert.equal(ShapefileIndex.open(file), ix, 'cached per file');
});

test('streamed rasterisation equals rasterising all polygons at once', () => {
  const file = fixture();
  for (const [b, res] of [
    [{ west: -180, south: -90, east: 180, north: 90 }, 0.25],
    [{ west: 170, south: -20, east: -170, north: 0 }, 0.05],
    [{ west: 9, south: 49, east: 13, north: 53 }, 0.01],
  ] as const) {
    const all = LandMask.fromPolygons(readShapefilePolygons(file, b), b, res);
    const ix = ShapefileIndex.open(file);
    const streamed = LandMask.rasterStreamed(b, res, add => {
      ix.forEach(b, add);
    });
    assert.deepEqual(streamed.raster, all.raster, JSON.stringify(b));
    assert.ok(all.landFraction() > 0);
  }
});

test('OnDemandLand: raster per bbox matched to the spacing, LRU reuse, exact point test', () => {
  const file = fixture();
  const land = new OnDemandLand([file], { maxEntries: 2, maxCells: 4_000_000 });
  const view = { west: -72, south: 40, east: -69, north: 43 };
  const m = land.forBBox(view, 0.05);
  assert.equal(m.resolutionDeg, 0.01); // quarter of 0.05 snapped down to the offered set
  assert.ok(m.isLand(-70.5, 41.5));
  assert.ok(!m.isLand(-71.5, 41.5));
  assert.equal(m.hasPolygons, false, 'polygons dropped after rasterising');
  // Same view again and a small pan inside the snapped box: cache hits.
  assert.equal(land.forBBox(view, 0.05), m);
  assert.equal(land.forBBox({ west: -71.9, south: 40.1, east: -69.1, north: 42.9 }, 0.05), m);
  assert.equal(land.stats().builds, 1);
  assert.equal(land.stats().hits, 2);
  // LRU bound.
  land.forBBox({ west: 9, south: 49, east: 13, north: 53 }, 0.05);
  land.forBBox({ west: 170, south: -20, east: -170, north: 0 }, 0.05);
  assert.equal(land.stats().entries, 2);
  // Antimeridian bbox raster sees both halves.
  const am = land.forBBox({ west: 170, south: -20, east: -170, north: 0 }, 0.05);
  assert.ok(am.isLand(179.5, -9.5) && am.isLand(-179.5, -9.5) && !am.isLand(178, -9.5));
  // Exact point tests honour holes and the antimeridian.
  assert.equal(land.isLandAt(10.2, 50.2), true);
  assert.equal(land.isLandAt(10.7, 50.7), false, 'lake');
  assert.equal(land.isLandAt(-70.5, 41.5), true);
  assert.equal(land.isLandAt(-70.5 + 360, 41.5), true);
  assert.equal(land.isLandAt(-179.5, -9.5), true);
  assert.equal(land.isLandAt(0, 0), false);
});

test('OnDemandLand: rasters saved on disk are reused by a new instance, identical to a fresh build', () => {
  const file = fixture();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-landcache-'));
  const view = { west: -72, south: 40, east: -69, north: 43 };
  const a = new OnDemandLand([file], { cacheDir });
  const built = a.forBBox(view, 0.05);
  assert.equal(a.stats().builds, 1);
  assert.equal(a.stats().disk_writes, 1);
  assert.equal(a.stats().disk.files, 1);
  // A new instance (as after a restart) reads it back instead of rasterising.
  const b = new OnDemandLand([file], { cacheDir });
  const loaded = b.forBBox(view, 0.05);
  assert.equal(b.stats().builds, 0);
  assert.equal(b.stats().disk_hits, 1);
  assert.equal(loaded.resolutionDeg, built.resolutionDeg);
  assert.deepEqual(loaded.bbox, built.bbox);
  assert.deepEqual(loaded.serializeRaster().raster, built.serializeRaster().raster);
  // A changed coastline file gets a different folder: nothing stale is reused.
  fs.appendFileSync(file, Buffer.alloc(0));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const c = new OnDemandLand([file], { cacheDir });
  c.forBBox(view, 0.05);
  assert.equal(c.stats().builds, 1);
  assert.equal(c.stats().disk_hits, 0);
  // The disk budget prunes least recently used rasters.
  const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-landcache-'));
  const d = new OnDemandLand([file], { cacheDir: pruneDir, diskBudgetBytes: 1 });
  for (let i = 0; i < 15; i++) d.forBBox({ west: -170 + i * 20, south: 0, east: -165 + i * 20, north: 5 }, 0.05);
  assert.equal(d.stats().disk.files, 15, 'no prune before the 16th write');
  d.forBBox({ west: 150, south: 0, east: 155, north: 5 }, 0.05); // 16th write → prune to the 1-byte budget
  assert.equal(d.stats().disk_writes, 16);
  assert.equal(d.stats().disk.files, 0);
});

test('overlay land resolution respects the cell budget and snapping is outward', () => {
  assert.equal(chooseOverlayResolution({ west: -80, south: 20, east: -40, north: 60 }, 0.2, 4_000_000), 0.05);
  // A whole-world request at fine spacing is coarsened to fit.
  const r = chooseOverlayResolution({ west: -180, south: -90, east: 180, north: 90 }, 0.02, 4_000_000);
  assert.ok(Math.ceil(360 / r) * Math.ceil(180 / r) <= 4_000_000);
  const b = snapBBox({ west: -71.3, south: 41.2, east: -70.1, north: 42.9 }, 0.01);
  assert.ok(b.west <= -71.3 && b.east >= -70.1 && b.south <= 41.2 && b.north >= 42.9);
  const w = snapBBox({ west: 175, south: -5, east: -175, north: 5 }, 0.01);
  assert.ok(w.west <= 175 && w.west > 170 && w.east >= -175 && w.east < -170);
});

// Point WRP_GSHHG_SHP at a GSHHG full-resolution L1 shapefile
// (GSHHS_shp/f/GSHHS_f_L1.shp) to run this; skipped otherwise.
const GSHHG = process.env.WRP_GSHHG_SHP ?? '';
test(
  'real GSHHG full resolution: indexed read equals the full scan; viewport build time',
  { skip: !(GSHHG && fs.existsSync(GSHHG)) && 'WRP_GSHHG_SHP not set' },
  () => {
    const b = { west: -75, south: 36, east: -65, north: 45 };
    let t = Date.now();
    const scan = readShapefilePolygons(GSHHG, b);
    const scanMs = Date.now() - t;
    t = Date.now();
    const ix = ShapefileIndex.open(GSHHG);
    const indexMs = Date.now() - t;
    t = Date.now();
    const read = ix.read(b);
    const readMs = Date.now() - t;
    assert.deepEqual(
      read.map(s => s.recordNumber),
      scan.map(s => s.recordNumber)
    );
    // Byte-level point test agrees with pointInShape on the decoded records.
    const pts: [number, number][] = [
      [-70.62, 41.39],
      [-70.5, 41.3],
      [-72, 42.3],
      [-69, 40],
      [-70.06, 41.28],
      [-76.3, 38.0],
      [-74.0, 40.7],
      [-66.5, 44.5],
    ];
    for (const [lon, lat] of pts) {
      const exact = ix.containing(lon, lat).some(s => pointInShape(s, lon, lat));
      assert.equal(ix.containsPoint(lon, lat), exact, `${lon},${lat}`);
    }
    assert.equal(ix.containsPoint(-72, 42.3), true, 'inland Massachusetts');
    assert.equal(ix.containsPoint(-69, 40), false, 'open Atlantic');
    console.log(
      `GSHHG f L1: index ${ix.count} records in ${indexMs} ms (${(ix.bytes() / 1e6).toFixed(1)} MB); bbox read ${readMs} ms indexed vs ${scanMs} ms full scan`
    );
  }
);

test('GSHHG L1 configuration expands all levels for indexed points, streamed rasters and exact masks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-hierarchy-'));
  try {
    for (let level = 1; level <= 4; level++) {
      const lo = level,
        hi = 10 - level;
      writeShp(path.join(dir, `GSHHS_f_L${level}.shp`), [
        [
          [
            [lo, lo],
            [hi, lo],
            [hi, hi],
            [lo, hi],
            [lo, lo],
          ],
        ],
      ]);
    }
    const files = [path.join(dir, 'GSHHS_f_L1.shp')];
    const land = new OnDemandLand(files);
    const mask = LandMask.fromShapefiles(files, { west: 0, south: 0, east: 10, north: 10 }, { resolutionDeg: 0.1 });
    const raster = land.forBBox({ west: 0, south: 0, east: 10, north: 10 }, 0.4);
    const cachedMask = LandMask.fromShapefiles(files, { west: 0, south: 0, east: 10, north: 10 }, { resolutionDeg: 0.1 });
    for (const [x, expected] of [
      [1.5, true],
      [2.5, false],
      [3.5, true],
      [5, false],
    ] as const) {
      assert.equal(land.isLandAt(x, x), expected);
      assert.equal(mask.isLandExact(x, x), expected);
      assert.equal(cachedMask.isLandPolygons(x, x), expected);
      assert.equal(raster.isLand(x, x), expected);
    }
    fs.unlinkSync(path.join(dir, 'GSHHS_f_L2.shp'));
    assert.throws(() => new OnDemandLand(files), /Incomplete GSHHG hierarchy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PolygonCache.forEach lists what a full scan lists, decoding each record once', () => {
  const file = fixture();
  const cache = new PolygonCache();
  const boxes = [
    { west: -72, south: 40, east: -69, north: 43 },
    { west: 170, south: -20, east: -170, north: 0 },
    { west: -180, south: -90, east: 180, north: 90 },
    { west: 0, south: 0, east: 1, north: 1 },
    { west: 9, south: 49, east: 13, north: 53 },
  ];
  for (const b of boxes) {
    const a = readShapefilePolygons(file, b);
    const c = cache.read([file], b);
    assert.deepEqual(
      c.map(s => s.recordNumber),
      a.map(s => s.recordNumber),
      JSON.stringify(b)
    );
    c.forEach((s, i) =>
      assert.deepEqual(
        s.rings.map(r => Array.from(r.coords)),
        a[i].rings.map(r => Array.from(r.coords))
      )
    );
  }
  // Four records in the file: decoded once each, every later listing a hit.
  const st = cache.stats();
  assert.equal(st.decodes, 4);
  assert.equal(st.entries, 4);
  assert.ok(st.hits > 0);
  assert.equal(st.evictions, 0);
  // The same object is handed out again (no copy).
  const first = cache.read([file], boxes[0])[0];
  assert.equal(cache.read([file], boxes[0])[0], first);
});

test('PolygonCache stays under its budget and still lists everything', () => {
  const file = fixture();
  const one = polygonBytes(readShapefilePolygons(file)[0]);
  const cache = new PolygonCache(2 * one + 10); // room for two of the four
  const world = { west: -180, south: -90, east: 180, north: 90 };
  const a = readShapefilePolygons(file, world).map(s => s.recordNumber);
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(
      cache.read([file], world).map(s => s.recordNumber),
      a
    );
    assert.ok(cache.stats().bytes <= cache.budgetBytes);
  }
  assert.ok(cache.stats().evictions > 0);
  // Streamed rasterisation through the cache equals rasterising a full scan.
  const res = 0.25;
  const all = LandMask.fromPolygons(readShapefilePolygons(file, world), world, res);
  const streamed = LandMask.rasterStreamed(world, res, add => {
    cache.forEach(file, world, add);
  });
  assert.deepEqual(streamed.raster, all.raster);
});
