/**
 * Plugin configuration.
 *
 * Two sources, merged into one ResolvedConfig (SI in memory):
 *  - the Signal K plugin config (admin UI, CONFIG_SCHEMA below): only
 *    server / installation settings — file paths, the download mirror,
 *    Weather API registration and the map overlay cache;
 *  - the web-app settings (settings.ts, stored in the plugin data dir as
 *    settings.json, edited in the page's Settings tab): vessel, forecast
 *    horizon and extras, currents, routing engine and publishing.
 *
 * Older versions kept everything in the plugin config; those keys are
 * described by LegacyPluginConfig and read once, to migrate them into
 * settings.json (settings.ts migrateLegacy). After that they are ignored.
 */

import { makeVessel, type VesselParams } from '../vessel/vessel';
import { HOUR_S } from '../geo/units';
import type { AppSettings } from './settings';
import type { RouteRequest } from './protocol';

/** What the Signal K plugin config holds now. */
export interface PluginConfig {
  landShapefiles?: string;
  polarFile?: string;
  polarsDir?: string;
  forecast?: {
    mirror?: 'ecmwf' | 'aws' | 'google';
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
    mirror: 'ecmwf' | 'aws' | 'google';
    keepCycles: number;
    /** Also fetch 2t, tprate, skt, 2d, ptype, tcc, 10fg (temperature, precipitation, SST, humidity, precip type, cloud cover, gust). */
    extraFields: boolean;
    /** Also fetch tp, ssrd, sf, strd, str, mucape (precipitation depth, solar and thermal radiation, snowfall, convective instability), for energy modelling. */
    energyFields: boolean;
    /** Memory guard: bytes that must remain free after a forecast load. */
    memoryHeadroomBytes: number;
    /** signalk-grib-downloader's folder; empty = find it. */
    regionalGribs: string;
  };
  currents: {
    harmonicDir: string | null;
    smocEnabled: boolean;
    smocHorizonS: number;
    smocStepS: number;
    smocHalfWidthDeg: number;
    rtofsEnabled: boolean;
    rtofsRegion: string;
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
    /** Polar rows closer to the wind than this many degrees are ignored (0 = as written). */
    noGoMinAngleDeg: number;
    maxWindMs: number | null;
    maxSwhM: number | null;
    comfortWeight: number;
    simStepM: number;
    landRasterMaxCells: number;
    /** Open the known canals' edges in the global water grid. */
    allowCanals: boolean;
    simplifyM: number;
    smoother: boolean;
    smootherTolerance: number;
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

export const MIRRORS = ['ecmwf', 'aws', 'google'] as const;

export const CONFIG_SCHEMA = {
  type: 'object',
  description:
    'Server and installation settings only. Vessel, forecast horizon, currents, routing and publishing are set in the ' +
    'web app (Weather Router Plus → Settings tab) and shared by every client.',
  properties: {
    landShapefiles: {
      type: 'string',
      title: 'Coastline shapefile(s)',
      description:
        'Absolute path(s) to polygon land shapefiles, comma-separated. Blank: GSHHG 2.3.7 full-resolution levels 1–4 are downloaded once ' +
        '(149 MB from www.soest.hawaii.edu) into the plugin data directory and used. A GSHHS layer path requires all four sibling levels. Add GSHHS_f_L6.shp for Antarctica.',
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
        mirror: { type: 'string', title: 'ECMWF open-data mirror', enum: [...MIRRORS], default: 'ecmwf' },
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
  const mirror = c.forecast?.mirror ?? 'ecmwf';
  if (!(MIRRORS as readonly string[]).includes(mirror))
    throw new Error(`config forecast.mirror: ${String(mirror)} is not one of ${MIRRORS.join(', ')}`);
  const harmonicDir = c.currents?.harmonicDir;
  const v = settings.vessel;
  const f = settings.forecast;
  const cu = settings.currents;
  const r = settings.routing;
  const p = settings.publish;
  return {
    landShapefiles: land,
    polarFile: c.polarFile && c.polarFile.trim() ? c.polarFile.trim() : null,
    polarsDir: c.polarsDir && c.polarsDir.trim() ? c.polarsDir.trim() : null,
    polarUserDir: null,
    vessel: makeVessel({
      motorSpeedMs: v.motorSpeed,
      polarPerformance: v.polarPerformance,
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
    },
    currents: {
      harmonicDir: harmonicDir && harmonicDir.trim() ? harmonicDir.trim() : null,
      smocEnabled: cu.smocEnabled,
      smocHorizonS: cu.smocHorizon,
      smocStepS: cu.smocStep,
      smocHalfWidthDeg: cu.smocHalfWidth,
      rtofsEnabled: cu.rtofsEnabled,
      rtofsRegion: cu.rtofsRegion,
      rtofsHorizonS: cu.rtofsHorizon,
      rtofsStepS: cu.rtofsStep,
    },
    tides: {
      enabled: settings.tides.enabled,
      halfWidthDeg: settings.tides.halfWidth,
      horizonS: settings.tides.horizon,
    },
    routing: {
      stages: r.stages,
      subsectors: r.subsectors,
      headings: r.headings,
      headingIncrementDeg: r.headingIncrement,
      sailThreshMs: r.sailThreshold,
      noGoMinAngleDeg: r.noGoMinAngle ?? 0,
      maxWindMs: r.maxWind ?? null,
      maxSwhM: r.maxSwh ?? null,
      comfortWeight: r.comfortWeight ?? 0,
      simStepM: r.simStep,
      landRasterMaxCells: r.landRasterMaxCells,
      allowCanals: r.allowCanals,
      simplifyM: r.simplify,
      smoother: r.smoother,
      smootherTolerance: r.smootherTolerance,
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

/**
 * The vessel for one route: values in the request take precedence; the
 * rest come from the vessel settings (never the built-in defaults).
 */
export function routeVessel(cfg: ResolvedConfig, rv: RouteRequest['vessel']): VesselParams {
  return makeVessel({
    ...cfg.vessel,
    motorSpeedMs: rv?.motor_speed_ms ?? cfg.vessel.motorSpeedMs,
    polarPerformance: rv?.polar_performance ?? cfg.vessel.polarPerformance,
  });
}
