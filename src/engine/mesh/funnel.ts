/**
 * The funnel (string-pulling) algorithm: the shortest polyline from start
 * to goal through a sequence of portals (the triangle edges the search
 * crossed, each as [left point, right point] seen along the way). Port of
 * the experiment's mesh_route5.py funnel (Mononen's simple stupid funnel).
 */

export type XY = [number, number];

/** Twice the signed area of a, b, c (positive when c is left of a→b). */
function area2(a: XY, b: XY, c: XY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
}

function same(a: XY, b: XY): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function funnel(portals: [XY, XY][], start: XY, goal: XY): XY[] {
  const pts: XY[] = [start];
  const P: [XY, XY][] = [[start, start], ...portals, [goal, goal]];
  let apex = start;
  let left = P[0][0];
  let right = P[0][1];
  let ai: number;
  let li = 0;
  let ri = 0;
  let i = 1;
  while (i < P.length) {
    const [pl, pr] = P[i];
    if (area2(apex, right, pr) >= 0) {
      if (same(apex, right) || area2(apex, left, pr) < 0) {
        right = pr;
        ri = i;
      } else {
        pts.push(left);
        apex = left;
        ai = li;
        left = apex;
        right = apex;
        li = ai;
        ri = ai;
        i = ai + 1;
        continue;
      }
    }
    if (area2(apex, left, pl) <= 0) {
      if (same(apex, left) || area2(apex, right, pl) > 0) {
        left = pl;
        li = i;
      } else {
        pts.push(right);
        apex = right;
        ai = ri;
        left = apex;
        right = apex;
        li = ai;
        ri = ai;
        i = ai + 1;
        continue;
      }
    }
    i++;
  }
  if (!same(pts[pts.length - 1], goal)) pts.push(goal);
  return pts;
}
