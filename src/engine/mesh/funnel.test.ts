/**
 * The funnel: a straight corridor is one leg, a corner is one corner, and
 * portals fanning around the apex do not repeat it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { funnel, type XY } from './funnel';

function noRepeats(p: XY[]): boolean {
  return p.every((q, i) => i === 0 || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]);
}

test('funnel: a straight corridor is start → goal', () => {
  const portals: [XY, XY][] = [
    [
      [2, 1],
      [2, -1],
    ],
    [
      [4, 1],
      [4, -1],
    ],
    [
      [6, 1],
      [6, -1],
    ],
  ];
  assert.deepEqual(funnel(portals, [0, 0], [8, 0]), [
    [0, 0],
    [8, 0],
  ]);
});

test('funnel: edges fanning around a corner vertex give that corner once (the restart branch used to emit the apex twice)', () => {
  const V: XY = [10, 0];
  const portals: [XY, XY][] = [
    [
      [5, 1],
      [5, -3],
    ],
    [V, [8, -3]],
    [V, [12, -2]],
    [V, [13, 2]],
    [
      [8, 6],
      [13, 6],
    ],
  ];
  const p = funnel(portals, [0, -1], [10, 10]);
  assert.deepEqual(p, [
    [0, -1],
    [10, 0],
    [10, 10],
  ]);
  assert.ok(noRepeats(p));
  // The mirror image (V on the right) turns the other way around the same corner.
  const mirrored: [XY, XY][] = [
    [
      [5, 3],
      [5, -1],
    ],
    [[8, 3], V],
    [[12, 2], V],
    [[13, -2], V],
    [
      [13, -6],
      [8, -6],
    ],
  ];
  const q = funnel(mirrored, [0, 1], [10, -10]);
  assert.deepEqual(q, [
    [0, 1],
    [10, 0],
    [10, -10],
  ]);
});

test('funnel: two corners in an S-bend, no point repeated', () => {
  const portals: [XY, XY][] = [
    [
      [2, 2],
      [2, 0],
    ],
    [
      [4, 2],
      [4, 0],
    ],
    [
      [4, 2],
      [6, 2],
    ],
    [
      [4, 4],
      [6, 4],
    ],
    [
      [4, 6],
      [6, 6],
    ],
    [
      [6, 6],
      [6, 8],
    ],
    [
      [8, 6],
      [8, 8],
    ],
  ];
  const p = funnel(portals, [0, 1], [10, 7]);
  assert.ok(noRepeats(p), JSON.stringify(p));
  assert.deepEqual(p[0], [0, 1]);
  assert.deepEqual(p[p.length - 1], [10, 7]);
  assert.ok(p.length >= 3 && p.length <= 4, JSON.stringify(p));
});
