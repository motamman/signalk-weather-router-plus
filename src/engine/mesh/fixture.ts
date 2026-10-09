/**
 * Test fixture: write a small chart mesh in the on-disk tile format
 * (store.ts), so the tests of the tile reader, the search and the mesh
 * leg's child process run on real files. Not used by the plugin.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NO_HAZARD, NO_VALUE } from './store';

/** A triangle as three [x, y] corners (lon, lat in degrees with xScale 1). */
export type Tri = number[][];

/**
 * Write one tile file: unit-square triangles, mult 1, no clearance, no
 * hazard, flags 0; depth per triangle (default none).
 */
export function writeTile(dir: string, file: string, tris: Tri[], nb: number[][], rev: number[][], depths?: number[]): void {
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
  at += n; // flags 0
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
 * Two 1° tiles side by side (A at (0,0): ids 0, 1; B at (1,0): ids 2, 3),
 * sharing the vertex column at lon 1, with the given depths per triangle
 * (default: 10 m everywhere). Returns the mesh folder.
 */
export function writeTwoTileMesh(dir: string, depths: [number, number, number, number] = [10, 10, 10, 10]): string {
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
    [depths[0], depths[1]]
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
    [depths[2], depths[3]]
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
