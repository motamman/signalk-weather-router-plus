/**
 * No answer depends on where the frame is laid out (paged.ts, the file's comment). A flat frame shows the earth cut
 * open along the meridian opposite its middle; where that meridian falls is the frame's business, not the earth's. The
 * same questions are asked of a mesh in frames laid out so that it falls on every place the questions touch (on each
 * point and tile edge, a quarter and half a degree either side) and at every 30° round the earth, and each question
 * must get one answer: of a mesh across the date line, of a mesh joined all the way round the earth, of the rough cut
 * under areas to avoid, and of the whole mesh search across the join of a ring written from four longitudes.
 *
 * Nor does an answer depend on how long a thing is or on where round the earth the mesh lies: a straight walk of any
 * length goes as far as its 1° pieces chained, through the same triangles; a route as returned, read the short way
 * between its points, crosses no unusable water, has no step as long as half a turn, and its steps add up to the way
 * the search went, the same route wherever the ring is written from; and the nearest usable water is what a search of
 * every triangle finds, the short way round, also where the point's antipode lies inside a tile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { meshAstar } from './astar';
import { boundarySeeds, buildCoarseMap, type CoarseRules, meshRulesOf, PieceGraph } from './coarse';
import { idFilter, type Tri, writeGridMesh, writeRingMesh, writeTile } from './fixture';
import { MeshLand } from './land';
import { PagedMesh } from './paged';
import { searchMesh } from './route';
import { M_PER_DEG_MESH, MeshStore } from './store';
import { walkMesh } from './width';

const RULES = { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 };
const COARSE: CoarseRules = {
  draughtM: 2,
  airDraftM: 18,
  underKeelClearanceM: 0.5,
  overheadClearanceM: 1,
  bufferM: 0,
  openingBridges: 'open',
};

type LonLat = [number, number];
/** A longitude between -180 and 180, the date line as 180, to the millionth of a degree. */
const wrap = (lon: number): number => {
  const v = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.abs(v + 180) < 1e-7 ? 180 : Math.round(v * 1e6) / 1e6;
};
const mm = (v: number): number => Math.round(v * 1e3) / 1e3;
/** The seconds a run of `deg` degrees of longitude takes at the rules' speed, in a frame whose x is scaled by `cl`. */
const runS = (deg: number, cl = 1): number => (deg * M_PER_DEG_MESH * cl) / RULES.motorSpeedMs;
/** Equal to the hundredth of a second (a cost is a sum of many pieces). */
const close = (got: number, want: number, what: string): void =>
  assert.ok(Math.abs(got - want) < 0.01, `${what}: ${got}, expected ${want}`);

/** The frames: the meridian opposite the frame's middle on each of `places` and 0.25° and 0.5° either side, and every 30°. */
function frames(places: number[]): number[] {
  const out = new Set<number>();
  for (const p of places) for (const d of [-0.5, -0.25, 0, 0.25, 0.5]) out.add(wrap(p + d - 180));
  for (let c = -180; c < 180; c += 30) out.add(c);
  return [...out];
}

interface Question {
  name: string;
  ask: (pm: PagedMesh, land: MeshLand) => unknown;
}

/** The questions about points, straight legs and the search between two points. */
function questions(points: LonLat[], legs: [LonLat, LonLat][], searches: [LonLat, LonLat][]): Question[] {
  const q: Question[] = [];
  for (const p of points) {
    const at = `(${p[0]}, ${p[1]})`;
    q.push({ name: `the triangles holding ${at}`, ask: pm => pm.locateAll(...pm.toXY(p[0], p[1])).sort((a, b) => a - b) });
    q.push({ name: `is ${at} land`, ask: (_pm, land) => land.isLand(p[0], p[1]) });
    q.push({
      name: `the nearest usable water to ${at}`,
      ask: pm => {
        const u = pm.nearestUsable(...pm.toXY(p[0], p[1]));
        if (!u) return null;
        const [lon, lat] = pm.fromXY(u.x, u.y);
        return [u.tri, wrap(lon), mm(lat), mm(u.distM)];
      },
    });
    for (const bearing of [90, 270])
      q.push({
        name: `the room from ${at} on bearing ${bearing}`,
        ask: (_pm, land) => {
          const c = land.clearAlong(p[0], p[1], bearing, 150_000);
          return [mm(c.m), wrap(c.end[0]), mm(c.end[1])];
        },
      });
  }
  for (const [a, b] of legs) {
    const leg = `(${a[0]}, ${a[1]}) to (${b[0]}, ${b[1]})`;
    q.push({ name: `does the leg ${leg} cross land`, ask: (_pm, land) => land.legCrossesLandExact(a[0], a[1], b[0], b[1]) });
    q.push({
      name: `the triangles along the leg ${leg}`,
      ask: (pm, land) => {
        const along: unknown[] = [];
        const got = land.forEachTriangleAlong(...pm.toXY(a[0], a[1]), ...pm.toXY(b[0], b[1]), (t, from, to) =>
          along.push([t, mm(from), mm(to)])
        );
        return [mm(got), along];
      },
    });
  }
  for (const [a, b] of searches)
    q.push({
      name: `the search from (${a[0]}, ${a[1]}) to (${b[0]}, ${b[1]})`,
      ask: pm => {
        const [sx, sy] = pm.toXY(a[0], a[1]);
        const [ex, ey] = pm.toXY(b[0], b[1]);
        const r = meshAstar(pm, pm.locateAll(sx, sy), pm.locateAll(ex, ey), sx, sy, ex, ey, RULES.motorSpeedMs);
        return r.goalNode === -2 ? 'no route' : [mm(r.goalG), r.crossings().length];
      },
    });
  return q;
}

/** Ask every question in every frame; each must get one answer. Returns the answers, by question name. */
function sameInEveryFrame(make: (centre: number) => PagedMesh, qs: Question[], centres: number[]): Map<string, unknown> {
  const answers = new Map<string, Map<string, number[]>>(qs.map(q => [q.name, new Map()]));
  for (const c of centres) {
    const pm = make(c);
    const land = new MeshLand(pm);
    for (const q of qs) {
      let a: string;
      try {
        a = JSON.stringify(q.ask(pm, land));
      } catch (err) {
        a = `error: ${(err as Error).message}`;
      }
      const seen = answers.get(q.name)!;
      seen.set(a, [...(seen.get(a) ?? []), c]);
    }
  }
  const out = new Map<string, unknown>();
  for (const [name, seen] of answers) {
    const said = [...seen].map(([a, cs]) => `${a} in ${cs.length} frame(s), e.g. about ${cs[0]}°`);
    assert.equal(seen.size, 1, `${name}: ${said.join('; ')}`);
    const only = [...seen.keys()][0];
    assert.ok(!only.startsWith('error: '), `${name}: ${only}`);
    out.set(name, JSON.parse(only));
  }
  return out;
}

test('a mesh across the date line: every lookup, straight leg and search answers the same wherever the frame is laid out', () => {
  // 178°E to 178°W, two rows; the tile from 180 to 179°W in the top row is too shallow for the boat.
  const cells: { i: number; j: number; depth: number }[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) cells.push({ i, j, depth: i === 2 && j === 1 ? 1 : 10 });
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-frame-')), cells, 178);
  try {
    const store = MeshStore.open(dir);
    const lons = [178.25, 178.5, 179, 179.5, 180, -179.5, -179, -178.5, -178.25];
    const points: LonLat[] = lons.flatMap(lon => [0.5, 1, 1.5].map(lat => [lon, lat] as LonLat));
    const legs: [LonLat, LonLat][] = [];
    for (const lat of [0.5, 1.5])
      for (let a = 0; a < lons.length; a++)
        for (const b of [a + 1, a + 2, a + 4])
          if (b < lons.length)
            legs.push(
              [
                [lons[a], lat],
                [lons[b], lat],
              ],
              [
                [lons[b], lat],
                [lons[a], lat],
              ]
            );
    const searches: [LonLat, LonLat][] = [
      [
        [178.5, 0.5],
        [-178.5, 0.5],
      ],
      [
        [-178.5, 1.5],
        [178.5, 1.5],
      ],
    ];
    const got = sameInEveryFrame(
      c => new PagedMesh(store, RULES, 1).centred(c),
      questions(points, legs, searches),
      frames([...lons, 178, -178])
    );
    // What the one answer is, for a few of them: the date line is open water in the bottom row and the shallow tile
    // blocks the top row east of it.
    assert.equal(got.get('does the leg (179.5, 0.5) to (-179.5, 0.5) cross land'), false);
    assert.equal(got.get('does the leg (-179.5, 0.5) to (179.5, 0.5) cross land'), false);
    assert.equal(got.get('does the leg (179.5, 1.5) to (-179.5, 1.5) cross land'), true);
    assert.equal(got.get('is (-179.5, 1.5) land'), true);
    // The date line at mid-height of the bottom row is the right edge of the lower triangle of the tile west of it and
    // the left edge of the upper triangle of the tile east of it (fixture.ts squareTile; tile (i, j) is cell 2i + j
    // here, its triangles 2 x cell and 2 x cell + 1).
    const lower = (i: number, j: number): number => 2 * (2 * i + j);
    assert.deepEqual(got.get('the triangles holding (180, 0.5)'), [lower(1, 0), lower(2, 0) + 1]);
    // 3° straight along the bottom row (the frame's scale is 1 here).
    close((got.get('the search from (178.5, 0.5) to (-178.5, 0.5)') as number[])[0], runS(3), 'the search across the date line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mesh joined all the way round the earth: the same wherever the frame is laid out, also across its join and round a wall', () => {
  // 360 tiles of 1° from 180°W, the last joined to the first on the date line; the tile from 20°E to 21°E is too shallow.
  const dir = writeRingMesh(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-frame-')),
    Array.from({ length: 360 }, (_, i) => (i === 200 ? 1 : 10))
  );
  try {
    const store = MeshStore.open(dir);
    const lons = [-179.5, -135.5, -90.5, -0.5, 19.5, 21.5, 90.5, 179.5];
    const points: LonLat[] = [...lons, 180, 0, 20.5].map(lon => [lon, 0.5] as LonLat);
    const legs: [LonLat, LonLat][] = [];
    for (const lon of lons) {
      const east = wrap(lon + 1.25);
      legs.push(
        [
          [lon, 0.5],
          [east, 0.5],
        ],
        [
          [east, 0.5],
          [lon, 0.5],
        ]
      );
    }
    const searches: [LonLat, LonLat][] = [
      [
        [179.5, 0.5],
        [-179.5, 0.5],
      ],
      [
        [-90.5, 0.5],
        [-87.5, 0.5],
      ],
      [
        [19.5, 0.5],
        [21.5, 0.5],
      ],
    ];
    const got = sameInEveryFrame(
      c => new PagedMesh(store, RULES, 1).centred(c),
      questions(points, legs, searches),
      frames([...lons, 180, 0, 20, 21])
    );
    assert.equal(got.get('does the leg (179.5, 0.5) to (-179.25, 0.5) cross land'), false);
    assert.equal(got.get('does the leg (19.5, 0.5) to (20.75, 0.5) cross land'), true);
    assert.equal(got.get('is (20.5, 0.5) land'), true);
    // Across the join: 1° straight. Past the wall: the other way round the ring, 358° straight along the row.
    close((got.get('the search from (179.5, 0.5) to (-179.5, 0.5)') as number[])[0], runS(1), "the search across the ring's join");
    close((got.get('the search from (19.5, 0.5) to (21.5, 0.5)') as number[])[0], runS(358), 'the search past the wall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rough cut under areas to avoid: the tiles worked out again, the waters and the nearest water of one are the same wherever the frame is laid out', () => {
  // The mesh across the date line, all of it usable; areas to avoid on the date line, beside it and well away from it.
  const cells: { i: number; j: number }[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) cells.push({ i, j });
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-frame-')), cells, 178);
  try {
    const store = MeshStore.open(dir);
    const seeds = boundarySeeds(store, COARSE);
    const map = buildCoarseMap(store, COARSE, new PagedMesh(store, meshRulesOf(COARSE), 1, seeds));
    const areas = [
      [{ lon: -179.9, lat: 0.5, radiusM: 5000 }],
      [{ lon: 180, lat: 1, radiusM: 5000 }],
      [{ lon: 179.95, lat: 1.5, radiusM: 20_000 }],
      [{ lon: 178.5, lat: 0.5, radiusM: 5000 }],
    ];
    const centres = frames([180, -179.9, 179.95, 179, -179, 178.5]);
    areas.forEach((avoid, k) => {
      const seen = new Map<string, number[]>();
      for (const c of centres) {
        const pm = new PagedMesh(store, meshRulesOf(COARSE, avoid), 1, seeds).centred(c);
        const graph = new PieceGraph(map, pm);
        const water = graph.component(graph.pieceOf(pm.locate(...pm.toXY(-178.5, 1.5)))!);
        const nu = pm.nearestUsable(...pm.toXY(avoid[0].lon, avoid[0].lat), graph.waterOf([water]))!;
        const [lon, lat] = pm.fromXY(nu.x, nu.y);
        const a = JSON.stringify({
          again: [...graph.recomputed].sort((x, y) => x - y),
          pieces: graph.pieces.length,
          nearest: [wrap(lon), mm(lat), mm(nu.distM)],
        });
        seen.set(a, [...(seen.get(a) ?? []), c]);
      }
      assert.equal(
        seen.size,
        1,
        `area ${k}: ${[...seen].map(([a, cs]) => `${a} in ${cs.length} frame(s), e.g. about ${cs[0]}°`).join('; ')}`
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the whole mesh search across the join of a ring, and across the meridian opposite it, is the short way wherever the ring starts', () => {
  for (const west of [-180, -90, 10, 123]) {
    const dir = writeRingMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-frame-')), new Array<number>(360).fill(10), west);
    try {
      const store = MeshStore.open(dir);
      for (const from of [west - 1.5, west + 90.5, west + 178.5]) {
        const r = searchMesh(store, [wrap(from), 0.5], [wrap(from + 3), 0.5], RULES).result;
        assert.ok(r.ok, r.ok ? '' : r.reason);
        if (!r.ok) continue;
        // 3° straight along the row, one piece; the search's frame is scaled by the cosine of the leg's latitude (route.ts).
        close(r.costS, runS(3, Math.cos((0.5 * Math.PI) / 180)), `ring from ${west}°, leg from ${wrap(from)}°`);
        assert.equal(r.path.length, 2);
        assert.deepEqual(
          r.path.map(p => [wrap(p[0]), mm(p[1])]),
          [
            [wrap(from), 0.5],
            [wrap(from + 3), 0.5],
          ]
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** The longitude from `a` to `b` the short way round, degrees (east positive). */
const shortWay = (a: number, b: number): number => {
  const d = b - a;
  return d - 360 * Math.round(d / 360);
};

test('a straight walk of any length, up to all the way round, goes as far as its 1° pieces chained, through the same triangles', () => {
  const meshes: [string, number[]][] = [
    ['a ring, all of it usable', new Array<number>(360).fill(10)],
    ['a ring with the tile from 20°E to 21°E too shallow', Array.from({ length: 360 }, (_, i) => (i === 200 ? 1 : 10))],
  ];
  for (const [title, depths] of meshes) {
    const dir = writeRingMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-frame-')), depths);
    try {
      const store = MeshStore.open(dir);
      for (const centre of [undefined, 100, -37.25]) {
        const pm = new PagedMesh(store, RULES, 1).centred(centre);
        for (const lon0 of [19.5, -179.5, 150.25])
          for (const dir of [-1, 1])
            for (const lat of [0.5, 0.25])
              for (const deg of [1.3, 100, 181, 358]) {
                const what = `${title}, frame about ${pm.frameLon}°, from ${lon0}° ${dir < 0 ? 'west' : 'east'} at latitude ${lat} for ${deg}°`;
                const [x0, y0] = pm.toXY(lon0, lat);
                const start = pm.locate(x0, y0, true);
                const whole: number[] = [];
                const w = walkMesh(pm, start, x0, y0, dir, 0, deg * M_PER_DEG_MESH, false, t => {
                  if (whole[whole.length - 1] !== t) whole.push(t);
                });
                // The same walk in pieces of 1° (the last one the rest), each from where the one before ended, until
                // one stops short (unusable water).
                let gone = 0;
                let tri = start;
                const pieces: number[] = [];
                for (let stopped = false; gone < deg * M_PER_DEG_MESH - 1e-6 && !stopped;) {
                  const step = Math.min(M_PER_DEG_MESH, deg * M_PER_DEG_MESH - gone);
                  const [x, y] = pm.toXY(lon0 + (dir * gone) / M_PER_DEG_MESH, lat);
                  const p = walkMesh(pm, tri, x, y, dir, 0, step, false, t => {
                    if (pieces[pieces.length - 1] !== t) pieces.push(t);
                  });
                  gone += p.dist;
                  tri = p.tri;
                  stopped = p.dist < step - 1e-6;
                }
                assert.ok(Math.abs(w.dist - gone) < 1e-3, `${what}: the walk went ${w.dist} m, its pieces ${gone} m`);
                assert.deepEqual(whole, pieces, what);
              }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a route as returned crosses no unusable water, has no step as long as half a turn, adds up to the way the search went, and is the same wherever the ring is written from', () => {
  // A ring of 360 tiles of 1°; `walls` are tiles too shallow for the boat, numbered from the ring's first tile; the
  // leg from `from` to `to`, degrees east of the ring's start. `way`: the longitude the only open way covers.
  const scenes = [
    // One wall between the ends, 2° apart: the only way is west, all the way round but those 2°.
    { name: 'past a wall, the long way round', walls: [200], from: 199.5, to: 201.5, way: 201.5 - 199.5 - 360 },
    { name: 'the short way, no wall near', walls: [200], from: 10.5, to: 13.5, way: 13.5 - 10.5 },
    // Two walls 200° apart and both ends between them: the way is east, between the walls.
    { name: 'between two walls, 150° east', walls: [40, 240], from: 60.5, to: 210.5, way: 210.5 - 60.5 },
    { name: 'between two walls, 190° east (more than half a turn)', walls: [40, 240], from: 45.5, to: 235.5, way: 235.5 - 45.5 },
  ];
  const cl = Math.cos((0.5 * Math.PI) / 180);
  for (const sc of scenes) {
    const routes = new Map<string, number[]>();
    for (const west of [-180, -90, 10, 123]) {
      const what = `${sc.name}, the ring from ${west}°`;
      const dir = writeRingMesh(
        fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-frame-')),
        Array.from({ length: 360 }, (_, i) => (sc.walls.includes(i) ? 1 : 10)),
        west
      );
      try {
        const store = MeshStore.open(dir);
        const s = searchMesh(store, [wrap(west + sc.from), 0.5], [wrap(west + sc.to), 0.5], RULES);
        const r = s.result;
        assert.ok(r.ok, r.ok ? '' : `${what}: ${r.reason}`);
        if (!r.ok) continue;
        // The search's cost is the way along the row (the frame is scaled by the cosine of the leg's latitude, route.ts).
        close(r.costS, runS(Math.abs(sc.way), cl), `${what}: the search's cost`);
        const land = new MeshLand(new PagedMesh(store, RULES, cl));
        let sum = 0;
        for (let i = 1; i < r.path.length; i++) {
          const a: LonLat = r.path[i - 1];
          const b: LonLat = r.path[i];
          const step = shortWay(a[0], b[0]);
          assert.ok(Math.abs(step) < 180 - 1e-9, `${what}: step ${i} is half a turn or more (${a[0]} to ${b[0]})`);
          assert.equal(
            land.legCrossesLandExact(a[0], a[1], b[0], b[1]),
            false,
            `${what}: step ${i} (${a[0]} to ${b[0]}) crosses unusable water`
          );
          sum += step;
        }
        assert.ok(Math.abs(sum - sc.way) < 1e-6, `${what}: the returned steps add up to ${sum}° of longitude, the way is ${sc.way}°`);
        assert.equal(r.widths.length, r.path.length, `${what}: a width for every point`);
        // The route with the ring's start taken off its longitudes: the same for every ring.
        assert.ok(r.endTri !== undefined, `${what}: the triangle the route ends in`);
        const end = s.paged.tileOf(r.endTri);
        const said = JSON.stringify({
          path: r.path.map(p => [wrap(p[0] - west), mm(p[1])]),
          widths: r.widths.map(w => w.map(mm)),
          cost: mm(r.costS),
          lengthM: mm(r.lengthM),
          endsInTheTileAt: wrap((end.bbox[0] + end.bbox[2]) / 2 - west),
        });
        routes.set(said, [...(routes.get(said) ?? []), west]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(routes.size, 1, `${sc.name}: ${[...routes].map(([r, ws]) => `rings from ${ws.join(', ')}°: ${r}`).join('; ')}`);
  }
});

test('the nearest usable water is what a search of every triangle finds, the short way round, also where the point antipode lies inside a tile', () => {
  // Five tiles of 1° with no neighbours (the scan needs none), at 0°, 90°E, 179°E, 180° and 90°W, each with water in
  // two corners only: a thin triangle along its west side and a small one in its north-east corner.
  const corners = [0, 90, 179, -180, -90];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-frame-'));
  const tris: Tri[] = [];
  const tiles = corners.map((lon, k) => {
    const t: Tri[] = [
      [
        [lon, 0],
        [lon + 0.1, 0],
        [lon, 1],
      ],
      [
        [lon + 0.9, 0.9],
        [lon + 1, 0.9],
        [lon + 1, 1],
      ],
    ];
    const none = [
      [-1, -1, -1],
      [-1, -1, -1],
    ];
    writeTile(dir, `t${k}.bin`, t, none, none, [10, 10], [0, 0]);
    tris.push(...t);
    return { i: k, j: 0, file: `t${k}.bin`, first: 2 * k, n: 2, bbox: [lon, 0, lon + 1, 1] };
  });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ version: 1, west: -180, south: 0, east: 180, north: 1, tileDeg: 1, xScale: 1, triangles: tris.length, tiles })
  );
  /** How far (px, py) is from a triangle on a flat sheet, degrees (the frame's scale is 1 here). */
  const flat = (px: number, py: number, t: Tri): number => {
    const side = (k: number): number => {
      const [ux, uy] = t[k];
      const [vx, vy] = t[(k + 1) % 3];
      return (vx - ux) * (py - uy) - (vy - uy) * (px - ux);
    };
    if (side(0) >= 0 && side(1) >= 0 && side(2) >= 0) return 0;
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const [ux, uy] = t[k];
      const [vx, vy] = t[(k + 1) % 3];
      const ex = vx - ux;
      const ey = vy - uy;
      const f = Math.max(0, Math.min(1, ((px - ux) * ex + (py - uy) * ey) / (ex * ex + ey * ey)));
      best = Math.min(best, Math.hypot(ux + f * ex - px, uy + f * ey - py));
    }
    return best;
  };
  try {
    const store = MeshStore.open(dir);
    // Every 7.25° round the earth, and closely where a point's antipode lies inside one of the tiles.
    const lons: number[] = [];
    for (let lon = -180; lon < 180; lon += 7.25) lons.push(lon);
    for (const c of corners) for (let d = -0.1; d <= 1.1001; d += 0.05) lons.push(wrap(c + 180 + d));
    for (const centre of [undefined, 45, 179.9]) {
      const pm = new PagedMesh(store, RULES, 1).centred(centre);
      for (const wanted of [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [0], [1], [0, 3], [5, 6], [4, 7, 8]]) {
        const only = idFilter(pm, g => wanted.includes(g));
        for (const lon of lons)
          for (const lat of [0.05, 0.95, 4]) {
            const what = `frame about ${pm.frameLon}°, the water of triangles ${wanted}, from (${lon}, ${lat})`;
            // The short way round: the nearest of the point where it is and a turn either way.
            let want = Infinity;
            for (const g of wanted) for (const turn of [-360, 0, 360]) want = Math.min(want, flat(lon + turn, lat, tris[g]));
            const u = pm.nearestUsable(...pm.toXY(lon, lat), only)!;
            assert.ok(
              Math.abs(u.distM / M_PER_DEG_MESH - want) < 1e-6,
              `${what}: ${u.distM / M_PER_DEG_MESH}° away, a search of every triangle finds ${want}°`
            );
            // The point returned is that far from the point asked about.
            const [qLon, qLat] = pm.fromXY(u.x, u.y);
            assert.ok(
              Math.abs(Math.hypot(shortWay(lon, qLon), qLat - lat) - want) < 1e-6,
              `${what}: the point returned, (${qLon}, ${qLat})`
            );
          }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
