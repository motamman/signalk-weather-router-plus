/**
 * The convexified polar (docs/drafts/routing-thought-experiment.md, Idea
 * 1). Per wind speed, the boat's achievable velocities are the polar
 * curve; time-sharing two headings reaches any point on the chord
 * between them, so the convex hull of the curve is the velocity set a
 * route can use when it may tack. The relaxation theorem of optimal
 * control says the time-optimal value is the same as with the curve
 * itself, with the tacks placed afterwards.
 *
 * `hull` is a PolarDiagram (1° rows) whose speed in a direction is the
 * radial distance to the hull, so the search needs no beat handling: a
 * straight leg into the wind is the two-tack beat at its exact VMG. After
 * the search, `mixFor` says which two polar headings a leg's direction
 * is a mix of (or that it lies on the polar itself), so the leg can be
 * split into its tacks.
 */

import { PolarDiagram } from './polar';

/** The two headings (signed true wind angles, degrees) whose time-share makes a direction, with their polar speeds. */
export interface HullMix {
  a1: number;
  s1: number;
  a2: number;
  s2: number;
}

interface HullVertex {
  x: number;
  y: number;
  /** Index into the signed-angle sample list, -1 for the origin. */
  idx: number;
}

/** One wind-speed column's hull. */
interface ColumnHull {
  /** Counter-clockwise hull vertices. */
  verts: HullVertex[];
  /** The signed angles and speeds sampled (sorted ascending by angle). */
  angles: number[];
  speeds: number[];
}

export class ConvexPolar {
  readonly hull: PolarDiagram;
  private readonly columns: ColumnHull[];

  constructor(readonly base: PolarDiagram) {
    const nW = base.tws.length;
    this.columns = [];
    for (let k = 0; k < nW; k++) this.columns.push(columnHull(base, k));
    const rows: number[] = [];
    const speeds: number[] = [];
    for (let a = 0; a <= 180; a++) {
      rows.push(a);
      for (let k = 0; k < nW; k++) speeds.push(radial(this.columns[k], a).r);
    }
    this.hull = new PolarDiagram(rows, base.tws, speeds);
  }

  /**
   * For a course at signed true wind angle `signedTwaDeg` (positive =
   * wind on starboard) in wind `twsMs`: the two polar headings it is a
   * time-share of, or null when the direction lies on the polar curve
   * itself (no tacking needed). The nearest wind-speed column decides.
   */
  mixFor(signedTwaDeg: number, twsMs: number): HullMix | null {
    const k = nearestColumn(this.base.tws, twsMs);
    const col = this.columns[k];
    const { i, j } = radial(col, signedTwaDeg);
    if (i < 0 || j < 0) return null; // a hull edge from the origin: no speed there
    const n = col.angles.length;
    // Consecutive samples (the polar's own interpolation): not a mix.
    if (Math.abs(i - j) === 1 || Math.abs(i - j) === n - 1) return null;
    return { a1: col.angles[i], s1: col.speeds[i], a2: col.angles[j], s2: col.speeds[j] };
  }
}

function nearestColumn(tws: Float64Array, twsMs: number): number {
  let best = 0;
  for (let k = 1; k < tws.length; k++) if (Math.abs(tws[k] - twsMs) < Math.abs(tws[best] - twsMs)) best = k;
  return best;
}

/**
 * The hull of one wind-speed column: the polar curve as the search sees it
 * (boatSpeed: the table's interpolation with its no-go floor), sampled
 * every degree and mirrored to signed angles, plus the origin. Sampling
 * the interpolated curve rather than the table's rows matters: between
 * two rows the table interpolates the speed linearly in angle, which
 * bows outside the chord between the rows, so a hull of the rows alone
 * would sit inside the polar there.
 */
function columnHull(base: PolarDiagram, k: number): ColumnHull {
  const tws = base.tws[k];
  const angles: number[] = [];
  const speeds: number[] = [];
  for (let a = -179; a <= 180; a++) {
    angles.push(a);
    speeds.push(base.boatSpeed(a, tws));
  }
  const pts: HullVertex[] = angles.map((a, idx) => ({
    x: speeds[idx] * Math.sin((a * Math.PI) / 180),
    y: speeds[idx] * Math.cos((a * Math.PI) / 180),
    idx,
  }));
  pts.push({ x: 0, y: 0, idx: -1 });
  return { verts: monotoneChain(pts), angles, speeds };
}

/** Andrew's monotone chain; counter-clockwise, no collinear points. */
function monotoneChain(points: HullVertex[]): HullVertex[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: HullVertex, a: HullVertex, b: HullVertex): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: HullVertex[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
    lower.push(q);
  }
  const upper: HullVertex[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * The hull's radial extent in a direction (signed angle from the wind):
 * the distance to the hull edge the ray meets, with the sample indices
 * of that edge's two ends (-1 for the origin).
 */
function radial(col: ColumnHull, signedTwaDeg: number): { r: number; i: number; j: number } {
  const dx = Math.sin((signedTwaDeg * Math.PI) / 180);
  const dy = Math.cos((signedTwaDeg * Math.PI) / 180);
  const v = col.verts;
  let best = { r: 0, i: -1, j: -1 };
  for (let e = 0; e < v.length; e++) {
    const p = v[e];
    const q = v[(e + 1) % v.length];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-15) continue;
    const t = (p.x * ey - p.y * ex) / den; // along the ray
    const u = (p.x * dy - p.y * dx) / den; // along the edge
    if (u < -1e-9 || u > 1 + 1e-9 || t < 0) continue;
    if (t > best.r) best = { r: t, i: p.idx, j: q.idx };
  }
  return best;
}
