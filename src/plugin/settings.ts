/**
 * Web-app settings: everything a user tunes (vessel, forecast horizon
 * and extras, currents, routing engine, publishing), kept out of the
 * Signal K plugin config and stored server-side in the plugin data
 * directory (settings.json) so every client shares them.
 *
 * Values are SI on the wire and on disk: metres, m/s, seconds (degrees
 * for the heading increment, as everywhere in this plugin's API). The
 * page converts for display with its unit presets.
 *
 * SETTINGS_SPEC is the single source of truth: defaults, ranges, enums,
 * labels and help text for GET /api/settings, validation for PUT, and
 * what a change needs re-done (`reload`). The ranges are the ones the
 * plugin config enforced before (resolveConfig, makeVessel), converted
 * to SI.
 */

import * as fs from 'node:fs';
import { HOUR_S } from '../geo/units';
import * as path from 'node:path';
import { KTS_TO_MS } from '../geo/geodesy';
import { RTOFS_REGIONS } from '../currents/rtofs';
import type { LegacyPluginConfig } from './config';
import { DEFAULT_ROUTER, ROUTER_KINDS, type RouterKind } from '../engine/router';

export interface AppSettings {
  vessel: {
    motorSpeed: number;
    polarPerformance: number;
  };
  forecast: {
    horizon: number;
    refreshInterval: number;
    keepCycles: number;
    extraFields: boolean;
    /** Also tp, ssrd, sf, strd, str, mucape, for energy modelling (off by default: about doubles the download). */
    energyFields: boolean;
    /** Bytes that must stay free after the forecast loads (memory guard). */
    memoryHeadroom: number;
    /** Folder of signalk-grib-downloader's runs; empty = find it (its config, else ~/.signalk/gribs). */
    regionalGribs: string;
  };
  currents: {
    smocEnabled: boolean;
    smocHorizon: number;
    smocStep: number;
    smocHalfWidth: number;
    rtofsEnabled: boolean;
    rtofsRegion: string;
    rtofsHorizon: number;
    rtofsStep: number;
  };
  tides: {
    enabled: boolean;
    /** Half-width of the resident tide-height map area around the vessel, degrees. */
    halfWidth: number;
    /** How far ahead the resident tide-height map area reaches, s. */
    horizon: number;
  };
  routing: {
    stages: number;
    subsectors: number;
    headings: number;
    headingIncrement: number;
    sailThreshold: number;
    /** Polar rows closer to the wind than this (degrees) are ignored; 0 = the polar as written. */
    noGoMinAngle: number;
    /** A leg is not allowed where the wind speed (m/s) exceeds this; null = no limit. */
    maxWind: number | null;
    /** A leg is not allowed where the significant wave height (m) exceeds this; null = no limit. */
    maxSwh: number | null;
    comfortWeight: number;
    simStep: number;
    landRasterMaxCells: number;
    /** Let routes use known ship canals (Corinth, Cape Cod, Kiel, Suez, …) where the coastline data shows them as water. */
    allowCanals: boolean;
    /** RDP simplification tolerance, metres (0 = off). */
    simplify: number;
    /** Run the shortcut smoother. */
    smoother: boolean;
    /** Smoother time tolerance, ratio (0.05 = a shortcut may be 5% slower). */
    smootherTolerance: number;
    /** Open-water router by default: standard (the isochrone search) or refined. */
    router: RouterKind;
    keepJobs: number;
  };
  publish: {
    toResources: boolean;
    routeNamePrefix: string;
    notifications: boolean;
  };
}

export type SettingsGroup = keyof AppSettings;

/**
 * What must be re-done when a setting changes:
 *  - forecast: decode the forecast again (new horizon or field set);
 *  - currents: reload the current sources (CMEMS SMOC, RTOFS);
 *  - tides: reload the Copernicus Marine sea-level source only;
 *  - refresh_timer: restart the cycle-check timer;
 *  - jobs: re-trim the finished-job list;
 *  - next_job: nothing now; the next route uses it;
 *  - cache: used at the next cache prune.
 */
export type ReloadKind = 'forecast' | 'currents' | 'tides' | 'refresh_timer' | 'jobs' | 'next_job' | 'cache';

/**
 * Display quantity, for the page's unit conversion: every one follows the
 * Signal K user's unit preferences (hours / minutes / seconds: the time
 * unit, data_size: the dataSize unit, angle: the angle unit; values stored
 * in seconds, bytes and degrees).
 */
export type Quantity =
  'speed' | 'depth' | 'wave_height' | 'short_distance' | 'ratio' | 'data_size' | 'hours' | 'minutes' | 'seconds' | 'angle' | 'count';

export interface SettingSpec {
  key: string;
  group: SettingsGroup;
  label: string;
  type: 'number' | 'integer' | 'boolean' | 'string' | 'enum';
  /** SI unit of the stored value ('m', 'm/s', 's', 'deg'), absent for dimensionless values. */
  unit?: string;
  quantity?: Quantity;
  min?: number;
  max?: number;
  /** Value must be a whole multiple of this (e.g. 3600 s = whole hours). */
  multipleOf?: number;
  /** Value must be one of these (SI), e.g. [3600, 10800] for a 1 h or 3 h step. */
  oneOf?: readonly number[];
  default: number | boolean | string | null;
  nullable?: boolean;
  enum?: readonly string[];
  maxLength?: number;
  /**
   * Shown under the setting. Quantities in it are tokens {<Signal K unit
   * category>:<value in its base unit>}, e.g. {time:3600}, {angle:0.26},
   * {dataSize:27e6}, for the client to convert.
   */
  help: string;
  reload: ReloadKind;
}

export const SETTINGS_GROUPS: { id: SettingsGroup; label: string; help: string }[] = [
  { id: 'vessel', label: 'Vessel', help: "Defaults for every route. A route request's own vessel values take precedence." },
  { id: 'forecast', label: 'Forecast', help: 'ECMWF open-data IFS on a {angle:0.00436332} grid, held for the whole globe.' },
  {
    id: 'currents',
    label: 'Currents',
    help: 'Copernicus Marine SMOC (worldwide surface currents on a {angle:0.00145444} grid, including tides and Stokes drift; primary) and NOAA Global RTOFS (regional; backup). Tidal harmonics come from the directory set in the Signal K plugin config and take precedence where they cover.',
  },
  {
    id: 'tides',
    label: 'Tides',
    help: 'Copernicus Marine hourly sea level (worldwide, on a {angle:0.00145444} grid): tide height, total water level and surge in the conditions popup and the Weather API, and the tide-height map layer. Heights are relative to mean sea level, not chart datum; not for under-keel clearance. Generated using E.U. Copernicus Marine Service Information.',
  },
  {
    id: 'routing',
    label: 'Routing engine',
    help: "Isochrone solver defaults. A route request's stages and sail threshold take precedence.",
  },
  { id: 'publish', label: 'Publishing', help: 'What happens with a finished route.' },
];

export const SETTINGS_SPEC: readonly SettingSpec[] = [
  {
    key: 'vessel.motorSpeed',
    group: 'vessel',
    label: 'Speed under power',
    type: 'number',
    unit: 'm/s',
    quantity: 'speed',
    min: 0.01,
    max: 50,
    default: 6 * KTS_TO_MS,
    help: 'Cruising speed when motoring.',
    reload: 'next_job',
  },
  {
    key: 'vessel.polarPerformance',
    group: 'vessel',
    label: 'Polar performance',
    type: 'number',
    unit: 'ratio',
    quantity: 'ratio',
    min: 0.3,
    max: 1.2,
    default: 1,
    help: "Share of the polar's boat speeds the boat actually makes under sail (100% = the polar as written). Polars are usually race predictions (flat water, racing sails, full crew); a loaded cruising boat is slower. Motor speed is not affected.",
    reload: 'next_job',
  },
  {
    key: 'forecast.horizon',
    group: 'forecast',
    label: 'Forecast horizon',
    type: 'number',
    unit: 's',
    quantity: 'hours',
    min: 3 * HOUR_S,
    max: 360 * HOUR_S,
    multipleOf: HOUR_S,
    default: 72 * HOUR_S,
    help: 'How far ahead the forecast reaches (ECMWF: 00z/12z runs to {time:1296000}, 06z/18z runs to {time:518400}, so above {time:518400} only 00z/12z runs are used). Changing it decodes the forecast again; the decoded run on disk grows with it (about {dataSize:1.35e9} for {time:259200} and {dataSize:4.6e9} for {time:1296000} with the extra fields), memory does not.',
    reload: 'forecast',
  },
  {
    key: 'forecast.refreshInterval',
    group: 'forecast',
    label: 'Check for a new cycle every',
    type: 'number',
    unit: 's',
    quantity: 'minutes',
    min: 600,
    max: 24 * HOUR_S,
    multipleOf: 60,
    default: HOUR_S,
    help: 'How often ECMWF is checked for a newer cycle.',
    reload: 'refresh_timer',
  },
  {
    key: 'forecast.keepCycles',
    group: 'forecast',
    label: 'Cached cycles kept on disk',
    type: 'integer',
    min: 1,
    max: 10,
    default: 2,
    help: 'Older downloaded cycles (GRIB messages and decoded runs) are deleted beyond this.',
    reload: 'cache',
  },
  {
    key: 'forecast.extraFields',
    group: 'forecast',
    label: 'Temperature, precipitation, SST, humidity, cloud cover',
    type: 'boolean',
    default: true,
    help: 'Also fetch 2t, tprate, skt, 2d, ptype, tcc and 10fg (the temperature, SST and precipitation layers, total cloud cover, wind gust and the full conditions). Changing it reloads the forecast.',
    reload: 'forecast',
  },
  {
    key: 'forecast.energyFields',
    group: 'forecast',
    label: 'Solar, thermal radiation, snowfall and instability',
    type: 'boolean',
    default: false,
    help: 'Also fetch tp, ssrd, sf, strd, str and mucape (total precipitation, surface solar radiation, snowfall, surface thermal radiation down and net, and convective instability) for energy modelling: roughly doubles the download (about +127 MB per 72 h cycle) and adds about 620 MB of decoded data on disk. Off by default, so a metered connection only pays for it on purpose. Changing it reloads the forecast.',
    reload: 'forecast',
  },
  {
    key: 'forecast.memoryHeadroom',
    group: 'forecast',
    label: 'Memory kept free',
    type: 'number',
    unit: 'B',
    quantity: 'data_size',
    min: 0,
    max: 64e9,
    multipleOf: 1e6,
    default: 1e9,
    help: 'A forecast update (one step decoded at a time) or a route (its forecast area) only runs if at least this much memory stays free afterwards for Signal K, the OS and other plugins. If it does not fit, the plugin says what to change instead.',
    reload: 'forecast',
  },
  {
    key: 'forecast.regionalGribs',
    group: 'forecast',
    label: 'Regional GRIB folder',
    type: 'string',
    default: '',
    maxLength: 500,
    help: 'Where the signalk-grib-downloader plugin keeps its runs (AROME, ARPEGE, ICON-EU, GFS). Empty: found by itself (the downloader’s own setting, else ~/.signalk/gribs). Optional: without it the router uses the ECMWF forecast alone. Each complete run’s surface wind is decoded and layered over ECMWF for routes where the regional model covers the point and time (ECMWF elsewhere; waves stay ECMWF). Its runs are listed in the status.',
    reload: 'next_job',
  },

  {
    key: 'currents.smocEnabled',
    group: 'currents',
    label: 'Use Copernicus Marine SMOC currents',
    type: 'boolean',
    default: true,
    help: 'Worldwide hourly surface currents (circulation + tides + Stokes drift) from Copernicus Marine, downloaded anonymously; takes precedence over RTOFS. Generated using E.U. Copernicus Marine Service Information.',
    reload: 'currents',
  },
  {
    key: 'currents.smocHorizon',
    group: 'currents',
    label: 'SMOC horizon',
    type: 'number',
    unit: 's',
    quantity: 'hours',
    min: 6 * HOUR_S,
    max: 240 * HOUR_S,
    multipleOf: HOUR_S,
    default: 72 * HOUR_S,
    help: 'How far ahead SMOC is held (the product reaches about 10 days).',
    reload: 'currents',
  },
  {
    key: 'currents.smocStep',
    group: 'currents',
    label: 'SMOC time step kept',
    type: 'number',
    unit: 's',
    quantity: 'hours',
    min: 1 * HOUR_S,
    max: 3 * HOUR_S,
    multipleOf: HOUR_S,
    oneOf: [1 * HOUR_S, 3 * HOUR_S],
    default: 3 * HOUR_S,
    help: 'The shorter of the two steps triples the download and memory.',
    reload: 'currents',
  },
  {
    key: 'currents.smocHalfWidth',
    group: 'currents',
    label: 'SMOC area around the vessel',
    type: 'number',
    unit: 'deg',
    quantity: 'angle',
    min: 2,
    max: 30,
    default: 15,
    help: 'Half-width of the area kept in memory around the vessel position (about {dataSize:27e6} at {angle:0.261799} with {time:10800} steps over {time:259200}; grows with the square of the half-width). Routes and map views elsewhere load their own area on demand.',
    reload: 'currents',
  },
  {
    key: 'currents.rtofsEnabled',
    group: 'currents',
    label: 'Use RTOFS ocean currents',
    type: 'boolean',
    default: true,
    help: 'Download NOAA Global RTOFS from NOMADS (used where SMOC has no data).',
    reload: 'currents',
  },
  {
    key: 'currents.rtofsRegion',
    group: 'currents',
    label: 'RTOFS regional product',
    type: 'enum',
    enum: RTOFS_REGIONS,
    default: 'west_atl',
    help: 'Which regional RTOFS product to download.',
    reload: 'currents',
  },
  {
    key: 'currents.rtofsHorizon',
    group: 'currents',
    label: 'RTOFS horizon',
    type: 'number',
    unit: 's',
    quantity: 'hours',
    min: 24 * HOUR_S,
    max: 144 * HOUR_S,
    multipleOf: HOUR_S,
    default: 72 * HOUR_S,
    help: 'How far ahead RTOFS is loaded.',
    reload: 'currents',
  },
  {
    key: 'currents.rtofsStep',
    group: 'currents',
    label: 'RTOFS time step kept',
    type: 'number',
    unit: 's',
    quantity: 'hours',
    min: 1 * HOUR_S,
    max: 6 * HOUR_S,
    multipleOf: HOUR_S,
    default: 3 * HOUR_S,
    help: 'Spacing of the RTOFS steps held in memory.',
    reload: 'currents',
  },

  {
    key: 'tides.enabled',
    group: 'tides',
    label: 'Use Copernicus Marine sea level',
    type: 'boolean',
    default: true,
    help: 'Tide height, total water level and surge (relative to mean sea level) for the conditions popup, the Weather API (water.level) and the tide-height map layer, downloaded anonymously from Copernicus Marine. About {dataSize:1e6} to {dataSize:4e6} per new place for a point series.',
    reload: 'tides',
  },
  {
    key: 'tides.halfWidth',
    group: 'tides',
    label: 'Tide map area around the vessel',
    type: 'number',
    unit: 'deg',
    quantity: 'angle',
    min: 1,
    max: 30,
    default: 15,
    help: 'Half-width of the tide-height map area kept in memory around the vessel position (hourly steps; about {dataSize:17e6} at {angle:0.261799} over {time:86400}, growing with the square of the half-width and with the horizon). Map views elsewhere load their own hour on demand.',
    reload: 'tides',
  },
  {
    key: 'tides.horizon',
    group: 'tides',
    label: 'Tide map horizon',
    type: 'number',
    unit: 's',
    quantity: 'hours',
    min: 6 * HOUR_S,
    max: 240 * HOUR_S,
    multipleOf: HOUR_S,
    default: 24 * HOUR_S,
    help: 'How far ahead the resident tide-height map area reaches (hourly steps; each hour of a {angle:0.523599} area downloads about {dataSize:1e6} to {dataSize:3e6} per new daily run). Map times beyond it load on demand. The conditions popup and Weather API are not limited by this.',
    reload: 'tides',
  },

  {
    key: 'routing.stages',
    group: 'routing',
    label: 'Isochrone stages',
    type: 'integer',
    min: 4,
    max: 200,
    default: 20,
    help: 'Propagation stages between start and end.',
    reload: 'next_job',
  },
  {
    key: 'routing.subsectors',
    group: 'routing',
    label: 'Subsectors',
    type: 'integer',
    min: 4,
    max: 200,
    default: 30,
    help: 'Angular sectors each isochrone is pruned to.',
    reload: 'next_job',
  },
  {
    key: 'routing.headings',
    group: 'routing',
    label: 'Headings each side',
    type: 'integer',
    min: 4,
    max: 180,
    default: 30,
    help: 'Headings tried either side of the course.',
    reload: 'next_job',
  },
  {
    key: 'routing.headingIncrement',
    group: 'routing',
    label: 'Heading increment',
    type: 'number',
    unit: 'deg',
    quantity: 'angle',
    min: 0.25,
    max: 10,
    default: 1,
    help: 'Spacing of the tried headings.',
    reload: 'next_job',
  },
  {
    key: 'routing.sailThreshold',
    group: 'routing',
    label: 'Sail when boat speed exceeds',
    type: 'number',
    unit: 'm/s',
    quantity: 'speed',
    min: 0,
    max: 50 * KTS_TO_MS,
    default: 4.9 * KTS_TO_MS,
    help: 'Below this polar speed the route motors (sail_max mode).',
    reload: 'next_job',
  },
  {
    key: 'routing.noGoMinAngle',
    group: 'routing',
    label: 'Tightest sailable angle',
    type: 'number',
    unit: 'deg',
    quantity: 'angle',
    min: 0,
    max: 60,
    default: 30,
    help: `Polar rows closer to the wind than this are ignored. Many library polars carry small boat speeds at {angle:0.0872665} to {angle:0.436332} off the wind, where no boat sails; left in, a route goes dead upwind at a crawl instead of tacking (an Amel 55 from the library: {speed:${3 * KTS_TO_MS}} at {angle:0.331613} against a {speed:${5.8 * KTS_TO_MS}} VMG tacking at {angle:0.698132}). 0 = use the polar as written.`,
    reload: 'next_job',
  },
  {
    key: 'routing.maxWind',
    group: 'routing',
    label: 'Maximum wind',
    type: 'number',
    unit: 'm/s',
    quantity: 'speed',
    min: 0,
    max: 100,
    default: null,
    nullable: true,
    help: 'A leg is not allowed where the forecast wind speed is above this. Empty = no limit. A route request can override it.',
    reload: 'next_job',
  },
  {
    key: 'routing.maxSwh',
    group: 'routing',
    label: 'Maximum wave height',
    type: 'number',
    unit: 'm',
    quantity: 'wave_height',
    min: 0,
    max: 30,
    default: null,
    nullable: true,
    help: 'A leg is not allowed where the significant wave height is above this. Empty = no limit. Needs wave data in the forecast. A route request can override it.',
    reload: 'next_job',
  },
  {
    key: 'routing.comfortWeight',
    group: 'routing',
    label: 'Comfort weight',
    type: 'number',
    min: 0,
    max: 3,
    default: 1,
    help: 'How much the router avoids rough water, as the boat meets it (the sea-state index weighted for the angle of the waves to the course: head seas count more, following seas less). Above the "slight" band each hour sailed counts extra in the search\'s choices: with 1, choppy water adds up to 25 %, rough 50 %, extreme 125 %. 0 = off (the fastest route). The times shown stay the real times. Needs wave data in the forecast. A route request can override it.',
    reload: 'next_job',
  },
  {
    key: 'routing.simStep',
    group: 'routing',
    label: 'Leg simulation step',
    type: 'number',
    unit: 'm',
    quantity: 'short_distance',
    min: 50,
    max: 5000,
    default: 200,
    help: 'Distance between samples along each leg.',
    reload: 'next_job',
  },
  {
    key: 'routing.landRasterMaxCells',
    group: 'routing',
    label: 'Land raster cell budget',
    type: 'integer',
    min: 1_000_000,
    max: 1_000_000_000,
    default: 25_000_000,
    help: 'Upper bound on the per-route land raster (1 byte per cell). Lower it on small machines.',
    reload: 'next_job',
  },
  {
    key: 'routing.allowCanals',
    group: 'routing',
    label: 'Allow canals',
    type: 'boolean',
    default: false,
    help: 'Let routes pass through known ship canals (Corinth, Cape Cod, Chesapeake and Delaware, Kiel, Suez, Panama) where the coastline data shows them as water. Off: routes go the natural way round. With the GSHHG coastline none of these canals is open water, so this only matters with coastline data that includes canals.',
    reload: 'next_job',
  },
  {
    key: 'routing.simplify',
    group: 'routing',
    label: 'Route simplification',
    type: 'number',
    unit: 'm',
    quantity: 'short_distance',
    min: 0,
    max: 5000,
    default: 10,
    help: 'Waypoints closer than this to the straight line between their neighbours are dropped when that line is clear of land (0 = off). Your own waypoints are always kept.',
    reload: 'next_job',
  },
  {
    key: 'routing.smoother',
    group: 'routing',
    label: 'Shortcut smoother',
    type: 'boolean',
    default: false,
    help: 'Replace runs of waypoints with one straight leg when it is clear of land and not much slower. Your own waypoints are always kept. The default; a route can choose On or Off (Route → Plan → Smoothing).',
    reload: 'next_job',
  },
  {
    key: 'routing.smootherTolerance',
    group: 'routing',
    label: 'Shortcut may be slower by',
    type: 'number',
    unit: 'ratio',
    quantity: 'ratio',
    min: 0,
    max: 0.5,
    default: 0.05,
    help: 'A straight shortcut is accepted when its simulated time is at most this much longer than the legs it replaces.',
    reload: 'next_job',
  },
  {
    key: 'routing.router',
    group: 'routing',
    label: 'Open-water router',
    type: 'enum',
    enum: ROUTER_KINDS,
    default: DEFAULT_ROUTER,
    help: 'standard: the isochrone search. refined: the same search on the convexified polar (a beat is a straight line at the exact VMG), each mixed sailing leg is then laid out as tacks, and a cross-track polish moves waypoints sideways where the route arrives earlier; under motor it is identical to standard. A route request can choose either (router).',
    reload: 'next_job',
  },
  {
    key: 'routing.keepJobs',
    group: 'routing',
    label: 'Finished routes kept',
    type: 'integer',
    min: 1,
    max: 500,
    default: 50,
    help: 'Older finished route jobs are deleted beyond this.',
    reload: 'jobs',
  },

  {
    key: 'publish.toResources',
    group: 'publish',
    label: 'Save finished routes to Signal K',
    type: 'boolean',
    default: true,
    help: 'Write each finished route to the Resources API (routes).',
    reload: 'next_job',
  },
  {
    key: 'publish.routeNamePrefix',
    group: 'publish',
    label: 'Route name prefix',
    type: 'string',
    default: 'WRP',
    maxLength: 40,
    help: 'Prefix for routes submitted without a name.',
    reload: 'next_job',
  },
  {
    key: 'publish.notifications',
    group: 'publish',
    label: 'Notifications',
    type: 'boolean',
    default: true,
    help: 'Emit notifications.weatherRouterPlus.<jobId> when a route finishes or fails.',
    reload: 'next_job',
  },
];

const SPEC_BY_KEY = new Map(SETTINGS_SPEC.map(s => [s.key, s]));

export class SettingsValidationError extends Error {
  readonly errors: Record<string, string>;
  constructor(errors: Record<string, string>) {
    super(
      `invalid settings: ${Object.entries(errors)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')}`
    );
    this.name = 'SettingsValidationError';
    this.errors = errors;
  }
}

export function defaultSettings(): AppSettings {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of SETTINGS_SPEC) {
    const [g, k] = s.key.split('.');
    (out[g] ??= {})[k] = s.default;
  }
  return out as unknown as AppSettings;
}

function cloneSettings(s: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(s)) as AppSettings;
}

/** The Signal K unit category of each settings quantity (values in its base unit). */
const QUANTITY_CATEGORY: Partial<Record<Quantity, string>> = {
  speed: 'speed',
  depth: 'depth',
  wave_height: 'depth',
  short_distance: 'length',
  ratio: 'percentage',
  data_size: 'dataSize',
  hours: 'time',
  minutes: 'time',
  seconds: 'time',
  angle: 'angle',
};

/**
 * A value of this setting in a message: a unit token {<Signal K category>:
 * <value in its base unit>} for the client to convert (angles: stored in
 * degrees, sent in radians); a bare number for counts.
 */
function quantityToken(spec: SettingSpec, v: number | undefined): string {
  if (v === undefined) return '';
  const cat = spec.quantity ? QUANTITY_CATEGORY[spec.quantity] : undefined;
  if (!cat) return String(v);
  return `{${cat}:${cat === 'angle' ? (v * Math.PI) / 180 : v}}`;
}

/** Check one value against its spec; returns the normalised value or throws with a message. */
export function validateValue(spec: SettingSpec, raw: unknown): number | boolean | string | null {
  switch (spec.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') throw new Error('must be true or false');
      return raw;
    case 'string': {
      if (typeof raw !== 'string') throw new Error('must be a string');
      const t = raw.trim();
      if (!t) return spec.default as string;
      if (spec.maxLength !== undefined && t.length > spec.maxLength) throw new Error(`must be at most ${spec.maxLength} characters`);
      return t;
    }
    case 'enum': {
      if (typeof raw !== 'string' || !spec.enum!.includes(raw)) throw new Error(`must be one of ${spec.enum!.join(', ')}`);
      return raw;
    }
    case 'number':
    case 'integer': {
      if (raw === null || raw === '') {
        if (spec.nullable) return null;
        throw new Error('is required');
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('must be a number');
      if (spec.type === 'integer' && !Number.isInteger(raw)) throw new Error('must be a whole number');
      if ((spec.min !== undefined && raw < spec.min - 1e-9) || (spec.max !== undefined && raw > spec.max + 1e-9)) {
        throw new Error(`must be in [${quantityToken(spec, spec.min)}, ${quantityToken(spec, spec.max)}]`);
      }
      let out = raw;
      if (spec.multipleOf !== undefined) {
        const q = raw / spec.multipleOf;
        if (Math.abs(q - Math.round(q)) > 1e-6) throw new Error(`must be a whole multiple of ${quantityToken(spec, spec.multipleOf)}`);
        out = Math.round(q) * spec.multipleOf;
      }
      if (spec.oneOf && !spec.oneOf.some(x => Math.abs(x - out) < 1e-9))
        throw new Error(`must be one of ${spec.oneOf.map(x => quantityToken(spec, x)).join(', ')}`);
      return out;
    }
  }
}

/**
 * Validate a partial update (nested: `{vessel: {motorSpeed: 3}}`) against
 * `base`, returning the merged settings and the dotted keys whose value
 * changed. Every problem is collected; any problem throws
 * SettingsValidationError and nothing is merged.
 */
export function mergeSettings(base: AppSettings, partial: unknown): { values: AppSettings; changed: string[] } {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new SettingsValidationError({ '': 'body must be an object of setting groups, e.g. {"vessel": {"motorSpeed": 3}}' });
  }
  const errors: Record<string, string> = {};
  const out = cloneSettings(base);
  const changed: string[] = [];
  for (const [g, groupVal] of Object.entries(partial as Record<string, unknown>)) {
    if (!SETTINGS_GROUPS.some(x => x.id === g)) {
      errors[g] = 'unknown settings group';
      continue;
    }
    if (groupVal === null || typeof groupVal !== 'object' || Array.isArray(groupVal)) {
      errors[g] = 'must be an object';
      continue;
    }
    for (const [k, raw] of Object.entries(groupVal as Record<string, unknown>)) {
      const key = `${g}.${k}`;
      const spec = SPEC_BY_KEY.get(key);
      if (!spec) {
        errors[key] = 'unknown setting';
        continue;
      }
      try {
        const v = validateValue(spec, raw);
        const grp = (out as unknown as Record<string, Record<string, unknown>>)[g];
        if (grp[k] !== v) {
          grp[k] = v;
          changed.push(key);
        }
      } catch (err) {
        errors[key] = (err as Error).message;
      }
    }
  }
  if (Object.keys(errors).length) throw new SettingsValidationError(errors);
  return { values: out, changed };
}

/** Settings from a stored object, key by key; invalid or missing keys fall back to defaults and are reported. */
export function settingsFromStored(stored: unknown): { values: AppSettings; problems: string[] } {
  const values = defaultSettings();
  const problems: string[] = [];
  const obj = stored && typeof stored === 'object' ? (stored as Record<string, Record<string, unknown>>) : {};
  for (const spec of SETTINGS_SPEC) {
    const [g, k] = spec.key.split('.');
    const grp = obj[g];
    if (!grp || typeof grp !== 'object' || !(k in grp)) continue;
    try {
      (values as unknown as Record<string, Record<string, unknown>>)[g][k] = validateValue(spec, grp[k]);
    } catch (err) {
      problems.push(`${spec.key}: ${(err as Error).message} (using the default)`);
    }
  }
  return { values, problems };
}

/**
 * Settings from the plugin config of earlier versions: every key that
 * was set is converted to SI (knots → m/s, hours / minutes → s) and
 * validated on its own; one that fails is skipped (default kept) and
 * reported rather than blocking the rest.
 */
export function migrateLegacy(legacy: LegacyPluginConfig | undefined): { values: AppSettings; migrated: string[]; skipped: string[] } {
  const l = legacy ?? {};
  const set = (o: Record<string, unknown>, key: string, v: unknown): void => {
    if (v === undefined || v === null || v === '') return;
    o[key] = v;
  };
  const src: Record<string, Record<string, unknown>> = { vessel: {}, forecast: {}, currents: {}, tides: {}, routing: {}, publish: {} };
  const num = (v: unknown, k = 1): unknown =>
    v === undefined || v === null || v === '' ? undefined : typeof v === 'number' ? v * k : Number.isFinite(Number(v)) ? Number(v) * k : v;
  const v = l.vessel ?? {};
  set(src.vessel, 'motorSpeed', num(v.motorSpeedKts, KTS_TO_MS));
  const f = l.forecast ?? {};
  set(src.forecast, 'horizon', num(f.horizonHours, HOUR_S));
  set(src.forecast, 'refreshInterval', num(f.refreshMinutes, 60));
  set(src.forecast, 'keepCycles', num(f.keepCycles));
  set(src.forecast, 'extraFields', f.extraFields);
  set(src.forecast, 'energyFields', f.energyFields);
  const c = l.currents ?? {};
  set(src.currents, 'rtofsEnabled', c.rtofsEnabled);
  set(src.currents, 'rtofsRegion', typeof c.rtofsRegion === 'string' ? c.rtofsRegion.trim() : c.rtofsRegion);
  set(src.currents, 'rtofsHorizon', num(c.rtofsHorizonHours, HOUR_S));
  set(src.currents, 'rtofsStep', num(c.rtofsStepHours, HOUR_S));
  const r = l.routing ?? {};
  set(src.routing, 'stages', num(r.stages));
  set(src.routing, 'subsectors', num(r.subsectors));
  set(src.routing, 'headings', num(r.headings));
  set(src.routing, 'headingIncrement', num(r.headingIncrementDeg));
  set(src.routing, 'sailThreshold', num(r.sailThresholdKts, KTS_TO_MS));
  set(src.routing, 'simStep', num(r.simStepM));
  set(src.routing, 'landRasterMaxCells', num(r.landRasterMaxCells));
  set(src.routing, 'keepJobs', num(r.keepJobs));
  const p = l.publish ?? {};
  set(src.publish, 'toResources', p.toResources);
  set(src.publish, 'routeNamePrefix', p.routeNamePrefix);
  set(src.publish, 'notifications', p.notifications);

  const values = defaultSettings();
  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const [g, grp] of Object.entries(src)) {
    for (const [k, raw] of Object.entries(grp)) {
      const key = `${g}.${k}`;
      const spec = SPEC_BY_KEY.get(key)!;
      try {
        (values as unknown as Record<string, Record<string, unknown>>)[g][k] = validateValue(spec, raw);
        migrated.push(key);
      } catch (err) {
        skipped.push(`${key}: ${String(raw)} ${(err as Error).message}`);
      }
    }
  }
  return { values, migrated, skipped };
}

interface SettingsFile {
  version: 1;
  /** 'plugin-config' when the file was first written by the migration. */
  migratedFrom?: string;
  updatedAt: string;
  values: AppSettings;
}

/** settings.json in the plugin data directory. */
export class SettingsStore {
  readonly file: string;
  private current: AppSettings = defaultSettings();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  /**
   * Load settings.json, or create it by migrating `legacy` (the old
   * plugin config) when it does not exist yet. The Signal K config file
   * is never modified. Returns what happened, for the log.
   */
  load(legacy: LegacyPluginConfig | undefined): { created: boolean; migrated: string[]; problems: string[] } {
    let text: string | null = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== null) {
      let parsed: Partial<SettingsFile> | null;
      try {
        parsed = JSON.parse(text) as Partial<SettingsFile>;
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object') {
        const { values, problems } = settingsFromStored(parsed.values);
        this.current = values;
        return { created: false, migrated: [], problems };
      }
      // Unreadable: keep it aside and start again from the legacy config.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      const m = migrateLegacy(legacy);
      this.current = m.values;
      this.write('plugin-config');
      return {
        created: true,
        migrated: m.migrated,
        problems: [`settings.json was not valid JSON; moved to ${path.basename(aside)}`, ...m.skipped],
      };
    }
    const m = migrateLegacy(legacy);
    this.current = m.values;
    this.write('plugin-config');
    return { created: true, migrated: m.migrated, problems: m.skipped };
  }

  get values(): AppSettings {
    return cloneSettings(this.current);
  }

  /** Validate and persist a partial update. Throws SettingsValidationError (nothing saved) on any invalid key. */
  update(partial: unknown): { values: AppSettings; changed: string[] } {
    const { values, changed } = mergeSettings(this.current, partial);
    if (changed.length) {
      const prev = this.current;
      this.current = values;
      try {
        this.write();
      } catch (err) {
        this.current = prev;
        throw err;
      }
    }
    return { values: cloneSettings(values), changed };
  }

  private write(migratedFrom?: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let prevMigrated: string | undefined;
    try {
      prevMigrated = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SettingsFile>).migratedFrom;
    } catch {
      prevMigrated = undefined;
    }
    const body: SettingsFile = {
      version: 1,
      migratedFrom: migratedFrom ?? prevMigrated,
      updatedAt: new Date().toISOString(),
      values: this.current,
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/** Reload kinds implied by a set of changed keys. */
export function reloadsFor(changed: string[]): Set<ReloadKind> {
  const out = new Set<ReloadKind>();
  for (const k of changed) {
    const s = SPEC_BY_KEY.get(k);
    if (s) out.add(s.reload);
  }
  return out;
}

/** GET /api/settings schema. */
export function settingsSchema(): { groups: typeof SETTINGS_GROUPS; settings: readonly SettingSpec[] } {
  return { groups: SETTINGS_GROUPS, settings: SETTINGS_SPEC };
}
