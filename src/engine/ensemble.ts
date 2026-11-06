/**
 * A finished route checked against ensemble members' weather (data/ensemble.ts): the route's own legs, sailed one
 * after the other from its departure in each member's wind, waves and the route's currents, with the route's vessel,
 * polar and simulator options. Nothing is searched again: the route stays the one found on the main forecast, and the
 * members say how it would go in each of the weathers the ensemble thinks possible.
 *
 * Per member: the arrival (or the leg that could not be sailed, and why), the time over the wind and the wave limit
 * (counted, not stopped, as smoother.ts limitWarnings counts them), and the strongest wind and highest waves met. The
 * summary: arrival percentiles over the members that arrive, and how many members go over each limit or get stuck.
 */

import { haversineBearing } from '../geo/geodesy';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';
import type { CurrentSource, WindSource } from './environment';
import { simulateLegTime, tackChargeS, type LegArrival, type SimOptions } from './legsim';
import { arrivalInto, type Route } from './route';

export interface EnsembleMemberResult {
  /** 0 = the control. */
  member: number;
  /** Arrival in this member's weather (ISO), null when a leg could not be sailed. */
  arrival: string | null;
  /** Passage time, s, null when stuck. */
  time_s: number | null;
  /** Seconds over the wind limit and over the wave limit (0 without that limit). */
  over_wind_s: number;
  over_waves_s: number;
  /** Strongest wind (m/s) and highest significant wave height (m) met on the legs sailed. */
  max_wind_ms: number;
  max_swh_m: number | null;
  /** Where the route could not be sailed in this member's weather, and why (legsim.ts LegSimResult.reason). */
  stuck?: { lon: number; lat: number; reason: string };
}

export interface EnsembleSummary {
  members: number;
  /** Arrival percentiles over the members that arrive (ISO), null when none does. */
  arrival_p10: string | null;
  arrival_p50: string | null;
  arrival_p90: string | null;
  /** Members over the wind limit, over the wave limit, stuck. */
  over_wind: number;
  over_waves: number;
  stuck: number;
}

export interface EnsembleCheckEnv {
  vessel: VesselParams;
  polar: PolarDiagram | null;
  current: CurrentSource;
  sim: SimOptions;
}

/** The route sailed in one member's weather (`wind`: that member's forecast). */
export function checkMember(route: Route, member: number, wind: WindSource, env: EnsembleCheckEnv): EnsembleMemberResult {
  const wps = route.waypoints;
  // Counted, not stopped: under block the simulator stops at the first step over a limit, which says nothing about how
  // long the passage is over it; the route's own limits are counted as avoid, as limitWarnings does.
  const count: SimOptions = { ...env.sim, maxWindMode: 'avoid', maxSwhMode: 'avoid' };
  const out: EnsembleMemberResult = {
    member,
    arrival: null,
    time_s: null,
    over_wind_s: 0,
    over_waves_s: 0,
    max_wind_ms: 0,
    max_swh_m: null,
  };
  const t0 = wps[0].time.getTime();
  let t = t0;
  let before: LegArrival | null = null;
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1];
    const b = wps[i];
    const at = new Date(t);
    const r = simulateLegTime(a.lon, a.lat, at, b.lon, b.lat, env.vessel, env.polar, wind, env.current, count, (_c, lon, lat, tMs, ws) => {
      if (ws > out.max_wind_ms) out.max_wind_ms = ws;
      const wv = wind.hasWaves ? wind.wavesAt(lon, lat, new Date(tMs)) : null;
      if (wv && Number.isFinite(wv.swh) && (out.max_swh_m === null || wv.swh > out.max_swh_m)) out.max_swh_m = wv.swh;
    });
    if (!Number.isFinite(r.seconds)) {
      out.stuck = { lon: a.lon, lat: a.lat, reason: r.reason ?? 'no_speed' };
      return out;
    }
    // The tack penalty against the course into a, as the route's own timing charges it (legsim.ts tackChargeS).
    const sailing = r.dominantMode === 'sailing';
    const charge = tackChargeS(before, wind.at(a.lon, a.lat, at)[1], haversineBearing(a.lon, a.lat, b.lon, b.lat), sailing, env.sim);
    t += (r.seconds + charge) * 1000;
    out.over_wind_s += r.overWindSeconds;
    out.over_waves_s += r.overSwhSeconds;
    before = arrivalInto(a, { ...b, mode: sailing ? 'sailing' : 'motoring' });
  }
  out.time_s = (t - t0) / 1000;
  out.arrival = new Date(t).toISOString();
  return out;
}

/** The `p`-th percentile (0..100) of sorted values, linear between the two nearest ranks. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const x = (p / 100) * (sorted.length - 1);
  const i = Math.floor(x);
  return i + 1 < sorted.length ? sorted[i] + (x - i) * (sorted[i + 1] - sorted[i]) : sorted[i];
}

export function summarise(results: readonly EnsembleMemberResult[]): EnsembleSummary {
  const arrivals = results
    .filter(r => r.arrival !== null)
    .map(r => Date.parse(r.arrival!))
    .sort((a, b) => a - b);
  const at = (p: number): string | null => (arrivals.length ? new Date(percentile(arrivals, p)).toISOString() : null);
  return {
    members: results.length,
    arrival_p10: at(10),
    arrival_p50: at(50),
    arrival_p90: at(90),
    over_wind: results.filter(r => r.over_wind_s > 0).length,
    over_waves: results.filter(r => r.over_waves_s > 0).length,
    stuck: results.filter(r => r.stuck).length,
  };
}
