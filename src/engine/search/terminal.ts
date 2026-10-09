/**
 * Terminal choice: the candidate whose simulated final leg (straight, or a beat to windward) arrives earliest, and that final leg.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import { norm360, twaFromHeading } from '../../geo/angles';
import { DEG, NM_M } from '../../geo/units';
import type { CurrentSource, WindSource } from '../environment';
import { simulateLegTime, type LegSimResult, type ModePolicy, type SimOptions, DEFAULT_TACK_PENALTY_S } from '../legsim';
import type { PolarDiagram } from '../../vessel/polar';
import type { VesselParams } from '../../vessel/vessel';
import { forecastNote, tryNote } from './context';
import { RouteError, TERMINAL_EVAL, ViasNotCrossedError, type Candidate, type SearchContext } from './types';
import type { SkeletonGuide } from './zones';

export interface Terminal {
  bestC: Candidate;
  stageOfBest: number;
  /** The tack point of a final beat, when any. */
  tackCand: Candidate | null;
  /** The end of the final leg (null when the leg ends at bestC, inside the arrival circle). */
  finalCand: Candidate | null;
}

/** The candidate at the end of a simulated straight hop from `from` to (lon, lat). */
function hopCandidate(from: Candidate, lon: number, lat: number, sim: LegSimResult): Candidate {
  const d = haversineDistanceM(from.lon, from.lat, lon, lat);
  return {
    lon,
    lat,
    timeMs: from.timeMs + sim.seconds * 1000,
    elapsedS: from.elapsedS + sim.seconds,
    costS: from.costS + sim.seconds + sim.penaltySeconds,
    parentIdx: -1,
    sogMs: d / sim.seconds,
    cogDeg: haversineBearing(from.lon, from.lat, lon, lat),
    mode: sim.dominantMode === 'sailing' ? 'sailing' : 'motoring',
    sailingS: sim.sailingSeconds,
    motoringS: sim.motoringSeconds,
    viaCount: from.viaCount,
    viaIdxs: [],
  };
}

/**
 * The final hop to windward as a beat: when the straight bearing from `from`
 * to the goal lies inside the polar's no-go angle for the wind there, two
 * close-hauled legs (TWA = the polar's tightest sailable angle plus a small
 * margin) on either tack, meeting at the tack point the laylines give, in
 * whichever order is faster and clear of land. Null when the straight hop
 * can be sailed (or motored, in motor mode), or no beat is possible.
 */
/** A final leg shorter than this is no leg: the candidate is at the destination. */
export const MIN_FINAL_LEG_M = 1;

export function beatToWindward(
  ctx: SearchContext,
  from: Candidate,
  gLon: number,
  gLat: number,
  vessel: VesselParams,
  polar: PolarDiagram | null,
  wind: WindSource,
  current: CurrentSource,
  simOpts: SimOptions,
  modePolicy: ModePolicy
): { tack: Candidate; final: Candidate; d1: number; d2: number } | null {
  if (!polar || modePolicy === 'motor') return null;
  const [ws, wd] = wind.at(from.lon, from.lat, new Date(from.timeMs));
  if (!Number.isFinite(ws) || ws <= 0 || !Number.isFinite(wd)) return null;
  const D = haversineDistanceM(from.lon, from.lat, gLon, gLat);
  if (D < MIN_FINAL_LEG_M) return null;
  const theta = haversineBearing(from.lon, from.lat, gLon, gLat);
  const twa = twaFromHeading(theta, wd);
  const floor = polar.noGoFloor(ws);
  if (!(twa < floor)) return null; // the straight hop can be sailed
  // The tack angle: the polar's tightest sailable angle plus a margin. The
  // tightest beat (3°) is the shortest, but the wind at the start is not
  // the wind along a leg of tens of km: a shift of a few degrees towards
  // the heading puts the leg in the no-go angle and the beat fails (job
  // f993afa5, Gibraltar → Canaries: four candidates 27° off the wind, no
  // beat possible with 3°). Wider beats are tried too; the fastest that
  // sails on both legs wins.
  let best: { tack: Candidate; final: Candidate; d1: number; d2: number; total: number } | null = null;
  for (const margin of BEAT_MARGINS_DEG) {
    const beta = Math.min(89, floor + margin);
    const h1 = norm360(wd + beta);
    const h2 = norm360(wd - beta);
    const det = Math.sin((h1 - h2) * DEG);
    if (Math.abs(det) < 1e-9) continue;
    const d1 = (D * Math.sin((theta - h2) * DEG)) / det;
    const d2 = (D * Math.sin((h1 - theta) * DEG)) / det;
    if (!(d1 > 0 && d2 > 0)) continue;
    const orders: { hFirst: number; dFirst: number; hSecond: number; dSecond: number }[] = [
      { hFirst: h1, dFirst: d1, hSecond: h2, dSecond: d2 },
      { hFirst: h2, dFirst: d2, hSecond: h1, dSecond: d1 },
    ];
    for (const o of orders) {
      const [tLon, tLat] = projectAlongBearing(from.lon, from.lat, o.hFirst, o.dFirst);
      const cross = ctx.landMask.legsCrossLandBulk(
        Float64Array.of(from.lon, tLon),
        Float64Array.of(from.lat, tLat),
        Float64Array.of(tLon, gLon),
        Float64Array.of(tLat, gLat)
      );
      if (cross[0] || cross[1]) continue;
      const s1 = simulateLegTime(from.lon, from.lat, new Date(from.timeMs), tLon, tLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(s1.seconds) || s1.seconds <= 0) continue;
      const tack = hopCandidate(from, tLon, tLat, s1);
      // The beat's one tack costs the penalty, in time and in cost.
      const tackS = simOpts.tackPenaltyS ?? DEFAULT_TACK_PENALTY_S;
      tack.timeMs += tackS * 1000;
      tack.elapsedS += tackS;
      tack.costS += tackS;
      const s2 = simulateLegTime(tLon, tLat, new Date(tack.timeMs), gLon, gLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(s2.seconds) || s2.seconds <= 0) continue;
      // Time plus comfort cost: with a comfort weight the beat avoids the rougher tack.
      const total = s1.seconds + s1.penaltySeconds + s2.seconds + s2.penaltySeconds;
      if (!best || total < best.total) best = { tack, final: hopCandidate(tack, gLon, gLat, s2), d1: o.dFirst, d2: o.dSecond, total };
    }
  }
  return best;
}

/** Margins (degrees) added to the polar's tightest sailable angle for the beat's two legs, tightest first. */
export const BEAT_MARGINS_DEG = [3, 8, 15, 25, 40];

export function chooseTerminal(ctx: SearchContext, guide: SkeletonGuide, stages: Candidate[][]): Terminal {
  const { args, wind, current, polar, vessel, modePolicy, simOpts, progress, checkCancel, eLon, eLat, snapToExact, nVias, limitNote } = ctx;
  const { kEff } = guide;
  const terminals = stages[stages.length - 1];
  if (terminals.length === 0) throw new RouteError('front went empty before reaching the destination; no path found');
  const score = (c: Candidate): [number, number] => [haversineDistanceM(c.lon, c.lat, eLon, eLat), c.costS];
  const pool = nVias > 0 ? terminals.filter(c => c.viaCount === nVias) : terminals;
  if (pool.length === 0) {
    const deepest = Math.max(0, ...terminals.map(c => c.viaCount));
    throw new ViasNotCrossedError(
      `finished ${stages.length - 1} stages without any branch crossing all ${nVias} via(s); deepest branch crossed ${deepest}. Widen the via radius, add stages, or move the via.`
    );
  }
  // Prefer terminals whose straight final leg is land-free.
  const poolHop = ctx.landMask.legsCrossLandBulk(
    Float64Array.from(pool.map(c => c.lon)),
    Float64Array.from(pool.map(c => c.lat)),
    new Float64Array(pool.length).fill(eLon),
    new Float64Array(pool.length).fill(eLat)
  );
  const clearPool = pool.filter((_c, i) => !poolHop[i]);
  const choose = clearPool.length ? clearPool : pool;
  // The nearest candidate (elapsed time as tie-break): the reference
  // implementation's choice, kept as the fallback.
  let bestC = choose[0];
  for (const c of choose) {
    const [d, t] = score(c);
    const [bd, bt] = score(bestC);
    if (d < bd || (d === bd && t < bt)) bestC = c;
  }
  const nearest = bestC;
  // Where a candidate's final leg ends: the exact destination, or
  // (approximate intermediate waypoint) only as far as the arrival circle;
  // null when the candidate is already inside the circle.
  const hopEndFor = (c: Candidate): [number, number] | null => {
    const d = haversineDistanceM(c.lon, c.lat, eLon, eLat);
    if (snapToExact) return [eLon, eLat];
    const r = args.arrivalRadiusM!;
    if (d <= r) return null;
    return projectAlongBearing(c.lon, c.lat, haversineBearing(c.lon, c.lat, eLon, eLat), d - r + Math.min(1, 0.001 * r));
  };
  // The choice that matters: the candidate whose predicted arrival is
  // earliest once its final leg (straight, or a beat when the straight hop
  // is in the no-go angle) is simulated, not the nearest one. Candidates
  // advance a fixed distance per stage, so a slow branch crawling straight
  // at the goal is nearest when the search stops while faster branches
  // that tacked are further out but hours ahead (job e6e338f6, leg 5: the
  // nearest branch 3.5 km out at 9.85 h, four tacking branches 12–14 km
  // out at about 5 h). Nearest first, at most TERMINAL_EVAL simulated.
  // Why a candidate's final leg failed, for the error when none succeeds.
  type FailWhy = 'land' | 'limited' | 'no_go' | 'current' | 'no_speed';
  const fails = new Map<Candidate, FailWhy>();
  const planFor = (c: Candidate) => {
    const hopEnd = hopEndFor(c);
    // arrivalS: the real arrival (reported); costS: arrival plus comfort cost (compared).
    if (!hopEnd) return { hopEnd: null, beat: null, sim: null, arrivalS: c.elapsedS, costS: c.costS };
    if (!snapToExact) {
      const cross = ctx.landMask.legsCrossLandBulk(
        Float64Array.of(c.lon),
        Float64Array.of(c.lat),
        Float64Array.of(hopEnd[0]),
        Float64Array.of(hopEnd[1])
      );
      if (cross[0]) {
        fails.set(c, 'land');
        return null;
      }
    }
    const beat = beatToWindward(ctx, c, hopEnd[0], hopEnd[1], vessel, polar, wind, current, simOpts, modePolicy);
    if (beat) return { hopEnd, beat, sim: null, arrivalS: beat.final.elapsedS, costS: beat.final.costS };
    const sim = simulateLegTime(c.lon, c.lat, new Date(c.timeMs), hopEnd[0], hopEnd[1], vessel, polar, wind, current, simOpts);
    if (!Number.isFinite(sim.seconds) || sim.seconds <= 0) {
      fails.set(c, sim.reason ?? 'no_speed');
      return null;
    }
    return { hopEnd, beat: null, sim, arrivalS: c.elapsedS + sim.seconds, costS: c.costS + sim.seconds + sim.penaltySeconds };
  };
  type FinalPlan = NonNullable<ReturnType<typeof planFor>>;
  const plans = new Map<Candidate, FinalPlan>();
  // The failures of every evaluated final leg, with the conditions at the
  // nearest candidate: what the user needs when no final leg can be sailed.
  const failNote = (): string => {
    if (fails.size === 0) return '';
    const n = (w: FailWhy): number => [...fails.values()].filter(v => v === w).length;
    const parts: string[] = [];
    if (n('limited')) parts.push(`${n('limited')} over the wind/wave limit`);
    if (n('no_go')) parts.push(`${n('no_go')} dead upwind with no beat possible (the polar's no-go angle)`);
    if (n('current')) parts.push(`${n('current')} stopped by a current stronger than the boat's speed`);
    if (n('no_speed')) parts.push(`${n('no_speed')} with no boat speed`);
    if (n('land')) parts.push(`${n('land')} crossing land`);
    const [ws, wd] = wind.at(nearest.lon, nearest.lat, new Date(nearest.timeMs));
    const [cu, cv] = current.at(nearest.lon, nearest.lat, new Date(nearest.timeMs));
    const brg = haversineBearing(nearest.lon, nearest.lat, eLon, eLat);
    const cond = `at the nearest (${(score(nearest)[0] / 1000).toFixed(1)} km out, ${new Date(nearest.timeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC): final leg bearing ${brg.toFixed(0)}°, wind ${ws.toFixed(1)} m/s from ${wd.toFixed(0)}°, current ${Math.hypot(cu, cv).toFixed(2)} m/s towards ${norm360((Math.atan2(cu, cv) * 180) / Math.PI).toFixed(0)}°`;
    return ` Of the ${fails.size} final legs tried: ${parts.join(', ')}; ${cond}.`;
  };
  if (clearPool.length) {
    const byDist = [...clearPool].sort((a, b) => score(a)[0] - score(b)[0]).slice(0, TERMINAL_EVAL);
    for (const c of byDist) {
      checkCancel();
      const plan = planFor(c);
      if (plan) plans.set(c, plan);
    }
    let earliest: Candidate | null = null;
    for (const [c, plan] of plans) {
      if (earliest === null) {
        earliest = c;
        continue;
      }
      const e = plans.get(earliest)!;
      if (plan.costS < e.costS || (plan.costS === e.costS && score(c)[0] < score(earliest)[0])) earliest = c;
    }
    if (earliest !== null) bestC = earliest;
    if (bestC !== nearest) {
      const np = plans.get(nearest);
      progress(
        Math.max(kEff, stages.length - 1),
        Math.max(kEff, stages.length - 1),
        `final choice: the branch ${args.comfortWeight && args.comfortWeight > 0 ? 'with the least time plus comfort cost, arriving' : 'arriving earliest'} (${(plans.get(bestC)!.arrivalS / 3600).toFixed(1)} h, from ${(score(bestC)[0] / 1000).toFixed(1)} km out) over the nearest (${(score(nearest)[0] / 1000).toFixed(1)} km out${np ? `, arriving ${(np.arrivalS / 3600).toFixed(1)} h` : ', no sailable final leg'})`
      );
    }
  }
  const stageOfBest = stages.findIndex(st => st.includes(bestC));
  const bestPlan = plans.get(bestC);

  // Final straight leg: to the exact destination, or (approximate
  // intermediate waypoint) only as far as the arrival circle.
  checkCancel();
  const bestDist = haversineDistanceM(bestC.lon, bestC.lat, eLon, eLat);
  const hopEnd: [number, number] | null = hopEndFor(bestC);
  let finalCand: Candidate | null = null;
  let tackCand: Candidate | null = null;
  if (hopEnd) {
    const [hLon, hLat] = hopEnd;
    const finalCross = ctx.landMask.legsCrossLandBulk(
      Float64Array.of(bestC.lon),
      Float64Array.of(bestC.lat),
      Float64Array.of(hLon),
      Float64Array.of(hLat)
    );
    if (finalCross[0]) {
      throw new RouteError(
        `terminal hop from (${bestC.lat.toFixed(4)}, ${bestC.lon.toFixed(4)}) to the destination crosses land; the propagation got close but the straight final leg is blocked. Try a via point or a closer endpoint.`
      );
    }
    // To windward: the straight hop lies inside the polar's no-go angle, so
    // beat to it on two close-hauled legs meeting at a tack point (the
    // laylines), in whichever order is faster and clear of land. Only a hop
    // that cannot be sailed at all is beaten; everything else stays straight.
    const beat = bestPlan ? bestPlan.beat : beatToWindward(ctx, bestC, hLon, hLat, vessel, polar, wind, current, simOpts, modePolicy);
    if (beat) {
      tackCand = beat.tack;
      finalCand = beat.final;
      progress(
        Math.max(kEff, stages.length - 1),
        Math.max(kEff, stages.length - 1),
        `final approach is to windward: beating to the waypoint on two tacks, ${(beat.d1 / NM_M).toFixed(1)} nm then ${(beat.d2 / NM_M).toFixed(1)} nm`
      );
    } else {
      const simFinal =
        bestPlan && bestPlan.sim
          ? bestPlan.sim
          : simulateLegTime(bestC.lon, bestC.lat, new Date(bestC.timeMs), hLon, hLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(simFinal.seconds) || simFinal.seconds <= 0) {
        // From far away (more than two stage steps) the straight hop was
        // never going to work: the search ran its budget out boxed in.
        if (bestDist > 2 * guide.stepFor(bestC.lon, bestC.lat).step) {
          throw new RouteError(
            `the search ran out of stages ${(bestDist / 1000).toFixed(0)} km from the destination, boxed in; ${tryNote(ctx)}; the straight final leg from there is stuck under ${modePolicy}${limitNote}.${forecastNote(ctx)}`,
            'boxed_in'
          );
        }
        throw new RouteError(
          `terminal hop to the destination could not be simulated (stuck under ${modePolicy} given wind/current at the destination${limitNote}).${failNote()}${forecastNote(ctx)}`
        );
      }
      const legDistFinal = haversineDistanceM(bestC.lon, bestC.lat, hLon, hLat);
      if (legDistFinal > 0) finalCand = hopCandidate(bestC, hLon, hLat, simFinal);
    }
  }
  if (!snapToExact) {
    const endAt = finalCand ?? bestC;
    progress(
      Math.max(kEff, stages.length - 1),
      Math.max(kEff, stages.length - 1),
      `leg ends inside the ${args.arrivalRadiusM!.toFixed(0)} m circle, ${haversineDistanceM(endAt.lon, endAt.lat, eLon, eLat).toFixed(0)} m from the waypoint${finalCand ? ' (straight hop from the last stage to the circle)' : ''}`
    );
  }
  return { bestC, stageOfBest, tackCand, finalCand };
}
