/**
 * The chart mesh as the router's land: the four checks the search, the
 * tack layout, the polish and the smoother make (geo/landmask.ts
 * LandTest), answered from the loaded mesh and its blocked triangles. A
 * point is unusable when the triangle under it is blocked, or when no
 * triangle holds it (outside the mesh). A straight move is unusable when
 * the walk from the triangle under its start along it meets a blocked
 * triangle or leaves the mesh before its end: the walk that measures
 * passage widths (width.ts), the test the mesh route itself is built
 * with. No copy of the chart, no raster.
 *
 * Triangles are found through a grid over the mesh's extent: each cell
 * lists the triangles whose bounding box meets it, so a point costs the
 * few triangles of its cell, not a scan of the tiles.
 */

import type { LandTest } from '../../geo/landmask';
import { FLAG_OPENING_BRIDGE, fromMeshXY, type LoadedMesh, NO_VALUE, toMeshXY } from './store';
import { rayWalk } from './width';

/** Index cell size, metres in the mesh frame: a few triangles a cell on a chart mesh (triangles are tens of metres). */
export const INDEX_CELL_M = 250;

export class MeshLand implements LandTest {
  private readonly x0: number;
  private readonly y0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cell: number;
  /** Triangle ids by cell: ids[offsets[c] .. offsets[c + 1]) are the triangles whose box meets cell c. */
  private readonly offsets: Int32Array;
  private readonly ids: Int32Array;

  constructor(
    readonly m: LoadedMesh,
    readonly blocked: Uint8Array,
    cellM = INDEX_CELL_M
  ) {
    const { x, y, n } = m;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < n * 3; k++) {
      if (x[k] < minX) minX = x[k];
      if (x[k] > maxX) maxX = x[k];
      if (y[k] < minY) minY = y[k];
      if (y[k] > maxY) maxY = y[k];
    }
    if (n === 0) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    this.cell = cellM;
    this.x0 = minX;
    this.y0 = minY;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cellM) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cellM) + 1);
    const cells = this.nx * this.ny;
    // Two passes: count the entries per cell, then fill.
    const counts = new Int32Array(cells + 1);
    const range = (t: number): [number, number, number, number] => {
      const a = t * 3;
      const bx0 = Math.min(x[a], x[a + 1], x[a + 2]);
      const bx1 = Math.max(x[a], x[a + 1], x[a + 2]);
      const by0 = Math.min(y[a], y[a + 1], y[a + 2]);
      const by1 = Math.max(y[a], y[a + 1], y[a + 2]);
      return [this.col(bx0), this.col(bx1), this.row(by0), this.row(by1)];
    };
    for (let t = 0; t < n; t++) {
      const [i0, i1, j0, j1] = range(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * this.nx + i + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.offsets = counts;
    this.ids = new Int32Array(counts[cells]);
    const fill = new Int32Array(cells);
    for (let t = 0; t < n; t++) {
      const [i0, i1, j0, j1] = range(t);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const c = j * this.nx + i;
          this.ids[this.offsets[c] + fill[c]++] = t;
        }
    }
  }

  private col(px: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((px - this.x0) / this.cell)));
  }

  private row(py: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((py - this.y0) / this.cell)));
  }

  /** Bytes the index holds. */
  indexBytes(): number {
    return this.offsets.byteLength + this.ids.byteLength;
  }

  /** Every triangle whose bounding box meets the box (mesh frame, metres), each once. */
  forEachTriangleNear(x0: number, y0: number, x1: number, y1: number, fn: (tri: number) => void): void {
    const i0 = this.col(Math.min(x0, x1));
    const i1 = this.col(Math.max(x0, x1));
    const j0 = this.row(Math.min(y0, y1));
    const j1 = this.row(Math.max(y0, y1));
    const seen = i1 > i0 || j1 > j0 ? new Set<number>() : null;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * this.nx + i;
        for (let k = this.offsets[c]; k < this.offsets[c + 1]; k++) {
          const t = this.ids[k];
          if (seen) {
            if (seen.has(t)) continue;
            seen.add(t);
          }
          fn(t);
        }
      }
  }

  /**
   * The triangle holding the point (mesh frame), or -1. Corners wind
   * counter-clockwise; a point on a shared edge or corner counts for the
   * first triangle met, as store.ts locate does, unless `preferUsable`:
   * then a usable triangle holding the point wins over a blocked one (a
   * mesh route corner on a depth contour belongs to the water the route
   * uses).
   */
  locate(px: number, py: number, preferUsable = false): number {
    const { x, y } = this.m;
    const c = this.row(py) * this.nx + this.col(px);
    let found = -1;
    for (let k = this.offsets[c]; k < this.offsets[c + 1]; k++) {
      const tri = this.ids[k];
      const a = tri * 3;
      const ax = x[a];
      const ay = y[a];
      const bx = x[a + 1];
      const by = y[a + 1];
      const cx = x[a + 2];
      const cy = y[a + 2];
      if (px < Math.min(ax, bx, cx) || px > Math.max(ax, bx, cx) || py < Math.min(ay, by, cy) || py > Math.max(ay, by, cy)) continue;
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (d1 >= 0 && d2 >= 0 && d3 >= 0) {
        if (!preferUsable || !this.blocked[tri]) return tri;
        if (found < 0) found = tri;
      }
    }
    return found;
  }

  /** The triangle under a position, or -1. */
  triangleAt(lon: number, lat: number, preferUsable = false): number {
    const [px, py] = toMeshXY(this.m, lon, lat);
    return this.locate(px, py, preferUsable);
  }

  /** Charted depth under a position, metres, or null (no triangle, or none charted); a contour corner reports the usable side. */
  depthAt(lon: number, lat: number): number | null {
    const t = this.triangleAt(lon, lat, true);
    if (t < 0 || this.m.depth[t] === NO_VALUE) return null;
    return this.m.depth[t];
  }

  /**
   * Every triangle the straight move a→b (mesh frame) passes through, in
   * order, blocked or not, starting with the one under a; stops where the
   * move leaves the mesh. The walk of width.ts rayWalk, reporting each
   * triangle.
   */
  forEachTriangleAlong(ax: number, ay: number, bx: number, by: number, fn: (tri: number) => void): void {
    const { x, y, neighbours: NB } = this.m;
    let cur = this.locate(ax, ay, true);
    if (cur < 0) return;
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) {
      fn(cur);
      return;
    }
    const dx = (bx - ax) / len;
    const dy = (by - ay) / len;
    let entry = -1;
    let s = 0;
    for (let iter = 0; iter < 100000; iter++) {
      fn(cur);
      let bestS = Infinity;
      let bestK = -1;
      for (let k = 0; k < 3; k++) {
        if (k === entry) continue;
        const a = cur * 3 + k;
        const b = cur * 3 + ((k + 1) % 3);
        const ex = x[b] - x[a];
        const ey = y[b] - y[a];
        if (ex * dy - ey * dx >= 0) continue;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-18) continue;
        const wx = x[a] - ax;
        const wy = y[a] - ay;
        const sHit = (wx * ey - wy * ex) / den;
        const u = (wx * dy - wy * dx) / den;
        if (u < -1e-7 || u > 1 + 1e-7) continue;
        if (sHit < s - 1e-9) continue;
        if (sHit < bestS) {
          bestS = sHit;
          bestK = k;
        }
      }
      if (bestK < 0 || bestS >= len) return;
      const n = NB[cur * 3 + bestK];
      if (n < 0) return;
      s = Math.max(bestS, s);
      entry = this.m.rev[cur * 3 + bestK];
      cur = n;
    }
  }

  /**
   * The opening bridges the move a→b passes under: one entry per run of
   * bridge triangles, at the first one's centroid, with the charted open
   * clearance (null when none is charted).
   */
  openingBridgesAlong(lonA: number, latA: number, lonB: number, latB: number): { lon: number; lat: number; clearM: number | null }[] {
    const [ax, ay] = toMeshXY(this.m, lonA, latA);
    const [bx, by] = toMeshXY(this.m, lonB, latB);
    const out: { lon: number; lat: number; clearM: number | null }[] = [];
    let inBridge = false;
    this.forEachTriangleAlong(ax, ay, bx, by, t => {
      const on = (this.m.flags[t] & FLAG_OPENING_BRIDGE) !== 0;
      if (on && !inBridge) {
        const cx = (this.m.x[t * 3] + this.m.x[t * 3 + 1] + this.m.x[t * 3 + 2]) / 3;
        const cy = (this.m.y[t * 3] + this.m.y[t * 3 + 1] + this.m.y[t * 3 + 2]) / 3;
        const [lon, lat] = fromMeshXY(this.m, cx, cy);
        out.push({ lon, lat, clearM: this.m.clear[t] === NO_VALUE ? null : this.m.clear[t] });
      }
      inBridge = on;
    });
    return out;
  }

  isLand(lon: number, lat: number): boolean {
    // A point on a shared edge or corner belongs to the usable triangle, as legCrossesLandExact locates its start.
    const t = this.triangleAt(lon, lat, true);
    return t < 0 || this.blocked[t] === 1;
  }

  isLandExact(lon: number, lat: number): boolean {
    return this.isLand(lon, lat);
  }

  /** Does the straight move a→b (in the mesh frame) meet a blocked triangle or leave the mesh? */
  legCrossesLandExact(lonA: number, latA: number, lonB: number, latB: number): boolean {
    const [ax, ay] = toMeshXY(this.m, lonA, latA);
    const [bx, by] = toMeshXY(this.m, lonB, latB);
    const ta = this.locate(ax, ay, true);
    if (ta < 0 || this.blocked[ta]) return true;
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) return false;
    const r = rayWalk(this.m, this.blocked, ta, ax, ay, (bx - ax) / len, (by - ay) / len, len);
    // The walk stops short at a blocked triangle, the mesh's edge, or a numerical dead end: all unusable.
    return r.dist < len - 1e-6;
  }

  legsCrossLandBulk(lonsA: ArrayLike<number>, latsA: ArrayLike<number>, lonsB: ArrayLike<number>, latsB: ArrayLike<number>): Uint8Array {
    const n = lonsA.length;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (this.legCrossesLandExact(lonsA[k], latsA[k], lonsB[k], latsB[k])) out[k] = 1;
    return out;
  }
}
