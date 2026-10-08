/**
 * The stall detector's measure (ProgressTracker): a front advancing along
 * the skeleton counts as progress even where its straight-line distance to
 * the goal does not shrink (a route wrapping a peninsula); without a
 * skeleton the straight-line measure alone decides, as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineDistanceM } from '../../geo/geodesy';
import { cumulativeM } from './skeleton';
import { ProgressTracker } from './stages';

/** A skeleton that circles the goal at 0.5° before turning in: three quarters of the ring, then straight to the centre. */
function arcSkeleton(): { lon: number; lat: number }[] {
  const pts: { lon: number; lat: number }[] = [];
  for (let deg = 0; deg <= 270; deg += 5) {
    const a = (deg * Math.PI) / 180;
    pts.push({ lon: 0.5 * Math.sin(a), lat: -0.5 * Math.cos(a) });
  }
  const last = pts[pts.length - 1];
  for (let f = 0.9; f > 0; f -= 0.1) pts.push({ lon: last.lon * f, lat: last.lat * f });
  pts.push({ lon: 0, lat: 0 });
  return pts;
}

function guideFor(skeleton: { lon: number; lat: number }[] | null) {
  const skeletonCum = skeleton ? cumulativeM(skeleton) : null;
  return {
    skeleton,
    skeletonCum,
    widths: null,
    nearestSkeleton: (lon: number, lat: number): number => {
      let best = 0;
      let bestD = Infinity;
      skeleton!.forEach((p, i) => {
        const d = haversineDistanceM(lon, lat, p.lon, p.lat);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    },
  };
}

test('ProgressTracker: a front moving along the skeleton around the goal gains every stage though its straight-line distance never shrinks', () => {
  const sk = arcSkeleton();
  const goal = { lon: 0, lat: 0 };
  const withSkeleton = new ProgressTracker(guideFor(sk), [goal], 5000);
  const without = new ProgressTracker(guideFor(null), [goal], 5000);
  // The front: one candidate a stage, stepping along the ring (5° of arc, about 4.9 km, from the skeleton's own points).
  const straightAtStart = haversineDistanceM(sk[1].lon, sk[1].lat, 0, 0);
  for (let i = 1; i <= 54; i++) {
    const c = { lon: sk[i].lon, lat: sk[i].lat, viaCount: 0 };
    const a = withSkeleton.update([c]);
    const b = without.update([c]);
    assert.equal(a.stagesWithoutGain, 0, `stage ${i} with the skeleton`);
    assert.ok(
      Math.abs(a.bestEver - straightAtStart) < 1,
      `straight-line distance stays ${(a.bestEver / 1000).toFixed(1)} km at stage ${i}`
    );
    // Without a skeleton the same front is stalled from the second stage on (the old measure, kept for a search without one).
    assert.equal(b.stagesWithoutGain, i === 1 ? 0 : i - 1, `stage ${i} without the skeleton`);
  }
  // Turning in: both measures gain.
  const a = withSkeleton.update([{ lon: sk[58].lon, lat: sk[58].lat, viaCount: 0 }]);
  const b = without.update([{ lon: sk[58].lon, lat: sk[58].lat, viaCount: 0 }]);
  assert.equal(a.stagesWithoutGain, 0);
  assert.equal(b.stagesWithoutGain, 0);
  // A front that stops moving stalls under both.
  for (let i = 0; i < 3; i++) withSkeleton.update([{ lon: sk[58].lon, lat: sk[58].lat, viaCount: 0 }]);
  assert.equal(withSkeleton.stagesWithoutGain, 3);
});

test('ProgressTracker: a gain under a twentieth of the step is no gain; crossing a via resets the measure to the next goal', () => {
  const sk = [
    { lon: 0, lat: 0 },
    { lon: 0.5, lat: 0 },
    { lon: 1, lat: 0 },
  ];
  const goals = [
    { lon: 0.5, lat: 0 },
    { lon: 1, lat: 0 },
  ];
  const t = new ProgressTracker(guideFor(sk), goals, 5000);
  assert.equal(t.update([{ lon: 0.1, lat: 0, viaCount: 0 }]).stagesWithoutGain, 0);
  // 100 m closer: under 250 m, no gain.
  assert.equal(t.update([{ lon: 0.1 + 100 / 111320, lat: 0, viaCount: 0 }]).stagesWithoutGain, 1);
  // The via crossed: the measure restarts against the destination.
  const r = t.update([{ lon: 0.5, lat: 0, viaCount: 1 }]);
  assert.equal(r.deepest, 1);
  assert.equal(r.stagesWithoutGain, 0);
  assert.ok(Math.abs(r.bestEver - haversineDistanceM(0.5, 0, 1, 0)) < 1);
});
