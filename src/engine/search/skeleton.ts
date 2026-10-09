/**
 * The skeleton: the corridor from the global water grid or the chart mesh route, or a coarse A* on the route's land mask.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { bboxFromLonLat, haversineDistanceM } from '../../geo/geodesy';
import { buildCoarseGrid, forEachRingCell, type NavigabilityGrid } from '../../geo/grid';
import { astarRoute, AstarError } from '../astar';
import { resizeBudget } from './context';
import { RouteCancelled, type SearchContext } from './types';

export interface SkeletonData {
  skeleton: { lon: number; lat: number }[] | null;
  /** Cumulative distance along the skeleton, metres, per point. */
  skeletonCum: number[] | null;
  /** Across-track water width per skeleton point (corridor only). */
  widths: ArrayLike<number> | null;
}

/**
 * Nearest passable cell centre to `p` within `maxRadius` cells (ring
 * search); returns `p` unchanged when its own cell is passable or when
 * nothing is found.
 */
function snapToPassable(grid: NavigabilityGrid, p: [number, number], maxRadius: number): [number, number] {
  const [i0, j0] = grid.spec.lonlatToIJ(p[0], p[1]);
  if (grid.isPassable(i0, j0)) return p;
  for (let r = 1; r <= maxRadius; r++) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    forEachRingCell(r, (di, dj) => {
      const i = i0 + di;
      const j = j0 + dj;
      if (!grid.isPassable(i, j)) return;
      const [lon, lat] = grid.spec.ijToLonLat(i, j);
      const d = haversineDistanceM(p[0], p[1], lon, lat);
      if (d < bestD) {
        bestD = d;
        best = [lon, lat];
      }
    });
    if (best) return best;
  }
  return p;
}

/** Cumulative great-circle distance along a polyline, metres, per point. */
export function cumulativeM(points: { lon: number; lat: number }[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversineDistanceM(points[i - 1].lon, points[i - 1].lat, points[i].lon, points[i].lat));
  }
  return cum;
}

/** Build the skeleton and, when it is longer than the straight line, re-size the stage budget to it. */
export function buildSkeleton(ctx: SearchContext): SkeletonData {
  const { args, progress, checkCancel, sLon, sLat, eLon, eLat, cruise, goals } = ctx;
  // ---- Coarse A* skeleton -------------------------------------------
  const chainEndpoints: [number, number][] = [
    [sLon, sLat],
    ...goals.slice(0, -1).map(g => [g.lon, g.lat] as [number, number]),
    [eLon, eLat],
  ];
  let skeleton: { lon: number; lat: number }[] | null;
  let skeletonCum: number[] | null;
  let widths: ArrayLike<number> | null = null;
  if (args.corridor && args.corridor.skeleton.length >= 2) {
    skeleton = args.corridor.skeleton.map(p => ({ lon: p.lon, lat: p.lat }));
    skeleton[0] = { lon: sLon, lat: sLat };
    skeleton[skeleton.length - 1] = { lon: eLon, lat: eLat };
    widths = args.corridor.widthM && args.corridor.widthM.length === skeleton.length ? args.corridor.widthM : null;
    skeletonCum = cumulativeM(skeleton);
    const skLen = skeletonCum[skeletonCum.length - 1];
    progress(
      0,
      ctx.K,
      `skeleton: corridor from ${args.corridor.source ?? 'the global water grid'}, ${skeleton.length} points, {distance:${skLen.toFixed(0)}}`
    );
    if (skLen > ctx.budget.budgetDistM) resizeBudget(ctx, skLen);
  } else
    try {
      const bbox = bboxFromLonLat(
        chainEndpoints.map(p => p[0]),
        chainEndpoints.map(p => p[1]),
        ctx.skeletonPaddingDeg
      );
      const t0 = Date.now();
      const coarse = buildCoarseGrid(ctx.landMask, bbox, ctx.skeletonResolutionDeg);
      progress(
        0,
        ctx.K,
        `skeleton grid ${coarse.spec.nx}x${coarse.spec.ny} at {angle:${ctx.skeletonResolutionDeg * (Math.PI / 180)}} built in {time:${(Date.now() - t0) / 1000}}`
      );
      checkCancel();
      // The skeleton is guidance only, so endpoints that fall on a land
      // cell of the coarse raster (a harbour narrower than a cell) are
      // snapped to the nearest passable cell centre for the search.
      const t1 = Date.now();
      const snapped = chainEndpoints.map(p => snapToPassable(coarse, p, 20));
      const chain: { lon: number; lat: number }[] = [];
      try {
        for (let s = 0; s + 1 < snapped.length; s++) {
          const seg = astarRoute(coarse, snapped[s], snapped[s + 1], cruise);
          if (chain.length) chain.push(...seg.path.slice(1));
          else chain.push(...seg.path);
        }
        skeleton = chain;
      } catch (err) {
        if (!(err instanceof AstarError)) throw err;
        progress(0, ctx.K, `skeleton chain A* failed (${err.message}); retrying start→end only`);
        skeleton = astarRoute(coarse, snapped[0], snapped[snapped.length - 1], cruise).path;
      }
      // Restore the exact endpoints on the skeleton.
      skeleton[0] = { lon: sLon, lat: sLat };
      skeleton[skeleton.length - 1] = { lon: eLon, lat: eLat };
      skeletonCum = cumulativeM(skeleton);
      progress(
        0,
        ctx.K,
        `skeleton: ${skeleton.length} points, {distance:${skeletonCum[skeletonCum.length - 1].toFixed(0)}}, A* {time:${(Date.now() - t1) / 1000}}`
      );
      const skLen = skeletonCum[skeletonCum.length - 1];
      if (skLen > ctx.budget.budgetDistM) resizeBudget(ctx, skLen);
    } catch (err) {
      if (err instanceof RouteCancelled) throw err;
      progress(0, ctx.K, `skeleton unavailable (${(err as Error).message}); headings aim straight at the destination`);
      skeleton = null;
      skeletonCum = null;
    }
  return { skeleton, skeletonCum, widths };
}
