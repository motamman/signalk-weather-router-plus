/**
 * A leg across the limits of the charts (docs/drafts/mesh-no-gshhg-design.md, part 5; the owner's design of
 * 2026-10-13): which waters it goes through, and where it crosses between them. The mesh decides wherever it has
 * triangles; the coastline search plans only in water outside every mesh; a leg moves between the two only where a
 * mesh's usable water meets the coastline's open water (an exit or entry: a side of usable mesh water with no
 * neighbour whose outside, half a raster cell out, is open water; exit.ts), or between two meshes where both call the
 * water usable (a transfer: joins.ts, recorded with each mesh's rough cut).
 *
 * The map of waters for the leg, on the coastline search's own raster for the leg's area (its resolution and land
 * buffer), built only when no one mesh holds both ends in one connected water:
 *  - every mesh meeting the area has its water marked (a cell whose centre a mesh triangle holds), so the coastline
 *    search never enters any district's charted water;
 *  - the open waters: the cells that are neither land nor charted, in connected pieces;
 *  - the charted waters: each mesh's connected groups for this boat (its rough cut, coarse.ts PieceGraph);
 *  - links: an exit links a charted group to the open piece its outside lies in; a join links a group of one mesh to
 *    a group of another (each mesh's joins file, read; the tiles an area to avoid recomputes are scanned again under
 *    the request's rules, as the rough cut recomputes them).
 *
 * The leg goes through the waters with the fewest changes between charts and open water (the owner's choice,
 * 2026-10-13, option a); a transfer between meshes is no change. So the charts alone are searched first (their groups
 * and the joins), and the open-water map is built only when they hold no way: the same answer, without the map's cost
 * on legs the charts join (measured on brain, 2026-10-13: the map took 29.8 s on Charleston → Chesapeake, where the
 * transfer alone took 4.8 s). Of the ways with the fewest changes, those with the fewest transfers between meshes
 * (the owner's choice, 2026-10-13, PR #39 review: joins weigh nothing, so every detour through more meshes tied and
 * each tied way was planned, a mesh search per stretch); where several still tie, each is planned and the cheapest
 * taken (the owner's choice, 2026-10-13): its mesh routes plus the straight runs across open water.
 *
 * Each charted stretch is one mesh search, from where it starts (the leg's start, the transfer point, or any entry
 * from the open piece before it, each costed by the distance over open water from the previous crossing) to where it
 * ends (the leg's end, or any exit into the next open piece, costed on by the distance over open water to the leg's
 * end, or a transfer into the next mesh, costed on by the straight run). So a stretch's entry and exit are chosen
 * together, towards the end. The open-water distances are walked on the open-water map itself (waterField): a straight
 * run ignored land, and from Greenland to Block Island the entry nearest as the crow flies was off Grand Manan, the
 * long way round Nova Scotia by sea, where the coastline search stalled (brain, 2026-10-30). An entry or exit the
 * water does not reach is no candidate. A transfer is a triangle of this mesh, in a piece the joins link to the next mesh's
 * group, whose centre the next mesh calls usable in that group (the step 2 test, made only on those pieces). The open
 * stretches lie between, for the coastline search with every mesh's water as land.
 *
 * Without the boat's draught and air draft the charted water cannot be judged; the leg can then only be one that open
 * water joins.
 */

import { DEG } from '../../geo/geodesy';
import { cellOf, type CellMask, type LandMask } from '../../geo/landmask';
import { M_PER_DEG } from '../../geo/units';
import { MinHeap } from '../heap';
import { meshAstar, type SearchExits } from './astar';
import { type CoarseMap, PieceGraph } from './coarse';
import { emptyMask, forEachEdgeSide, isFree, markMeshWater } from './exit';
import { JoinFinder } from './joins';
import { type BoundarySeeds, PagedMesh } from './paged';
import type { MeshRules } from './route';
import type { MeshStore } from './store';

export interface WaterMesh {
  store: MeshStore;
  /** The rough cut for the leg's rules and its tile-boundary record (null without rules). */
  map: CoarseMap | null;
  boundary: BoundarySeeds | null;
  /** Its joins to each other mesh of the list that it meets (index into the list, the joins file's numbers). */
  joins: { to: number; data: Int32Array }[];
  /** For the messages. */
  name: string;
}

export type WaterStretch =
  | { kind: 'mesh'; mesh: number; from: [number, number]; to: [number, number] }
  | { kind: 'open'; from: [number, number]; to: [number, number] };

export type WatersPlan =
  | { ok: true; kind: 'one-mesh'; mesh: number }
  | { ok: true; kind: 'open'; mask: CellMask }
  | {
      ok: true;
      kind: 'chain';
      stretches: WaterStretch[];
      /** Every mesh's water on the coastline raster (1 = charted), the cells of the crossings cleared; null when the leg stays on the charts (none was built). */
      mask: CellMask | null;
      /** Changes between charts and open water along the leg; transfers between meshes; ways that tied. */
      changes: number;
      transfers: number;
      ways: number;
      /** The open-water distance fields walked for the crossings' costs (waterField): how many, cells each, ms in all. */
      water?: { fields: number; cells: number; ms: number };
    }
  | { ok: false; reason: string };

type Box = [number, number, number, number];
const meets = (a: Box, b: Box): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

export function planWaters(
  meshes: WaterMesh[],
  /** The leg's rules; null when the boat's draught or air draft is not set (`why` says which). */
  rules: MeshRules | null,
  why: string,
  /** The coastline search's land for the leg's area (built only when one mesh does not hold the leg). */
  landFor: () => LandMask,
  start: [number, number],
  end: [number, number],
  names: { start: string; end: string }
): WatersPlan {
  const cl = Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const speed = rules?.motorSpeedMs ?? 1;
  // Each mesh in the leg's frame, with its connected groups for this boat.
  const pms = meshes.map(m => new PagedMesh(m.store, rules ?? { draughtM: 0, airDraftM: 0, motorSpeedMs: 1 }, cl, m.boundary));
  const graphs = rules ? meshes.map((m, i) => new PieceGraph(m.map!, pms[i])) : [];
  const groupOfPiece = (i: number, p: number | null): number | null => (p === null ? null : graphs[i].component(p));
  const groupOf = (i: number, t: number): number | null => groupOfPiece(i, graphs[i].pieceOf(t));
  /** The charted waters a point lies in: per mesh, the groups of the usable triangles it touches. */
  const chartedAt = (p: [number, number]): { mesh: number; group: number }[] => {
    if (!rules) return [];
    const out: { mesh: number; group: number }[] = [];
    pms.forEach((pm, i) => {
      for (const t of pm.locateAll(...pm.toXY(p[0], p[1]))) {
        const g = groupOf(i, t);
        if (g !== null && !out.some(o => o.mesh === i && o.group === g)) out.push({ mesh: i, group: g });
      }
    });
    return out;
  };
  const sAt = chartedAt(start);
  const eAt = chartedAt(end);
  // One mesh holds both ends in one water: the leg is that mesh's alone.
  const one = sAt.find(s => eAt.some(e => e.mesh === s.mesh && e.group === s.group));
  if (one) return { ok: true, kind: 'one-mesh', mesh: one.mesh };

  // The map of waters as links: charted groups (c<mesh>:<group>) and open pieces (o<piece>); a join between meshes
  // weighs nothing, an exit or entry one change. The exits by charted group and open piece they join.
  const sides = new Map<string, { tri: number; x: number; y: number; cell: number }[]>();
  const adj = new Map<string, Map<string, number>>();
  const link = (u: string, v: string, w: number): void => {
    let m = adj.get(u);
    if (!m) adj.set(u, (m = new Map()));
    if (!m.has(v) || m.get(v)! > w) m.set(v, w);
  };
  // The joins between meshes, from each mesh's record; in tiles an area to avoid recomputed, scanned again now. The
  // pieces of this mesh each join takes, per pair of groups, are where its transfer search may end.
  const joinPieces = new Map<string, Set<number>>();
  const join = (i: number, pa: number | null, j: number, pb: number | null): void => {
    const ga = groupOfPiece(i, pa);
    const gb = groupOfPiece(j, pb);
    if (ga === null || gb === null) return;
    const k = `${i}:${ga}>${j}:${gb}`;
    let set = joinPieces.get(k);
    if (!set) joinPieces.set(k, (set = new Set()));
    set.add(pa!);
    link(`c${i}:${ga}`, `c${j}:${gb}`, 0);
  };
  meshes.forEach((m, i) => {
    for (const { to: j, data } of m.joins) {
      for (let q = 0; q < data.length; q += 4)
        join(i, graphs[i].storedPiece(data[q], data[q + 1]), j, graphs[j].storedPiece(data[q + 2], data[q + 3]));
      if (!graphs[i].recomputed.size && !graphs[j].recomputed.size) continue;
      const jBoxes = [...graphs[j].recomputed].map(idx => pms[j].infoAt(idx)!.bbox);
      const finder = new JoinFinder({ store: m.store, pm: pms[i] }, { store: meshes[j].store, pm: pms[j] });
      for (let idx = 0; idx < pms[i].tileCount; idx++) {
        const b = pms[i].infoAt(idx)!.bbox;
        if (!graphs[i].recomputed.has(idx) && !jBoxes.some(x => meets(b, x))) continue;
        if (!finder.meetsB(b)) continue;
        finder.scanTile(pms[i].tile(idx), (a, u) => join(i, graphs[i].pieceOf(a), j, graphs[j].pieceOf(u)));
        pms[i].drop(idx);
      }
      pms[j].retain(() => false);
    }
  });

  // The distance over open water from a point to every cell (set once the open-water map is built; a way on the
  // charts alone has no open stretch and never asks).
  let overWater: (p: [number, number]) => Float32Array | null = () => null;

  // The charts alone first: a way through them and the joins between meshes is no change at all, so none through open
  // water can do better (the owner's rule: fewest changes); the open-water map is built only when there is none.
  if (rules && sAt.length && eAt.length) {
    const onCharts = solve(
      sAt.map(x => `c${x.mesh}:${x.group}`),
      eAt.map(x => `c${x.mesh}:${x.group}`),
      null
    );
    if (onCharts) return onCharts;
  }

  const land = landFor();
  const mask = emptyMask(land);
  for (const m of meshes) markMeshWater(m.store, mask);
  const labels = labelOpen(land, mask);
  // The open-water distance fields, one per point a cost is measured from, walked when first asked for (crossings).
  const fields = new Map<number, Float32Array | null>();
  const waterStats = { fields: 0, cells: land.nx * land.ny, ms: 0 };
  overWater = (p: [number, number]): Float32Array | null => {
    const c = cellOf(mask, p[0], p[1]);
    if (fields.has(c)) return fields.get(c)!;
    const t0 = Date.now();
    const f = waterField(land, mask, c);
    waterStats.fields++;
    waterStats.ms += Date.now() - t0;
    fields.set(c, f);
    return f;
  };
  const openAt = (p: [number, number]): number => {
    const c = cellOf(mask, p[0], p[1]);
    return c >= 0 ? labels[c] : -1;
  };
  const sOpen = sAt.length ? -1 : openAt(start);
  const eOpen = eAt.length ? -1 : openAt(end);
  const nowhere = (who: string): WatersPlan => ({
    ok: false,
    reason: `${who} is neither on water this boat can use on the charts nor on open water of the coastline data outside them`,
  });
  if (!sAt.length && sOpen < 0) return nowhere(names.start);
  if (!eAt.length && eOpen < 0) return nowhere(names.end);
  if (sOpen >= 0 && sOpen === eOpen) return { ok: true, kind: 'open', mask };
  if (!rules)
    return {
      ok: false,
      reason: `the leg's ends are not joined by open water outside the charts, and the charts cannot be used: ${why}`,
    };

  // The exits of every mesh in the area, by the charted group and the open piece they join.
  pms.forEach((pm, i) => {
    forEachEdgeSide(pm, mask, (t, mx, my, c) => {
      if (c < 0 || labels[c] < 0) return;
      const g = groupOf(i, t);
      if (g === null) return;
      const k = `${i}:${g}|${labels[c]}`;
      const list = sides.get(k);
      if (list) list.push({ tri: t, x: mx, y: my, cell: c });
      else sides.set(k, [{ tri: t, x: mx, y: my, cell: c }]);
      link(`c${i}:${g}`, `o${labels[c]}`, 1);
      link(`o${labels[c]}`, `c${i}:${g}`, 1);
    });
  });

  const way = solve(
    sAt.length ? sAt.map(x => `c${x.mesh}:${x.group}`) : [`o${sOpen}`],
    eAt.length ? eAt.map(x => `c${x.mesh}:${x.group}`) : [`o${eOpen}`],
    mask
  );
  if (!way)
    return {
      ok: false,
      reason: `${names.start}'s water and ${names.end}'s water do not connect for this boat (draught {depth:${rules.draughtM}}, air draft {length:${rules.airDraftM}}), on the charts or through open water beyond them, within the area`,
    };
  return way.ok && way.kind === 'chain' ? { ...way, water: waterStats } : way;

  /**
   * The way through the waters linked so far with the fewest changes from the start's waters to the end's, the
   * cheapest of those that tie, with its crossings; null when none links them.
   */
  function solve(startKeys: string[], goalKeys: string[], mask: CellMask | null): WatersPlan | null {
    // Fewest changes first, then fewest transfers: a change weighs more than all the transfers a way can make (a way
    // passes each water once), a transfer 1. The links' own weights: 1 an exit or entry, 0 a join.
    const nodes = new Set<string>([...startKeys, ...goalKeys]);
    for (const [u, m] of adj) {
      nodes.add(u);
      for (const v of m.keys()) nodes.add(v);
    }
    const CHANGE = nodes.size + 1;
    const weigh = (w: number): number => (w === 0 ? 1 : CHANGE);
    const dist = new Map<string, number>();
    const settled = new Set<string>();
    for (const s of startKeys) dist.set(s, 0);
    for (;;) {
      let u: string | null = null;
      for (const [k, d] of dist) if (!settled.has(k) && (u === null || d < dist.get(u)!)) u = k;
      if (u === null) break;
      settled.add(u);
      const du = dist.get(u)!;
      for (const [v, w] of adj.get(u) ?? []) {
        const dv = du + weigh(w);
        if (!dist.has(v) || dist.get(v)! > dv) dist.set(v, dv);
      }
    }
    const best = Math.min(...goalKeys.map(g => dist.get(g) ?? Infinity));
    if (!Number.isFinite(best)) return null;
    // Every way with those fewest changes and transfers: the paths back from the end's water along links that keep to
    // it (a link u → v with dist(u) + its weight = dist(v)).
    const into = new Map<string, [string, number][]>();
    for (const [u, m] of adj)
      for (const [v, w] of m) {
        const list = into.get(v);
        if (list) list.push([u, w]);
        else into.set(v, [[u, w]]);
      }
    const ways: string[][] = [];
    const startSet = new Set(startKeys);
    const onPath = new Set<string>();
    const back = (v: string, tail: string[]): void => {
      if (startSet.has(v)) ways.push([v, ...tail]);
      onPath.add(v);
      for (const [u, w] of into.get(v) ?? [])
        if (!onPath.has(u) && dist.has(u) && dist.get(u)! + weigh(w) === dist.get(v)) back(u, [v, ...tail]);
      onPath.delete(v);
    };
    for (const g of goalKeys) if (dist.get(g) === best) back(g, []);

    const plans = ways.map(w => crossings(w));
    const ok = plans.filter((p): p is Extract<Crossings, { ok: true }> => p.ok);
    if (!ok.length) return { ok: false, reason: (plans[0] as Extract<Crossings, { ok: false }>).reason };
    const chosen = ok.reduce((a, b) => (b.cost < a.cost ? b : a));
    // The cells the leg crosses in belong to the coastline search too (where it meets the charts).
    if (mask)
      for (const s of chosen.stretches)
        if (s.kind === 'open')
          for (const q of [s.from, s.to]) {
            const c = cellOf(mask, q[0], q[1]);
            if (c >= 0) mask.cells[c] = 0;
          }
    return {
      ok: true,
      kind: 'chain',
      stretches: chosen.stretches,
      mask,
      changes: Math.floor(best / CHANGE),
      transfers: chosen.transfers,
      ways: ways.length,
    };
  }

  /** The crossings of one way through the waters: one mesh search per charted stretch, entry and exit together. */
  function crossings(path: string[]): Crossings {
    const stretches: WaterStretch[] = [];
    let prevPoint = start;
    let transfers = 0;
    let cost = 0;
    // The open water from the last exit on to the leg's end, as its exit was costed (the distance over open water).
    let openRestS = 0;
    for (let p = 0; p < path.length; p++) {
      if (path[p][0] === 'o') continue;
      const [i, g] = path[p].slice(1).split(':').map(Number);
      const pm = pms[i];
      const [px, py] = pm.toXY(prevPoint[0], prevPoint[1]);
      const [ex, ey] = pm.toXY(end[0], end[1]);
      // Where the stretch may start, and what reaching each start cost (the straight run across open water).
      const startTris: number[] = [];
      const startAt: { x: number; y: number; g: number }[] = [];
      const before = p > 0 ? path[p - 1] : null;
      if (before && before[0] === 'o') {
        const best = new Map<number, { x: number; y: number; g: number }>();
        // Each entry costed by the distance over open water from the previous crossing; one the water does not reach is none.
        const from = overWater(prevPoint);
        for (const sd of sides.get(`${i}:${g}|${before.slice(1)}`) ?? []) {
          const d = from && sd.cell >= 0 ? from[sd.cell] : Infinity;
          if (!Number.isFinite(d)) continue;
          const c = d / speed;
          const b = best.get(sd.tri);
          if (!b || c < b.g) best.set(sd.tri, { x: sd.x, y: sd.y, g: c });
        }
        if (!best.size)
          return {
            ok: false,
            reason: `no entry into ${meshes[i].name}'s charted water can be reached over open water from ${prevPoint[1].toFixed(4)}, ${prevPoint[0].toFixed(4)}`,
          };
        for (const [t, a] of best) {
          startTris.push(t);
          startAt.push(a);
        }
      } else {
        for (const t of pm.locateAll(px, py))
          if (groupOf(i, t) === g) {
            startTris.push(t);
            startAt.push({ x: px, y: py, g: 0 });
          }
      }
      // Where it may end, each end costed on by the straight run to the leg's end (none for the leg's end itself).
      const after = p + 1 < path.length ? path[p + 1] : null;
      let goals: SearchExits;
      if (!after) {
        let ends = pm.locateAll(ex, ey).filter(t => groupOf(i, t) === g);
        let [gx, gy] = [ex, ey];
        if (!ends.length) {
          const nu = pm.nearestUsable(ex, ey, t => groupOf(i, t) === g)!;
          ends = [nu.tri];
          [gx, gy] = [nu.x, nu.y];
        }
        goals = new Map(ends.map(t => [t, { x: gx, y: gy, restS: 0 }]));
      } else if (after[0] === 'o') {
        const best = new Map<number, { x: number; y: number; restS: number }>();
        // Into the open water the leg ends in: each exit costed on by the distance over open water to the leg's end, one
        // the water does not join to it none. Into open water that leads to more charts: by the straight run, as only a
        // guide towards the end (the next charted stretch's entry is then costed over open water from the exit chosen).
        const last = p + 1 === path.length - 1;
        const to = last ? overWater(end) : null;
        for (const sd of sides.get(`${i}:${g}|${after.slice(1)}`) ?? []) {
          const d = last ? (to && sd.cell >= 0 ? to[sd.cell] : Infinity) : Math.hypot(ex - sd.x, ey - sd.y);
          if (!Number.isFinite(d)) continue;
          const r = d / speed;
          const b = best.get(sd.tri);
          if (!b || r < b.restS) best.set(sd.tri, { x: sd.x, y: sd.y, restS: r });
        }
        if (!best.size)
          return {
            ok: false,
            reason: `no exit from ${meshes[i].name}'s charted water is joined over open water to ${end[1].toFixed(4)}, ${end[0].toFixed(4)}`,
          };
        goals = best;
      } else {
        const [j, h] = after.slice(1).split(':').map(Number);
        goals = transferGoals(i, g, j, h, ex, ey);
        transfers++;
      }
      const res = meshAstar(pm, startTris, [], px, py, ex, ey, speed, goals, startAt);
      pm.retain(() => false);
      if (res.goalNode === -2 || res.goalTri < 0)
        return {
          ok: false,
          reason: `the rough cut of ${meshes[i].name} says its water connects where the leg enters and leaves it, but the search found no way; rebuild the rough cut in the plugin configuration`,
        };
      const k = startTris.indexOf(res.startTri);
      const goal = goals.get(res.goalTri)!;
      if (after && after[0] === 'o') openRestS = goal.restS;
      const entry: [number, number] = before && before[0] === 'o' ? pm.fromXY(startAt[k].x, startAt[k].y) : prevPoint;
      const exit: [number, number] = after ? pm.fromXY(goal.x, goal.y) : end;
      if (before && before[0] === 'o') stretches.push({ kind: 'open', from: prevPoint, to: entry });
      stretches.push({ kind: 'mesh', mesh: i, from: entry, to: exit });
      cost += res.goalG - goal.restS;
      prevPoint = exit;
    }
    if (path[path.length - 1][0] === 'o') {
      stretches.push({ kind: 'open', from: prevPoint, to: end });
      cost += openRestS;
    }
    return { ok: true, stretches, transfers, cost };
  }

  /**
   * Where a stretch on mesh i (group g) may change to mesh j (group h): a usable triangle of a piece the joins link
   * to h, whose centre mesh j calls usable in h, both meshes covering it; costed on by the straight run to the end.
   */
  function transferGoals(i: number, g: number, j: number, h: number, ex: number, ey: number): SearchExits {
    const pieces = joinPieces.get(`${i}:${g}>${j}:${h}`) ?? new Set<number>();
    const pa = pms[i];
    const pb = pms[j];
    const memo = new Map<number, { x: number; y: number; restS: number } | null>();
    return {
      get: (t: number) => {
        const m = memo.get(t);
        if (m !== undefined) return m ?? undefined;
        let e: { x: number; y: number; restS: number } | null = null;
        const piece = graphs[i].pieceOf(t);
        if (piece !== null && pieces.has(piece)) {
          const T = pa.tileOf(t);
          const q = (t - T.first) * 3;
          const cx = (T.x[q] + T.x[q + 1] + T.x[q + 2]) / 3;
          const cy = (T.y[q] + T.y[q + 1] + T.y[q + 2]) / 3;
          const [lon, lat] = pa.fromXY(cx, cy);
          if (meshes[i].store.covers(lon, lat) && meshes[j].store.covers(lon, lat) && pb.locateAll(cx, cy).some(u => groupOf(j, u) === h))
            e = { x: cx, y: cy, restS: Math.hypot(ex - cx, ey - cy) / speed };
        }
        memo.set(t, e);
        return e ?? undefined;
      },
    };
  }
}

type Crossings = { ok: true; stretches: WaterStretch[]; transfers: number; cost: number } | { ok: false; reason: string };

/** The open pieces: each raster cell that is neither land nor charted gets the number of its connected piece; others -1. */
function labelOpen(land: LandMask, mask: CellMask): Int32Array {
  const { nx, ny } = mask;
  const labels = new Int32Array(nx * ny).fill(-1);
  const queue = new Int32Array(nx * ny);
  let next = 0;
  for (let s = 0; s < nx * ny; s++) {
    if (labels[s] >= 0 || !isFree(land, mask, s)) continue;
    let qh = 0;
    let qt = 0;
    labels[s] = next;
    queue[qt++] = s;
    const visit = (n: number): void => {
      if (labels[n] >= 0 || !isFree(land, mask, n)) return;
      labels[n] = next;
      queue[qt++] = n;
    };
    while (qh < qt) {
      const c = queue[qh++];
      const i = c % nx;
      const j = (c - i) / nx;
      if (i > 0) visit(c - 1);
      if (i < nx - 1) visit(c + 1);
      if (j > 0) visit(c - nx);
      if (j < ny - 1) visit(c + nx);
    }
    next++;
  }
  return labels;
}

/**
 * The distance over open water (metres) from raster cell `s` to every cell: 8-connected moves through free cells
 * (isFree: neither coastline land, buffered, nor any mesh's water), each its true length (east-west by the cosine of the
 * row's latitude, a diagonal their hypotenuse; a diagonal only where both cells beside it are free, so the walk never
 * slips between two land cells touching at a corner, as the open pieces, 4-connected, do not), Dijkstra on the
 * engine's one heap. The source counts as water whatever its cell (a crossing on a mesh's edge lies in a cell of mesh
 * water, a stop moved off the coast may lie in a buffered one). Infinity where the water does not reach; null off the
 * raster. Float32: seven significant digits, a few metres on a leg of thousands of kilometres; each value stored
 * rounded (Math.fround) so a popped key matches its cell's.
 */
export function waterField(land: LandMask, mask: CellMask, s: number): Float32Array | null {
  if (s < 0) return null;
  const { nx, ny } = mask;
  const r = mask.resolutionDeg;
  const dy = r * M_PER_DEG;
  const dist = new Float32Array(nx * ny).fill(Infinity);
  const heap = new MinHeap();
  dist[s] = 0;
  heap.push(0, s);
  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > dist[c]) continue; // a stale entry
    const i = c % nx;
    const j = (c - i) / nx;
    const dx = dy * Math.cos((mask.bbox.south + (j + 0.5) * r) * DEG);
    const dd = Math.hypot(dx, dy);
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= ny) continue;
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ii = i + di;
        if (ii < 0 || ii >= nx) continue;
        const n = jj * nx + ii;
        if (!isFree(land, mask, n)) continue;
        if (di !== 0 && dj !== 0 && (!isFree(land, mask, j * nx + ii) || !isFree(land, mask, jj * nx + i))) continue;
        const nd = Math.fround(d + (di !== 0 && dj !== 0 ? dd : di !== 0 ? dx : dy));
        if (nd < dist[n]) {
          dist[n] = nd;
          heap.push(nd, n);
        }
      }
    }
  }
  return dist;
}
