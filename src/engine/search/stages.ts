/**
 * The stage loop: propose, fallback ladder, subsector pruning, the front for display, stall detection, early termination.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { haversineDistanceM, perpendicularOffsetM } from '../../geo/geodesy';
import type { StageFront } from '../route';
import { fmtUtc, forecastNote, resetTry, tryNote } from './context';
import { propose } from './propose';
import { BEATING_SHARE, RouteError, STALL_STAGES, ViasNotCrossedError, type Candidate, type SearchContext } from './types';
import type { SkeletonGuide } from './zones';

function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** The path from the start to `cand` (in stage `stageIdx`), [lon, lat] per stage, start first. */
function traceBack(stages: Candidate[][], stageIdx: number, cand: Candidate): [number, number][] {
  const out: [number, number][] = [];
  let cur: Candidate | undefined = cand;
  let s = stageIdx;
  while (cur && s >= 0) {
    out.push([r4(cur.lon), r4(cur.lat)]);
    if (s === 0 || cur.parentIdx < 0) break;
    cur = stages[s - 1][cur.parentIdx];
    s--;
  }
  return out.reverse();
}

/** Run the stages from the start; returns every stage's retained candidates (stage 0 = the start). */
export function runStages(ctx: SearchContext, guide: SkeletonGuide): Candidate[][] {
  const { args, progress, checkCancel, sLon, sLat, eLon, eLat, goals, nVias, startViaCount, cruise, fronts, lastTry, limitNote } = ctx;
  const { deltaD, candStepM } = ctx.budget;
  const { kEff, maxStages } = guide;
  const announced = new Set<number>();
  for (let gi = 0; gi < nVias; gi++) {
    const g = goals[gi];
    if (g.auto)
      progress(
        0,
        kEff,
        `auto via at ${g.name ?? 'a narrow passage'}, width ${((g.widthM ?? 0) / 1000).toFixed(1)} km (disc radius ${(g.radiusM / 1000).toFixed(1)} km)`
      );
  }
  const stages: Candidate[][] = [
    [
      {
        lon: sLon,
        lat: sLat,
        timeMs: args.departureTime.getTime(),
        elapsedS: 0,
        costS: 0,
        parentIdx: -1,
        sogMs: 0,
        cogDeg: 0,
        mode: 'motoring',
        sailingS: 0,
        motoringS: 0,
        viaCount: startViaCount,
        viaIdxs: [],
      },
    ],
  ];

  let bestEver = Infinity;
  let stagesWithoutGain = 0;
  let bestEverDeepest = -1;
  for (let stage = 0; stage < maxStages; stage++) {
    checkCancel();
    const tStage = Date.now();
    const parents = stages[stages.length - 1];
    if (parents.length === 0) {
      throw new RouteError(
        `stage ${stage} has no live waypoints: every candidate from the previous stage was blocked by land${limitNote} even after widening the heading sweep and halving the step (${tryNote(ctx)}).${forecastNote(ctx)}`
      );
    }
    resetTry(ctx, parents);
    let cands = propose(ctx, guide, parents, ctx.m, ctx.deltaC, 1);
    // Fallback ladder, per parent (deviation from the reference, which
    // widened only when the whole stage's sweep was empty): a parent whose
    // primary sweep produced nothing (its headings in the polar's no-go
    // angle, on land, or over a limit) gets the wider sweeps on its own,
    // while its siblings keep their primary candidates. A parent facing
    // dead upwind can then tack at every stage instead of only on the
    // stages where every other parent was stuck too (the eastern
    // Mediterranean job 3bde5200: the front shuffled between 1 and 4
    // members, "tacking in place" 1,356–1,430 km from the goal).
    {
      const has = new Uint8Array(parents.length);
      for (const c of cands) has[c.parentIdx] = 1;
      let dead: number[] = [];
      for (let p = 0; p < parents.length; p++) if (!has[p]) dead.push(p);
      const ladder: [number, number, number, string][] = [
        [ctx.m * 2, ctx.deltaC * 2, 1, `widening to ±${ctx.m * 2 * ctx.deltaC * 2}°`],
        [ctx.m * 3, ctx.deltaC * 2, 0.5, `trying ±${ctx.m * 3 * ctx.deltaC * 2}° with half step`],
        // Beyond the reference: a full 360° sweep at a quarter step, for
        // parents boxed in by a coast whose exits are shorter than half a
        // stage step.
        [90, 2, 0.25, 'trying full 360° sweep with quarter step'],
      ];
      for (const [m, dc, sf, label] of ladder) {
        if (dead.length === 0) break;
        progress(
          stage + 1,
          Math.max(kEff, stage + 1),
          `${dead.length === parents.length ? 'primary sweep empty' : `${dead.length} of ${parents.length} parents with an empty sweep`}; ${label}`
        );
        const extra = propose(
          ctx,
          guide,
          dead.map(p => parents[p]),
          m,
          dc,
          sf
        );
        const got = new Set<number>();
        for (const c of extra) {
          c.parentIdx = dead[c.parentIdx];
          got.add(c.parentIdx);
          cands.push(c);
        }
        dead = dead.filter(p => !got.has(p));
      }
    }
    if (cands.length === 0) {
      stages.push([]);
      continue;
    }

    // Subsector pruning.
    const best = new Map<string, number>();
    const cost = new Float64Array(cands.length);
    const remaining = new Float64Array(cands.length);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const g = goals[c.viaCount];
      remaining[i] = haversineDistanceM(c.lon, c.lat, g.lon, g.lat);
      // The cost so far (time plus any comfort cost) and the rest at cruise speed.
      cost[i] = c.costS + remaining[i] / cruise;
      let key = guide.zoneKey(c);
      if (key === null) {
        const off = perpendicularOffsetM(sLon, sLat, eLon, eLat, c.lon, c.lat);
        let bin = Math.floor(off / deltaD);
        if (bin < -ctx.k) bin = -ctx.k;
        if (bin > ctx.k - 1) bin = ctx.k - 1;
        key = `${c.viaCount}:${bin}`;
      }
      const cur = best.get(key);
      if (cur === undefined || cost[i] < cost[cur]) best.set(key, i);
    }
    // The leader survives (deviation from the reference): for each goal
    // the candidate nearest to it is kept whatever its bin. The bin cost
    // prices the remaining distance at cruise speed, which is optimistic
    // to windward, so a branch further back but earlier could take every
    // bin of the leading branch and the front fell back (job c14934c9:
    // best remaining 545 km → 762 km at stage 21). With the leader kept
    // the best remaining distance never increases.
    {
      const lead = new Map<number, number>();
      for (let i = 0; i < cands.length; i++) {
        const vc = cands[i].viaCount;
        const cur = lead.get(vc);
        if (cur === undefined || remaining[i] < remaining[cur]) lead.set(vc, i);
      }
      const kept = new Set(best.values());
      for (const [vc, i] of lead) if (!kept.has(i)) best.set(`lead:${vc}`, i);
    }
    const retained = [...best.values()].map(i => cands[i]);
    stages.push(retained);
    {
      // The stage's front for display: sorted across the track within each
      // goal, plus the best candidate's path back to the start.
      let bi = -1;
      for (const i of best.values()) if (bi < 0 || cost[i] < cost[bi]) bi = i;
      const pts = retained
        .map(c => ({ c, off: perpendicularOffsetM(sLon, sLat, eLon, eLat, c.lon, c.lat) }))
        .sort((a, b) => a.c.viaCount - b.c.viaCount || a.off - b.off)
        .map(({ c }) => ({ lon: r4(c.lon), lat: r4(c.lat), timeMs: c.timeMs, viaCount: c.viaCount }));
      const front: StageFront = {
        leg: 0,
        stage: stage + 1,
        totalStages: maxStages,
        points: pts,
        best: bi >= 0 ? traceBack(stages, stages.length - 1, cands[bi]) : [],
      };
      fronts.push(front);
      args.onFrontier?.(front);
    }

    let bestRemaining = Infinity;
    let bestAtMs = 0;
    for (const c of retained) {
      const d = haversineDistanceM(c.lon, c.lat, eLon, eLat);
      if (d < bestRemaining) {
        bestRemaining = d;
        bestAtMs = c.timeMs;
      }
    }
    const dropped: string[] = [];
    if (lastTry.limited) dropped.push(`${lastTry.limited} over the limit`);
    if (lastTry.land) dropped.push(`${lastTry.land} on land`);
    if (lastTry.noGo) dropped.push(`${lastTry.noGo} dead upwind`);
    progress(
      stage + 1,
      Math.max(kEff, stage + 1),
      `${parents.length} parents → ${cands.length} candidates → ${retained.length} retained${dropped.length ? ` (${dropped.join(', ')})` : ''}; best remaining ${(bestRemaining / 1000).toFixed(1)} km at ${fmtUtc(bestAtMs)}; ${((Date.now() - tStage) / 1000).toFixed(1)} s`
    );
    // Stall detector: once the planned stages are used up, a front that
    // has not come closer to the destination for a few stages in a row is
    // boxed in (by land, the wind/wave limit, or a forecast that no longer
    // changes); say so rather than running the budget out and failing on
    // the terminal hop from far away.
    // Progress is measured towards the deepest branch's own goal (the next
    // via, or the destination once every via is crossed), not towards the
    // destination: a branch can sit a few km from the destination with a
    // via still uncrossed (job 58b50b0d: east of Crete, the Kythira via
    // behind it) and must not count as progress. A gain under a twentieth
    // of the stage step is no gain.
    let deepest = 0;
    for (const c of retained) deepest = Math.max(deepest, c.viaCount);
    let goalRemaining = Infinity;
    for (const c of retained) {
      if (c.viaCount !== deepest) continue;
      goalRemaining = Math.min(goalRemaining, haversineDistanceM(c.lon, c.lat, goals[deepest].lon, goals[deepest].lat));
    }
    if (deepest > bestEverDeepest) {
      bestEverDeepest = deepest;
      bestEver = Infinity;
    }
    if (goalRemaining < bestEver - 0.05 * candStepM) {
      bestEver = goalRemaining;
      stagesWithoutGain = 0;
    } else {
      stagesWithoutGain++;
    }
    // A front that is beating (a fair share of its water candidates dead
    // upwind) sails well over the planned distance, so it gets the stages
    // up to the hard ceiling before a stall counts; otherwise the planned
    // stages are enough.
    const water = Math.max(1, lastTry.tried - lastTry.land);
    const beating = lastTry.noGo / water >= BEATING_SHARE;
    const stallFrom = beating ? maxStages - STALL_STAGES : kEff;
    if (stage + 1 >= stallFrom && stagesWithoutGain >= STALL_STAGES) {
      if (deepest < nVias) {
        // Boxed in before every via was crossed: the caller may retry
        // without the automatic vias (the corridor's guidance, not the
        // user's waypoints), as it does when the stages run out.
        const g = goals[deepest];
        throw new ViasNotCrossedError(
          `the search is boxed in before crossing all ${nVias} via(s): deepest branch crossed ${deepest}, and for ${stagesWithoutGain} stages no candidate came closer than ${(bestEver / 1000).toFixed(0)} km to the next via${g.name ? ` at ${g.name}` : ''}; ${tryNote(ctx)}.${forecastNote(ctx)}`
        );
      }
      // The front at the destination with no clear final leg: the point
      // sits in a land cell of the raster (too close to the shore).
      const atGoal =
        bestEver <= candStepM
          ? ' The front reached the destination but no final leg to it was clear of land: the point is too close to the shore for the land raster.'
          : '';
      throw new RouteError(
        `the search is boxed in: for ${stagesWithoutGain} stages no candidate came closer than ${(bestEver / 1000).toFixed(1)} km to the destination; ${tryNote(ctx)}.${atGoal}${forecastNote(ctx)}`,
        'boxed_in'
      );
    }
    for (const c of retained) {
      for (const vi of c.viaIdxs) {
        const g = goals[vi];
        if (g.auto && !announced.has(vi)) {
          announced.add(vi);
          progress(stage + 1, Math.max(kEff, stage + 1), `first branch through the auto via at ${g.name ?? 'a narrow passage'}`);
        }
      }
    }

    const eligible = retained.filter(c => c.viaCount === nVias);
    if (eligible.length) {
      let minDist = Infinity;
      for (const c of eligible) minDist = Math.min(minDist, haversineDistanceM(c.lon, c.lat, eLon, eLat));
      if (args.arrivalRadiusM !== undefined && minDist <= args.arrivalRadiusM) {
        progress(
          stage + 1,
          Math.max(kEff, stage + 1),
          `early termination: within arrival radius ${args.arrivalRadiusM.toFixed(0)} m (${minDist.toFixed(0)} m)`
        );
        break;
      }
      // Within one (local) stage step of the destination, with a land-free final leg.
      const near = eligible.filter(c => haversineDistanceM(c.lon, c.lat, eLon, eLat) <= guide.stepFor(c.lon, c.lat).step);
      if (near.length) {
        const hop = ctx.landMask.legsCrossLandBulk(
          Float64Array.from(near.map(c => c.lon)),
          Float64Array.from(near.map(c => c.lat)),
          new Float64Array(near.length).fill(eLon),
          new Float64Array(near.length).fill(eLat)
        );
        const clear = near.filter((_c, i) => !hop[i]);
        if (clear.length) {
          let md = Infinity;
          for (const c of clear) md = Math.min(md, haversineDistanceM(c.lon, c.lat, eLon, eLat));
          progress(
            stage + 1,
            Math.max(kEff, stage + 1),
            `early termination: within one stage step of destination with a clear final leg (${(md / 1000).toFixed(1)} km)`
          );
          break;
        }
      }
      if (stage + 1 >= kEff && stage + 1 < maxStages)
        progress(stage + 1, Math.max(kEff, stage + 1), 'planned stages used without a clear final leg; continuing');
    } else if (nVias > 0) {
      const deepest = Math.max(...retained.map(c => c.viaCount));
      progress(stage + 1, Math.max(kEff, stage + 1), `via progress: deepest branch crossed ${deepest}/${nVias}`);
    }
  }
  return stages;
}
