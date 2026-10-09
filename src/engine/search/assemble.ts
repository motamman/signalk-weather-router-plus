/**
 * Route assembly: back-trace, waypoints (with via markers), totals, enrichment, exact-polygon validation.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { alongTrackDistanceM, haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import { simulateLegTime } from '../legsim';
import { recomputePerWaypointMetadata, type Route, type RouteWarning, type Waypoint } from '../route';
import { enrichWaypoints } from './enrich';
import { MIN_FINAL_LEG_M, type Terminal } from './terminal';
import type { Candidate, SearchContext } from './types';
import type { SkeletonGuide } from './zones';

export function assembleRoute(ctx: SearchContext, guide: SkeletonGuide, stages: Candidate[][], t: Terminal): Route {
  const { bestC, stageOfBest, tackCand, finalCand } = t;
  const { args, wind, current, polar, vessel, simOpts, progress, goals, nVias, fronts } = ctx;
  const { skeleton, kEff } = guide;
  // Back-trace.
  const chain: Candidate[] = [];
  let cur: Candidate | undefined = bestC;
  let curStage = stageOfBest;
  while (cur && curStage >= 0) {
    chain.push(cur);
    if (curStage === 0 || cur.parentIdx < 0) break;
    cur = stages[curStage - 1][cur.parentIdx];
    curStage--;
  }
  chain.reverse();
  if (tackCand) chain.push(tackCand);
  if (finalCand) chain.push(finalCand);
  // A candidate that landed on the destination (the stage step dividing
  // the distance exactly) gets a final hop of millimetres: the route then
  // ends with the same point twice and a zero-length leg (2026-10-08, a
  // 330 m channel dead downwind in the pipeline tests). The hop is dropped
  // and the candidate's waypoint takes the exact end instead.
  let snapEnd: [number, number] | null = null;
  if (finalCand && chain.length >= 2) {
    const prev = chain[chain.length - 2];
    if (haversineDistanceM(prev.lon, prev.lat, finalCand.lon, finalCand.lat) < MIN_FINAL_LEG_M) {
      chain.pop();
      snapEnd = [finalCand.lon, finalCand.lat];
    }
  }

  // Build waypoints.
  const wps: Waypoint[] = [];
  let motorS = 0;
  let sailS = 0;
  let dist = 0;
  chain.forEach((c, i) => {
    // A user via crossed by a step that ends outside its circle: add a
    // waypoint on that step where it passes closest to the via (same
    // straight line, so the track is unchanged) and mark it, instead of
    // marking the step's end up to a stage step past the waypoint.
    let endIsVia = false;
    if (i > 0) {
      const par = chain[i - 1];
      const inserts: { at: number; lon: number; lat: number }[] = [];
      for (const vi of c.viaIdxs) {
        const g = goals[vi];
        if (g.auto) continue;
        if (haversineDistanceM(c.lon, c.lat, g.lon, g.lat) <= g.radiusM) {
          endIsVia = true;
          continue;
        }
        const legM = haversineDistanceM(par.lon, par.lat, c.lon, c.lat);
        const at = Math.min(legM, Math.max(0, alongTrackDistanceM(par.lon, par.lat, c.lon, c.lat, g.lon, g.lat)));
        if (at <= 0 || at >= legM) {
          endIsVia = true;
          continue;
        }
        const [lon, lat] = projectAlongBearing(par.lon, par.lat, haversineBearing(par.lon, par.lat, c.lon, c.lat), at);
        inserts.push({ at, lon, lat });
      }
      inserts.sort((x, y) => x.at - y.at);
      let prevWp = { lon: par.lon, lat: par.lat, timeMs: par.timeMs };
      for (const ins of inserts) {
        const sim = simulateLegTime(
          prevWp.lon,
          prevWp.lat,
          new Date(prevWp.timeMs),
          ins.lon,
          ins.lat,
          vessel,
          polar,
          wind,
          current,
          simOpts
        );
        const secs = Number.isFinite(sim.seconds) && sim.seconds > 0 ? sim.seconds : 0;
        const timeMs = Math.min(c.timeMs - 1, Math.max(prevWp.timeMs + 1, prevWp.timeMs + secs * 1000));
        wps.push({
          lon: ins.lon,
          lat: ins.lat,
          time: new Date(timeMs),
          sogMs: c.sogMs,
          cogDeg: c.cogDeg,
          mode: sim.dominantMode === 'sailing' ? 'sailing' : sim.dominantMode === 'motoring' ? 'motoring' : c.mode,
          leg: 'ocean',
          role: 'via',
        });
        prevWp = { lon: ins.lon, lat: ins.lat, timeMs };
      }
    }
    wps.push({
      lon: c.lon,
      lat: c.lat,
      time: new Date(c.timeMs),
      sogMs: i > 0 ? c.sogMs : 0,
      cogDeg: i > 0 ? c.cogDeg : 0,
      mode: i > 0 ? c.mode : 'motoring',
      leg: 'ocean',
      role: endIsVia ? 'via' : undefined,
    });
    if (i > 0) {
      motorS += c.motoringS;
      sailS += c.sailingS;
      dist += haversineDistanceM(chain[i - 1].lon, chain[i - 1].lat, c.lon, c.lat);
    }
  });

  if (snapEnd) {
    wps[wps.length - 1].lon = snapEnd[0];
    wps[wps.length - 1].lat = snapEnd[1];
  }
  enrichWaypoints(wps, wind, current);

  const route: Route = {
    waypoints: wps,
    totalTimeS: (wps[wps.length - 1].time.getTime() - wps[0].time.getTime()) / 1000,
    totalDistanceM: dist,
    motoringTimeS: motorS,
    sailingTimeS: sailS,
    validated: false,
    skeleton: skeleton ? skeleton.map(p => ({ lon: p.lon, lat: p.lat })) : undefined,
  };
  const autos = goals.slice(0, nVias).filter(g => g.auto);
  if (autos.length)
    route.autoVias = autos.map(g => ({ lon: g.lon, lat: g.lat, radiusM: g.radiusM, widthM: g.widthM ?? 0, name: g.name ?? '' }));
  route.fronts = fronts;
  recomputePerWaypointMetadata(route);

  // Final validation against the exact polygons.
  const warns: RouteWarning[] = [];
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    if (ctx.landMask.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat)) {
      warns.push({ leg_index: i, violation: 'leg_crosses_land', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
    }
  }
  // Legs over a wind or wave limit at their waypoints (the search tested
  // sub-steps; a difference at the waypoints is possible and should show).
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1];
    const b = wps[i];
    if (args.maxWindMs !== undefined && b.windMs !== undefined && b.windMs > args.maxWindMs)
      warns.push({ leg_index: i - 1, violation: 'wind_over_limit', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
    if (args.maxSwhM !== undefined && b.swhM !== undefined && b.swhM > args.maxSwhM)
      warns.push({ leg_index: i - 1, violation: 'waves_over_limit', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
  }
  route.validated = true;
  if (warns.length) {
    route.warnings = warns;
    const count = (v: RouteWarning['violation']): number => warns.filter(w => w.violation === v).length;
    const parts: string[] = [];
    const land = count('leg_crosses_land');
    const wind = count('wind_over_limit');
    const waves = count('waves_over_limit');
    if (land) parts.push(`${land} leg(s) cross land in the exact polygon check`);
    if (wind) parts.push(`${wind} leg(s) over the wind limit at a waypoint`);
    if (waves) parts.push(`${waves} leg(s) over the wave limit at a waypoint`);
    progress(Math.max(kEff, stages.length - 1), Math.max(kEff, stages.length - 1), `WARNING: ${parts.join('; ')}`);
  }
  progress(
    Math.max(kEff, stages.length - 1),
    Math.max(kEff, stages.length - 1),
    `done: ${wps.length} waypoints, {distance:${dist.toFixed(0)}}, {time:${route.totalTimeS.toFixed(0)}}`
  );
  return route;
}
