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

import { DRAWBRIDGE_CHOICES, type DrawbridgeChoice } from '../engine/mesh/route';
import { LIMIT_MODES, type LimitMode } from '../engine/legsim';
import * as fs from 'node:fs';
import { HOUR_S } from '../geo/units';
import * as path from 'node:path';
import { KTS_TO_MS } from '../geo/geodesy';
import { RTOFS_REGIONS } from '../currents/rtofs';
import type { LegacyPluginConfig } from './config';
import { DEFAULT_ROUTER, ROUTER_KINDS, type RouterKind } from '../engine/router';
import { DEFAULT_OVERHEAD_M, DEFAULT_UKC_M, OVERHEAD_M_RANGE, UKC_M_RANGE } from '../vessel/vessel';

export interface AppSettings {
  vessel: {
    motorSpeed: number;
    polarPerformance: number;
    underKeelClearance: number;
    overheadClearance: number;
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
    smocStep: number;
    smocHalfWidth: number;
    rtofsEnabled: boolean;
    /** RTOFS products loaded wherever the vessel is, besides the one that contains it. */
    rtofsExtra: string[];
    rtofsStep: number;
  };
  tides: {
    enabled: boolean;
    /** Half-width of the resident tide-height map area around the vessel, degrees. */
    halfWidth: number;
  };
  routing: {
    stages: number;
    subsectors: number;
    headings: number;
    headingIncrement: number;
    sailThreshold: number;
    /** Seconds lost per tack or gybe, charged by both routers. */
    tackPenalty: number;
    /** On a chart mesh leg, keep at least this far (m) from every triangle the boat cannot use; 0 = none. */
    navigableBuffer: number;
    /** Keep at least this far (m) from the coastline; 0 = none. */
    landBuffer: number;
    /** Opening bridges on chart-mesh legs: ask, open or avoid. */
    drawbridges: DrawbridgeChoice;
    /** Seconds added at each opening bridge the route passes under. */
    bridgeWait: number;
    /** Polar rows closer to the wind than this (degrees) are ignored; 0 = the polar as written. */
    noGoMinAngle: number;
    /** A leg is not allowed where the wind speed (m/s) exceeds this; null = no limit. */
    maxWind: number | null;
    /** A leg is not allowed where the significant wave height (m) exceeds this; null = no limit. */
    maxSwh: number | null;
    /** What exceeding each limit does: block (impassable) or avoid (allowed, time over it counting extra). */
    maxWindMode: LimitMode;
    maxSwhMode: LimitMode;
    /** Avoid: each second over a limit counts (1 + this) seconds in the search's choices. */
    limitAvoidStrength: number;
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
  /** enumList: a list of `enum` values (checkboxes), each at most once, kept in the enum's order. */
  type: 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'enumList';
  /** SI unit of the stored value ('m', 'm/s', 's', 'deg'), absent for dimensionless values. */
  unit?: string;
  quantity?: Quantity;
  min?: number;
  max?: number;
  /** Value must be a whole multiple of this (e.g. 3600 s = whole hours). */
  multipleOf?: number;
  /** Value must be one of these (SI), e.g. [3600, 10800] for a 1 h or 3 h step. */
  oneOf?: readonly number[];
  /**
   * The Defaults tab's slider step (SI), converted to the user's unit by
   * the page; a whole multiple of `multipleOf` where that is set. Every
   * numeric setting has one (the owner's decision, 2026-10-08: numbers on
   * the Defaults tab are sliders, not text boxes).
   */
  step?: number;
  default: number | boolean | string | readonly string[] | null;
  nullable?: boolean;
  enum?: readonly string[];
  /** enum / enumList: text shown beside each value (unit tokens as in `help`). */
  enumHelp?: Readonly<Record<string, string>>;
  maxLength?: number;
  /**
   * Shown under the setting. Quantities in it are tokens {<Signal K unit
   * category>:<value in its base unit>}, e.g. {time:3600}, {angle:0.26},
   * {dataSize:27e6}, for the client to convert.
   */
  help: string;
  reload: ReloadKind;
  /** What else a change re-does (the forecast horizon is every source's horizon). */
  alsoReload?: readonly ReloadKind[];
}

export const SETTINGS_GROUPS: { id: SettingsGroup; label: string; help: string }[] = [
  { id: 'vessel', label: 'Vessel', help: "Defaults for every route. A route request's own vessel values take precedence." },
  { id: 'forecast', label: 'Forecast', help: 'ECMWF open-data IFS on a {angle:0.00436332} grid, held for the whole globe.' },
  {
    id: 'currents',
    label: 'Currents',
    help: 'Copernicus Marine SMOC (worldwide surface currents on a {angle:0.00145444} grid, including tides and Stokes drift; primary) and NOAA Global RTOFS (regional products; backup where SMOC has no data). Tidal harmonics come from the directory set in the Signal K plugin config and take precedence where they cover.',
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

/**
 * Each RTOFS product's area (its grid as the decoder places it, from the
 * 2026-10-21 run's f024 headers: rtofsExtentOfGrid), its daily download (f024 + f048 + f072, the files a 72 h
 * horizon needs, measured on that run) and the memory its steps hold at
 * the default 72 h and 3 h step (columns × rows × u, v × 4 bytes × 24
 * steps: worked out, not measured; west_atl's 46 MB was measured on brain
 * in 0.1.2-beta.1).
 */
const RTOFS_PRODUCT_HELP: Readonly<Record<string, string>> = {
  west_atl: '10–44.72°N, 100–54.08°W; {dataSize:115.2e6} a day, {dataSize:48.0e6} in memory',
  west_conus: '10–59.92°N, 150–100.08°W; {dataSize:165.5e6} a day, {dataSize:75.0e6} in memory',
  alaska: '40–84.7°N, 140°E–115.3°W; {dataSize:32.0e6} a day, {dataSize:10.1e6} in memory',
  arctic: '60–79.92°N, 160°E–124.08°W; {dataSize:123.7e6} a day, {dataSize:45.6e6} in memory',
  bering: '40–67.12°N, 155°E–149.08°W; {dataSize:140.6e6} a day, {dataSize:45.7e6} in memory',
  guam: '0–29.92°N, 130–179.92°E; {dataSize:134.3e6} a day, {dataSize:45.0e6} in memory',
  gulf_alaska: '40–62°N, 165–123.5°W; {dataSize:1.8e6} a day, {dataSize:0.7e6} in memory',
  honolulu: '0–39.92°N, 180–130.08°W; {dataSize:175.8e6} a day, {dataSize:60.0e6} in memory',
  hudson_baffin: '40–77.75°N, 109–27.25°W; {dataSize:16.1e6} a day, {dataSize:9.6e6} in memory',
  samoa: '30–0.08°S, 170°E–145.28°W; {dataSize:119.2e6} a day, {dataSize:40.3e6} in memory',
  trop_paci_lowres: '40°S–39°N, 130°E–111°W (1° grid); {dataSize:5.6e6} a day, {dataSize:1.8e6} in memory',
};

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
    step: 0.1 * KTS_TO_MS,
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
    step: 0.01,
    default: 1,
    help: "Share of the polar's boat speeds the boat actually makes under sail (100% = the polar as written). Polars are usually race predictions (flat water, racing sails, full crew); a loaded cruising boat is slower. Motor speed is not affected. Applies to the files polar source; the Signal K source uses polars.performanceFactor.",
    reload: 'next_job',
  },
  {
    key: 'vessel.underKeelClearance',
    group: 'vessel',
    label: 'Under-keel clearance',
    type: 'number',
    unit: 'm',
    quantity: 'depth',
    min: UKC_M_RANGE[0],
    max: UKC_M_RANGE[1],
    step: 0.1,
    default: DEFAULT_UKC_M,
    help: 'Water kept under the keel on chart-mesh legs: charted depth must be at least the draught plus this. A route request can set its own.',
    reload: 'next_job',
  },
  {
    key: 'vessel.overheadClearance',
    group: 'vessel',
    label: 'Overhead clearance',
    type: 'number',
    unit: 'm',
    quantity: 'short_distance',
    min: OVERHEAD_M_RANGE[0],
    max: OVERHEAD_M_RANGE[1],
    step: 0.1,
    default: DEFAULT_OVERHEAD_M,
    help: 'Headroom kept above the mast under bridges and overhead cables on chart-mesh legs: charted clearance must be at least the air draft plus this. A route request can set its own.',
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
    step: HOUR_S,
    multipleOf: HOUR_S,
    default: 72 * HOUR_S,
    help: 'How far ahead the forecast reaches (ECMWF: 00z/12z runs to {time:1296000}, 06z/18z runs to {time:518400}, so above {time:518400} only 00z/12z runs are used), and with it every other source: SMOC and RTOFS currents and the tide map, each to the end of its own data when that comes first (SMOC about {time:864000}, RTOFS {time:518400}). Changing it decodes the forecast again and reloads currents and tides; the decoded run on disk grows with it (about {dataSize:1.35e9} for {time:259200} and {dataSize:4.6e9} for {time:1296000} with the extra fields), and so do the SMOC and tide areas held around the vessel.',
    reload: 'forecast',
    alsoReload: ['currents', 'tides'],
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
    step: 60,
    multipleOf: 60,
    default: 900,
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
    step: 1,
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
    step: 100e6,
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
    key: 'currents.smocStep',
    group: 'currents',
    label: 'SMOC time step kept',
    type: 'number',
    unit: 's',
    quantity: 'hours',
    min: 1 * HOUR_S,
    max: 3 * HOUR_S,
    step: 2 * HOUR_S,
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
    step: 1,
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
    help: 'Download NOAA Global RTOFS from NOMADS (used where SMOC has no data). The regional product that contains the vessel is loaded, the finest where two overlap, and changes when the vessel moves into another; where none does (Europe, the Mediterranean, the Indian Ocean, the South Atlantic, Australia) nothing is downloaded. Without a vessel position only the products below are loaded.',
    reload: 'currents',
  },
  {
    key: 'currents.rtofsExtra',
    group: 'currents',
    label: 'Also load RTOFS products',
    type: 'enumList',
    enum: RTOFS_REGIONS,
    enumHelp: RTOFS_PRODUCT_HELP,
    default: [],
    help: 'Products loaded wherever the vessel is, for a passage planned elsewhere. Each is its own daily download and stays in memory (also in each map tile builder while it runs). Sizes for the default 72 h horizon and 3 h step: the download measured on the 2026-10-21 run, the memory worked out from the grid.',
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
    step: HOUR_S,
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
    step: 1,
    default: 15,
    help: 'Half-width of the tide-height map area kept in memory around the vessel position (hourly steps; about {dataSize:17e6} at {angle:0.261799} over {time:86400}, growing with the square of the half-width and with the forecast horizon, which the tide map follows). Map views elsewhere load their own hour on demand.',
    reload: 'tides',
  },

  {
    key: 'routing.stages',
    group: 'routing',
    label: 'Isochrone stages',
    type: 'integer',
    min: 4,
    max: 200,
    step: 1,
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
    step: 1,
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
    step: 1,
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
    step: 0.25,
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
    step: 0.1 * KTS_TO_MS,
    default: 4.9 * KTS_TO_MS,
    help: 'Below this polar speed the route motors (sail_max mode).',
    reload: 'next_job',
  },
  {
    key: 'routing.tackPenalty',
    group: 'routing',
    label: 'Tacking penalty',
    type: 'number',
    unit: 's',
    // EXCEPTION: shown and typed in seconds whatever the Signal K time preference says (public/rp-settings.js, the owner's decision 2026-10-08, until Signal K has a seconds category).
    quantity: 'seconds',
    min: 0,
    max: 3600,
    step: 5,
    default: 30,
    help: 'Time lost on every tack or gybe. Both routers charge it: a branch that tacks arrives later and ranks lower, so routes with needless tacks lose to straighter ones.',
    reload: 'next_job',
  },
  {
    key: 'routing.landBuffer',
    group: 'routing',
    label: 'Buffer from land',
    type: 'number',
    unit: 'm',
    quantity: 'short_distance',
    min: 0,
    max: 5000,
    step: 10,
    default: 0,
    help: 'The route keeps at least this far from the coastline: the search, the smoother and the final check all measure to the shoreline. A start or end closer than this is moved out to it; a passage narrower than twice this closes. 0 = none.',
    reload: 'next_job',
  },
  {
    key: 'routing.navigableBuffer',
    group: 'routing',
    label: 'Buffer from unusable water',
    type: 'number',
    unit: 'm',
    quantity: 'short_distance',
    min: 0,
    max: 5000,
    step: 10,
    default: 0,
    help: 'On a chart-mesh leg the route keeps at least this far from every bit of water the boat cannot use (charted depth under the draft, bridges under the air draft, rocks, marks, structures, areas to avoid). The mesh route and the sailed stretches both keep it. A passage narrower than twice this closes. 0 = none.',
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
    step: 1,
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
    step: KTS_TO_MS,
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
    step: 0.1,
    default: null,
    nullable: true,
    help: 'A leg is not allowed where the significant wave height is above this. Empty = no limit. Needs wave data in the forecast. A route request can override it.',
    reload: 'next_job',
  },
  {
    key: 'routing.maxWindMode',
    group: 'routing',
    label: 'Over the wind limit',
    type: 'enum',
    enum: LIMIT_MODES,
    default: 'block',
    help: "block: a leg is not allowed where the wind is above the maximum (the route goes round, or fails when it cannot). avoid: it is allowed, but each hour over the maximum counts extra in the search's choices (Avoid strength), and the route shows a warning on each leg that goes over. A route request can choose (max_wind_mode).",
    reload: 'next_job',
  },
  {
    key: 'routing.maxSwhMode',
    group: 'routing',
    label: 'Over the wave limit',
    type: 'enum',
    enum: LIMIT_MODES,
    default: 'block',
    help: "block: a leg is not allowed where the significant wave height is above the maximum (the route goes round, or fails when it cannot). avoid: it is allowed, but each hour over the maximum counts extra in the search's choices (Avoid strength), and the route shows a warning on each leg that goes over. A route request can choose (max_swh_mode).",
    reload: 'next_job',
  },
  {
    key: 'routing.limitAvoidStrength',
    group: 'routing',
    label: 'Avoid strength',
    type: 'number',
    min: 0,
    max: 10,
    step: 0.5,
    default: 1,
    help: "For a limit set to avoid: each hour over it counts as (1 + this) hours in the search's choices, however far over. 1 = time over a limit counts double; 0 = no cost, warnings only. The times shown stay the real times. A route request can override it (limit_avoid_strength).",
    reload: 'next_job',
  },
  {
    key: 'routing.comfortWeight',
    group: 'routing',
    label: 'Comfort weight',
    type: 'number',
    min: 0,
    max: 3,
    step: 0.1,
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
    step: 10,
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
    step: 1_000_000,
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
    step: 1,
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
    step: 0.01,
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
    key: 'routing.drawbridges',
    group: 'routing',
    label: 'Drawbridges',
    type: 'enum',
    enum: DRAWBRIDGE_CHOICES,
    default: 'ask',
    help: "Opening bridges on chart-mesh legs. ask: the route is planned as if they open, and when it passes under one the web app says so and offers to re-plan avoiding them. open: plan as if they open. avoid: never pass one. The chart's open clearance is checked against the air draft either way. A route request can choose (drawbridges).",
    reload: 'next_job',
  },
  {
    key: 'routing.bridgeWait',
    group: 'routing',
    label: 'Wait at a drawbridge',
    type: 'number',
    unit: 's',
    // EXCEPTION: shown and typed in seconds whatever the Signal K time preference says (public/rp-settings.js, the owner's decision 2026-10-08, until Signal K has a seconds category).
    quantity: 'seconds',
    min: 0,
    max: 7200,
    step: 30,
    default: 0,
    help: 'Time added at each opening bridge the route passes under, for the opening; everything after it is later by that much.',
    reload: 'next_job',
  },
  {
    key: 'routing.keepJobs',
    group: 'routing',
    label: 'Finished routes kept',
    type: 'integer',
    min: 1,
    max: 500,
    step: 1,
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

/** Two setting values are the same (lists element by element). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/**
 * The RTOFS product the old `currents.rtofsRegion` setting named, when it
 * was a choice: any product but west_atl, the old default, which a stored
 * file cannot tell from a choice (settings.json holds every value). That
 * product is loaded as an extra product; west_atl is loaded whenever the
 * vessel is inside it.
 */
function extraFromOldRegion(region: unknown): string | null {
  return typeof region === 'string' && region !== 'west_atl' && (RTOFS_REGIONS as readonly string[]).includes(region) ? region : null;
}

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
export function validateValue(spec: SettingSpec, raw: unknown): number | boolean | string | string[] | null {
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
    case 'enumList': {
      if (!Array.isArray(raw)) throw new Error(`must be a list of ${spec.enum!.join(', ')}`);
      for (const x of raw)
        if (typeof x !== 'string' || !spec.enum!.includes(x)) throw new Error(`must be a list of ${spec.enum!.join(', ')}`);
      return spec.enum!.filter(x => raw.includes(x));
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
        if (!sameValue(grp[k], v)) {
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

/**
 * Settings from a stored object, key by key; invalid or missing keys fall
 * back to defaults and are reported. `notes`: settings carried over from
 * one that no longer exists (the old RTOFS product).
 */
export function settingsFromStored(stored: unknown): { values: AppSettings; problems: string[]; notes: string[] } {
  const values = defaultSettings();
  const problems: string[] = [];
  const notes: string[] = [];
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
  // A settings.json from before the extra products: its one RTOFS product, when it was a choice, is loaded as one.
  const cur = obj.currents;
  const old = cur && typeof cur === 'object' && !('rtofsExtra' in cur) ? extraFromOldRegion(cur.rtofsRegion) : null;
  if (old) {
    values.currents.rtofsExtra = [old];
    notes.push(`currents.rtofsRegion ${old} is now an extra RTOFS product (currents.rtofsExtra)`);
  }
  return { values, problems, notes };
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
  // The one RTOFS product of earlier versions: a choice (any but west_atl, the default) is loaded as an extra product.
  const oldRaw = typeof c.rtofsRegion === 'string' ? c.rtofsRegion.trim() : c.rtofsRegion;
  const oldRegion = extraFromOldRegion(oldRaw);
  if (oldRegion) set(src.currents, 'rtofsExtra', [oldRegion]);
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
  if (oldRaw !== undefined && oldRaw !== null && oldRaw !== '' && !(RTOFS_REGIONS as readonly unknown[]).includes(oldRaw))
    skipped.push(`currents.rtofsRegion: ${String(oldRaw)} is not an RTOFS product`);
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
  load(legacy: LegacyPluginConfig | undefined): { created: boolean; migrated: string[]; problems: string[]; notes: string[] } {
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
        const { values, problems, notes } = settingsFromStored(parsed.values);
        this.current = values;
        return { created: false, migrated: [], problems, notes };
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
        notes: [],
      };
    }
    const m = migrateLegacy(legacy);
    this.current = m.values;
    this.write('plugin-config');
    return { created: true, migrated: m.migrated, problems: m.skipped, notes: [] };
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
    if (!s) continue;
    out.add(s.reload);
    for (const r of s.alsoReload ?? []) out.add(r);
  }
  return out;
}

/** GET /api/settings schema. */
export function settingsSchema(): { groups: typeof SETTINGS_GROUPS; settings: readonly SettingSpec[] } {
  return { groups: SETTINGS_GROUPS, settings: SETTINGS_SPEC };
}
