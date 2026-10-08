import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolarDiagram } from './polar';
import { ConvexPolar } from './convexpolar';

// One wind speed; a polar with a no-go angle (0 at 0° and 30°), best upwind at 45°, a non-convex dip at 135°
// (3 m/s there lies inside the chord from 90° at 6 m/s to 180° at 5 m/s).
const BASE = new PolarDiagram([0, 30, 45, 90, 135, 180], [8], [0, 0, 4, 6, 3, 5]);

test('convex polar: the hull speed into the wind is the beat VMG, a convex point keeps its speed, the dip is bridged', () => {
  const cp = new ConvexPolar(BASE);
  const vmg = 4 * Math.cos((45 * Math.PI) / 180);
  assert.ok(Math.abs(cp.hull.boatSpeed(0, 8) - vmg) < 1e-9, `upwind ${cp.hull.boatSpeed(0, 8)} vs VMG ${vmg}`);
  assert.equal(cp.hull.noGoFloor(8), 0, 'no no-go angle on the hull');
  assert.ok(Math.abs(cp.hull.boatSpeed(90, 8) - 6) < 1e-9, 'a hull vertex keeps the polar speed');
  assert.ok(cp.hull.boatSpeed(135, 8) > 3, 'the dip between 90° and 180° is bridged by the chord');
  for (let a = 0; a <= 180; a += 5) assert.ok(cp.hull.boatSpeed(a, 8) >= BASE.boatSpeed(a, 8) - 1e-9, `hull ≥ polar at ${a}°`);
});

test('convex polar: mixFor names the two headings of a beat, and none on the curve', () => {
  const cp = new ConvexPolar(BASE);
  const beat = cp.mixFor(0, 8);
  assert.ok(beat);
  assert.deepEqual(
    [beat.a1, beat.a2].sort((x, y) => x - y),
    [-45, 45]
  );
  assert.equal(beat.s1, 4);
  const close = cp.mixFor(20, 8);
  assert.ok(
    close && Math.min(close.a1, close.a2) === -45 && Math.max(close.a1, close.a2) === 45,
    'inside the beat sector still a mix of ±45°'
  );
  assert.equal(cp.mixFor(90, 8), null, 'on the curve: no mix');
  // The dip: a mix of a heading just abaft the beam and one near dead downwind (the chord's tangent
  // points lie on the interpolated curve, a little inside the 90° and 180° rows).
  const dip = cp.mixFor(135, 8);
  assert.ok(dip, 'the dip is a mix');
  const lo = Math.min(dip.a1, dip.a2);
  const hi = Math.max(dip.a1, dip.a2);
  assert.ok(lo >= 90 && lo < 135 && hi > 135 && hi <= 180, `dip chord ${lo}°–${hi}°`);
  // Mirrored: the same on the port side.
  const dipPort = cp.mixFor(-135, 8);
  assert.ok(dipPort && Math.min(dipPort.a1, dipPort.a2) === -hi && Math.max(dipPort.a1, dipPort.a2) === -lo);
});
