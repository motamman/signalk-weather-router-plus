/**
 * Wire formats of a Route: the GeoJSON the plugin API answers with (route,
 * skeleton) and the Signal K Resources API `routes` record. Everything on
 * the wire is SI (m, m/s, s, degrees); clients convert. Property names are
 * the ones the web app and the plotter extension read.
 */

import { roughnessIndex } from './conditions';
import { encounterIndex, seaAngle, seaSector } from '../engine/seas';
import type { Route, StopSnap, Waypoint } from '../engine/route';
import { haversineDistanceM } from '../geo/geodesy';

export function skeletonToGeoJSON(route: Route): Record<string, unknown> | null {
  if (!route.skeleton || route.skeleton.length < 2) return null;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: route.skeleton.map(p => [p.lon, p.lat]) },
        properties: { kind: 'skeleton', points: route.skeleton.length },
      },
    ],
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Waypoint index of each stop: 0 = the first waypoint, the k-th via = the
 * k-th waypoint with role 'via', the last stop = the last waypoint.
 */
function stopWaypointIndex(route: Route, stopIndex: number, stopCount: number): number {
  const wps = route.waypoints;
  if (stopIndex === 0) return 0;
  if (stopIndex === stopCount - 1) return wps.length - 1;
  let k = 0;
  for (let i = 1; i < wps.length - 1; i++) {
    if (wps[i].role !== 'via') continue;
    k++;
    if (k === stopIndex) return i;
  }
  return -1;
}

/** Per-waypoint snap data keyed by waypoint index, plus the route-level fields the web app draws. */
function snapProperties(route: Route): { byWaypoint: Map<number, StopSnap>; props: Record<string, unknown> } {
  const byWaypoint = new Map<number, StopSnap>();
  const props: Record<string, unknown> = {};
  const snaps = route.snaps ?? [];
  if (!snaps.length) return { byWaypoint, props };
  const stopCount = routeStopCount(route);
  props.stop_count = stopCount;
  props.snaps = snaps.map(s => ({
    index: s.index,
    original: [round(s.original[0], 6), round(s.original[1], 6)],
    anchor: [round(s.anchor[0], 6), round(s.anchor[1], 6)],
    distance_m: round(s.distanceM, 0),
  }));
  for (const s of snaps) {
    const wi = stopWaypointIndex(route, s.index, stopCount);
    if (wi >= 0) byWaypoint.set(wi, s);
    const which = s.index === 0 ? 'start' : s.index === stopCount - 1 ? 'end' : null;
    if (which) {
      props[`${which}_original`] = [round(s.original[0], 6), round(s.original[1], 6)];
      props[`${which}_anchor`] = [round(s.anchor[0], 6), round(s.anchor[1], 6)];
      props[`${which}_snap_distance_m`] = round(s.distanceM, 0);
    }
  }
  return { byWaypoint, props };
}

/** Number of stops the route was requested with: start, the via waypoints, the destination. */
function routeStopCount(route: Route): number {
  return 2 + route.waypoints.slice(1, -1).filter(w => w.role === 'via').length;
}

/**
 * Where the forecast ends relative to the route: its last valid step, how many
 * legs end after it (they ran on conditions held at that step) and by how much
 * the arrival is past it. Null when the caller gave no forecast end.
 */
export function forecastEnd(route: Route): { validTo: Date; legsBeyond: number; beyondS: number } | null {
  if (route.forecastValidToMs === undefined) return null;
  const validTo = new Date(route.forecastValidToMs);
  const wps = route.waypoints;
  let legsBeyond = 0;
  for (let i = 1; i < wps.length; i++) if (wps[i].time.getTime() > route.forecastValidToMs) legsBeyond++;
  const arrival = wps.length ? wps[wps.length - 1].time.getTime() : route.forecastValidToMs;
  return { validTo, legsBeyond, beyondS: Math.max(0, (arrival - route.forecastValidToMs) / 1000) };
}

function finite(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
}

export function waypointProperties(wp: Waypoint): Record<string, unknown> {
  const d: Record<string, unknown> = {
    lon: round(wp.lon, 6),
    lat: round(wp.lat, 6),
    time: wp.time.toISOString(),
    sog_ms: round(wp.sogMs, 3),
    cog_deg: round(wp.cogDeg, 1),
    depth_m: finite(wp.depthM) ? round(wp.depthM, 1) : null,
    mode: wp.mode,
  };
  if (finite(wp.twaDeg)) d.twa_deg = Math.round(wp.twaDeg);
  if (finite(wp.windMs)) d.wind_ms = round(wp.windMs, 3);
  if (finite(wp.windDirDeg)) d.wind_dir_deg = Math.round(wp.windDirDeg);
  if (finite(wp.swhM)) d.swh_m = round(wp.swhM, 2);
  if (finite(wp.mwpS)) d.mwp_s = round(wp.mwpS, 1);
  if (finite(wp.mwdDeg)) d.mwd_deg = Math.round(wp.mwdDeg);
  if (finite(wp.currentMs)) d.current_ms = round(wp.currentMs, 4);
  if (finite(wp.currentDirDeg)) d.current_dir_deg = Math.round(wp.currentDirDeg);
  if (finite(wp.currentUMs)) d.current_u_ms = round(wp.currentUMs, 4);
  if (finite(wp.currentVMs)) d.current_v_ms = round(wp.currentVMs, 4);
  // The sea on the leg arriving here (the values of a waypoint are those of
  // the leg into it): the sea-state index of the water, the angle between the
  // leg's course and the waves (0 = head seas), and the index weighted for
  // that angle (engine/seas.ts). Not at the start (no leg into it).
  if (finite(wp.windMs) && finite(wp.windDirDeg) && finite(wp.swhM)) {
    const r = roughnessIndex(
      wp.windMs,
      finite(wp.currentMs) ? wp.currentMs : 0,
      wp.windDirDeg,
      finite(wp.currentDirDeg) ? wp.currentDirDeg : 0,
      wp.swhM,
      finite(wp.mwpS) ? wp.mwpS : 5,
      finite(wp.mwdDeg) ? wp.mwdDeg : 0
    );
    d.sea_index = round(r.idx, 1);
    if (wp.sogMs > 0 && finite(wp.mwdDeg) && finite(wp.cogDeg)) {
      const a = seaAngle(wp.cogDeg, wp.mwdDeg);
      d.seas_angle_deg = Math.round(a.angle);
      d.seas_side = a.side;
      d.seas_sector = seaSector(a.angle);
      d.encounter_index = round(encounterIndex(r.idx, wp.cogDeg, wp.mwdDeg), 1);
    }
  }
  // Wind and wave extremes sampled along the leg departing here (the
  // waypoint's own wind_ms/swh_m are the conditions at this point).
  if (finite(wp.windMinMs)) d.leg_wind_min_ms = round(wp.windMinMs, 2);
  if (finite(wp.windMaxMs)) d.leg_wind_max_ms = round(wp.windMaxMs, 2);
  if (finite(wp.swhMinM)) d.leg_swh_min_m = round(wp.swhMinM, 2);
  if (finite(wp.swhMaxM)) d.leg_swh_max_m = round(wp.swhMaxM, 2);
  if (wp.leg !== undefined) d.leg = wp.leg;
  if (wp.role !== undefined) d.role = wp.role;
  if (wp.tack) d.tack = true;
  return d;
}

export function routeToGeoJSON(route: Route): Record<string, unknown> {
  const wps = route.waypoints;
  const props: Record<string, unknown> = {
    total_distance_m: round(route.totalDistanceM, 1),
    total_time_s: round(route.totalTimeS, 1),
    motoring_time_s: round(route.motoringTimeS, 1),
    sailing_time_s: round(route.sailingTimeS, 1),
    departure: wps.length ? wps[0].time.toISOString() : null,
    arrival: wps.length ? wps[wps.length - 1].time.toISOString() : null,
    waypoint_count: wps.length,
    validated: route.validated,
    repairs_applied: 0,
    smoother_drops: route.smootherDrops ?? 0,
  };
  if (route.forecastCycle) props.forecast_cycle = route.forecastCycle;
  if (route.drawbridges && route.drawbridges.length) {
    props.drawbridges = route.drawbridges.map(b => ({
      lat: round(b.lat, 6),
      lon: round(b.lon, 6),
      clear_m: b.clearM === null ? null : round(b.clearM, 1),
      leg_index: b.legIndex,
    }));
  }
  if (route.autoVias && route.autoVias.length) {
    props.auto_vias = route.autoVias.map(v => ({
      name: v.name,
      lat: round(v.lat, 6),
      lon: round(v.lon, 6),
      width_m: Math.round(v.widthM),
      radius_m: Math.round(v.radiusM),
    }));
  }
  const fe = forecastEnd(route);
  if (fe) {
    props.forecast_valid_to = fe.validTo.toISOString();
    if (fe.legsBeyond > 0) {
      props.forecast_horizon_exceeded_s = round(route.forecastHorizonExceededS ?? fe.beyondS, 0);
      props.legs_beyond_forecast = fe.legsBeyond;
      props.forecast_horizon_note = `the route arrives after the last forecast step; the last ${fe.legsBeyond} leg${fe.legsBeyond === 1 ? '' : 's'} ran on conditions held at that step`;
      if (route.limitsBeyondForecast) props.limits_beyond_forecast = true;
    }
  }
  if (route.warnings && route.warnings.length) {
    props.warnings = route.warnings;
    const land = route.warnings.filter(w => w.violation === 'leg_crosses_land').length;
    if (land) {
      props.land_crossings = land;
      props.has_land_crossing = true;
    }
  }
  const swh = wps.map(w => w.swhM).filter(finite);
  if (swh.length) {
    props.max_swh_m = round(Math.max(...swh), 2);
    props.avg_swh_m = round(swh.reduce((a, b) => a + b, 0) / swh.length, 2);
  }
  const snapped = snapProperties(route);
  Object.assign(props, snapped.props);
  // What the route was asked for: a client keeps its waypoint pins there
  // (the route's own via points are where it entered each circle) and
  // draws the circles.
  if (route.precision) props.precision = route.precision;
  if (route.stops && route.stops.length) {
    props.stops = route.stops.map(s => {
      const o: Record<string, number> = { lon: round(s.lon, 6), lat: round(s.lat, 6) };
      if (s.radiusM !== undefined) o.radius_m = round(s.radiusM, 0);
      return o;
    });
  }
  const features: Record<string, unknown>[] = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: wps.map(w => [w.lon, w.lat]) },
      properties: props,
    },
  ];
  for (let i = 0; i < wps.length; i++) {
    const p = waypointProperties(wps[i]);
    if (fe && wps[i].time.getTime() > fe.validTo.getTime()) p.beyond_forecast = true;
    const sn = snapped.byWaypoint.get(i);
    if (sn) {
      p.snap_distance_m = round(sn.distanceM, 0);
      p.original = [round(sn.original[0], 6), round(sn.original[1], 6)];
    }
    if (i + 1 < wps.length) {
      const nxt = wps[i + 1];
      p.leg_distance_m = round(haversineDistanceM(wps[i].lon, wps[i].lat, nxt.lon, nxt.lat), 1);
      const legS = (nxt.time.getTime() - wps[i].time.getTime()) / 1000;
      if (legS >= 0) p.leg_time_s = round(legS, 1);
    }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [wps[i].lon, wps[i].lat] }, properties: p });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Signal K Resources API `routes` record. Coordinates stay strict
 * [lon, lat]; per-waypoint data rides in `properties.coordinatesMeta`,
 * a parallel array of the same length. The server's Route schema
 * requires each coordinatesMeta item to carry a `name` (string) and
 * allows additional properties, so every item is named "WP<n>" and
 * carries the SI waypoint fields alongside.
 */
export function routeToSignalKRoute(route: Route, name: string, description?: string): Record<string, unknown> {
  const wps = route.waypoints;
  const fe = forecastEnd(route);
  const snapped = snapProperties(route);
  const beyondNote =
    fe && fe.legsBeyond > 0
      ? ` Forecast ends ${fe.validTo.toISOString().slice(0, 16).replace('T', ' ')} UTC; the last ${fe.legsBeyond} leg${fe.legsBeyond === 1 ? '' : 's'} ran on conditions held at that step.`
      : '';
  return {
    name,
    // Unit-free: the web app rewrites this (and each point's description) in the
    // user's display units once the route is published.
    description:
      description ??
      `Weather route: ${wps.length} waypoints, sailing ${route.totalTimeS > 0 ? Math.round((100 * route.sailingTimeS) / route.totalTimeS) : 0}% of the time.${beyondNote}`,
    distance: round(route.totalDistanceM, 1),
    start: wps.length ? wps[0].time.toISOString() : undefined,
    end: wps.length ? wps[wps.length - 1].time.toISOString() : undefined,
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: wps.map(w => [w.lon, w.lat]) },
      properties: {
        source: 'signalk-weather-router-plus',
        total_time_s: round(route.totalTimeS, 1),
        motoring_time_s: round(route.motoringTimeS, 1),
        sailing_time_s: round(route.sailingTimeS, 1),
        departure: wps.length ? wps[0].time.toISOString() : null,
        arrival: wps.length ? wps[wps.length - 1].time.toISOString() : null,
        ...(fe ? { forecast_valid_to: fe.validTo.toISOString() } : {}),
        ...(fe && fe.legsBeyond > 0 ? { legs_beyond_forecast: fe.legsBeyond } : {}),
        coordinatesMeta: wps.map((w, i) => ({
          name: i === 0 ? 'Start' : i === wps.length - 1 ? 'End' : `WP${i}`,
          ...waypointProperties(w),
          ...(fe && w.time.getTime() > fe.validTo.getTime() ? { beyond_forecast: true } : {}),
          ...(snapped.byWaypoint.has(i)
            ? {
                snap_distance_m: round(snapped.byWaypoint.get(i)!.distanceM, 0),
                original: snapped.byWaypoint.get(i)!.original.map(v => round(v, 6)),
              }
            : {}),
        })),
      },
    },
  };
}
