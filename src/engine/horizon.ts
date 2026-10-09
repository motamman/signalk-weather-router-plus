/**
 * The forecast's last step against a leg's arrival: the horizon fields on
 * the route and the warning when the leg runs past it. Used by the leg
 * pipeline (coastline legs) and the mesh leg (engine/mesh/legrun.ts).
 */

import type { WindSource } from './environment';
import type { ProgressFn } from './progress';
import type { Route } from './route';

/** A forecast for a leg: a wind source that knows the range of time it covers. */
export interface LegWind extends WindSource {
  validRange: [Date, Date];
}

export function forecastHorizonNote(r: Route, legWind: LegWind | null, limited: boolean, label: string, progress: ProgressFn): void {
  if (!legWind) return;
  const lastValid = legWind.validRange[1].getTime();
  r.forecastValidToMs = lastValid;
  const arrival = r.waypoints[r.waypoints.length - 1].time.getTime();
  if (arrival > lastValid) {
    r.forecastHorizonExceededS = (arrival - lastValid) / 1000;
    const beyond = r.waypoints.filter(w => w.time.getTime() > lastValid).length;
    if (limited) r.limitsBeyondForecast = true;
    progress(
      0,
      0,
      `WARNING: ${label}arrival is {time:${((arrival - lastValid) / 1000).toFixed(0)}} after the last forecast step (${legWind.validRange[1].toISOString().slice(0, 16).replace('T', ' ')} UTC); the last ${beyond} leg${beyond === 1 ? '' : 's'} ran on conditions held at that step${limited ? ', and the wind/wave limit was checked against those held conditions' : ''}. A longer forecast horizon (Defaults) covers more of the passage`
    );
  }
}
