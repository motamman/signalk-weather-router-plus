/**
 * Builder for the global water grid (see watergrid.ts).
 *
 * The world is processed in 10° tiles. Each tile is rasterised at the
 * fine resolution (0.005°, centre-sampled) together with a 1.2° halo, so
 *  - edges on the tile border (including the antimeridian, where the halo
 *    wraps) see the neighbouring tile's fine cells directly;
 *  - the distance-to-land field (an anisotropic Euclidean distance
 *    transform in metres) near the tile border sees land in the halo;
 *  - narrow passages near a tile border are judged with their context.
 * Memory is bounded by one tile (about 6 M fine cells: 6 MB raster plus
 * 25 MB of distances) plus the three global bit planes (60 MB).
 *
 * Narrow passages (chokepoints) are found with a merge tree of the
 * coarse cells' clearance (the largest distance to land of any fine water
 * cell in the coarse cell) inside local windows (2° core, 1° margin):
 * cells are added from the widest water down; when a cell joins two
 * components whose widest water is clearly wider than the cell itself,
 * that cell is the narrowest point of a passage between them. Windows are
 * local on purpose: the Strait of Messina is a passage between two basins
 * that are also connected the long way round Sicily, which a global merge
 * tree would never report.
 */

import { shorelinePaths } from './shapefile';
import type { BBox } from './geodesy';
import { lonOffset, unwrapLonNear } from './angles';
import { M_PER_DEG } from '../geo/units';
import { DEG, wrapLon } from './geodesy';
import { LandMask } from './landmask';
import { ShapefileIndex } from './shapefile';
import { CANALS, type CanalDef } from './watergrid_canals';
import {
  Chokepoints,
  SplitCells,
  WaterGrid,
  WG_FINE_PER_CELL,
  WG_NX,
  WG_NY,
  WG_RES,
  WG_VERSION,
  sourceFingerprints,
  type CanalRecord,
  type WaterGridHeader,
} from './watergrid';

export interface ChokepointParams {
  /** Largest clearance (half-width) reported, metres. */
  maxClearanceM: number;
  /** Both sides' widest water must be at least ratio × the passage clearance… */
  ratio: number;
  /** …and at least this much wider, metres… */
  minDiffM: number;
  /** …and at least this clearance, metres (basins narrower than 2× this are ignored). */
  minBasinClearanceM: number;
}

export const DEFAULT_CHOKEPOINT_PARAMS: ChokepointParams = {
  maxClearanceM: 20_000,
  ratio: 1.5,
  minDiffM: 500,
  minBasinClearanceM: 1_000,
};

// ---------------------------------------------------------------------
// Coarse bits from a fine raster

export interface SplitRecord {
  /** Coarse cell index in the raster's coarse grid. */
  cell: number;
  /** 16 labels: sides S, N, W, E × 4 positions (west→east / south→north); 0 = land. */
  labels: Uint8Array;
  /** Crossing masks: bits 0–3 east, 4–7 north, 8–11 west, 12–15 south. */
  cross: number;
}

export interface CoarseBits {
  cnx: number;
  cny: number;
  /** One byte per coarse cell: 1 = water / edge open. */
  water: Uint8Array;
  east: Uint8Array;
  north: Uint8Array;
  /** Cells whose fine water forms 2+ components touching the cell border. */
  splits: SplitRecord[];
}

/**
 * Coarse water / east / north bits for a fine raster (1 = land, row 0 =
 * south) aggregated by k × k. East/north edges on the raster's own east
 * and north border are closed (nothing known beyond). The edge rule: an
 * edge is open when some fine row (column) has water on both sides of it,
 * i.e. a 4-connected fine water path inside the two cells crosses it.
 */
export function coarseBitsFromFine(fine: Uint8Array, fnx: number, fny: number, k: number): CoarseBits {
  if (fnx % k || fny % k) throw new Error(`coarseBitsFromFine: ${fnx}x${fny} is not a multiple of ${k}`);
  const cnx = fnx / k;
  const cny = fny / k;
  const water = new Uint8Array(cnx * cny);
  const east = new Uint8Array(cnx * cny);
  const north = new Uint8Array(cnx * cny);
  const splits: SplitRecord[] = [];
  const lab = new Int8Array(k * k);
  const stack: number[] = [];
  for (let cy = 0; cy < cny; cy++) {
    for (let cx = 0; cx < cnx; cx++) {
      const ci = cy * cnx + cx;
      const fy0 = cy * k;
      const fx0 = cx * k;
      let w = 0;
      for (let dy = 0; dy < k; dy++) {
        const base = (fy0 + dy) * fnx + fx0;
        for (let dx = 0; dx < k; dx++) if (!fine[base + dx]) w++;
      }
      water[ci] = w ? 1 : 0;
      if (!w) continue;
      if (k === 4 && w > 1 && w < k * k) {
        const rec = splitRecord(fine, fnx, fny, k, fx0, fy0, lab, stack);
        if (rec) {
          rec.cell = ci;
          splits.push(rec);
        }
      }
      if (cx + 1 < cnx) {
        const xa = fx0 + k - 1;
        for (let dy = 0; dy < k; dy++) {
          const row = (fy0 + dy) * fnx;
          if (!fine[row + xa] && !fine[row + xa + 1]) {
            east[ci] = 1;
            break;
          }
        }
      }
      if (cy + 1 < cny) {
        const ya = (fy0 + k - 1) * fnx;
        const yb = ya + fnx;
        for (let dx = 0; dx < k; dx++) {
          if (!fine[ya + fx0 + dx] && !fine[yb + fx0 + dx]) {
            north[ci] = 1;
            break;
          }
        }
      }
    }
  }
  return { cnx, cny, water, east, north, splits };
}

/**
 * Label the fine 4-components of one k × k block; when two or more touch
 * the block border, return its split record (labels along the sides and
 * the crossing masks to the neighbouring fine cells), else null.
 */
function splitRecord(
  fine: Uint8Array,
  fnx: number,
  fny: number,
  k: number,
  fx0: number,
  fy0: number,
  lab: Int8Array,
  stack: number[]
): SplitRecord | null {
  const isW = (x: number, y: number): boolean => fine[(fy0 + y) * fnx + fx0 + x] === 0;
  lab.fill(0);
  let comps = 0;
  for (let s = 0; s < k * k; s++) {
    const sx = s % k;
    const sy = Math.floor(s / k);
    if (lab[s] || !isW(sx, sy)) continue;
    comps++;
    lab[s] = comps;
    stack.push(s);
    while (stack.length) {
      const t = stack.pop()!;
      const tx = t % k;
      const ty = Math.floor(t / k);
      if (tx + 1 < k && !lab[t + 1] && isW(tx + 1, ty)) {
        lab[t + 1] = comps;
        stack.push(t + 1);
      }
      if (tx > 0 && !lab[t - 1] && isW(tx - 1, ty)) {
        lab[t - 1] = comps;
        stack.push(t - 1);
      }
      if (ty + 1 < k && !lab[t + k] && isW(tx, ty + 1)) {
        lab[t + k] = comps;
        stack.push(t + k);
      }
      if (ty > 0 && !lab[t - k] && isW(tx, ty - 1)) {
        lab[t - k] = comps;
        stack.push(t - k);
      }
    }
  }
  if (comps < 2) return null;
  // Components that touch the border, renumbered 1.. in first-seen order along S, N, W, E.
  const labels = new Uint8Array(16);
  const pos = (side: number, i: number): [number, number] =>
    side === 0 ? [i, 0] : side === 1 ? [i, k - 1] : side === 2 ? [0, i] : [k - 1, i];
  const renum = new Map<number, number>();
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < k; i++) {
      const [x, y] = pos(side, i);
      const l = lab[y * k + x];
      if (!l) continue;
      if (!renum.has(l)) renum.set(l, renum.size + 1);
      labels[side * 4 + i] = renum.get(l)!;
    }
  }
  if (renum.size < 2) return null;
  // Crossing masks: this border fine cell and the adjacent fine cell outside both water.
  const outside = (x: number, y: number): boolean => {
    const gx = fx0 + x;
    const gy = fy0 + y;
    if (gx < 0 || gy < 0 || gx >= fnx || gy >= fny) return false;
    return fine[gy * fnx + gx] === 0;
  };
  let cross = 0;
  for (let i = 0; i < k; i++) {
    if (labels[3 * 4 + i] && outside(k, i)) cross |= 1 << i; // east
    if (labels[1 * 4 + i] && outside(i, k)) cross |= 1 << (4 + i); // north
    if (labels[2 * 4 + i] && outside(-1, i)) cross |= 1 << (8 + i); // west
    if (labels[0 * 4 + i] && outside(i, -1)) cross |= 1 << (12 + i); // south
  }
  return { cell: -1, labels, cross };
}

// ---------------------------------------------------------------------
// Anisotropic Euclidean distance transform (Felzenszwalb & Huttenlocher)

function edt1d(f: Float64Array, n: number, h: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  // Parabolas rooted at x_q = q·h with height f[q]; lower envelope.
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] >= 1e300) continue;
    if (f[v[k]] >= 1e300) {
      // First finite parabola replaces the placeholder.
      v[k] = q;
      continue;
    }
    const xq = q * h;
    let s = (f[q] + xq * xq - (f[v[k]] + (v[k] * h) ** 2)) / (2 * (xq - v[k] * h));
    while (s <= z[k]) {
      k--;
      s = (f[q] + xq * xq - (f[v[k]] + (v[k] * h) ** 2)) / (2 * (xq - v[k] * h));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]] >= 1e300) {
    for (let q = 0; q < n; q++) d[q] = Infinity;
    return;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    const x = q * h;
    while (z[k + 1] < x) k++;
    const dx = x - v[k] * h;
    d[q] = dx * dx + f[v[k]];
  }
}

/**
 * Distance in metres from every cell centre to the nearest land cell
 * centre (0 on land), capped at `capM`. Cells are `res` degrees; row 0 is
 * at `southLat`. Horizontal spacing follows each row's latitude.
 */
export function distanceToLandM(land: Uint8Array, nx: number, ny: number, southLat: number, res: number, capM: number): Float32Array {
  const INF = 1e301;
  const out = new Float32Array(nx * ny);
  const maxN = Math.max(nx, ny);
  const f = new Float64Array(maxN);
  const d = new Float64Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);
  const dy = res * M_PER_DEG;
  const cap2 = capM * capM;
  // Columns (uniform spacing dy); squared metres kept in `out` (Float32 is plenty below the cap).
  for (let j = 0; j < nx; j++) {
    for (let i = 0; i < ny; i++) f[i] = land[i * nx + j] ? 0 : INF;
    edt1d(f, ny, dy, d, v, z);
    for (let i = 0; i < ny; i++) out[i * nx + j] = d[i] > cap2 ? cap2 * 4 : d[i];
  }
  // Rows (spacing by latitude).
  for (let i = 0; i < ny; i++) {
    const lat = southLat + (i + 0.5) * res;
    const dx = Math.max(1, res * M_PER_DEG * Math.cos(lat * DEG));
    const base = i * nx;
    for (let j = 0; j < nx; j++) {
      const g = out[base + j];
      f[j] = g >= cap2 * 4 ? INF : g;
    }
    edt1d(f, nx, dx, d, v, z);
    for (let j = 0; j < nx; j++) {
      const s = Math.sqrt(d[j]);
      out[base + j] = s > capM ? capM : s;
    }
  }
  return out;
}

/** Per coarse cell: the largest fine distance-to-land among its fine cells, and where. */
export function coarseClearance(dist: Float32Array, fnx: number, fny: number, k: number): { clear: Float32Array; argmax: Int32Array } {
  const cnx = fnx / k;
  const cny = fny / k;
  const clear = new Float32Array(cnx * cny);
  const argmax = new Int32Array(cnx * cny).fill(-1);
  for (let cy = 0; cy < cny; cy++) {
    for (let cx = 0; cx < cnx; cx++) {
      let best = 0;
      let at = -1;
      for (let dy = 0; dy < k; dy++) {
        const base = (cy * k + dy) * fnx + cx * k;
        for (let dx = 0; dx < k; dx++) {
          const val = dist[base + dx];
          if (val > best) {
            best = val;
            at = base + dx;
          }
        }
      }
      clear[cy * cnx + cx] = best;
      argmax[cy * cnx + cx] = at;
    }
  }
  return { clear, argmax };
}

// ---------------------------------------------------------------------
// Chokepoints: windowed merge tree

export interface SaddleEvent {
  /** Cell index (window grid) of the narrowest point. */
  cell: number;
  /** Clearance there, metres (width ≈ 2×). */
  clearanceM: number;
  /** Endpoints (cell indices) of short ascents into the two basins (axis). */
  a: number;
  b: number;
}

/**
 * Merge tree over the cells of a grid window. `clear` is the clearance per
 * cell (0 = land), `east` / `north` the edge bits (1 = open). Only events
 * whose cell lies in the core box [x0, x1) × [y0, y1) are returned.
 */
export function mergeTreeSaddles(
  clear: Float32Array,
  east: Uint8Array,
  north: Uint8Array,
  nx: number,
  ny: number,
  win: { x0: number; y0: number; x1: number; y1: number },
  core: { x0: number; y0: number; x1: number; y1: number },
  params: ChokepointParams = DEFAULT_CHOKEPOINT_PARAMS
): SaddleEvent[] {
  if (win.x0 < 0 || win.y0 < 0 || win.x1 > nx || win.y1 > ny) throw new Error('mergeTreeSaddles: window outside the grid');
  const ww = win.x1 - win.x0;
  const wh = win.y1 - win.y0;
  const n = ww * wh;
  const QUANT = 10; // metres per bucket
  let maxQ = 0;
  const q = new Int32Array(n);
  let count = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const c = clear[(win.y0 + y) * nx + win.x0 + x];
      if (c > 0) {
        const b = Math.floor(c / QUANT);
        q[y * ww + x] = b + 1;
        if (b + 1 > maxQ) maxQ = b + 1;
        count++;
      }
    }
  }
  if (count === 0) return [];
  // Counting sort, widest first; ties in index order.
  const start = new Int32Array(maxQ + 2);
  for (let i = 0; i < n; i++) if (q[i]) start[maxQ - q[i] + 1]++;
  for (let b = 1; b <= maxQ + 1; b++) start[b] += start[b - 1];
  const order = new Int32Array(count);
  for (let i = 0; i < n; i++) if (q[i]) order[start[maxQ - q[i]]++] = i;

  const parent = new Int32Array(n).fill(-1);
  const mx = new Float32Array(n);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const cl = (i: number): number => clear[(win.y0 + Math.floor(i / ww)) * nx + win.x0 + (i % ww)];
  const open = (i: number, dx: number, dy: number): boolean => {
    const x = i % ww;
    const y = Math.floor(i / ww);
    const gx = win.x0 + x;
    const gy = win.y0 + y;
    if (dx === 1) return x + 1 < ww && east[gy * nx + gx] === 1;
    if (dx === -1) return x > 0 && east[gy * nx + gx - 1] === 1;
    if (dy === 1) return y + 1 < wh && north[gy * nx + gx] === 1;
    return y > 0 && north[(gy - 1) * nx + gx] === 1;
  };
  const DIRS: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  // Short steepest ascent from a cell (for the passage axis).
  const ascend = (from: number, steps: number): number => {
    let cur = from;
    for (let s = 0; s < steps; s++) {
      let best = cur;
      let bestC = cl(cur);
      for (const [dx, dy] of DIRS) {
        if (!open(cur, dx, dy)) continue;
        const nb = cur + dx + dy * ww;
        const c = cl(nb);
        if (c > bestC) {
          bestC = c;
          best = nb;
        }
      }
      if (best === cur) break;
      cur = best;
    }
    return cur;
  };
  const events: SaddleEvent[] = [];
  for (let o = 0; o < count; o++) {
    const x = order[o];
    const s = cl(x);
    parent[x] = x;
    mx[x] = s;
    let root = x;
    let firstNb = -1;
    for (const [dx, dy] of DIRS) {
      if (!open(x, dx, dy)) continue;
      const nb = x + dx + dy * ww;
      if (parent[nb] < 0) continue; // not processed yet
      const r = find(nb);
      if (r === root) continue;
      if (root !== x || firstNb >= 0) {
        // x already belongs to another component: a merge of two basins at x.
        const m1 = mx[root];
        const m2 = mx[r];
        const lo = Math.min(m1, m2);
        const gx = (x % ww) + win.x0;
        const gy = Math.floor(x / ww) + win.y0;
        if (
          s <= params.maxClearanceM &&
          lo >= params.ratio * s &&
          lo >= s + params.minDiffM &&
          lo >= params.minBasinClearanceM &&
          gx >= core.x0 &&
          gx < core.x1 &&
          gy >= core.y0 &&
          gy < core.y1
        ) {
          const a = ascend(firstNb >= 0 ? firstNb : x, 8);
          const b = ascend(nb, 8);
          events.push({
            cell: gy * nx + gx,
            clearanceM: s,
            a: (Math.floor(a / ww) + win.y0) * nx + (a % ww) + win.x0,
            b: (Math.floor(b / ww) + win.y0) * nx + (b % ww) + win.x0,
          });
        }
      } else {
        firstNb = nb;
      }
      // Union (keep the larger max as the root's value).
      if (mx[r] >= mx[root]) {
        parent[root] = r;
        root = r;
      } else {
        parent[r] = root;
      }
      if (s > mx[root]) mx[root] = s;
    }
  }
  return events;
}

// ---------------------------------------------------------------------
// Canal cuts

/**
 * Edges crossed by a segment (grid DDA over a global grid of `res` cells,
 * nx columns; longitudes may cross the antimeridian). Returns edge ids
 * cellIndex * 2 + (0 east | 1 north). At an exact corner crossing all four
 * edges of the two L-paths are returned, so the cut blocks diagonal moves.
 */
export function edgesCrossedBySegment(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  res = WG_RES,
  nx = WG_NX,
  ny = WG_NY
): number[] {
  const dl = unwrapLonNear(lon2 - lon1, 0);
  const x1 = (wrapLon(lon1) + 180) / res;
  const y1 = (lat1 + 90) / res;
  const x2 = x1 + dl / res;
  const y2 = (lat2 + 90) / res;
  const out = new Set<number>();
  const wrap = (c: number): number => ((c % nx) + nx) % nx;
  const eastId = (r: number, c: number): number => (r * nx + wrap(c)) * 2;
  const northId = (r: number, c: number): number => (r * nx + wrap(c)) * 2 + 1;
  let cx = Math.floor(x1);
  let cy = Math.floor(y1);
  const ex = Math.floor(x2);
  const ey = Math.floor(y2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? (sx > 0 ? cx + 1 - x1 : x1 - cx) * tDx : Infinity;
  let tMaxY = dy !== 0 ? (sy > 0 ? cy + 1 - y1 : y1 - cy) * tDy : Infinity;
  let guard = 0;
  while ((cx !== ex || cy !== ey) && guard++ < 1_000_000) {
    if (Math.min(tMaxX, tMaxY) > 1) break;
    if (Math.abs(tMaxX - tMaxY) < 1e-12) {
      // Corner: both L-paths.
      const nxC = cx + sx;
      const nyR = cy + sy;
      out.add(eastId(cy, sx > 0 ? cx : nxC));
      out.add(northId(sy > 0 ? cy : nyR, nxC));
      out.add(northId(sy > 0 ? cy : nyR, cx));
      out.add(eastId(nyR, sx > 0 ? cx : nxC));
      cx = nxC;
      cy = nyR;
      tMaxX += tDx;
      tMaxY += tDy;
    } else if (tMaxX < tMaxY) {
      out.add(eastId(cy, sx > 0 ? cx : cx - 1));
      cx += sx;
      tMaxX += tDx;
    } else {
      if (!(sy < 0 && cy === 0) && !(sy > 0 && cy >= ny - 1)) out.add(northId(sy > 0 ? cy : cy - 1, cx));
      cy += sy;
      tMaxY += tDy;
    }
  }
  return [...out].filter(id => Math.floor(id / 2 / nx) >= 0 && Math.floor(id / 2 / nx) < ny);
}

/** Canal records for a grid: the currently open edges crossed by each canal's cuts. */
export function canalRecords(grid: WaterGrid, canals: readonly CanalDef[] = CANALS): CanalRecord[] {
  return canals.map(c => {
    const edges = new Set<number>();
    for (const [a, b] of c.cuts) {
      for (const e of edgesCrossedBySegment(a[1], a[0], b[1], b[0], grid.res, grid.nx, grid.ny)) {
        const idx = Math.floor(e / 2);
        const plane = e % 2 === 0 ? grid.east : grid.north;
        if (plane[idx >> 3] & (1 << (idx & 7))) edges.add(e);
      }
    }
    return { name: c.name, edges: [...edges].sort((x, y) => x - y) };
  });
}

// ---------------------------------------------------------------------
// Global build

export interface BuildOptions {
  /** Restrict to tiles intersecting this box (tests, partial builds); others stay land. */
  region?: BBox;
  tileDeg?: number;
  haloDeg?: number;
  chokepoints?: ChokepointParams;
  onProgress?: (done: number, total: number, message: string) => void;
  /** Return true to abort (throws). */
  shouldCancel?: () => boolean;
}

function setBit(plane: Uint8Array, idx: number): void {
  plane[idx >> 3] |= 1 << (idx & 7);
}

/**
 * Build the global grid from coastline shapefiles (union of their land).
 * Deterministic for the same inputs.
 */
export function buildWaterGrid(shapefiles: string[], opts: BuildOptions = {}): WaterGrid {
  const t0 = Date.now();
  const TILE = opts.tileDeg ?? 10;
  const K = WG_FINE_PER_CELL;
  const FINE = WG_RES / K;
  const HALO_C = Math.round((opts.haloDeg ?? 1.2) / WG_RES); // coarse cells
  const HALO_F = HALO_C * K;
  const TILE_C = Math.round(TILE / WG_RES);
  const TILE_F = TILE_C * K;
  const CORE_C = 100; // 2° chokepoint window cores
  const MARGIN_C = 50; // 1° window margin
  if (TILE_C % CORE_C) throw new Error('tile size must be a multiple of 2°');
  if (MARGIN_C > HALO_C) throw new Error('halo must be at least the chokepoint window margin (1°)');
  const params = opts.chokepoints ?? DEFAULT_CHOKEPOINT_PARAMS;
  const capM = Math.max(params.maxClearanceM * 3, 60_000);
  shapefiles = shorelinePaths(shapefiles);
  const indexes = shapefiles.map(p => ShapefileIndex.open(p));
  const grid = WaterGrid.empty();
  const { water, east, north } = grid;
  const cpLat: number[] = [];
  const cpLon: number[] = [];
  const cpW: number[] = [];
  const cpAxis: number[] = [];
  const splitCells: SplitRecord[] = [];
  const stats = { tiles: 0, tilesMixed: 0, tilesWater: 0, tilesLand: 0, waterCells: 0, eastOpen: 0, northOpen: 0, splitCells: 0 };

  const tiles: [number, number][] = [];
  for (let lat0 = -90; lat0 < 90; lat0 += TILE) {
    for (let lon0 = -180; lon0 < 180; lon0 += TILE) {
      if (opts.region) {
        const r = opts.region;
        if (lat0 + TILE <= r.south || lat0 >= r.north) continue;
        const rw = lonOffset(r.east, r.west) || 360;
        const off = lonOffset(lon0, r.west);
        const off2 = lonOffset(r.west, lon0);
        if (!(off < rw || off2 < TILE)) continue;
      }
      tiles.push([lat0, lon0]);
    }
  }
  let done = 0;
  for (const [lat0, lon0] of tiles) {
    if (opts.shouldCancel?.()) throw new Error('water grid build cancelled');
    const haloS = Math.min(HALO_F, Math.round((lat0 + 90) / FINE));
    const haloN = Math.min(HALO_F, Math.round((90 - lat0 - TILE) / FINE));
    const fnx = TILE_F + 2 * HALO_F;
    const fny = TILE_F + haloS + haloN;
    const south = lat0 - haloS * FINE;
    const north_ = lat0 + TILE + haloN * FINE;
    const bbox: BBox = { west: wrapLon(lon0 - HALO_F * FINE), east: wrapLon(lon0 + TILE + HALO_F * FINE), south, north: north_ };
    const mask = LandMask.rasterStreamed(
      bbox,
      FINE,
      add => {
        for (const ix of indexes) ix.forEach(bbox, add);
      },
      { edgeCells: false, nx: fnx, ny: fny }
    );
    const fine = mask.raster;
    let land = 0;
    for (let i = 0; i < fine.length; i++) land += fine[i];
    const gRow0 = Math.round((lat0 + 90) / WG_RES);
    const gCol0 = Math.round((lon0 + 180) / WG_RES);
    const coreY0 = haloS / K;
    const coreX0 = HALO_C;
    stats.tiles++;
    if (land === fine.length) {
      stats.tilesLand++;
    } else if (land === 0) {
      stats.tilesWater++;
      for (let r = 0; r < TILE_C; r++) {
        const gr = gRow0 + r;
        for (let c = 0; c < TILE_C; c++) {
          const gi = gr * WG_NX + gCol0 + c;
          setBit(water, gi);
          setBit(east, gi);
          if (gr < WG_NY - 1) setBit(north, gi);
        }
      }
    } else {
      stats.tilesMixed++;
      const bits = coarseBitsFromFine(fine, fnx, fny, K);
      const cnx = bits.cnx;
      for (let r = 0; r < TILE_C; r++) {
        const gr = gRow0 + r;
        for (let c = 0; c < TILE_C; c++) {
          const wi = (coreY0 + r) * cnx + coreX0 + c;
          const gi = gr * WG_NX + gCol0 + c;
          if (bits.water[wi]) setBit(water, gi);
          if (bits.east[wi]) setBit(east, gi);
          if (bits.north[wi] && gr < WG_NY - 1) setBit(north, gi);
        }
      }
      for (const sp of bits.splits) {
        const wy = Math.floor(sp.cell / cnx);
        const wx = sp.cell % cnx;
        if (wy < coreY0 || wy >= coreY0 + TILE_C || wx < coreX0 || wx >= coreX0 + TILE_C) continue;
        let cross = sp.cross;
        if (gRow0 + wy - coreY0 >= WG_NY - 1) cross &= ~(0xf << 4); // no north neighbour at the pole row
        splitCells.push({ cell: (gRow0 + wy - coreY0) * WG_NX + gCol0 + wx - coreX0, labels: sp.labels, cross });
      }
      // Clearance and chokepoints.
      const dist = distanceToLandM(fine, fnx, fny, south, FINE, capM);
      const { clear, argmax } = coarseClearance(dist, fnx, fny, K);
      for (let by = 0; by < TILE_C / CORE_C; by++) {
        for (let bx = 0; bx < TILE_C / CORE_C; bx++) {
          const core = {
            x0: coreX0 + bx * CORE_C,
            y0: coreY0 + by * CORE_C,
            x1: coreX0 + (bx + 1) * CORE_C,
            y1: coreY0 + (by + 1) * CORE_C,
          };
          let any = false;
          for (let y = core.y0; y < core.y1 && !any; y++) {
            for (let x = core.x0; x < core.x1; x++) {
              const c = clear[y * cnx + x];
              if (c > 0 && c <= params.maxClearanceM) {
                any = true;
                break;
              }
            }
          }
          if (!any) continue;
          const win = {
            x0: Math.max(0, core.x0 - MARGIN_C),
            y0: Math.max(0, core.y0 - MARGIN_C),
            x1: Math.min(cnx, core.x1 + MARGIN_C),
            y1: Math.min(bits.cny, core.y1 + MARGIN_C),
          };
          for (const ev of mergeTreeSaddles(clear, bits.east, bits.north, cnx, bits.cny, win, core, params)) {
            const fi = argmax[ev.cell];
            const fy = Math.floor(fi / fnx);
            const fx = fi % fnx;
            const lat = south + (fy + 0.5) * FINE;
            const lon = wrapLon(lon0 - HALO_F * FINE + (fx + 0.5) * FINE);
            const ay = Math.floor(ev.a / cnx);
            const ax = ev.a % cnx;
            const byy = Math.floor(ev.b / cnx);
            const bxx = ev.b % cnx;
            const dyM = (byy - ay) * WG_RES * M_PER_DEG;
            const dxM = (bxx - ax) * WG_RES * M_PER_DEG * Math.cos(lat * DEG);
            let axis = (Math.atan2(dxM, dyM) / DEG + 360) % 180;
            if (!Number.isFinite(axis)) axis = 0;
            cpLat.push(lat);
            cpLon.push(lon);
            cpW.push(Math.min(65535, Math.round(2 * ev.clearanceM)));
            cpAxis.push(Math.round(axis) % 180);
          }
        }
      }
    }
    done++;
    opts.onProgress?.(
      done,
      tiles.length,
      `tile ${lat0 >= 0 ? 'N' : 'S'}${Math.abs(lat0)} ${lon0 >= 0 ? 'E' : 'W'}${Math.abs(lon0)}${land === 0 ? ' (all water)' : land === fine.length ? ' (all land)' : ''}`
    );
  }
  for (let i = 0; i < water.length; i++) {
    stats.waterCells += popcount8(water[i]);
    stats.eastOpen += popcount8(east[i]);
    stats.northOpen += popcount8(north[i]);
  }
  const chokepoints = new Chokepoints(Float32Array.from(cpLat), Float32Array.from(cpLon), Uint16Array.from(cpW), Uint8Array.from(cpAxis));
  const header: WaterGridHeader = {
    version: WG_VERSION,
    res: WG_RES,
    nx: WG_NX,
    ny: WG_NY,
    fineRes: FINE,
    fineRule: 'centre-sampled: a fine cell is water when its centre is outside every land polygon',
    edgeRule: 'edge open when a 4-connected path of fine water cells inside the two coarse cells crosses it',
    sources: sourceFingerprints(shapefiles),
    builtAt: new Date().toISOString(),
    canals: [],
    chokepointRule: `windowed merge tree (2° cores, 1° margin): clearance ≤ ${params.maxClearanceM} m, basins ≥ ${params.ratio}× and ≥ +${params.minDiffM} m and ≥ ${params.minBasinClearanceM} m`,
    stats: { ...stats, chokepoints: chokepoints.length },
  };
  if (opts.region) header.stats!.partial = 1;
  splitCells.sort((a, b) => a.cell - b.cell);
  stats.splitCells = splitCells.length;
  header.stats!.splitCells = splitCells.length;
  const splitLabels = new Uint8Array(splitCells.length * 16);
  splitCells.forEach((sp, i) => splitLabels.set(sp.labels, i * 16));
  const splits = new SplitCells(
    Uint32Array.from(splitCells.map(sp => sp.cell)),
    splitLabels,
    Uint16Array.from(splitCells.map(sp => sp.cross))
  );
  const out = new WaterGrid(header, water, east, north, chokepoints, splits);
  header.canals = canalRecords(out);
  header.buildSeconds = Math.round((Date.now() - t0) / 100) / 10;
  return out;
}

function popcount8(b: number): number {
  b = b - ((b >> 1) & 0x55);
  b = (b & 0x33) + ((b >> 2) & 0x33);
  return (b + (b >> 4)) & 0x0f;
}
