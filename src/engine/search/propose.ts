/**
 * Candidate proposal: the heading sweep from each parent, land test in bulk, batched scoring, via bookkeeping.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing, segmentWithinDisc } from '../../geo/geodesy';
import { norm360 } from '../../geo/angles';
import { scoreCandidatesFromParent, DEFAULT_TACK_PENALTY_S, tackBetween } from '../legsim';
import type { Candidate, SearchContext } from './types';
import type { SkeletonGuide } from './zones';

/**
 * Per parent: the heading sweep (2·sweepM+1 headings, sweepDc apart, one
 * step × stepFactor long), plus one hop into the next user waypoint's
 * circle when that circle is closer than one step (INTO_CIRCLE_NOTE in
 * propagator.ts).
 */
export function propose(
  ctx: SearchContext,
  guide: SkeletonGuide,
  parents: Candidate[],
  sweepM: number,
  sweepDc: number,
  stepFactor: number
): Candidate[] {
  const { wind, current, polar, vessel, simOpts, goals, nVias, lastTry } = ctx;
  const nH = 2 * sweepM + 1;
  const nP = parents.length;
  // Per parent: the heading sweep, plus one hop into the next user
  // waypoint's circle when that circle is closer than one step
  // (INTO_CIRCLE_NOTE). hopDist[p] = 0: no hop.
  const pStep = new Float64Array(nP);
  const pTgt: [number, number][] = [];
  const hopDist = new Float64Array(nP);
  const hopBrg = new Float64Array(nP);
  let total = 0;
  for (let p = 0; p < nP; p++) {
    const par = parents[p];
    const sf = guide.stepFor(par.lon, par.lat);
    pStep[p] = sf.step * stepFactor;
    pTgt.push(guide.targetForParent(sf.idx, sf.step, par.lon, par.lat));
    total += nH;
    if (par.viaCount < nVias) {
      const g = goals[par.viaCount];
      if (!g.auto) {
        const d = haversineDistanceM(par.lon, par.lat, g.lon, g.lat);
        const hop = d - g.radiusM + Math.min(1, 0.001 * g.radiusM);
        if (d > g.radiusM && hop < pStep[p]) {
          hopDist[p] = hop;
          hopBrg[p] = haversineBearing(par.lon, par.lat, g.lon, g.lat);
          total++;
        }
      }
    }
  }
  const pIdx = new Int32Array(total);
  const hdg = new Float64Array(total);
  const dist = new Float64Array(total);
  const cLon = new Float64Array(total);
  const cLat = new Float64Array(total);
  const pLon = new Float64Array(total);
  const pLat = new Float64Array(total);
  const pCount = new Int32Array(nP);
  let q = 0;
  const push = (p: number, b: number, d: number): void => {
    const par = parents[p];
    const [x, y] = projectAlongBearing(par.lon, par.lat, b, d);
    pIdx[q] = p;
    hdg[q] = b;
    dist[q] = d;
    cLon[q] = x;
    cLat[q] = y;
    pLon[q] = par.lon;
    pLat[q] = par.lat;
    q++;
  };
  for (let p = 0; p < nP; p++) {
    const par = parents[p];
    const tgt = pTgt[p];
    const b0 = haversineBearing(par.lon, par.lat, tgt[0], tgt[1]);
    for (let h = -sweepM; h <= sweepM; h++) push(p, norm360(b0 + h * sweepDc), pStep[p]);
    if (hopDist[p] > 0) push(p, hopBrg[p], hopDist[p]);
    pCount[p] = nH + (hopDist[p] > 0 ? 1 : 0);
  }
  const crosses = ctx.landMask.legsCrossLandBulk(pLon, pLat, cLon, cLat);
  const out: Candidate[] = [];
  lastTry.tried += total;
  for (let i = 0; i < total; i++) if (crosses[i]) lastTry.land++;
  // Group survivors by parent for batched scoring.
  let start = 0;
  for (let p = 0; p < nP; p++) {
    const end = start + pCount[p];
    const keep: number[] = [];
    for (let i = start; i < end; i++) if (!crosses[i]) keep.push(i);
    start = end;
    if (keep.length === 0) continue;
    const par = parents[p];
    const bearings = new Float64Array(keep.map(i => hdg[i]));
    const dists = new Float64Array(keep.map(i => dist[i]));
    const sc = scoreCandidatesFromParent(par.lon, par.lat, new Date(par.timeMs), bearings, dists, vessel, polar, wind, current, simOpts);
    // The tacking penalty: a move that puts the wind on the other side of
    // the boat from the parent's heading, both under sail, costs the penalty
    // in time and in rank (the start has no heading: no penalty).
    const tackS = simOpts.tackPenaltyS ?? DEFAULT_TACK_PENALTY_S;
    const [, wdPar] = tackS > 0 && par.mode === 'sailing' ? wind.at(par.lon, par.lat, new Date(par.timeMs)) : [0, NaN];
    for (let c = 0; c < keep.length; c++) {
      let secs = sc.seconds[c];
      if (!Number.isFinite(secs) || secs <= 0) {
        if (sc.limited[c]) lastTry.limited++;
        else if (sc.noGo[c]) lastTry.noGo++;
        else lastTry.stuck++;
        continue;
      }
      const i = keep[c];
      // A tack: the penalty is time spent sailing, so it counts in the sailing time too (the totals must add up).
      const tacked = Number.isFinite(wdPar) && sc.dominant[c] === 1 && tackBetween(par.cogDeg, hdg[i], wdPar);
      if (tacked) secs += tackS;
      const legDist = haversineDistanceM(par.lon, par.lat, cLon[i], cLat[i]);
      const cand: Candidate = {
        lon: cLon[i],
        lat: cLat[i],
        timeMs: par.timeMs + secs * 1000,
        elapsedS: par.elapsedS + secs,
        costS: par.costS + secs + sc.penalty[c],
        parentIdx: p,
        sogMs: legDist / secs,
        cogDeg: hdg[i],
        mode: sc.dominant[c] === 1 ? 'sailing' : 'motoring',
        sailingS: sc.sailing[c] + (tacked ? tackS : 0),
        motoringS: sc.motoring[c],
        viaCount: par.viaCount,
        viaIdxs: [],
      };
      while (cand.viaCount < nVias) {
        const g = goals[cand.viaCount];
        if (segmentWithinDisc(par.lon, par.lat, cand.lon, cand.lat, g.lon, g.lat, g.radiusM)) {
          cand.viaIdxs.push(cand.viaCount);
          cand.viaCount++;
        } else break;
      }
      out.push(cand);
    }
  }
  return out;
}
