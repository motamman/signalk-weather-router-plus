/**
 * The sail plans of a polar set (polar-format 2): each plan's own table, and which plan is the fastest at a wind
 * speed and angle. The route is sailed on the set's `best` table; the plans only name which sails make that speed.
 * The plan named is the fastest of the plans' own tables at the condition itself, as polar-format describes for
 * calculating `best` (the owner's choice, 2026-11-03), not the nearest cell of `best`'s winner grid.
 */

import type { PolarDiagram } from './polar';

/** One sail plan: its name and its table, scaled and floored as the route's polar is. */
export interface SailPlanPolar {
  name: string;
  polar: PolarDiagram;
}

/**
 * The fastest sail plan at a true wind angle (degrees) and true wind speed (m/s), or null when no plan sails there.
 * Of two plans equally fast, the first in the set.
 */
export function sailPlanAt(plans: readonly SailPlanPolar[], twaDeg: number, twsMs: number): string | null {
  let name: string | null = null;
  let speed = 0;
  for (const p of plans) {
    const s = p.polar.boatSpeed(twaDeg, twsMs);
    if (s > speed) {
      speed = s;
      name = p.name;
    }
  }
  return name;
}
