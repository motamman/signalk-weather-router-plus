/**
 * Route corridor from the global water grid.
 *
 *  1. A* on the 0.02° grid from the start through the vias to the end
 *     (engine/gridastar.ts), in a window around each leg that grows when
 *     the water path lies further out (Lisbon → Palma must go south to
 *     Gibraltar, outside the endpoints' box).
 *  2. The route's own land raster (conservative, the one the propagator
 *     checks legs against) is built over the corridor's bounding box plus
 *     a margin, not the endpoints' box.
 *  3. Consistency: a flood fill on that raster, restricted to a band of
 *     grid cells around the corridor, must connect start and end. Where it
 *     stops (a passage the raster's resolution closes, e.g. a 700 m strait
 *     on a 0.005° raster), the raster is refined locally (a finer patch,
 *     down to MIN_PATCH_RES) and the fill repeated; if the passage stays
 *     closed at the finest patch it is not navigable for this router: its
 *     cells are blocked and A* runs again.
 *  4. Width profile: across-track water width at every skeleton point
 *     (rays on the route raster), used by the propagator to shorten stages
 *     and to bin candidates finely inside narrow passages.
 *  5. Automatic vias: chokepoints stored in the grid whose gate (a line
 *     across the passage at its narrowest point) the corridor crosses,
 *     when the passage is narrower than a stage step, become soft
 *     pass-through discs so every branch is pulled through the passage.
 */

import type { BBox } from '../geo/geodesy';
import { lonOffset, unwrapLonNear } from '../geo/angles';
import { M_PER_DEG } from '../geo/units';
import { DEG, haversineBearing, haversineDistanceM, wrapLon } from '../geo/geodesy';
import type { LandMask } from '../geo/landmask';
import { describePassage } from '../geo/straits';
import type { WaterGrid } from '../geo/watergrid';
import { gridAstar, smoothGridPath, type GridNode, type GridSource } from './gridastar';
import { CorridorError, GridAstarError } from './errors';
import type { ProgressFn } from './progress';
import { distanceTransformCells } from './astar';
import { MinHeap } from './heap';
import { stringPull } from './pathutil';
import { forEachRingCell } from '../geo/grid';

/** Finest local refinement of the route raster, degrees (≈ 55 m): passages narrower than about 3 cells stay closed. */
export const MIN_PATCH_RES = 0.0005;
/**
 * A* heuristic weight: the corridor costs at most 10 % more than the
 * optimum (measured: +0.3 % Newport → Horta, +0.3 % Lisbon → Helsinki)
 * for 1.5–10× fewer expansions. The corridor only guides the isochrones.
 */
export const ASTAR_HEURISTIC_WEIGHT = 1.1;
/** Band half-width around the corridor for the consistency fill, grid cells. */
const BAND = 2;
/** Maximum A* re-runs after blocking a passage the route raster closes. */
const MAX_REROUTES = 12;
/** Maximum local refinements per corridor. */
const MAX_REFINES = 40;
/** Degrees added around the corridor for the route raster. */
export const CORRIDOR_MARGIN_DEG = 1.0;
/** Stage step may be at most this many passage widths. */
export const STEP_PER_WIDTH = 4;
/** …but never below this, metres. */
export const MIN_STEP_M = 1000;
/** Rays for the width profile stop at this distance each side, metres. */
const WIDTH_RAY_CAP_M = 30_000;
/**
 * The shore-distance profile looks this far, metres: a point with no land
 * within it is clear of the shore (the mesh handover's test, mesh/handover.ts).
 */
export const SHORE_CLEAR_M = 5000;
/** Narrow stretches are refined until the passage spans at least this many raster cells (down to MIN_PATCH_RES). */
export const PATCH_CELLS_ACROSS = 10;
/** Skeleton stretches narrower than this are re-traced on the route raster (fine A*), metres. */
export const FINE_SKELETON_WIDTH_M = 8000;
/** A stored chokepoint becomes an automatic via when narrower than this × the stage step. */
export const AUTO_VIA_WIDTH_RATIO = 1.0;

export interface AutoVia {
  lon: number;
  lat: number;
  radiusM: number;
  widthM: number;
  axisDeg: number;
  name: string;
  /** Chain segment (0 = start → first via / end) the via lies on. */
  segment: number;
  /** Index along the raw corridor path, for ordering. */
  pathIndex: number;
}

export interface Corridor {
  /** Densified skeleton (≤ SKELETON_SPACING_M between points), exact endpoints. */
  skeleton: { lon: number; lat: number }[];
  /** Across-track water width at each skeleton point, metres (Infinity = wider than 2 × the ray cap). */
  widthM: Float64Array;
  /** Distance from each skeleton point to the nearest land on the route raster, metres (Infinity = none within SHORE_CLEAR_M). */
  shoreM: Float64Array;
  /** Skeleton length, metres. */
  lengthM: number;
  /** Route raster box. */
  bbox: BBox;
  /** Route raster (with any local patches). */
  land: LandMask;
  /** Automatic vias, in route order, with the chain segment they belong to. */
  autoVias: AutoVia[];
  stats: {
    astarMs: number;
    expanded: number;
    windowCells: number;
    reroutes: number;
    refines: number;
    blockedCells: number;
    verifyMs: number;
  };
}

export { CorridorError };

export interface CorridorOptions {
  /** Route raster for a box (cached by the caller). Must carry polygons (for refine). */
  landFor: (bbox: BBox) => LandMask;
  /** Stages the propagator will use (for the via width threshold). */
  stages: number;
  onProgress?: ProgressFn;
  shouldCancel?: () => boolean;
  /** Largest A* window, cells (7 bytes each). */
  maxWindowCells?: number;
}

const SKELETON_SPACING_M = 2000;

// ---------------------------------------------------------------------
// Endpoint snapping and window A*

/** Water nodes to start from / aim at near a point: its own cell's components, else water cells within `radius`. */
function endpointNodes(grid: WaterGrid, lon: number, lat: number, radius: number): { nodes: GridSource[]; radiusM: number } {
  const [r0, c0] = grid.cellOf(lon, lat);
  const own = grid.nodeComponents(r0, c0);
  if (own.length) return { nodes: own.map(comp => ({ r: r0, c: c0, comp, cost: 0 })), radiusM: 0 };
  const nodes: GridSource[] = [];
  let radiusM = 0;
  for (let rad = 1; rad <= radius && nodes.length === 0; rad++) {
    forEachRingCell(rad, (dr, dc) => {
      for (const comp of grid.nodeComponents(r0 + dr, c0 + dc)) {
        const [clon, clat] = grid.cellCentre(r0 + dr, c0 + dc);
        const d = haversineDistanceM(lon, lat, clon, clat);
        nodes.push({ r: r0 + dr, c: c0 + dc, comp, cost: d });
        radiusM = Math.max(radiusM, d);
      }
    });
  }
  return { nodes, radiusM };
}

/** Size-capped flood from nodes; `small` when the whole component was explored under the cap. */
function probeComponent(grid: WaterGrid, nodes: GridNode[], cap: number): { small: boolean; cells: Set<number> } {
  const seen = new Set<number>();
  const st: GridNode[] = [];
  const key = (r: number, c: number, comp: number): number => (r * grid.nx + grid.wrapCol(c)) * 16 + comp;
  for (const n of nodes) {
    const k = key(n.r, n.c, n.comp);
    if (!seen.has(k)) {
      seen.add(k);
      st.push(n);
    }
  }
  while (st.length) {
    if (seen.size > cap) return { small: false, cells: seen };
    const n = st.pop()!;
    grid.neighbours(n.r, n.c, n.comp, (dr, dc, comp2) => {
      const k = key(n.r + dr, n.c + dc, comp2);
      if (seen.has(k)) return;
      seen.add(k);
      st.push({ r: n.r + dr, c: n.c + dc, comp: comp2 });
    });
  }
  return { small: true, cells: seen };
}

/**
 * A* for one leg of the chain with a growing window. Columns of the
 * returned path are unwrapped continuously from the leg's start cell.
 */
function legAstar(
  grid: WaterGrid,
  a: [number, number],
  b: [number, number],
  blocked: Set<number>,
  maxWindowCells: number,
  progress: (m: string) => void,
  shouldCancel?: () => boolean
): { path: GridNode[]; expanded: number; windowCells: number } {
  let src = endpointNodes(grid, a[0], a[1], 5);
  let dst = endpointNodes(grid, b[0], b[1], 5);
  if (!src.nodes.length)
    throw new CorridorError(
      `no water within 5 grid cells (≈10 km) of (${a[1].toFixed(4)}, ${a[0].toFixed(4)}): the point is on land`,
      true
    );
  if (!dst.nodes.length)
    throw new CorridorError(
      `no water within 5 grid cells (≈10 km) of (${b[1].toFixed(4)}, ${b[0].toFixed(4)}): the point is on land`,
      true
    );
  // An endpoint in a small enclosed pocket of the grid (a marina basin the
  // 0.02° grid closes): aim for the nearest open water instead.
  const PROBE_CAP = 50_000;
  const fix = (
    ep: { nodes: GridSource[]; radiusM: number },
    lonlat: [number, number],
    other: GridSource[],
    which: string
  ): { nodes: GridSource[]; radiusM: number } => {
    const pr = probeComponent(grid, ep.nodes, PROBE_CAP);
    if (!pr.small) return ep;
    const otherIn = other.some(o => pr.cells.has((o.r * grid.nx + grid.wrapCol(o.c)) * 16 + o.comp));
    if (otherIn) return ep;
    const [r0, c0] = grid.cellOf(lonlat[0], lonlat[1]);
    const alt: GridSource[] = [];
    let radiusM = 0;
    for (let rad = 1; rad <= 5 && alt.length === 0; rad++) {
      forEachRingCell(rad, (dr, dc) => {
        for (const comp of grid.nodeComponents(r0 + dr, c0 + dc)) {
          if (pr.cells.has(((r0 + dr) * grid.nx + grid.wrapCol(c0 + dc)) * 16 + comp)) continue;
          if (probeComponent(grid, [{ r: r0 + dr, c: c0 + dc, comp }], PROBE_CAP).small) continue;
          const [clon, clat] = grid.cellCentre(r0 + dr, c0 + dc);
          const d = haversineDistanceM(lonlat[0], lonlat[1], clon, clat);
          alt.push({ r: r0 + dr, c: c0 + dc, comp, cost: d });
          radiusM = Math.max(radiusM, d);
        }
      });
    }
    if (!alt.length)
      throw new CorridorError(
        `the ${which} (${lonlat[1].toFixed(4)}, ${lonlat[0].toFixed(4)}) is in water enclosed at the {angle:0.000349066} grid resolution with no open water within {distance:10000}`
      );
    progress(
      `${which} is in a pocket the {angle:0.000349066} grid closes; corridor starts from open water {distance:${radiusM.toFixed(0)}} away`
    );
    return { nodes: alt, radiusM };
  };
  src = fix(src, a, dst.nodes, 'start of this leg');
  dst = fix(dst, b, src.nodes, 'end of this leg');

  // Unwrapped goal column nearest the start (short way round).
  const sR = src.nodes[0].r;
  const sC = src.nodes[0].c;
  const goalNodes = dst.nodes.map(n => {
    let c = n.c;
    while (c - sC > grid.nx / 2) c -= grid.nx;
    while (c - sC < -grid.nx / 2) c += grid.nx;
    return { r: n.r, c, comp: n.comp };
  });
  const rMin = Math.min(sR, ...goalNodes.map(n => n.r));
  const rMax = Math.max(sR, ...goalNodes.map(n => n.r));
  const cMin = Math.min(sC, ...goalNodes.map(n => n.c));
  const cMax = Math.max(sC, ...goalNodes.map(n => n.c));
  const span = Math.max(rMax - rMin, cMax - cMin);
  const margins = [
    Math.max(100, Math.round(span * 0.25)),
    Math.max(300, Math.round(span * 0.75)),
    Math.max(750, span * 2),
    Math.max(2000, span * 5),
    grid.nx,
  ];
  let expanded = 0;
  let lastErr: GridAstarError | null = null;
  for (const m of margins) {
    let r0 = Math.max(0, rMin - m);
    let r1 = Math.min(grid.ny - 1, rMax + m);
    let c0 = cMin - m;
    let c1 = cMax + m;
    if (c1 - c0 + 1 >= grid.nx) {
      c0 = Math.floor((cMin + cMax) / 2 - grid.nx / 2);
      c1 = c0 + grid.nx - 1;
    }
    let cells = (r1 - r0 + 1) * (c1 - c0 + 1);
    if (cells > maxWindowCells) {
      // Shrink the margin to fit the cell budget (the minimal box must fit).
      const w0 = cMax - cMin + 1;
      const h0 = rMax - rMin + 1;
      if (w0 * h0 > maxWindowCells)
        throw new CorridorError(
          `route too long for the grid search: ${w0}×${h0} cells exceed ${maxWindowCells} (add intermediate waypoints)`
        );
      let lo = 0;
      let hi = m;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const cw = Math.min(grid.nx, w0 + 2 * mid);
        const ch = Math.min(grid.ny, h0 + 2 * mid);
        if (cw * ch <= maxWindowCells) lo = mid;
        else hi = mid - 1;
      }
      r0 = Math.max(0, rMin - lo);
      r1 = Math.min(grid.ny - 1, rMax + lo);
      c0 = cMin - lo;
      c1 = cMax + lo;
      cells = (r1 - r0 + 1) * (c1 - c0 + 1);
    }
    const win = { r0, r1, c0, c1 };
    try {
      const res = gridAstar(grid, win, src.nodes, goalNodes, b, dst.radiusM, {
        blocked,
        shouldCancel,
        heuristicWeight: ASTAR_HEURISTIC_WEIGHT,
      });
      expanded += res.expanded;
      return { path: unwrapPath(grid, res.path), expanded, windowCells: cells };
    } catch (err) {
      if (!(err instanceof GridAstarError)) throw err; // RouteCancelled among them
      expanded += err.expanded;
      lastErr = err;
      if (cells >= maxWindowCells || (c1 - c0 + 1 >= grid.nx && r0 === 0 && r1 === grid.ny - 1)) break;
      progress(
        `no water path inside a {angle:${(c1 - c0 + 1) * grid.res * (Math.PI / 180)}} × {angle:${(r1 - r0 + 1) * grid.res * (Math.PI / 180)}} window; widening`
      );
    }
  }
  throw new CorridorError(
    `no water path between (${a[1].toFixed(4)}, ${a[0].toFixed(4)}) and (${b[1].toFixed(4)}, ${b[0].toFixed(4)}) on the global water grid${lastErr ? ` (${lastErr.message})` : ''}`
  );
}

/** Make consecutive columns differ by at most 1 (a full-width window may wrap). */
function unwrapPath(grid: WaterGrid, path: GridNode[]): GridNode[] {
  const out = path.map(p => ({ ...p }));
  for (let i = 1; i < out.length; i++) {
    let c = out[i].c;
    while (c - out[i - 1].c > grid.nx / 2) c -= grid.nx;
    while (c - out[i - 1].c < -grid.nx / 2) c += grid.nx;
    out[i].c = c;
  }
  return out;
}

// ---------------------------------------------------------------------
// Consistency with the route raster

interface BandCell {
  r: number;
  c: number;
  s: number;
  clear: boolean;
  /** s×s land bits (1 = land) when not clear. */
  land: Uint8Array | null;
  reached: boolean;
}

/**
 * Flood fill on the route raster inside a band of grid cells around the
 * corridor, from the start to the end. Each band cell is sampled at the
 * raster's finest resolution there (base or patch); cells without land
 * are one node. Returns ok, or the last corridor index the fill reached.
 */
export function verifyCorridor(
  land: LandMask,
  gridRes: number,
  path: GridNode[],
  start: [number, number],
  end: [number, number],
  band = BAND
): { ok: true } | { ok: false; reachedIndex: number } {
  const rMin = Math.min(...path.map(p => p.r)) - band;
  const cMin = Math.min(...path.map(p => p.c)) - band;
  const cMax = Math.max(...path.map(p => p.c)) + band;
  const Wb = cMax - cMin + 1;
  const idxOf = new Map<number, number>();
  const cells: BandCell[] = [];
  const keyOf = (r: number, c: number): number => (r - rMin) * Wb + (c - cMin);
  const cellLonW = (c: number): number => -180 + c * gridRes;
  const cellLatS = (r: number): number => -90 + r * gridRes;
  const finestIn = (lonW: number, latS: number): number => {
    let res = land.resolutionDeg;
    for (const p of land.patches) {
      if (p.resolutionDeg >= res) continue;
      const pw = p.bbox.west;
      let off = lonOffset(lonW, pw);
      if (off > 180) off -= 360;
      const pWidth = p.nx * p.resolutionDeg;
      if (off + gridRes <= 0 || off >= pWidth) continue;
      if (latS + gridRes <= p.bbox.south || latS >= p.bbox.north) continue;
      res = p.resolutionDeg;
    }
    return res;
  };
  const addCell = (r: number, c: number): void => {
    const k = keyOf(r, c);
    if (idxOf.has(k) || r < 0 || r >= 180 / gridRes) return;
    const lonW = cellLonW(c);
    const latS = cellLatS(r);
    const s = Math.max(1, Math.round(gridRes / finestIn(lonW, latS)));
    const bits = new Uint8Array(s * s);
    let any = 0;
    const sub = gridRes / s;
    for (let y = 0; y < s; y++) {
      const lat = latS + (y + 0.5) * sub;
      for (let x = 0; x < s; x++) {
        if (land.isLand(wrapLon(lonW + (x + 0.5) * sub), lat)) {
          bits[y * s + x] = 1;
          any++;
        }
      }
    }
    idxOf.set(k, cells.length);
    cells.push({ r, c, s, clear: any === 0, land: any === 0 ? null : bits, reached: false });
  };
  for (const p of path) {
    for (let dr = -band; dr <= band; dr++) for (let dc = -band; dc <= band; dc++) addCell(p.r + dr, p.c + dc);
  }
  // Node numbering.
  const off = new Int32Array(cells.length + 1);
  for (let i = 0; i < cells.length; i++) off[i + 1] = off[i] + (cells[i].clear ? 1 : cells[i].s * cells[i].s);
  const total = off[cells.length];
  const visited = new Uint8Array(total);
  const qb = new Int32Array(total);
  const qs = new Int32Array(total);
  let qh = 0;
  let qt = 0;
  const visit = (b: number, sub: number): void => {
    const node = off[b] + (sub < 0 ? 0 : sub);
    if (visited[node]) return;
    const cell = cells[b];
    if (sub >= 0 && cell.land![sub]) return;
    visited[node] = 1;
    cell.reached = true;
    qb[qt] = b;
    qs[qt] = sub;
    qt++;
  };
  const cellAt = (lon: number, lat: number, refC: number): { b: number; sub: number } | null => {
    const r = Math.floor((lat + 90) / gridRes);
    let c = Math.floor((wrapLon(lon) + 180) / gridRes);
    const nxG = Math.round(360 / gridRes);
    while (c - refC > nxG / 2) c -= nxG;
    while (c - refC < -nxG / 2) c += nxG;
    const b = idxOf.get(keyOf(r, c));
    if (b === undefined) return null;
    const cell = cells[b];
    if (cell.clear) return { b, sub: -1 };
    const fx = Math.min(
      cell.s - 1,
      Math.max(0, Math.floor(((wrapLon(lon) + 180) / gridRes - Math.floor((wrapLon(lon) + 180) / gridRes)) * cell.s))
    );
    const fy = Math.min(cell.s - 1, Math.max(0, Math.floor(((lat + 90) / gridRes - r) * cell.s)));
    let best = -1;
    let bestD = Infinity;
    for (let y = 0; y < cell.s; y++)
      for (let x = 0; x < cell.s; x++) {
        if (cell.land![y * cell.s + x]) continue;
        const d = (x - fx) ** 2 + (y - fy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = y * cell.s + x;
        }
      }
    return best >= 0 ? { b, sub: best } : null;
  };
  const s0 = cellAt(start[0], start[1], path[0].c);
  const e0 = cellAt(end[0], end[1], path[path.length - 1].c);
  if (!s0) return { ok: false, reachedIndex: -1 };
  visit(s0.b, s0.sub);
  const neighbourCell = (b: number, dr: number, dc: number): number => {
    const cell = cells[b];
    // Outside the band's columns: keyOf would alias into the next/previous row.
    if (cell.c + dc < cMin || cell.c + dc > cMax) return -1;
    const i = idxOf.get(keyOf(cell.r + dr, cell.c + dc));
    return i === undefined ? -1 : i;
  };
  // Border sub-cells of cell b2 facing direction (dr, dc) as seen from the neighbour, within span [lo, hi) of 0..1.
  const enterBorder = (b2: number, dr: number, dc: number, lo: number, hi: number): void => {
    const c2 = cells[b2];
    if (c2.clear) {
      visit(b2, -1);
      return;
    }
    const s2 = c2.s;
    const k0 = Math.floor(lo * s2 + 1e-9);
    const k1 = Math.min(s2 - 1, Math.ceil(hi * s2 - 1e-9) - 1);
    for (let k = k0; k <= k1; k++) {
      // Entering moving (dr, dc): east → x = 0, west → x = s2-1, north → y = 0, south → y = s2-1.
      const x = dc === 1 ? 0 : dc === -1 ? s2 - 1 : k;
      const y = dr === 1 ? 0 : dr === -1 ? s2 - 1 : k;
      visit(b2, y * s2 + x);
    }
  };
  const DIRS: [number, number][] = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  while (qh < qt) {
    const b = qb[qh];
    const sub = qs[qh];
    qh++;
    const cell = cells[b];
    if (sub < 0) {
      for (const [dr, dc] of DIRS) {
        const b2 = neighbourCell(b, dr, dc);
        if (b2 >= 0) enterBorder(b2, dr, dc, 0, 1);
      }
      continue;
    }
    const s = cell.s;
    const x = sub % s;
    const y = (sub - x) / s;
    for (const [dr, dc] of DIRS) {
      const x2 = x + dc;
      const y2 = y + dr;
      if (x2 >= 0 && x2 < s && y2 >= 0 && y2 < s) {
        visit(b, y2 * s + x2);
        continue;
      }
      const b2 = neighbourCell(b, dr, dc);
      if (b2 < 0) continue;
      const pos = dc !== 0 ? y : x;
      enterBorder(b2, dr, dc, pos / s, (pos + 1) / s);
    }
  }
  if (e0) {
    const node = off[e0.b] + (e0.sub < 0 ? 0 : e0.sub);
    if (visited[node]) return { ok: true };
  }
  let reachedIndex = -1;
  for (let i = 0; i < path.length; i++) {
    const b = idxOf.get(keyOf(path[i].r, path[i].c));
    if (b !== undefined && cells[b].reached) reachedIndex = i;
  }
  return { ok: false, reachedIndex };
}

// ---------------------------------------------------------------------
// Width profile

/**
 * Across-track passage width at each point, metres: along the line
 * through the point perpendicular to the skeleton (sampled on the route
 * raster out to `capM` each side), the longest run of water that comes
 * within `nearM` of the point. An islet on the skeleton therefore does not
 * read as a narrow passage (the water beside it is the passage), while a
 * strait reads as its width. Infinity when that run reaches the cap on
 * both sides.
 */
export function widthProfile(land: LandMask, pts: { lon: number; lat: number }[], capM = WIDTH_RAY_CAP_M, nearM = 2500): Float64Array {
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const brg = a === b ? 0 : haversineBearing(a.lon, a.lat, b.lon, b.lat);
    const res = land.resolutionAt(p.lon, p.lat);
    const stepM = Math.max(10, res * M_PER_DEG * 0.5);
    const cosLat = Math.max(0.05, Math.cos(p.lat * DEG));
    const perp = (brg + 90) * DEG;
    const sb = Math.sin(perp);
    const cb = Math.cos(perp);
    const n = Math.ceil(capM / stepM);
    let runStart = -Infinity; // offset where the current water run began (-Infinity: open from the cap)
    let best = 0;
    let bestOpen = false;
    for (let k = -n; k <= n + 1; k++) {
      const d = k * stepM;
      const isLand = k <= n && land.isLand(wrapLon(p.lon + (d * sb) / (M_PER_DEG * cosLat)), p.lat + (d * cb) / M_PER_DEG);
      if (k <= n && !isLand) {
        if (runStart === Infinity) runStart = d;
        continue;
      }
      // Run [runStart, d) ended (land at d, or the cap).
      if (runStart !== Infinity) {
        const lo = runStart === -Infinity ? -capM : runStart;
        const hi = k > n ? capM : d;
        if (lo <= nearM && hi >= -nearM) {
          const len = hi - lo;
          const open = runStart === -Infinity && k > n;
          if (open) bestOpen = true;
          else if (len > best) best = len;
        }
      }
      runStart = Infinity; // inside land
    }
    out[i] = bestOpen ? Infinity : best > 0 ? best : stepM;
  }
  return out;
}

/**
 * Distance from each point to the nearest land, metres: every raster cell
 * within `capM` of the point is sampled (a lattice of half the raster's
 * cell size there, so no cell is skipped: a small island between two
 * directions is seen), ring by ring outward, stopping once the ring's
 * nearest sample is farther than the nearest land found. Infinity when
 * no land lies within `capM`. Unlike the width profile this sees a single
 * shore: a point 500 m off a straight open coast reads 500 m here and
 * open water in the width profile.
 */
export function shoreProfile(land: LandMask, pts: { lon: number; lat: number }[], capM = SHORE_CLEAR_M): Float64Array {
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const stepDeg = land.resolutionAt(p.lon, p.lat) * 0.5;
    const cosLat = Math.max(0.05, Math.cos(p.lat * DEG));
    const stepX = Math.max(10, stepDeg * M_PER_DEG * cosLat);
    const stepY = Math.max(10, stepDeg * M_PER_DEG);
    const nx = Math.ceil(capM / stepX);
    const ny = Math.ceil(capM / stepY);
    const rings = Math.max(nx, ny);
    let nearest = Infinity;
    const probe = (dx: number, dy: number): void => {
      if (Math.abs(dx) > nx || Math.abs(dy) > ny) return;
      const d = Math.hypot(dx * stepX, dy * stepY);
      if (d > capM || d >= nearest) return;
      if (land.isLand(wrapLon(p.lon + dx * stepDeg), p.lat + dy * stepDeg)) nearest = d;
    };
    // Ring r: the lattice samples at Chebyshev index r (its perimeter only).
    for (let r = 0; r <= rings && r * Math.min(stepX, stepY) < nearest; r++) {
      if (r === 0) {
        probe(0, 0);
        continue;
      }
      for (let k = -r; k <= r; k++) {
        probe(k, -r);
        probe(k, r);
      }
      for (let k = -r + 1; k <= r - 1; k++) {
        probe(-r, k);
        probe(r, k);
      }
    }
    out[i] = nearest;
  }
  return out;
}

// ---------------------------------------------------------------------
// Planner

function gridBBox(grid: WaterGrid, path: GridNode[], extra: [number, number][], marginDeg: number): BBox {
  let cLo = Infinity;
  let cHi = -Infinity;
  let rLo = Infinity;
  let rHi = -Infinity;
  for (const p of path) {
    if (p.c < cLo) cLo = p.c;
    if (p.c > cHi) cHi = p.c;
    if (p.r < rLo) rLo = p.r;
    if (p.r > rHi) rHi = p.r;
  }
  let west = -180 + cLo * grid.res;
  let east = -180 + (cHi + 1) * grid.res;
  let south = -90 + rLo * grid.res;
  let north = -90 + (rHi + 1) * grid.res;
  const mid = (west + east) / 2;
  for (const [lon, lat] of extra) {
    let x = lon;
    x = unwrapLonNear(x, mid);
    west = Math.min(west, x);
    east = Math.max(east, x);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  west -= marginDeg;
  east += marginDeg;
  south = Math.max(-90, south - marginDeg);
  north = Math.min(90, north + marginDeg);
  if (east - west >= 360) return { west: -180, east: 180, south, north };
  return { west: wrapLon(west), east: wrapLon(east), south, north };
}

function bboxInside(inner: BBox, outer: BBox): boolean {
  if (inner.south < outer.south || inner.north > outer.north) return false;
  const ow = lonOffset(outer.east, outer.west) || 360;
  const iw = lonOffset(inner.east, inner.west) || 360;
  const off = lonOffset(inner.west, outer.west);
  return off + iw <= ow + 1e-9;
}

function densify(pts: { lon: number; lat: number }[], spacingM: number): { lon: number; lat: number }[] {
  const out: { lon: number; lat: number }[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = haversineDistanceM(a.lon, a.lat, b.lon, b.lat);
    const n = Math.max(1, Math.ceil(d / spacingM));
    let dl = b.lon - a.lon;
    if (dl > 180) dl -= 360;
    if (dl < -180) dl += 360;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      out.push({ lon: wrapLon(a.lon + f * dl), lat: a.lat + f * (b.lat - a.lat) });
    }
  }
  return out;
}

/**
 * Plan the corridor for start → vias → end. `chain` is [start, ...vias, end]
 * as [lon, lat]. Throws CorridorError when no water path exists.
 */
export function planCorridor(grid: WaterGrid, chain: [number, number][], opts: CorridorOptions): Corridor {
  const progress = (m: string): void => opts.onProgress?.(0, 0, m);
  const maxWindowCells = opts.maxWindowCells ?? 12_000_000;
  const blocked = new Set<number>();
  const stats = { astarMs: 0, expanded: 0, windowCells: 0, reroutes: 0, refines: 0, blockedCells: 0, verifyMs: 0 };
  let land: LandMask | null = null;
  let landBox: BBox | null = null;
  let path: GridNode[];
  let segStart: number[];
  for (let attempt = 0; ; attempt++) {
    // 1. A* leg by leg.
    const t0 = Date.now();
    path = [];
    segStart = [];
    for (let s = 0; s + 1 < chain.length; s++) {
      const leg = legAstar(grid, chain[s], chain[s + 1], blocked, maxWindowCells, progress, opts.shouldCancel);
      stats.expanded += leg.expanded;
      stats.windowCells = Math.max(stats.windowCells, leg.windowCells);
      let legPath = leg.path;
      if (path.length) {
        // Continue the unwrapped columns from the previous leg.
        const last = path[path.length - 1];
        let shift = 0;
        while (legPath[0].c + shift - last.c > grid.nx / 2) shift -= grid.nx;
        while (legPath[0].c + shift - last.c < -grid.nx / 2) shift += grid.nx;
        legPath = legPath.map(p => ({ ...p, c: p.c + shift }));
        segStart.push(path.length - 1);
        const same = legPath[0].r === last.r && legPath[0].c === last.c && legPath[0].comp === last.comp;
        path.push(...(same ? legPath.slice(1) : legPath));
      } else {
        segStart.push(0);
        path.push(...legPath);
      }
    }
    stats.astarMs += Date.now() - t0;
    // 2. Route raster over the corridor.
    const box = gridBBox(grid, path, chain, CORRIDOR_MARGIN_DEG);
    const w = lonOffset(box.east, box.west) || 360;
    if (w > 120 || box.north - box.south > 90) {
      throw new CorridorError(
        `the corridor's bounding box (${w.toFixed(0)}° × ${(box.north - box.south).toFixed(0)}°) is too large (max 120° × 90°); add intermediate waypoints`
      );
    }
    if (!land || !landBox || !bboxInside(box, landBox)) {
      land = opts.landFor(box);
      landBox = box;
      if (land.hasPolygons) {
        chain.forEach(([lon, lat], i) => {
          if (land!.isLandExact(lon, lat)) {
            const what = i === 0 ? 'start point' : i === chain.length - 1 ? 'end point' : `waypoint ${i}`;
            throw new CorridorError(`${what} (${lat.toFixed(4)}, ${lon.toFixed(4)}) is on land`, true);
          }
        });
      }
    }
    // 3. Consistency with the route raster.
    const tv = Date.now();
    let verdict = verifyCorridor(land, grid.res, path, chain[0], chain[chain.length - 1]);
    while (!verdict.ok && stats.refines < MAX_REFINES) {
      const p = Math.max(0, verdict.reachedIndex);
      const lo = Math.max(0, p - 2);
      const hi = Math.min(path.length - 1, p + 6);
      const [clon, clat] = grid.cellCentre(path[Math.min(path.length - 1, p + 1)].r, path[Math.min(path.length - 1, p + 1)].c);
      const cur = land.resolutionAt(clon, clat);
      if (cur <= MIN_PATCH_RES * 1.0001) break;
      const next = Math.max(MIN_PATCH_RES, cur / 4);
      const seg = path.slice(lo, hi + 1);
      const pb = gridBBox(grid, seg, [], grid.res * 0.5);
      const patch = land.refine(pb, next);
      if (!patch) break;
      stats.refines++;
      progress(
        `route raster refined to {length:${Math.round(next * M_PER_DEG)}} around ${clat.toFixed(3)}, ${clon.toFixed(3)} where the corridor passes a narrow passage`
      );
      verdict = verifyCorridor(land, grid.res, path, chain[0], chain[chain.length - 1]);
    }
    stats.verifyMs += Date.now() - tv;
    if (verdict.ok) break;
    // Closed even at the finest patch: not navigable here; block and re-route.
    const p = Math.max(0, verdict.reachedIndex);
    if (p >= path.length - 2 || attempt >= MAX_REROUTES) {
      const [lon, lat] = grid.cellCentre(path[Math.min(path.length - 1, p + 1)].r, path[Math.min(path.length - 1, p + 1)].c);
      throw new CorridorError(
        p >= path.length - 2
          ? `the destination is not connected to the corridor on the route's land raster (closed near ${lat.toFixed(3)}, ${lon.toFixed(3)}); move it into open water`
          : `the water corridor keeps passing channels too narrow for the route raster (last near ${lat.toFixed(3)}, ${lon.toFixed(3)}); add a waypoint to choose the passage`
      );
    }
    const chainCells = new Set(
      chain.map(([lon, lat]) => {
        const [r, c] = grid.cellOf(lon, lat);
        return r * grid.nx + c;
      })
    );
    let added = 0;
    for (let i = p + 1; i <= Math.min(path.length - 2, p + 3); i++) {
      const k = path[i].r * grid.nx + grid.wrapCol(path[i].c);
      if (chainCells.has(k)) continue;
      if (!blocked.has(k)) {
        blocked.add(k);
        added++;
      }
    }
    if (!added) {
      const [lon, lat] = grid.cellCentre(path[p].r, path[p].c);
      throw new CorridorError(
        `the corridor is closed on the route raster near ${lat.toFixed(3)}, ${lon.toFixed(3)} next to a route point; move the point into open water`
      );
    }
    stats.reroutes++;
    stats.blockedCells = blocked.size;
    const [lon, lat] = grid.cellCentre(path[p + 1].r, path[p + 1].c);
    progress(
      `passage near ${lat.toFixed(3)}, ${lon.toFixed(3)} is closed on the route raster even at {length:${Math.round(MIN_PATCH_RES * M_PER_DEG)}}; re-routing around it`
    );
  }
  if (!land || !landBox) throw new CorridorError('internal: no route raster');

  // 4. Skeleton: each leg's grid path smoothed (line of sight on the grid),
  // with the exact route points at the leg ends, densified.
  const pts: { lon: number; lat: number }[] = [];
  for (let sgi = 0; sgi < segStart.length; sgi++) {
    const a = segStart[sgi];
    const b = sgi + 1 < segStart.length ? segStart[sgi + 1] : path.length - 1;
    const legSmooth = smoothGridPath(grid, path.slice(a, b + 1), 150, blocked);
    const legPts = legSmooth.map(n => {
      const [lon, lat] = grid.cellCentre(n.r, n.c);
      return { lon, lat };
    });
    legPts[0] = { lon: chain[sgi][0], lat: chain[sgi][1] };
    if (legPts.length === 1) legPts.push({ lon: chain[sgi + 1][0], lat: chain[sgi + 1][1] });
    else legPts[legPts.length - 1] = { lon: chain[sgi + 1][0], lat: chain[sgi + 1][1] };
    pts.push(...(pts.length ? legPts.slice(1) : legPts));
  }
  const skeleton = densify(pts, SKELETON_SPACING_M);
  let lengthM = 0;
  for (let i = 1; i < skeleton.length; i++)
    lengthM += haversineDistanceM(skeleton[i - 1].lon, skeleton[i - 1].lat, skeleton[i].lon, skeleton[i].lat);
  let widthM = widthProfile(land, skeleton);
  // Room to manoeuvre: a passage only a few raster cells wide (the
  // conservative raster loses up to a cell on each bank) leaves the
  // propagator's legs few headings; refine such stretches locally.
  const refined = refineNarrowStretches(land, skeleton, widthM, grid.res);
  if (refined.patches) {
    stats.refines += refined.patches;
    progress(
      `route raster refined to {length:${Math.round(refined.finestDeg * M_PER_DEG)}} in ${refined.patches} narrow stretch${refined.patches === 1 ? '' : 'es'} (passages under ${PATCH_CELLS_ACROSS} raster cells wide)`
    );
    widthM = widthProfile(land, skeleton);
  }
  // Narrow stretches: the grid's 2 km cells cannot place the skeleton inside
  // a 700 m channel; re-trace those stretches on the route raster.
  const traced = traceNarrowStretches(land, skeleton, widthM);
  if (traced.stretches) {
    skeleton.splice(0, skeleton.length, ...traced.skeleton);
    progress(`skeleton re-traced on the route raster through ${traced.stretches} narrow stretch${traced.stretches === 1 ? '' : 'es'}`);
    widthM = widthProfile(land, skeleton);
    lengthM = 0;
    for (let i = 1; i < skeleton.length; i++)
      lengthM += haversineDistanceM(skeleton[i - 1].lon, skeleton[i - 1].lat, skeleton[i].lon, skeleton[i].lat);
  }

  // 5. Automatic vias.
  const stepM = lengthM / Math.max(1, opts.stages);
  const autoVias = findAutoVias(grid, path, segStart, chain, stepM, land);
  const shoreM = shoreProfile(land, skeleton);
  return { skeleton, widthM, shoreM, lengthM, bbox: landBox, land, autoVias, stats };
}

/**
 * Re-trace skeleton stretches narrower than FINE_SKELETON_WIDTH_M with an
 * A* on the route raster (at the finest resolution present there), whose
 * cost rises near the banks so the path keeps to mid-channel; smoothed by
 * line of sight on the raster and densified. A stretch whose fine search
 * fails keeps its grid skeleton.
 */
export function traceNarrowStretches(
  land: LandMask,
  pts: { lon: number; lat: number }[],
  widthM: Float64Array
): { skeleton: { lon: number; lat: number }[]; stretches: number } {
  const out: { lon: number; lat: number }[] = [];
  let stretches = 0;
  let i = 0;
  const n = pts.length;
  // out = (finished part) + pts[lastEnd .. i-1] copied as they are.
  let lastEnd = 0;
  while (i < n) {
    if (!(widthM[i] < FINE_SKELETON_WIDTH_M)) {
      out.push(pts[i]);
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && widthM[j + 1] < FINE_SKELETON_WIDTH_M) j++;
    // Anchor a little outside the stretch (in wider water).
    const a = Math.max(lastEnd, i - 3);
    const b = Math.min(n - 1, j + 3);
    const traced = fineTrace(land, pts.slice(a, b + 1));
    if (traced) {
      for (let q = a; q < i; q++) out.pop();
      out.push(...traced);
      stretches++;
      i = b + 1;
      lastEnd = i;
    } else {
      for (let q = i; q <= j; q++) out.push(pts[q]);
      i = j + 1;
    }
  }
  return { skeleton: out, stretches };
}

function fineTrace(land: LandMask, seg: { lon: number; lat: number }[]): { lon: number; lat: number }[] | null {
  const first = seg[0];
  const last = seg[seg.length - 1];
  let west = first.lon;
  let east = first.lon;
  let south = first.lat;
  let north = first.lat;
  let res = land.resolutionDeg;
  for (const p of seg) {
    let x = p.lon;
    while (x - first.lon > 180) x -= 360;
    while (x - first.lon < -180) x += 360;
    west = Math.min(west, x);
    east = Math.max(east, x);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    res = Math.min(res, land.resolutionAt(p.lon, p.lat));
  }
  const pad = 0.05;
  west -= pad;
  east += pad;
  south -= pad;
  north += pad;
  const nx = Math.ceil((east - west) / res);
  const ny = Math.ceil((north - south) / res);
  if (nx * ny > 6_000_000) return null;
  const water = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const lat = south + (y + 0.5) * res;
    for (let x = 0; x < nx; x++) water[y * nx + x] = land.isLand(wrapLon(west + (x + 0.5) * res), lat) ? 0 : 1;
  }
  const clear = distanceTransformCells(water, ny, nx); // cells to the nearest land
  const cellOf = (p: { lon: number; lat: number }): number => {
    let x = p.lon;
    while (x - first.lon > 180) x -= 360;
    while (x - first.lon < -180) x += 360;
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((x - west) / res)));
    const cy = Math.min(ny - 1, Math.max(0, Math.floor((p.lat - south) / res)));
    // Nearest water cell (the first found, ring by ring).
    let found = -1;
    for (let r = 0; r < 40 && found < 0; r++) {
      forEachRingCell(r, (dy, dx) => {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && water[yy * nx + xx]) {
          found = yy * nx + xx;
          return true;
        }
        return false;
      });
    }
    return found;
  };
  const s0 = cellOf(first);
  const e0 = cellOf(last);
  if (s0 < 0 || e0 < 0) return null;
  // A*: 8-connected, diagonals need both orthogonal cells; cost × (1 + 3 · max(0, 1 - clearance / 4 cells)).
  const cosL = Math.cos(((south + north) / 2) * DEG);
  const g = new Float64Array(nx * ny).fill(Infinity);
  const par = new Int32Array(nx * ny).fill(-1);
  const done = new Uint8Array(nx * ny);
  const heap = new MinHeap();
  const ex = e0 % nx;
  const ey = Math.floor(e0 / nx);
  const h = (c: number): number => Math.hypot(((c % nx) - ex) * cosL, Math.floor(c / nx) - ey);
  g[s0] = 0;
  heap.push(h(s0), s0);
  const DIRS: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  let found = false;
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === e0) {
      found = true;
      break;
    }
    const cx = c % nx;
    const cy = (c - cx) / nx;
    for (const [dx, dy] of DIRS) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const k = y * nx + x;
      if (!water[k] || done[k]) continue;
      if (dx && dy && (!water[cy * nx + x] || !water[y * nx + cx])) continue;
      const step = Math.hypot(dx * cosL, dy);
      const pen = 1 + 3 * Math.max(0, 1 - clear[k] / 4);
      const ng = g[c] + step * pen;
      if (ng < g[k]) {
        g[k] = ng;
        par[k] = c;
        heap.push(ng + h(k), k);
      }
    }
  }
  if (!found) return null;
  const cells: number[] = [];
  for (let c = e0; c >= 0; c = par[c]) cells.push(c);
  cells.reverse();
  // Line of sight on the raster (every sampled cell water with ≥ 1 cell clearance).
  const los = (a: number, b: number): boolean => {
    const ax = a % nx;
    const ay = Math.floor(a / nx);
    const bx = b % nx;
    const by = Math.floor(b / nx);
    const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2);
    for (let q = 0; q <= steps; q++) {
      const x = Math.round(ax + ((bx - ax) * q) / steps);
      const y = Math.round(ay + ((by - ay) * q) / steps);
      const k = y * nx + x;
      if (!water[k] || clear[k] < 1.5) return false;
    }
    return true;
  };
  const kept = stringPull(cells, (ai, q) => q <= ai + 400 && los(cells[ai], cells[q]));
  const poly = kept.map(c => ({ lon: wrapLon(west + ((c % nx) + 0.5) * res), lat: south + (Math.floor(c / nx) + 0.5) * res }));
  poly[0] = first;
  poly[poly.length - 1] = last;
  return densify(poly, 300);
}

/**
 * Add finer patches along stretches of the skeleton where the passage is
 * narrower than PATCH_CELLS_ACROSS cells of the raster there.
 */
function refineNarrowStretches(
  land: LandMask,
  pts: { lon: number; lat: number }[],
  widthM: Float64Array,
  padDeg: number
): { patches: number; finestDeg: number } {
  let patches = 0;
  let finestDeg = Infinity;
  if (!land.hasPolygons) return { patches, finestDeg };
  const needs = (i: number): number => {
    const res = land.resolutionAt(pts[i].lon, pts[i].lat);
    if (res <= MIN_PATCH_RES * 1.0001 || !(widthM[i] < PATCH_CELLS_ACROSS * res * M_PER_DEG)) return 0;
    let next = res / 2;
    while (next > MIN_PATCH_RES && widthM[i] < PATCH_CELLS_ACROSS * next * M_PER_DEG) next /= 2;
    return Math.max(MIN_PATCH_RES, next);
  };
  const MAX_SPAN_DEG = 0.5;
  let i = 0;
  while (i < pts.length) {
    const r0 = needs(i);
    if (!r0) {
      i++;
      continue;
    }
    let res = r0;
    let j = i;
    let west = pts[i].lon;
    let east = pts[i].lon;
    let south = pts[i].lat;
    let north = pts[i].lat;
    while (j + 1 < pts.length) {
      const r = needs(j + 1);
      if (!r) break;
      let x = pts[j + 1].lon;
      x = unwrapLonNear(x, west);
      const nw = Math.min(west, x);
      const ne = Math.max(east, x);
      const ns = Math.min(south, pts[j + 1].lat);
      const nn = Math.max(north, pts[j + 1].lat);
      if (ne - nw > MAX_SPAN_DEG || nn - ns > MAX_SPAN_DEG) break;
      west = nw;
      east = ne;
      south = ns;
      north = nn;
      res = Math.min(res, r);
      j++;
    }
    const box: BBox = { west: wrapLon(west - padDeg), east: wrapLon(east + padDeg), south: south - padDeg, north: north + padDeg };
    try {
      if (land.refine(box, res)) {
        patches++;
        finestDeg = Math.min(finestDeg, land.resolutionAt(pts[i].lon, pts[i].lat));
      }
    } catch {
      // Patch too large for the cell cap: leave the stretch at the base resolution.
    }
    i = j + 1;
  }
  return { patches, finestDeg };
}

/** Chokepoints whose gate the corridor crosses, narrower than AUTO_VIA_WIDTH_RATIO × stepM. */
export function findAutoVias(
  grid: WaterGrid,
  path: GridNode[],
  segStart: number[],
  chain: [number, number][],
  stepM: number,
  land: LandMask | null
): AutoVia[] {
  const cp = grid.chokepoints;
  if (!cp.length || path.length < 2) return [];
  const cand = new Set<number>();
  for (let i = 0; i < path.length; i += 20) {
    const [lon, lat] = grid.cellCentre(path[i].r, path[i].c);
    for (const k of cp.near(lon, lat, 1)) cand.add(k);
  }
  const [elon, elat] = grid.cellCentre(path[path.length - 1].r, path[path.length - 1].c);
  for (const k of cp.near(elon, elat, 1)) cand.add(k);
  const out: AutoVia[] = [];
  const slack = 1.5 * grid.res * M_PER_DEG;
  for (const k of cand) {
    const widthM = cp.widthM[k];
    if (!(widthM < AUTO_VIA_WIDTH_RATIO * stepM)) continue;
    const plat = cp.lat[k];
    const plon = cp.lon[k];
    const cosP = Math.cos(plat * DEG);
    const th = cp.axisDeg[k] * DEG;
    const ax = Math.sin(th);
    const ay = Math.cos(th);
    const toXY = (r: number, c: number): [number, number] => {
      const [lon, lat] = grid.cellCentre(r, c);
      let dl = lon - plon;
      if (dl > 180) dl -= 360;
      if (dl < -180) dl += 360;
      return [dl * cosP * M_PER_DEG, (lat - plat) * M_PER_DEG];
    };
    let hit = -1;
    let prev = toXY(path[0].r, path[0].c);
    for (let i = 1; i < path.length; i++) {
      const cur = toXY(path[i].r, path[i].c);
      if (Math.abs(cur[0]) > 200_000 || Math.abs(cur[1]) > 200_000) {
        prev = cur;
        continue;
      }
      const sa = prev[0] * ax + prev[1] * ay;
      const sb = cur[0] * ax + cur[1] * ay;
      if ((sa <= 0 && sb > 0) || (sa >= 0 && sb < 0)) {
        const f = sa / (sa - sb);
        const x = prev[0] + f * (cur[0] - prev[0]);
        const y = prev[1] + f * (cur[1] - prev[1]);
        const across = Math.abs(x * ay - y * ax);
        if (across <= widthM / 2 + slack) {
          hit = i;
          break;
        }
      }
      prev = cur;
    }
    if (hit < 0) continue;
    const radiusM = Math.max(widthM / 2 + 500, 1000);
    // Not when a route point already lies in the disc.
    if (chain.some(([lon, lat]) => haversineDistanceM(lon, lat, plon, plat) <= radiusM)) continue;
    let vlon = plon;
    let vlat = plat;
    if (land && land.hasPolygons && land.isLandExact(vlon, vlat)) {
      // Nudge onto water (the stored point is a fine-cell centre of the grid build).
      const nudged = nearestExactWater(land, vlon, vlat, radiusM / 2);
      if (!nudged) continue;
      [vlon, vlat] = nudged;
    }
    let segment = 0;
    while (segment + 1 < segStart.length && segStart[segment + 1] <= hit) segment++;
    out.push({ lon: vlon, lat: vlat, radiusM, widthM, axisDeg: cp.axisDeg[k], name: describePassage(plat, plon), segment, pathIndex: hit });
  }
  out.sort((a, b) => a.pathIndex - b.pathIndex);
  // Drop near-duplicates (keep the narrower).
  const kept: AutoVia[] = [];
  for (const v of out) {
    const dup = kept.findIndex(q => haversineDistanceM(q.lon, q.lat, v.lon, v.lat) < Math.max(1000, Math.min(q.radiusM, v.radiusM)));
    if (dup < 0) kept.push(v);
    else if (v.widthM < kept[dup].widthM) kept[dup] = v;
  }
  return kept;
}

/**
 * Is `clearM` of water around the point by the exact polygons (the point
 * itself, and 8 bearings at clearM and at clearM / 2)? With clearM 0, just
 * the point.
 */
export function waterAround(land: LandMask, lon: number, lat: number, clearM: number): boolean {
  if (land.isLandExact(lon, lat)) return false;
  if (!(clearM > 0)) return true;
  const cosL = Math.max(0.05, Math.cos(lat * DEG));
  for (const d of [clearM, clearM / 2]) {
    for (let a = 0; a < 360; a += 45) {
      const y = lat + (d * Math.cos(a * DEG)) / M_PER_DEG;
      const x = wrapLon(lon + (d * Math.sin(a * DEG)) / (M_PER_DEG * cosL));
      if (land.isLandExact(x, y)) return false;
    }
  }
  return true;
}

/**
 * Nearest point not on land by the exact polygons, with `clearM` of water
 * around it (see waterAround), searched on rings of 50 m out to `maxM`;
 * null when none.
 */
export function nearestExactWater(land: LandMask, lon: number, lat: number, maxM: number, clearM = 0): [number, number] | null {
  const cosL = Math.max(0.05, Math.cos(lat * DEG));
  for (let d = 50; d <= maxM; d += 50) {
    for (let a = 0; a < 360; a += 15) {
      const y = lat + (d * Math.cos(a * DEG)) / M_PER_DEG;
      const x = wrapLon(lon + (d * Math.sin(a * DEG)) / (M_PER_DEG * cosL));
      if (waterAround(land, x, y, clearM)) return [x, y];
    }
  }
  return null;
}

/** A via as the propagator takes it (see propagator.ts Via). */
export interface ChainVia {
  lon: number;
  lat: number;
  radiusM: number;
  auto?: boolean;
  name?: string;
  widthM?: number;
}

/**
 * User vias and automatic vias in route order: the automatic vias of each
 * chain segment come before the user via that ends the segment.
 */
export function mergeVias(user: ChainVia[], autos: AutoVia[]): ChainVia[] {
  const out: ChainVia[] = [];
  for (let s = 0; s <= user.length; s++) {
    for (const a of autos) {
      if (a.segment === s) out.push({ lon: a.lon, lat: a.lat, radiusM: a.radiusM, auto: true, name: a.name, widthM: a.widthM });
    }
    if (s < user.length) out.push(user[s]);
  }
  return out;
}
