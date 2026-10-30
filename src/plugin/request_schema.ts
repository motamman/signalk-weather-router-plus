/**
 * The route request, described once as a TypeBox schema: the fields, their
 * ranges (shared with the settings they override, from SETTINGS_SPEC), and
 * their documentation. The TypeScript type (RouteRequest), the API
 * validator and the OpenAPI document all come from it, so a field cannot be
 * in one and missing from another (issue #76, step 1).
 * The validator reads each field's range from the schema and keeps the API's
 * own error texts; TypeBox's checker is not used.
 */

import { Type, type Static, type TSchema } from 'typebox';
import { DRAWBRIDGE_CHOICES } from '../engine/mesh/route';
import { LIMIT_MODES } from '../engine/legsim';
import { DEFAULT_ARRIVAL_RADIUS_M, MAX_ARRIVAL_RADIUS_M, validateLegOptions } from '../engine/multileg';
import { ROUTER_KINDS } from '../engine/router';
import { SEARCH_PRESETS } from '../engine/search/presets';
import { SETTINGS_SPEC } from './settings';
import { AIR_DRAFT_M_RANGE, DRAUGHT_M_RANGE, OVERHEAD_M_RANGE, UKC_M_RANGE } from '../vessel/vessel';

/** The range a setting allows, for a request field that overrides it. */
function settingRange(key: string): { minimum: number; maximum: number } {
  const s = SETTINGS_SPEC.find(x => x.key === key);
  if (!s || s.min === undefined || s.max === undefined) throw new Error(`request_schema: setting ${key} has no range`);
  return { minimum: s.min, maximum: s.max };
}

export const MAX_WAYPOINTS = 20;
/** A route request's JSON, bytes: the request is kept with its job and answered in every job list (a real one is under 4 KB). */
export const MAX_ROUTE_REQUEST_BYTES = 64 * 1024;
export const MODES = ['sail_max', 'fastest', 'motor'] as const;

/**
 * The scalar fields of a route request, in the order the OpenAPI document lists them. Enums carry `type: 'string'`
 * as the document has always written them (TypeBox leaves it out).
 */
export const ROUTE_REQUEST_FIELDS = {
  precision: Type.Optional(
    Type.Enum(['precise', 'approximate'] as const, {
      type: 'string',
      default: 'precise',
      description:
        'precise: each leg ends exactly on its waypoint; approximate: consecutive approximate waypoints are routed as one search that must pass through each waypoint circle in order (leg by leg if no branch passes them all). The destination is always exact.',
    })
  ),
  arrival_radius_m: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: MAX_ARRIVAL_RADIUS_M,
      default: DEFAULT_ARRIVAL_RADIUS_M,
      description: 'Waypoint circle radius in metres for approximate precision (must be > 0 then); ignored when precise.',
    })
  ),
  departure: Type.Optional(Type.String({ format: 'date-time', description: 'Empty or absent = now' })),
  mode: Type.Optional(Type.Enum(MODES, { type: 'string', default: 'sail_max' })),
  search: Type.Optional(
    Type.Enum(SEARCH_PRESETS, {
      type: 'string',
      default: 'normal',
      description:
        'Search method: normal (the routing settings as they are, seconds), moderate (a better route; about 2 minutes on a long passage), maximum (the best route; about 6 minutes). An explicit stages still wins over the preset',
    })
  ),
  router: Type.Optional(
    Type.Enum(ROUTER_KINDS, {
      type: 'string',
      description:
        'Open-water router: standard (the isochrone search) or refined (the search on the convexified polar, legs laid out afterwards, cross-track polish; engine/experimental); default from the routing.router setting',
    })
  ),
  sail_thresh_ms: Type.Optional(Type.Number({ minimum: 0, description: 'Overrides the routing.sailThreshold setting (m/s)' })),
  max_wind_ms: Type.Optional(
    Type.Number({
      ...settingRange('routing.maxWind'),
      description: 'A leg is not allowed where the forecast wind speed exceeds this (m/s); overrides routing.maxWind',
    })
  ),
  max_swh_m: Type.Optional(
    Type.Number({
      ...settingRange('routing.maxSwh'),
      description:
        'A leg is not allowed where the significant wave height exceeds this (m); overrides routing.maxSwh. Needs wave data in the forecast',
    })
  ),
  max_wind_mode: Type.Optional(
    Type.Enum(LIMIT_MODES, {
      type: 'string',
      description:
        'What exceeding max_wind_ms does: block (the leg is not allowed) or avoid (allowed, each second over it counting (1 + limit_avoid_strength) seconds in the search, with a wind_over_limit warning on each leg that goes over); default from routing.maxWindMode',
    })
  ),
  max_swh_mode: Type.Optional(
    Type.Enum(LIMIT_MODES, {
      type: 'string',
      description:
        'What exceeding max_swh_m does: block or avoid, as max_wind_mode (warning waves_over_limit); default from routing.maxSwhMode',
    })
  ),
  limit_avoid_strength: Type.Optional(
    Type.Number({
      ...settingRange('routing.limitAvoidStrength'),
      description:
        'For a limit set to avoid: extra seconds per second spent over it, however far over (1 = time over counts double, 0 = warnings only); overrides routing.limitAvoidStrength. Route times stay real',
    })
  ),
  comfort_weight: Type.Optional(
    Type.Number({
      ...settingRange('routing.comfortWeight'),
      description:
        'How much the search avoids rough water as the boat meets it (sea-state index weighted for the wave angle); 0 = off; overrides routing.comfortWeight. Route times stay real',
    })
  ),
  simplify_m: Type.Optional(
    Type.Number({
      ...settingRange('routing.simplify'),
      description: 'RDP simplification tolerance in metres (0 = off); overrides routing.simplify',
    })
  ),
  smoother: Type.Optional(Type.Boolean({ description: 'Run the shortcut smoother; overrides routing.smoother' })),
  drawbridges: Type.Optional(
    Type.Enum(DRAWBRIDGE_CHOICES, {
      type: 'string',
      description:
        'Opening bridges on chart-mesh legs: ask (plan as open and report the ones crossed in the summary), open (plan as open), avoid (never pass one); default from the routing.drawbridges setting',
    })
  ),
  smoother_tolerance: Type.Optional(
    Type.Number({
      ...settingRange('routing.smootherTolerance'),
      description: 'Shortcut time tolerance as a ratio; overrides routing.smootherTolerance',
    })
  ),
  smoother_sim_step_m: Type.Optional(
    Type.Number({
      ...settingRange('routing.simStep'),
      description: "The smoother's simulation step, m; overrides routing.simStep for the smoother only (the search keeps routing.simStep)",
    })
  ),
  tack_penalty: Type.Optional(
    Type.Number({
      ...settingRange('routing.tackPenalty'),
      description: 'Seconds lost per tack or gybe; overrides the routing.tackPenalty setting',
    })
  ),
  name: Type.Optional(Type.String({ description: 'Name for the Signal K route resource' })),
  stages: Type.Optional(Type.Number({ ...settingRange('routing.stages'), description: 'Overrides the routing.stages setting' })),
  no_forecast: Type.Optional(Type.Boolean({ description: 'Route with calm wind' })),
  no_currents: Type.Optional(Type.Boolean({ description: 'Route without currents' })),
  wind_model: Type.Optional(
    Type.Enum(['auto', 'ecmwf'] as const, {
      type: 'string',
      default: 'auto',
      description:
        'auto: regional wind from signalk-grib-downloader (AROME, ARPEGE, ICON-EU) where it covers the point and time, ECMWF elsewhere; ecmwf: ECMWF only',
    })
  ),
  avoid_areas: Type.Optional(
    Type.Boolean({
      description:
        'Treat the areas marked on Signal K notes (a note with properties.avoid.radius_m, metres, around its position) as land; default true',
    })
  ),
  publish: Type.Optional(Type.Boolean({ description: 'Override the publish.toResources setting for this route' })),
};

/** The per-route vessel overrides. `name` and `motor_speed_ms` are bare types in the OpenAPI document, as always. */
export const VESSEL_FIELDS = {
  name: Type.Optional(Type.String()),
  motor_speed_ms: Type.Optional(Type.Number()),
  polar_performance: Type.Optional(
    Type.Number({
      minimum: 0.3,
      maximum: 1.2,
      description: 'Share of the polar boat speeds achieved under sail (ratio, 1 = as written)',
    })
  ),
  polar: Type.Optional(
    Type.String({
      maxLength: 200,
      description:
        'Polar token from /api/polars; absent = polarSource preference; auto = managed with local fallback; signalk-active = require managed; default or file token = local override',
    })
  ),
  draught_m: Type.Optional(
    Type.Number({
      minimum: DRAUGHT_M_RANGE[0],
      maximum: DRAUGHT_M_RANGE[1],
      description:
        "Draught, m (default: the vessel's Signal K design.draft.maximum); with air_draft_m, lets motoring legs use the chart mesh",
    })
  ),
  air_draft_m: Type.Optional(
    Type.Number({
      minimum: AIR_DRAFT_M_RANGE[0],
      maximum: AIR_DRAFT_M_RANGE[1],
      description: "Air draft (height above the waterline), m (default: the vessel's Signal K design.airHeight)",
    })
  ),
  under_keel_clearance_m: Type.Optional(
    Type.Number({
      minimum: UKC_M_RANGE[0],
      maximum: UKC_M_RANGE[1],
      description:
        'Water kept under the keel on chart-mesh legs, m: charted depth must be at least the draught plus this (default: the Under-keel clearance setting)',
    })
  ),
  overhead_clearance_m: Type.Optional(
    Type.Number({
      minimum: OVERHEAD_M_RANGE[0],
      maximum: OVERHEAD_M_RANGE[1],
      description:
        'Headroom kept above the mast on chart-mesh legs, m: charted clearance must be at least the air draft plus this (default: the Overhead clearance setting)',
    })
  ),
};

const Point = Type.Object({ lat: Type.Number(), lon: Type.Number() });

/** The whole route request: the type, the validator's ranges and the OpenAPI schema. */
export const RouteRequestSchema = Type.Object({
  start: Point,
  end: Point,
  waypoints: Type.Optional(
    Type.Array(
      Type.Object({
        lat: Type.Number(),
        lon: Type.Number(),
        radius_m: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_ARRIVAL_RADIUS_M })),
      }),
      {
        maxItems: MAX_WAYPOINTS,
        description:
          'Ordered waypoints; each ends one leg and starts the next. radius_m overrides arrival_radius_m for that waypoint (approximate precision).',
      }
    )
  ),
  ...ROUTE_REQUEST_FIELDS,
  vessel: Type.Optional(
    Type.Object(VESSEL_FIELDS, { description: 'Per-route overrides of the vessel settings (SI); absent keys use the settings.' })
  ),
});

export type RouteRequest = Static<typeof RouteRequestSchema>;

const isPoint = (p: unknown): p is { lat: number; lon: number } =>
  !!p && typeof p === 'object' && typeof (p as { lat: unknown }).lat === 'number' && typeof (p as { lon: unknown }).lon === 'number';

/** Why a point is not usable, or null. */
function pointError(p: unknown, name: string): string | null {
  if (!isPoint(p)) return `${name} must be {lat, lon}`;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return `${name} must be {lat, lon} numbers`;
  if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 360) return `${name} out of range`;
  return null;
}

/** The JSON Schema keywords a field's check reads. */
interface FieldJson {
  type?: string;
  enum?: readonly string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

/** Why a field's value does not fit its schema, or null. */
function fieldError(name: string, v: unknown, schema: TSchema): string | null {
  const s = schema as FieldJson;
  if (s.enum) {
    return s.enum.includes(v as string) ? null : `${name} must be ${s.enum.slice(0, -1).join(', ')} or ${s.enum[s.enum.length - 1]}`;
  }
  if (s.format === 'date-time') return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? null : `${name} must be ISO 8601`;
  switch (s.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${name} must be a number`;
      if (s.minimum !== undefined && s.maximum !== undefined && !(v >= s.minimum && v <= s.maximum))
        return `${name} must be ${s.minimum}..${s.maximum}`;
      if (s.minimum !== undefined && v < s.minimum) return `${name} must be >= ${s.minimum}`;
      if (s.maximum !== undefined && v > s.maximum) return `${name} must be <= ${s.maximum}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${name} must be true or false`;
    case 'string':
      if (typeof v !== 'string') return `${name} must be a string`;
      if (s.maxLength !== undefined && v.length > s.maxLength) return `${name} must be at most ${s.maxLength} characters`;
      return null;
    default:
      throw new Error(`request_schema: field ${name} has no check`);
  }
}

/**
 * The first problem with a route request body, or null when it is valid.
 * Covers the shape, every field's range against RouteRequestSchema, the
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
  for (const [name, schema] of Object.entries(ROUTE_REQUEST_FIELDS)) {
    if (name === 'precision' || name === 'arrival_radius_m') continue; // validateLegOptions
    const v = body[name];
    if (v === undefined) continue;
    if (name === 'departure' && v === '') continue; // empty = now
    const e = fieldError(name, v, schema);
    if (e) return e;
  }
  if (b.vessel !== undefined) {
    if (b.vessel === null || typeof b.vessel !== 'object') return 'vessel must be an object';
    const vessel = b.vessel as unknown as Record<string, unknown>;
    for (const [name, schema] of Object.entries(VESSEL_FIELDS)) {
      const v = vessel[name];
      if (v === undefined) continue;
      const e = fieldError(`vessel.${name}`, v, schema);
      if (e) return name === 'polar' ? 'vessel.polar must be a polar token from /api/polars' : e;
    }
  }
  return null;
}

/** The route request as an OpenAPI object schema. */
export function routeRequestSchema(): Record<string, unknown> {
  return RouteRequestSchema as unknown as Record<string, unknown>;
}
