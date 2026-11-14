/**
 * Test fixture: write a small chart mesh in the on-disk tile format
 * (store.ts), so the tests of the tile reader, the search and the mesh
 * leg's child process run on real files. Not used by the plugin.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { wrapEdge } from '../../geo/geodesy';
import type { PagedMesh, WaterFilter } from './paged';
import { NO_HAZARD, NO_VALUE } from './store';

/** A triangle as three [x, y] corners (lon, lat in degrees with xScale 1). */
export type Tri = number[][];

/**
 * Write one tile file: unit-square triangles, mult 1, no clearance, no
 * hazard; depth per triangle (default none), flags per triangle (default 0).
 */
export function writeTile(
  dir: string,
  file: string,
  tris: Tri[],
  nb: number[][],
  rev: number[][],
  depths?: number[],
  flags?: number[]
): void {
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
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(depths ? depths[i] : NO_VALUE, at); // depth
    at += 4;
  }
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(NO_VALUE, at); // clear
    at += 4;
  }
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(NO_HAZARD, at);
    at += 4;
  }
  for (const t of rev)
    for (const v of t) {
      buf.writeInt8(v, at);
      at += 1;
    }
  for (let i = 0; i < n; i++) {
    buf.writeUInt8(flags ? flags[i] : 0, at);
    at += 1;
  }
  if (at !== buf.length) throw new Error(`fixture tile: wrote ${at} of ${buf.length} bytes`);
  fs.writeFileSync(path.join(dir, file), buf);
}

/** A 1° tile of the unit square at (i, j), split along its rising diagonal: lower triangle (ids first) and upper triangle (first + 1). */
export function squareTile(i: number, j: number): Tri[] {
  return [
    [
      [i, j],
      [i + 1, j],
      [i + 1, j + 1],
    ],
    [
      [i, j],
      [i + 1, j + 1],
      [i, j + 1],
    ],
  ];
}

/**
 * A mesh of 1° tiles at the given cells (each tile two triangles split along
 * its rising diagonal, squareTile), neighbours joined across every shared
 * tile edge; per cell an optional depth and flags for both its triangles
 * (default 10 m, 0). Index origin (`west`, 0), xScale 1: column i is the degree
 * from `west + i` eastwards, and a column at or past 180 is stored as the mesh
 * format stores it (store.ts, the date line): its longitudes from -180, the
 * index's box with its west greater than its east. Returns the mesh folder.
 */
export function writeGridMesh(dir: string, cells: { i: number; j: number; depth?: number; flags?: number }[], west = 0): string {
  /** The longitude of column i's west edge, as stored. */
  const lonOf = (i: number): number => (west + i >= 180 ? west + i - 360 : west + i);
  const id = new Map(cells.map((c, k) => [`${c.i},${c.j}`, k]));
  // Global ids: cell k's lower triangle 2k, upper 2k + 1.
  const lower = (i: number, j: number): number => (id.has(`${i},${j}`) ? 2 * id.get(`${i},${j}`)! : -1);
  const upper = (i: number, j: number): number => (id.has(`${i},${j}`) ? 2 * id.get(`${i},${j}`)! + 1 : -1);
  const tiles = cells.map((c, k) => {
    const { i, j } = c;
    // Lower: edges bottom (→ upper of the cell below, its top edge 1), right (→ upper of the cell right, its left
    // edge 2), diagonal (→ own upper, edge 0). Upper: diagonal (→ own lower, edge 2), top (→ lower of the cell
    // above, its bottom edge 0), left (→ lower of the cell left, its right edge 1).
    const nb = [
      [upper(i, j - 1), upper(i + 1, j), 2 * k + 1],
      [2 * k, lower(i, j + 1), lower(i - 1, j)],
    ];
    const rev = nb.map((row, t) => row.map((g, e) => (g < 0 ? -1 : t === 0 ? [1, 2, 0][e] : [2, 0, 1][e])));
    const file = `t_${i}_${j}.bin`;
    const d = c.depth ?? 10;
    const f = c.flags ?? 0;
    writeTile(dir, file, squareTile(lonOf(i), j), nb, rev, [d, d], [f, f]);
    return { i, j, file, first: 2 * k, n: 2, bbox: [lonOf(i), j, lonOf(i) + 1, j + 1] };
  });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      west,
      south: 0,
      east: wrapEdge(west + Math.max(...cells.map(c => c.i)) + 1),
      north: Math.max(...cells.map(c => c.j)) + 1,
      tileDeg: 1,
      xScale: 1,
      triangles: cells.length * 2,
      tiles,
    })
  );
  return dir;
}

/**
 * Two 1° tiles side by side (A at (0,0): ids 0, 1; B at (1,0): ids 2, 3),
 * sharing the vertex column at lon 1, with the given depths per triangle
 * (default: 10 m everywhere) and flags (default 0). Returns the mesh folder.
 */
export function writeTwoTileMesh(
  dir: string,
  depths: [number, number, number, number] = [10, 10, 10, 10],
  flags: [number, number, number, number] = [0, 0, 0, 0]
): string {
  writeTile(
    dir,
    'a.bin',
    squareTile(0, 0),
    [
      [-1, 3, 1],
      [0, -1, -1],
    ],
    [
      [-1, 2, 0],
      [2, -1, -1],
    ],
    [depths[0], depths[1]],
    [flags[0], flags[1]]
  );
  writeTile(
    dir,
    'b.bin',
    squareTile(1, 0),
    [
      [-1, -1, 3],
      [2, -1, 0],
    ],
    [
      [-1, -1, 0],
      [2, -1, 1],
    ],
    [depths[2], depths[3]],
    [flags[2], flags[3]]
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
      xScale: 1,
      triangles: 4,
      tiles: [
        { i: 0, j: 0, file: 'a.bin', first: 0, n: 2, bbox: [0, 0, 1, 1] },
        { i: 1, j: 0, file: 'b.bin', first: 2, n: 2, bbox: [1, 0, 2, 1] },
      ],
    })
  );
  return dir;
}

/**
 * A filter for the nearest-water search (paged.ts WaterFilter) from a test of triangle ids that reads no tile: the
 * test, and the tiles holding an id it takes (from the mesh's index).
 */
export function idFilter(pm: PagedMesh, accept: (g: number) => boolean): WaterFilter {
  const tiles = new Set<number>();
  for (let idx = 0; idx < pm.tileCount; idx++) {
    const info = pm.infoAt(idx)!;
    for (let g = info.first; g < info.first + info.n; g++)
      if (accept(g)) {
        tiles.add(idx);
        break;
      }
  }
  return { accept, tiles };
}
