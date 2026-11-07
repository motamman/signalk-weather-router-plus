/**
 * Plugin configuration.
 *
 * Two sources, merged into one ResolvedConfig (SI in memory):
 *  - the Signal K plugin config (admin UI, CONFIG_SCHEMA below): only
 *    server / installation settings — file paths, the download mirror,
 *    Weather API registration and the map overlay cache;
 *  - the web-app settings (settings.ts, stored in the plugin data dir as
 *    settings.json, edited in the page's Defaults tab): vessel, forecast
 *    horizon and extras, currents, routing engine and publishing.
 *
 * Older versions kept everything in the plugin config; those keys are
 * described by LegacyPluginConfig and read once, to migrate them into
 * settings.json (settings.ts migrateLegacy). After that they are ignored.
 */

import type { DrawbridgeChoice } from '../engine/mesh/route';
import { DEFAULT_LIMIT_AVOID_STRENGTH, DEFAULT_LIMIT_MODE, type LimitMode } from '../engine/legsim';
import { makeVessel, type VesselParams } from '../vessel/vessel';
import type { RouterKind } from '../engine/router';
import { DEFAULT_MESH_CATALOG_URL } from './meshes';
import { HOUR_S } from '../geo/units';
import {
  ECMWF_MIRROR_LABELS,
  ECMWF_MIRRORS,
  ENSEMBLE_MEMBER_CHOICES,
  ENSEMBLE_MODELS,
  ENSEMBLES,
  type EcmwfMirror,
  type EnsembleModelId,
  isEcmwfMirror,
} from '../data/ecmwf';
import type { AppSettings } from './settings';
import type { RouteRequest } from './protocol';

/** What the Signal K plugin config holds now. */
export interface PluginConfig {
  landShapefiles?: string;
  polarSource?: 'auto' | 'files' | 'signalk';
  /** A chart navigation mesh folder you manage yourself (index.json and tiles); blank = none. */
  meshDir?: string;
  /** Managed meshes: the catalogue of published meshes and the names ticked for download (plugin/meshes.ts). */
  mesh?: {
    catalogUrl?: string;
    downloads?: string[];
    /** Downloaded meshes switched off for routing (kept on disk). */
    disabled?: string[];
    /** Names whose copy in `meshDir` is routed on even when a newer download exists (the panel's "my folder" choice). */
    preferLocal?: string[];
    /** Names whose downloaded copy is routed on even when the copy in `meshDir` is newer (the panel's "downloaded" choice). */
    preferDownload?: string[];
  };
  polarFile?: string;
  polarsDir?: string;
  forecast?: {
    mirror?: EcmwfMirror;
    /** Ensemble downloads (data/ecmwf.ts ENSEMBLES): off unless enabled. */
    ensemble?: {
      enabled?: boolean;
      /** The ensembles to download; at least one while enabled. */
      models?: string[];
      /** Members downloaded per ensemble, 5 to 50 in fives. */
      members?: number;
    };
  };
  currents?: {
    harmonicDir?: string;
  };
  weatherProvider?: {
    enabled?: boolean;
  };
  overlayCache?: {
    enabled?: boolean;
    /** m */
    radius?: number;
    /** s; 0 = the whole forecast */
    window?: number;
    maxZoom?: number;
    /** bytes */
    diskCap?: number;
    workers?: number;
    followView?: boolean;
  };
}

/** Plugin-config keys of earlier versions, read only by the settings migration. */
export interface LegacyPluginConfig {
  vessel?: {
    name?: string;
    motorSpeedKts?: number;
  };
  forecast?: {
    horizonHours?: number;
    refreshMinutes?: number;
    keepCycles?: number;
    extraFields?: boolean;
    energyFields?: boolean;
  };
  currents?: {
    rtofsEnabled?: boolean;
    rtofsRegion?: string;
    rtofsHorizonHours?: number;
    rtofsStepHours?: number;
  };
  routing?: {
    stages?: number;
    subsectors?: number;
    headings?: number;
    headingIncrementDeg?: number;
    sailThresholdKts?: number;
    simStepM?: number;
    landRasterMaxCells?: number;
    keepJobs?: number;
  };
  publish?: {
    toResources?: boolean;
    routeNamePrefix?: string;
    notifications?: boolean;
  };
}

export interface ResolvedConfig {
  landShapefiles: string[];
  polarSource: 'auto' | 'files' | 'signalk';
  /** A mesh folder managed by hand, or null. */
  meshDir: string | null;
  /** Managed meshes: catalogue URL, the names ticked, and the store directory the copies live in. */
  mesh: { catalogUrl: string; downloads: string[]; disabled: string[]; preferLocal: string[]; preferDownload: string[]; storeDir: string };
  polarFile: string | null;
  polarsDir: string | null;
  /** Where user polars are kept and generated ones written (see polars.ts PolarLibraryConfig.userDir). */
  polarUserDir: string | null;
  vessel: VesselParams;
  forecast: {
    /** Forecast horizon, seconds. */
    horizonS: number;
    /** Forecast refresh interval, seconds. */
    refreshIntervalS: number;
    mirror: EcmwfMirror;
    keepCycles: number;
    /** Also fetch 2t, tprate, skt, 2d, ptype, tcc, 10fg (temperature, precipitation, SST, humidity, precip type, cloud cover, gust). */
    extraFields: boolean;
    /** Also fetch tp, ssrd, sf, strd, str, mucape (precipitation depth, solar and thermal radiation, snowfall, convective instability), for energy modelling. */
    energyFields: boolean;
    /** Memory guard: bytes that must remain free after a forecast load. */
    memoryHeadroomBytes: number;
    /** signalk-grib-downloader's folder; empty = find it. */
    regionalGribs: string;
    /**
     * The ensembles downloaded beside the main forecast, after it, and how many members of each (members 1 to N, and
     * the control where one is published); null = off: nothing downloaded, nothing shown, and nothing of the
     * setting read or checked.
     */
    ensemble: { models: EnsembleModelId[]; members: number } | null;
  };
  currents: {
    harmonicDir: string | null;
    smocEnabled: boolean;
    smocHorizonS: number;
    smocStepS: number;
    smocHalfWidthDeg: number;
    rtofsEnabled: boolean;
    /** Products loaded wherever the vessel is, besides the one that contains it (RTOFS_REGIONS order). */
    rtofsExtra: string[];
    rtofsHorizonS: number;
    rtofsStepS: number;
  };
  tides: {
    /** Copernicus Marine hourly sea level (tide height, water level, surge; tide map layer). */
    enabled: boolean;
    halfWidthDeg: number;
    horizonS: number;
  };
  routing: {
    stages: number;
    subsectors: number;
    headings: number;
    headingIncrementDeg: number;
    sailThreshMs: number;
    /** Seconds lost per tack or gybe. */
    tackPenaltyS: number;
    /** Buffer from unusable water on mesh legs, metres (0 = none). */
    navigableBufferM: number;
    /** Buffer from the coastline, metres (0 = none). */
    landBufferM: number;
    drawbridges: DrawbridgeChoice;
    bridgeWaitS: number;
    /** Polar rows closer to the wind than this many degrees are ignored (0 = as written). */
    noGoMinAngleDeg: number;
    maxWindMs: number | null;
    maxSwhM: number | null;
    maxWindMode: LimitMode;
    maxSwhMode: LimitMode;
    limitAvoidStrength: number;
    comfortWeight: number;
    simStepM: number;
    landRasterMaxCells: number;
    /** Open the known canals' edges in the global water grid. */
    allowCanals: boolean;
    simplifyM: number;
    smoother: boolean;
    smootherTolerance: number;
    /** Open-water router by default (engine/router.ts). */
    router: RouterKind;
    keepJobs: number;
  };
  publish: {
    toResources: boolean;
    routeNamePrefix: string;
    notifications: boolean;
  };
  weatherProvider: {
    enabled: boolean;
  };
  /** Map overlay tiles saved on disk and built ahead of time (tiles.ts, prebuild.ts). SI. */
  overlayCache: {
    enabled: boolean;
    radiusM: number;
    /** Seconds ahead built; null = the whole forecast. */
    windowS: number | null;
    maxZoom: number;
    diskCapBytes: number;
    workers: number;
    followView: boolean;
  };
}

/** Overlay cache defaults (SI). */
export const OVERLAY_CACHE_DEFAULTS = {
  enabled: true,
  radius: 250_000,
  window: 0,
  maxZoom: 15,
  diskCap: 20e9,
  workers: 2,
  followView: true,
} as const;

export const MIRRORS = Object.keys(ECMWF_MIRRORS) as EcmwfMirror[];

/** The mirror when the config names none: the schema, resolveConfig and the configuration panel (via the status) read it. */
export const DEFAULT_MIRROR: EcmwfMirror = 'ecmwf';

/**
 * What one member of each ensemble costs, at 72 h, from the test box (Pi 5): downloaded per cycle (2026-11-05: 5 IFS
 * ENS members took 350,757,112 B; AIFS ENS's control and 5 members 206,788,659 B; arithmetic per member) and on disk
 * (du -sb, the 06Z run of 2026-11-06). Both were measured with the five required fields; an IFS ENS member now holds
 * mp2 as a sixth (ecmwf.ts ENSEMBLE_OPTIONAL_PARAMS), so its figures are arithmetic: the download plus one mp2 message
 * a step at the main forecast's measured size (440,100 B, the 05 Nov 18Z run at +24 h, from its .index; 25 steps at
 * 72 h), the disk six fifths exactly (every decoded field is the same global float32 grid). AIFS ENS publishes no
 * mp2: its figures stand.
 */
export const ENSEMBLE_MEMBER_COST = {
  /** The forecast horizon the figures are for (hours): every page that shows them names it, as a longer horizon costs more in proportion. */
  horizonHours: 72,
  downloadBytes: { 'ifs-ens': 350_757_112 / 5 + 25 * 440_100, 'aifs-ens': 206_788_659 / 6 } satisfies Record<EnsembleModelId, number>,
  diskBytes: { 'ifs-ens': (519_126_603 * 6) / 5, 'aifs-ens': 269_947_987 } satisfies Record<EnsembleModelId, number>,
};

/** What the ensemble downloads cost and do, for the plugin config's schema and the configuration pages (configChoices). */
export const ENSEMBLE_DOWNLOAD_NOTE =
  "Also download ECMWF ensembles, each cycle after the forecast (wind and waves, to the forecast's horizon), so Find Route " +
  `can compute the route on each member's forecast as well: where each member's route goes and when it arrives. At ${ENSEMBLE_MEMBER_COST.horizonHours} h, ` +
  `per member and cycle: an IFS ENS member about ${Math.round(ENSEMBLE_MEMBER_COST.downloadBytes['ifs-ens'] / 1e6)} MB downloaded and ` +
  `${Math.round(ENSEMBLE_MEMBER_COST.diskBytes['ifs-ens'] / 1e6)} MB on disk (arithmetic from the test box's measures with five fields, ` +
  "2026-11-05 and 2026-11-06, plus its sixth field, the wave period mp2, at the main forecast's measured message size), an AIFS ENS member about " +
  `${Math.round(ENSEMBLE_MEMBER_COST.downloadBytes['aifs-ens'] / 1e6)} MB downloaded and ${Math.round(ENSEMBLE_MEMBER_COST.diskBytes['aifs-ens'] / 1e6)} MB on disk ` +
  '(measured on the test box, Pi 5, 2026-11-05 and 2026-11-06).';

/** The ensemble downloads when the config says nothing: off; on, IFS ENS with 5 members. The schema and resolveEnsemble read these. */
export const ENSEMBLE_DEFAULTS: { enabled: boolean; models: EnsembleModelId[]; members: number } = {
  enabled: false,
  models: ['ifs-ens'],
  members: 5,
};

export const CONFIG_SCHEMA = {
  type: 'object',
  description:
    'Server and installation settings only. Vessel, forecast horizon, currents, routing and publishing are set in the ' +
    'web app (Weather Router Plus → Defaults tab) and shared by every client.',
  properties: {
    landShapefiles: {
      type: 'string',
      title: 'Coastline shapefile(s)',
      description:
        'Absolute path(s) to polygon land shapefiles, comma-separated. Blank: GSHHG 2.3.7 full-resolution levels 1–4 are downloaded once ' +
        '(149 MB from www.soest.hawaii.edu) into the plugin data directory and used. A GSHHS layer path requires all four sibling levels. Add GSHHS_f_L6.shp for Antarctica.',
    },
    mesh: {
      type: 'object',
      title: 'Chart meshes',
      properties: {
        catalogUrl: {
          type: 'string',
          title: 'Mesh catalogue URL',
          description:
            'The index.json listing the published meshes (the s57Work build writes charts/mesh/index.json). Blank = the US-ENC catalogue on R2.',
        },
        downloads: {
          type: 'array',
          title: 'Meshes to download',
          description:
            'Names from the catalogue (01CGD, 07CGD, …); each is mirrored into the plugin data directory and kept current. An unticked mesh is deleted.',
          items: { type: 'string' },
        },
        disabled: {
          type: 'array',
          title: 'Downloaded meshes not used for routing',
          description: 'Names of downloaded meshes switched off (kept on disk, not opened by the router).',
          items: { type: 'string' },
        },
        preferLocal: {
          type: 'array',
          title: 'Meshes routed on from your own folder',
          description:
            'Names that exist both as a download and in your mesh folder, where the router uses your copy whatever the dates. Unlisted in both lists: the newer build.',
          items: { type: 'string' },
        },
        preferDownload: {
          type: 'array',
          title: 'Meshes routed on from the download',
          description:
            'Names that exist both as a download and in your mesh folder, where the router uses the download whatever the dates.',
          items: { type: 'string' },
        },
      },
    },
    meshDir: {
      type: 'string',
      title: 'Chart mesh directory (your own)',
      description:
        'A navigation mesh folder you manage yourself (index.json and its tiles), used beside the downloaded ones. Where a mesh covers a leg, and the vessel draught and air draft are set ' +
        '(Signal K vessel base data), the leg is routed on the mesh: charted depths, bridge clearances, rocks, wrecks, marks and structures avoided. Blank = none.',
    },
    polarSource: {
      type: 'string',
      title: 'Polar source',
      enum: ['auto', 'files', 'signalk'],
      default: 'auto',
      description:
        'auto detects the active Polar Management polar with local fallback. files prefers the internal default. signalk is retained as an alias for auto. Local polars remain available as overrides.',
    },
    polarFile: {
      type: 'string',
      title: 'Default polar file (.csv or .pol)',
      description: 'Boat speed table in knots. Blank = the bundled Catalina 36 polar.',
    },
    polarsDir: {
      type: 'string',
      title: 'Polar library directory',
      description:
        "Directory of .pol/.csv polars offered in the web app's vessel picker. Blank = the ~700 polars bundled with the plugin " +
        '(weather_routing_pi library, GPL-3.0); polars you generate are then kept in the plugin data directory.',
    },
    currents: {
      type: 'object',
      title: 'Currents',
      properties: {
        harmonicDir: {
          type: 'string',
          title: 'Tidal harmonics directory (.npz)',
          description: 'Directory of FES2014 / NECOFS .npz extracts; every *.npz in it is loaded.',
        },
      },
    },
    forecast: {
      type: 'object',
      title: 'Forecast download',
      properties: {
        mirror: { type: 'string', title: 'ECMWF open-data mirror', enum: [...MIRRORS], default: DEFAULT_MIRROR },
        ensemble: {
          type: 'object',
          title: 'Ensemble downloads',
          description: ENSEMBLE_DOWNLOAD_NOTE,
          properties: {
            enabled: { type: 'boolean', title: 'Download ensembles', default: ENSEMBLE_DEFAULTS.enabled },
            models: {
              type: 'array',
              title: 'Ensembles',
              items: { type: 'string', enum: [...ENSEMBLE_MODELS], enumNames: ENSEMBLE_MODELS.map(m => ENSEMBLES[m].name) },
              uniqueItems: true,
              minItems: 1,
              default: ENSEMBLE_DEFAULTS.models,
            },
            members: {
              type: 'integer',
              title: 'Members per ensemble',
              enum: [...ENSEMBLE_MEMBER_CHOICES],
              default: ENSEMBLE_DEFAULTS.members,
            },
          },
        },
      },
    },
    weatherProvider: {
      type: 'object',
      title: 'Weather API',
      properties: {
        enabled: { type: 'boolean', title: 'Register as a Signal K Weather API provider', default: true },
      },
    },
    overlayCache: {
      type: 'object',
      title: 'Map overlay cache',
      description:
        'Map overlay tiles (colour layers, wind barbs, current arrows, coastline) are saved on disk and answered without waiting for the ' +
        'data worker. Tiles around the boat, and around the area the map shows, are built ahead of time for every hour of the window: ' +
        'the full radius down to zoom 8, half the radius at each deeper zoom. Values are SI (metres, seconds, bytes).',
      properties: {
        enabled: { type: 'boolean', title: 'Build tiles ahead of time', default: OVERLAY_CACHE_DEFAULTS.enabled },
        radius: {
          type: 'number',
          title: 'Radius (m)',
          description: 'Around the boat and the map view, at zoom 8 and below; halved at each deeper zoom.',
          default: OVERLAY_CACHE_DEFAULTS.radius,
          minimum: 1000,
          maximum: 2_000_000,
        },
        window: {
          type: 'number',
          title: 'Window (s)',
          description: 'How far ahead tiles are built, from now. 0 = the whole forecast.',
          default: OVERLAY_CACHE_DEFAULTS.window,
          minimum: 0,
          maximum: 360 * HOUR_S,
        },
        maxZoom: {
          type: 'integer',
          title: 'Deepest zoom built ahead',
          default: OVERLAY_CACHE_DEFAULTS.maxZoom,
          minimum: 6,
          maximum: 18,
        },
        diskCap: {
          type: 'number',
          title: 'Disk cap (bytes)',
          description: 'Least recently used tiles are removed above this. 20e9 = 20 GB.',
          default: OVERLAY_CACHE_DEFAULTS.diskCap,
          minimum: 100e6,
        },
        workers: {
          type: 'integer',
          title: 'Build workers',
          description: 'Threads building tiles ahead of time, at lower priority than the map and routes.',
          default: OVERLAY_CACHE_DEFAULTS.workers,
          minimum: 1,
          maximum: 8,
        },
        followView: {
          type: 'boolean',
          title: 'Also build around the area the map shows',
          default: OVERLAY_CACHE_DEFAULTS.followView,
        },
      },
    },
  },
};

function cacheNumber(v: unknown, def: number, min: number, max: number, name: string, integer = false): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    throw new Error(`config overlayCache.${name}: ${String(v)} is not ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  return n;
}

/** What the plugin config offers, for the pages that set it: the mirrors, the ensembles, the member counts, the defaults. */
export function configChoices(): {
  mirrors: { id: EcmwfMirror; label: string }[];
  mirror_default: EcmwfMirror;
  ensembles: { id: EnsembleModelId; name: string }[];
  ensemble_members: readonly number[];
  ensemble_defaults: typeof ENSEMBLE_DEFAULTS;
  ensemble_note: string;
} {
  return {
    mirrors: MIRRORS.map(id => ({ id, label: ECMWF_MIRROR_LABELS[id] })),
    mirror_default: DEFAULT_MIRROR,
    ensembles: ENSEMBLE_MODELS.map(id => ({ id, name: ENSEMBLES[id].name })),
    ensemble_members: ENSEMBLE_MEMBER_CHOICES,
    ensemble_defaults: ENSEMBLE_DEFAULTS,
    ensemble_note: ENSEMBLE_DOWNLOAD_NOTE,
  };
}

/** Why `members` is not a member count this plugin offers (ENSEMBLE_MEMBER_CHOICES), or null. */
export function ensembleMembersProblem(members: number): string | null {
  return (ENSEMBLE_MEMBER_CHOICES as readonly number[]).includes(members)
    ? null
    : `${String(members)} is not one of ${ENSEMBLE_MEMBER_CHOICES.join(', ')}`;
}

/**
 * Why `models` are not ensembles this plugin downloads, or null: not a list (the options file is edited by hand, and
 * its type is only the compiler's), or the first entry that is not one of them.
 */
export function ensembleModelsProblem(models: unknown): string | null {
  if (!Array.isArray(models)) return `${JSON.stringify(models)} is not a list of ensembles (${ENSEMBLE_MODELS.join(', ')})`;
  const bad = models.find(m => !(ENSEMBLE_MODELS as readonly unknown[]).includes(m));
  return bad === undefined ? null : `${bad} is not one of ${ENSEMBLE_MODELS.join(', ')}`;
}

/**
 * The ensemble downloads from the plugin config: null (off) unless enabled, and then nothing else of the setting is
 * read or checked (a feature that is off changes nothing, a start-up included); enabled needs a member count on the
 * list and at least one known ensemble.
 */
export function resolveEnsemble(e: NonNullable<PluginConfig['forecast']>['ensemble']): ResolvedConfig['forecast']['ensemble'] {
  if (!(e?.enabled ?? ENSEMBLE_DEFAULTS.enabled)) return null;
  const members = e?.members ?? ENSEMBLE_DEFAULTS.members;
  const badCount = ensembleMembersProblem(members);
  if (badCount) throw new Error(`config forecast.ensemble.members: ${badCount}`);
  const models = e?.models ?? ENSEMBLE_DEFAULTS.models;
  const problem = ensembleModelsProblem(models);
  if (problem) throw new Error(`config forecast.ensemble.models: ${problem}`);
  if (models.length === 0)
    throw new Error(
      'config forecast.ensemble: ensemble downloads are on but no ensemble is selected; select at least one, or turn them off'
    );
  return { models: [...new Set(models)] as EnsembleModelId[], members };
}

/**
 * Merge the plugin config (installation) with the web-app settings (SI)
 * into the engine's ResolvedConfig. `settings` must already be valid
 * (SettingsStore validates on load and on every update).
 */
export function resolveConfig(raw: PluginConfig | undefined, settings: AppSettings): ResolvedConfig {
  const c = raw ?? {};
  const land = (c.landShapefiles ?? '')
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);
  const mirror = c.forecast?.mirror ?? DEFAULT_MIRROR;
  if (!isEcmwfMirror(mirror)) throw new Error(`config forecast.mirror: ${String(mirror)} is not one of ${MIRRORS.join(', ')}`);
  if (c.polarSource !== undefined && c.polarSource !== 'auto' && c.polarSource !== 'files' && c.polarSource !== 'signalk')
    throw new Error('config polarSource: expected auto, files or signalk');
  const harmonicDir = c.currents?.harmonicDir;
  const ensemble = resolveEnsemble(c.forecast?.ensemble);
  const v = settings.vessel;
  const f = settings.forecast;
  const cu = settings.currents;
  const r = settings.routing;
  const p = settings.publish;
  return {
    polarSource: c.polarSource ?? 'auto',
    landShapefiles: land,
    meshDir: c.meshDir && c.meshDir.trim() ? c.meshDir.trim() : null,
    mesh: {
      catalogUrl: c.mesh?.catalogUrl && c.mesh.catalogUrl.trim() ? c.mesh.catalogUrl.trim() : DEFAULT_MESH_CATALOG_URL,
      downloads: Array.isArray(c.mesh?.downloads) ? c.mesh.downloads.map(s => String(s).trim()).filter(Boolean) : [],
      disabled: Array.isArray(c.mesh?.disabled) ? c.mesh.disabled.map(s => String(s).trim()).filter(Boolean) : [],
      preferLocal: Array.isArray(c.mesh?.preferLocal) ? c.mesh.preferLocal.map(s => String(s).trim()).filter(Boolean) : [],
      preferDownload: Array.isArray(c.mesh?.preferDownload) ? c.mesh.preferDownload.map(s => String(s).trim()).filter(Boolean) : [],
      storeDir: '', // set by the plugin (index.ts resolve) from its data directory
    },
    polarFile: c.polarFile && c.polarFile.trim() ? c.polarFile.trim() : null,
    polarsDir: c.polarsDir && c.polarsDir.trim() ? c.polarsDir.trim() : null,
    polarUserDir: null,
    vessel: makeVessel({
      motorSpeedMs: v.motorSpeed,
      polarPerformance: v.polarPerformance,
      underKeelClearanceM: v.underKeelClearance,
      overheadClearanceM: v.overheadClearance,
    }),
    forecast: {
      horizonS: f.horizon,
      refreshIntervalS: f.refreshInterval,
      mirror,
      keepCycles: f.keepCycles,
      extraFields: f.extraFields,
      energyFields: f.energyFields,
      memoryHeadroomBytes: f.memoryHeadroom,
      regionalGribs: f.regionalGribs ?? '',
      ensemble,
    },
    currents: {
      harmonicDir: harmonicDir && harmonicDir.trim() ? harmonicDir.trim() : null,
      smocEnabled: cu.smocEnabled,
      // One horizon for every source (the owner's decision, 2026-10-22): each reaches the forecast's, or the end of
      // its own data when that comes first (SMOC's run, RTOFS's last file, the tide run).
      smocHorizonS: f.horizon,
      smocStepS: cu.smocStep,
      smocHalfWidthDeg: cu.smocHalfWidth,
      rtofsEnabled: cu.rtofsEnabled,
      rtofsExtra: [...cu.rtofsExtra],
      rtofsHorizonS: f.horizon,
      rtofsStepS: cu.rtofsStep,
    },
    tides: {
      enabled: settings.tides.enabled,
      halfWidthDeg: settings.tides.halfWidth,
      horizonS: f.horizon,
    },
    routing: {
      stages: r.stages,
      subsectors: r.subsectors,
      headings: r.headings,
      headingIncrementDeg: r.headingIncrement,
      sailThreshMs: r.sailThreshold,
      tackPenaltyS: r.tackPenalty ?? 30,
      navigableBufferM: r.navigableBuffer ?? 0,
      landBufferM: r.landBuffer ?? 0,
      drawbridges: r.drawbridges ?? 'ask',
      bridgeWaitS: r.bridgeWait ?? 0,
      noGoMinAngleDeg: r.noGoMinAngle ?? 0,
      maxWindMs: r.maxWind ?? null,
      maxSwhM: r.maxSwh ?? null,
      maxWindMode: r.maxWindMode ?? DEFAULT_LIMIT_MODE,
      maxSwhMode: r.maxSwhMode ?? DEFAULT_LIMIT_MODE,
      limitAvoidStrength: r.limitAvoidStrength ?? DEFAULT_LIMIT_AVOID_STRENGTH,
      comfortWeight: r.comfortWeight ?? 0,
      simStepM: r.simStep,
      landRasterMaxCells: r.landRasterMaxCells,
      allowCanals: r.allowCanals,
      simplifyM: r.simplify,
      smoother: r.smoother,
      smootherTolerance: r.smootherTolerance,
      router: r.router,
      keepJobs: r.keepJobs,
    },
    publish: {
      toResources: p.toResources,
      routeNamePrefix: p.routeNamePrefix,
      notifications: p.notifications,
    },
    weatherProvider: {
      enabled: c.weatherProvider?.enabled ?? true,
    },
    overlayCache: (() => {
      const o = c.overlayCache ?? {};
      const d = OVERLAY_CACHE_DEFAULTS;
      const windowS = cacheNumber(o.window, d.window, 0, 360 * HOUR_S, 'window');
      return {
        enabled: o.enabled ?? d.enabled,
        radiusM: cacheNumber(o.radius, d.radius, 1000, 2_000_000, 'radius'),
        windowS: windowS > 0 ? windowS : null,
        maxZoom: cacheNumber(o.maxZoom, d.maxZoom, 6, 18, 'maxZoom', true),
        diskCapBytes: cacheNumber(o.diskCap, d.diskCap, 100e6, Number.MAX_SAFE_INTEGER, 'diskCap'),
        workers: cacheNumber(o.workers, d.workers, 1, 8, 'workers', true),
        followView: o.followView ?? d.followView,
      };
    })(),
  };
}

/** Do two configs load the same CMEMS SMOC (on, step, horizon, area)? A currents reload then keeps it. */
export function smocLoadSame(a: ResolvedConfig, b: ResolvedConfig): boolean {
  const x = a.currents;
  const y = b.currents;
  return (
    x.smocEnabled === y.smocEnabled &&
    x.smocStepS === y.smocStepS &&
    x.smocHorizonS === y.smocHorizonS &&
    x.smocHalfWidthDeg === y.smocHalfWidthDeg
  );
}

/**
 * Do two configs load each RTOFS product the same way (on in both, same
 * horizon and step)? A currents reload then keeps the products loaded; the
 * refresh adds or drops products only.
 */
export function rtofsLoadSame(a: ResolvedConfig, b: ResolvedConfig): boolean {
  const x = a.currents;
  const y = b.currents;
  return x.rtofsEnabled && y.rtofsEnabled && x.rtofsHorizonS === y.rtofsHorizonS && x.rtofsStepS === y.rtofsStepS;
}

/** Draught and air draft as Signal K's vessel base data has them (design.draft.maximum, design.airHeight), null when unset. */
export interface SelfDesign {
  draughtM: number | null;
  airDraftM: number | null;
}

/**
 * A vessel dimension from Signal K self-data (`design.draft.maximum`,
 * `design.airHeight`): the raw value or its `{value}` wrapper, a `key`
 * inside it when given, a finite number within `range`; anything else is
 * null (unknown). The bounds are makeVessel's, so a value Signal K reports
 * in the wrong unit disables the chart mesh instead of failing every route.
 */
export function selfDesignValue(raw: unknown, key: string | undefined, range: readonly [number, number]): number | null {
  let v = raw && typeof raw === 'object' && 'value' in raw ? (raw as { value: unknown }).value : raw;
  if (key && v && typeof v === 'object') v = (v as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= range[0] && v <= range[1] ? v : null;
}

/**
 * The vessel for one route: values in the request take precedence; the
 * rest come from the vessel settings (never the built-in defaults), and
 * the draught and air draft from Signal K's vessel base data (like the
 * name: not plugin settings).
 */
export function routeVessel(cfg: ResolvedConfig, rv: RouteRequest['vessel'], self?: SelfDesign): VesselParams {
  return makeVessel({
    ...cfg.vessel,
    motorSpeedMs: rv?.motor_speed_ms ?? cfg.vessel.motorSpeedMs,
    polarPerformance: rv?.polar_performance ?? cfg.vessel.polarPerformance,
    draughtM: rv?.draught_m ?? self?.draughtM ?? null,
    airDraftM: rv?.air_draft_m ?? self?.airDraftM ?? null,
    underKeelClearanceM: rv?.under_keel_clearance_m ?? cfg.vessel.underKeelClearanceM,
    overheadClearanceM: rv?.overhead_clearance_m ?? cfg.vessel.overheadClearanceM,
  });
}
