/**
 * The route request, described once: the fields, their ranges (shared
 * with the settings they override, from SETTINGS_SPEC), and their
 * documentation. The API validator, the OpenAPI document and the route
 * worker all read this table (docs/plans/structural-cleanup.md, phase 4.1).
 */

import { DEFAULT_ARRIVAL_RADIUS_M, MAX_ARRIVAL_RADIUS_M, validateLegOptions } from '../engine/multileg';
import { ROUTER_KINDS } from '../engine/router';
import { SEARCH_PRESETS } from '../engine/search/presets';
import type { RouteRequest } from './protocol';
import { SETTINGS_SPEC } from './settings';

export type RouteFieldSpec =
  | { type: 'number'; min?: number; max?: number; default?: number; description?: string }
  | { type: 'boolean'; description: string }
  | { type: 'string'; maxLength?: number; description: string }
  | { type: 'enum'; values: readonly string[]; default?: string; description?: string }
  | { type: 'date-time'; description: string };

/** The range a setting allows, for a request field that overrides it. */
function settingRange(key: string): { min: number; max: number } {
  const s = SETTINGS_SPEC.find(x => x.key === key);
  if (!s || s.min === undefined || s.max === undefined) throw new Error(`request_schema: setting ${key} has no range`);
  return { min: s.min, max: s.max };
}

export const MAX_WAYPOINTS = 20;
export const MODES = ['sail_max', 'fastest', 'motor'] as const;

/** The scalar fields of a route request, in the order the OpenAPI document lists them. */
export const ROUTE_REQUEST_FIELDS: Record<string, RouteFieldSpec> = {
  precision: {
    type: 'enum',
    values: ['precise', 'approximate'],
    default: 'precise',
    description:
      'precise: each leg ends exactly on its waypoint; approximate: consecutive approximate waypoints are routed as one search that must pass through each waypoint circle in order (leg by leg if no branch passes them all). The destination is always exact.',
  },
  arrival_radius_m: {
    type: 'number',
    min: 0,
    max: MAX_ARRIVAL_RADIUS_M,
    default: DEFAULT_ARRIVAL_RADIUS_M,
    description: 'Waypoint circle radius in metres for approximate precision (must be > 0 then); ignored when precise.',
  },
  departure: { type: 'date-time', description: 'Empty or absent = now' },
  mode: { type: 'enum', values: MODES, default: 'sail_max' },
  search: {
    type: 'enum',
    values: SEARCH_PRESETS,
    default: 'normal',
    description:
      'Search method: normal (the routing settings as they are, seconds), moderate (a better route; about 2 minutes on a long passage), maximum (the best route; about 6 minutes). An explicit stages still wins over the preset',
  },
  router: {
    type: 'enum',
    values: ROUTER_KINDS,
    description:
      'Open-water router: standard (the isochrone search) or refined (the search on the convexified polar, legs laid out afterwards, cross-track polish; engine/experimental); default from the routing.router setting',
  },
  sail_thresh_ms: { type: 'number', min: 0, description: 'Overrides the routing.sailThreshold setting (m/s)' },
  max_wind_ms: {
    type: 'number',
    ...settingRange('routing.maxWind'),
    description: 'A leg is not allowed where the forecast wind speed exceeds this (m/s); overrides routing.maxWind',
  },
  max_swh_m: {
    type: 'number',
    ...settingRange('routing.maxSwh'),
    description:
      'A leg is not allowed where the significant wave height exceeds this (m); overrides routing.maxSwh. Needs wave data in the forecast',
  },
  comfort_weight: {
    type: 'number',
    ...settingRange('routing.comfortWeight'),
    description:
      'How much the search avoids rough water as the boat meets it (sea-state index weighted for the wave angle); 0 = off; overrides routing.comfortWeight. Route times stay real',
  },
  simplify_m: {
    type: 'number',
    ...settingRange('routing.simplify'),
    description: 'RDP simplification tolerance in metres (0 = off); overrides routing.simplify',
  },
  smoother: { type: 'boolean', description: 'Run the shortcut smoother; overrides routing.smoother' },
  smoother_tolerance: {
    type: 'number',
    ...settingRange('routing.smootherTolerance'),
    description: 'Shortcut time tolerance as a ratio; overrides routing.smootherTolerance',
  },
  name: { type: 'string', description: 'Name for the Signal K route resource' },
  stages: { type: 'number', ...settingRange('routing.stages'), description: 'Overrides the routing.stages setting' },
  no_forecast: { type: 'boolean', description: 'Route with calm wind' },
  no_currents: { type: 'boolean', description: 'Route without currents' },
  wind_model: {
    type: 'enum',
    values: ['auto', 'ecmwf'],
    default: 'auto',
    description:
      'auto: regional wind from signalk-grib-downloader (AROME, ARPEGE, ICON-EU) where it covers the point and time, ECMWF elsewhere; ecmwf: ECMWF only',
  },
  avoid_areas: {
    type: 'boolean',
    description:
      'Treat the areas marked on Signal K notes (a note with properties.avoid.radius_m, metres, around its position) as land; default true',
  },
  publish: { type: 'boolean', description: 'Override the publish.toResources setting for this route' },
};

/** The per-route vessel overrides. */
export const VESSEL_FIELDS: Record<string, RouteFieldSpec> = {
  name: { type: 'string', description: 'Ignored (accepted so older clients still validate); the vessel name comes from Signal K' },
  motor_speed_ms: { type: 'number', description: 'Motor speed, m/s' },
  polar_performance: {
    type: 'number',
    min: 0.3,
    max: 1.2,
    description: 'Share of the polar boat speeds achieved under sail (ratio, 1 = as written)',
  },
  polar: { type: 'string', maxLength: 200, description: 'Polar token from /api/polars; absent = the configured default' },
  draught_m: {
    type: 'number',
    min: 0.1,
    max: 30,
    description:
      "Draught, m (default: the vessel's Signal K design.draft.maximum); with air_draft_m, lets motoring legs use the chart mesh",
  },
  air_draft_m: {
    type: 'number',
    min: 0.5,
    max: 100,
    description: "Air draft (height above the waterline), m (default: the vessel's Signal K design.airHeight)",
  },
};

const isPoint = (p: unknown): p is { lat: number; lon: number } =>
  !!p && typeof p === 'object' && typeof (p as { lat: unknown }).lat === 'number' && typeof (p as { lon: unknown }).lon === 'number';

/** Why a point is not usable, or null. */
function pointError(p: unknown, name: string): string | null {
  if (!isPoint(p)) return `${name} must be {lat, lon}`;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return `${name} must be {lat, lon} numbers`;
  if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 360) return `${name} out of range`;
  return null;
}

/** Why a field's value does not fit its spec, or null. */
function fieldError(name: string, v: unknown, spec: RouteFieldSpec): string | null {
  switch (spec.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${name} must be a number`;
      if (spec.min !== undefined && spec.max !== undefined && !(v >= spec.min && v <= spec.max))
        return `${name} must be ${spec.min}..${spec.max}`;
      if (spec.min !== undefined && v < spec.min) return `${name} must be >= ${spec.min}`;
      if (spec.max !== undefined && v > spec.max) return `${name} must be <= ${spec.max}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${name} must be true or false`;
    case 'string':
      if (typeof v !== 'string') return `${name} must be a string`;
      if (spec.maxLength !== undefined && v.length > spec.maxLength) return `${name} must be at most ${spec.maxLength} characters`;
      return null;
    case 'enum':
      return spec.values.includes(v as string)
        ? null
        : `${name} must be ${spec.values.slice(0, -1).join(', ')} or ${spec.values[spec.values.length - 1]}`;
    case 'date-time':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? null : `${name} must be ISO 8601`;
  }
}

/**
 * The first problem with a route request body, or null when it is valid.
 * Covers the shape, every field's range against ROUTE_REQUEST_FIELDS, the
 * waypoint rules (engine/multileg.ts) and the vessel overrides.
 */
export function validateRouteRequest(b: RouteRequest): string | null {
  const e0 = pointError(b.start, 'start') ?? pointError(b.end, 'end');
  if (e0) return e0;
  if (b.waypoints !== undefined) {
    if (!Array.isArray(b.waypoints)) return 'waypoints must be an array of {lat, lon}';
    for (let i = 0; i < b.waypoints.length; i++) {
      const e = pointError(b.waypoints[i], `waypoints[${i}]`);
      if (e) return e;
    }
    if (b.waypoints.length > MAX_WAYPOINTS) return `at most ${MAX_WAYPOINTS} waypoints`;
  }
  const legErr = validateLegOptions(b.precision, b.arrival_radius_m, b.waypoints);
  if (legErr) return legErr;
  const body = b as unknown as Record<string, unknown>;
  for (const [name, spec] of Object.entries(ROUTE_REQUEST_FIELDS)) {
    if (name === 'precision' || name === 'arrival_radius_m') continue; // validateLegOptions
    const v = body[name];
    if (v === undefined) continue;
    if (name === 'departure' && v === '') continue; // empty = now
    const e = fieldError(name, v, spec);
    if (e) return e;
  }
  if (b.vessel !== undefined) {
    if (b.vessel === null || typeof b.vessel !== 'object') return 'vessel must be an object';
    const vessel = b.vessel as unknown as Record<string, unknown>;
    for (const [name, spec] of Object.entries(VESSEL_FIELDS)) {
      const v = vessel[name];
      if (v === undefined) continue;
      const e = fieldError(`vessel.${name}`, v, spec);
      if (e) return name === 'polar' ? 'vessel.polar must be a polar token from /api/polars' : e;
    }
  }
  return null;
}

/** One field as an OpenAPI property schema. */
function fieldSchema(spec: RouteFieldSpec): Record<string, unknown> {
  const desc = spec.description ? { description: spec.description } : {};
  switch (spec.type) {
    case 'number':
      return {
        type: 'number',
        ...(spec.min !== undefined ? { minimum: spec.min } : {}),
        ...(spec.max !== undefined ? { maximum: spec.max } : {}),
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        ...desc,
      };
    case 'boolean':
      return { type: 'boolean', ...desc };
    case 'string':
      return { type: 'string', ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}), ...desc };
    case 'enum':
      return { type: 'string', enum: [...spec.values], ...(spec.default !== undefined ? { default: spec.default } : {}), ...desc };
    case 'date-time':
      return { type: 'string', format: 'date-time', ...desc };
  }
}

/** The route request as an OpenAPI object schema. */
export function routeRequestSchema(): Record<string, unknown> {
  const point = {
    type: 'object',
    required: ['lat', 'lon'],
    properties: { lat: { type: 'number' }, lon: { type: 'number' } },
  };
  const properties: Record<string, unknown> = {
    start: point,
    end: point,
    waypoints: {
      type: 'array',
      maxItems: MAX_WAYPOINTS,
      description:
        'Ordered waypoints; each ends one leg and starts the next. radius_m overrides arrival_radius_m for that waypoint (approximate precision).',
      items: { ...point, properties: { ...point.properties, radius_m: { type: 'number', minimum: 0, maximum: MAX_ARRIVAL_RADIUS_M } } },
    },
  };
  for (const [name, spec] of Object.entries(ROUTE_REQUEST_FIELDS)) properties[name] = fieldSchema(spec);
  const vesselProps: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(VESSEL_FIELDS)) {
    const s = fieldSchema(spec);
    if (name === 'name' || name === 'motor_speed_ms') delete s.description; // as documented before: bare types
    vesselProps[name] = s;
  }
  properties.vessel = {
    type: 'object',
    description: 'Per-route overrides of the vessel settings (SI); absent keys use the settings.',
    properties: vesselProps,
  };
  return { type: 'object', required: ['start', 'end'], properties };
}
