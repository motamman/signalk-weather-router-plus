/**
 * Where two districts' chart meshes join for one boat (docs/drafts/mesh-no-gshhg-design.md, part 5): a usable triangle
 * of mesh A, in a tile meeting mesh B, whose centre lies in usable water of B, both meshes covering the point (the
 * step 2 transfer test, engine/mesh/transfer.ts). Which piece of A's water then joins which piece of B's depends only
 * on the two meshes and the boat's rules, so the rough-cut build records it (plugin/meshcoarse.ts); a leg reads it.
 * The two directions differ (01CGD → 05CGD 192 piece joins, 05CGD → 01CGD 79; brain, 2026-10-13): a leg changing from
 * A to B uses A's record, found from A's triangles, where its search on A ends.
 *
 * Each centre is looked up in B by walking from the triangle the previous centre was found in (consecutive triangles
 * of a tile lie close together); a centre inside the walk's triangle by more than the lookup's tolerance (width.ts
 * U_TOL of the longest edge, as paged.ts locateIn) is in that triangle alone. Near an edge or a corner, at B's edge,
 * or with nothing found yet, B's full lookup answers (paged.ts locateAll), so the answer is always the lookup's.
 * Measured against the full lookup alone (brain, 2026-10-13, 01/05, 07/05 and 08 → 07): the same group joins, in
 * 23–45% less time; the full lookup then missed two joins in the Gulf whose triangles' tiles lay two index cells away
 * (since fixed in paged.ts).
 */

import type { PagedMesh, PagedTile } from './paged';
import { type MeshStore, tileExtentsMeet as meets } from './store';
import { U_TOL } from './width';

export const JOINS_VERSION = 1;

type Box = [number, number, number, number];

export class JoinFinder {
  private prev = -1;
  private readonly bBoxes: Box[];

  constructor(
    private readonly a: { store: MeshStore; pm: PagedMesh },
    /** Mesh B in A's frame (the same `cl`), under the same rules. */
    private readonly b: { store: MeshStore; pm: PagedMesh }
  ) {
    this.bBoxes = b.store.index.tiles.map(t => t.bbox);
  }

  /** Whether a tile of A (its extent) meets any tile of B: only such tiles can hold a join. */
  meetsB(bbox: Box): boolean {
    return this.bBoxes.some(b => meets(bbox, b));
  }

  /**
   * Every usable triangle of A in tile T whose centre lies in usable water of B, with each usable triangle of B
   * holding it: `found(aTri, bTri)`, global ids. B's tiles not meeting T are let go afterwards.
   */
  scanTile(T: PagedTile, found: (aTri: number, bTri: number) => void): void {
    const pa = this.a.pm;
    for (let l = 0; l < T.n; l++) {
      if (T.blocked[l]) continue;
      const q = l * 3;
      const cx = (T.x[q] + T.x[q + 1] + T.x[q + 2]) / 3;
      const cy = (T.y[q] + T.y[q + 1] + T.y[q + 2]) / 3;
      const [lon, lat] = pa.fromXY(cx, cy);
      if (!this.a.store.covers(lon, lat) || !this.b.store.covers(lon, lat)) continue;
      for (const u of this.locate(cx, cy)) found(T.first + l, u);
    }
    this.b.pm.retain(U => meets(U.bbox, T.bbox));
  }

  /** The usable triangles of B holding a point of the frame, as B's locateAll gives them. */
  private locate(px: number, py: number): number[] {
    const pb = this.b.pm;
    let u = this.prev;
    // Each step moves to a neighbour the point lies beyond, so the walk ends; it is bounded by B's triangles.
    for (let step = 0; u >= 0 && step < this.b.store.index.triangles; step++) {
      const U = pb.tileOf(u);
      const q = (u - U.first) * 3;
      const ax = U.x[q];
      const ay = U.y[q];
      const bx = U.x[q + 1];
      const by = U.y[q + 1];
      const cx = U.x[q + 2];
      const cy = U.y[q + 2];
      const lab = Math.hypot(bx - ax, by - ay);
      const lbc = Math.hypot(cx - bx, cy - by);
      const lca = Math.hypot(ax - cx, ay - cy);
      const tol = U_TOL * Math.max(lab, lbc, lca);
      // The point's distance inside each edge (edge k runs from corner k to k + 1); negative: beyond it.
      const d = [
        ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / lab,
        ((cx - bx) * (py - by) - (cy - by) * (px - bx)) / lbc,
        ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) / lca,
      ];
      if (d[0] > tol && d[1] > tol && d[2] > tol) {
        this.prev = u;
        return U.blocked[u - U.first] ? [] : [u];
      }
      let k = 0;
      if (d[1] < d[k]) k = 1;
      if (d[2] < d[k]) k = 2;
      // On an edge or a corner (within the tolerance): the full lookup decides which triangles hold it.
      if (d[k] >= -tol) break;
      u = U.nb[q + k];
    }
    const all = pb.locateAll(px, py);
    const any = all.length ? all[0] : pb.locate(px, py, false);
    if (any >= 0) this.prev = any;
    return all;
  }
}
