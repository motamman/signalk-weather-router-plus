/**
 * Message protocol between the plugin (main thread) and its two
 * workers. Both workers run the same code; `role` decides what they do:
 *  - `data`: decodes each new forecast run to disk (decoded.ts), holds
 *    the current sources and the on-demand overlay land masks; answers
 *    overlay / conditions / Weather API queries by reading what each
 *    needs from the decoded run; refreshes from the network.
 *  - `route`: computes routes, so a running route never blocks an
 *    overlay query. Before a route it reads the route area of the
 *    decoded run (whose location the main thread relays) into a store it
 *    drops when the route ends. Current sources are its own copies,
 *    loaded from the disk cache (never the network).
 * No thread keeps the decoded forecast in memory.
 * Everything crossing the boundary is structured-cloneable.
 */

import type { AvoidArea } from '../geo/avoid';
import type { ResolvedConfig, SelfDesign } from './config';
import type { ModePolicy } from '../engine/legsim';
import type { RouterKind } from '../engine/router';
import type { BBox } from '../geo/geodesy';
import type { DecodedIndex } from '../data/decoded';
import type { SerializedSmoc, SmocStatus } from '../currents/smoc';
import type { SerializedRtofs } from '../currents/rtofs';
import type { SerializedHarmonic } from '../currents/harmonic';
import type { TideStatus } from '../tides/sealevel';
import type { ArcoRun } from '../data/arco';

/** data: forecast, currents, map queries; route: the engine; tiles: builds map tiles ahead of time (prebuild.ts). */
export type WorkerRole = 'data' | 'route' | 'tiles';

export interface VesselPosition {
  lat: number;
  lon: number;
}

export interface RouteRequest {
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
  /**
   * Intermediate waypoints; each ends one leg and starts the next.
   * radius_m overrides arrival_radius_m for that waypoint (approximate).
   */
  waypoints?: { lat: number; lon: number; radius_m?: number }[];
  /** "precise" (default): each leg ends exactly on its waypoint; "approximate": one search through the waypoint circles. */
  precision?: 'precise' | 'approximate';
  /** Waypoint circle radius in approximate mode, metres (default 200, 0..5000, > 0 when approximate). */
  arrival_radius_m?: number;
  departure?: string;
  mode?: ModePolicy;
  sail_thresh_ms?: number;
  /** Wind speed (m/s) and significant wave height (m) a leg must not exceed; default from routing.maxWind / routing.maxSwh. */
  max_wind_ms?: number;
  max_swh_m?: number;
  /** Comfort weight, 0–3 (0 = off); overrides routing.comfortWeight. */
  comfort_weight?: number;
  /** RDP simplification tolerance, metres (0 = off); default from routing.simplify. */
  simplify_m?: number;
  /** Run the shortcut smoother; default from routing.smoother. */
  smoother?: boolean;
  /** Smoother time tolerance, ratio; default from routing.smootherTolerance. */
  smoother_tolerance?: number;
  name?: string;
  stages?: number;
  no_forecast?: boolean;
  no_currents?: boolean;
  /** auto (default): regional wind layered over ECMWF where available; ecmwf: ECMWF only. */
  wind_model?: 'auto' | 'ecmwf';
  /** Open-water router: the isochrone search, or the experimental pathway (engine/experimental); default from the routing.router setting. */
  router?: RouterKind;
  /** Treat the areas marked on Signal K notes (properties.avoid.radius_m) as land (default true). */
  avoid_areas?: boolean;
  publish?: boolean;
  vessel?: {
    name?: string;
    motor_speed_ms?: number;
    /** Share of the polar's boat speeds achieved under sail, ratio 0.3..1.2 (default from settings). */
    polar_performance?: number;
    /** Polar token from GET /api/polars (`default` or a library file name). */
    polar?: string;
    /** Draught, m (default: Signal K design.draft.maximum); with the air draft, enables the chart mesh for motoring legs. */
    draught_m?: number;
    /** Air draft, m (default: Signal K design.airHeight). */
    air_draft_m?: number;
  };
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
  time: string;
  stage: number;
  total: number;
  message: string;
}

export interface RouteSummary {
  total_distance_m: number;
  total_time_s: number;
  sailing_time_s: number;
  motoring_time_s: number;
  waypoint_count: number;
  warnings: number;
  departure: string;
  arrival: string;
  forecast_cycle?: string;
  current_sources?: string[];
  /** Label of the polar the route was computed with, or null when motor-only. */
  polar?: string | null;
  /** Polar performance applied (ratio; 1 = the polar as written). */
  polar_performance?: number;
  /** Automatic vias placed at narrow passages (not waypoints of the route). */
  auto_vias?: { name: string; width_m: number }[];
  /** Routes with waypoints: number of legs and the waypoint precision used. */
  legs?: number;
  precision?: 'precise' | 'approximate';
  /** A leg's corridor search failed and ran on the coarse per-route skeleton (counted in /api/status corridor_fallbacks). */
  corridor_fallback?: true;
  /** Regional wind models used and the share of the search's wind samples each answered (0..1); absent when only ECMWF was used. */
  regional_wind?: { name: string; run: string; share: number }[];
  /** At least one leg was routed on the chart mesh (charted depths and obstructions) instead of the coastline search. */
  mesh?: true;
  /** The open-water router that ran. */
  router?: RouterKind;
}

export type QueryKind =
  | 'field'
  | 'currents'
  | 'wind_points'
  | 'sea_points'
  | 'conditions'
  | 'pressure'
  | 'land_mask'
  | 'tide_series'
  | 'weather_point'
  | 'forecast_info';

export interface QueryArgs {
  field: { layer: string; bbox: BBox; timeMs: number; res: number };
  currents: { bbox: BBox; timeMs: number; res: number };
  wind_points: { bbox: BBox; timeMs: number; res: number };
  sea_points: { bbox: BBox; timeMs: number; res: number };
  conditions: { lon: number; lat: number; fromMs: number; hours: number; stepH: number };
  /** Current-hour conditions sample points for one XYZ tile. */
  /** `mercator`: rows evenly spaced in Web Mercator y (a map tile), else in latitude. */
  land_mask: { bbox: BBox; w: number; h: number; mercator?: boolean };
  pressure: { bbox: BBox; timeMs: number; intervalHpa: number };
  /** Hourly tide / water level / surge at a point (Weather API); result TideSeriesResult. */
  tide_series: { lat: number; lon: number; fromMs: number; hours: number };
  /** Signal K Weather API point forecasts (result WeatherData[], without water level). */
  /** `observation`: one entry for the conditions at `startMs` (interpolated between steps) instead of the forecast steps. */
  weather_point: { lat: number; lon: number; startMs: number | null; maxCount: number | null; observation?: boolean };
  /** GET /api/forecast samples at a point (result the `samples` array). */
  forecast_info: { lat: number; lon: number };
}

/** The decoded run in use: where it is on disk and its index (relayed data worker → main → route worker). */
export interface ForecastRunInfo {
  dir: string;
  index: DecodedIndex;
  /** When the data worker adopted this run (status loaded_at). */
  loadedAtMs: number;
  /** 'disk': a complete decoded run of this cycle was already on disk (no decode); 'grib': decoded now from the GRIB cache / download. */
  source: 'disk' | 'grib';
  /** Milliseconds from the start of the check to the run being ready. */
  readyMs: number;
  /** GRIB fields downloaded for this run (0 when decoded from the disk cache or opened). */
  downloaded: number;
}

/** Memory a thread holds for the forecast (windows read from the decoded run). */
export interface ForecastMemory {
  /** Bytes held now (a route's corridor store while it runs; a query's window while it is answered). */
  heldBytes: number;
  /** Largest recent window: what it was for, bytes, read time. */
  last: { what: string; bytes: number; readMs: number; at: string } | null;
}

/** Result of a `tide_series` query (structured-cloneable). null series: tides off, outside the grid or no data. */
export interface TideSeriesResult {
  run: string | null;
  t0Ms: number;
  stepMs: number;
  /** m above local mean sea level; NaN = no data. */
  waterLevel: Float64Array;
  tide: Float64Array;
  surge: Float64Array;
  /** Why there is no series (null when there is one). */
  error: string | null;
}

export interface LandCacheStatus {
  entries: number;
  cells: number;
  bytes: number;
  index_bytes: number;
  builds: number;
  hits: number;
  last_build_ms: number;
  /** The thread's decoded-polygon cache (geo/polygoncache.ts). */
  polygons?: { entries: number; bytes: number; budget_bytes: number; hits: number; decodes: number; evictions: number };
}

/**
 * What the data worker is doing to get a forecast (null when idle):
 * finding the cycle, then decoding it step by step (downloading what is
 * not in the GRIB cache). `why`: no decoded run on disk yet ('first'), the
 * runs on disk do not fit the settings or are incomplete ('redecode'), or a
 * newer cycle while a run serves ('update').
 */
export interface ForecastLoading {
  phase: 'checking' | 'decoding';
  why: 'first' | 'redecode' | 'update';
  /** The cycle being decoded (ISO), once known. */
  cycle: string | null;
  /** Steps decoded and written, and of how many (0 / null until the first step). */
  done: number;
  total: number | null;
  startedAt: string;
}

export interface DataStatus {
  forecast: {
    cycle: string;
    validFrom: string;
    validTo: string;
    steps: number;
    params: string[];
    hasWaves: boolean;
    loadedAt: string;
    source: 'disk' | 'grib';
    readyMs: number;
    /** Directory and bytes of the run in use. */
    decodedDir: string;
    decodedBytes: number;
    /** Bytes of every decoded run kept on disk (keepCycles). */
    decodedDiskBytes: number;
    /** Bytes of the GRIB message cache. */
    gribCacheBytes: number;
  } | null;
  /** Last streaming decode: time, the one-step block it reused, bytes written. */
  lastDecode: { at: string; cycle: string; ms: number; stepBlockBytes: number; writtenBytes: number; downloaded: number } | null;
  /** Bytes of the one-step block while a decode runs (null otherwise). */
  decodingBlockBytes: number | null;
  /** Forecast memory the data worker holds (query windows). */
  forecastMemory: ForecastMemory;
  currents: {
    name: string;
    priority: number;
    resolutionM: number;
    bbox: { south: number; west: number; north: number; east: number };
    validFrom?: string;
    validTo?: string;
    /** CMEMS SMOC only: run, resident / on-demand areas, memory, downloads. */
    smoc?: SmocStatus;
  }[];
  rtofsRun: string | null;
  /** On-demand overlay land rasters (LRU). */
  land: LandCacheStatus | null;
  /** Copernicus Marine sea level (tides): run, resident / on-demand map areas, point cache, downloads; null when off or not loaded. */
  tides: TideStatus | null;
  /** Last tide source error (probe or load), null when fine. */
  tidesError: string | null;
  /** Regional runs decoded from signalk-grib-downloader (data worker), per source. */
  regional: RegionalDecodeState[];
}

/** One regional source's decode state. */
export interface RegionalDecodeState {
  source: string;
  /** yyyymmddHH of the decoded run, or null. */
  cycle: string | null;
  dir: string | null;
  steps: number;
  bytes: number;
  decodeMs: number;
  decodedAt: string | null;
  error: string | null;
  /** Why the source is not decoded or used for routes (not finer than the global forecast), or absent. */
  skipped?: string;
}

export type MainToWorker =
  | { type: 'init'; role: WorkerRole; config: ResolvedConfig; cacheDir: string }
  /**
   * data worker: check ECMWF/NOMADS/Copernicus and reload the forecast and currents; route worker: reload RTOFS from the disk cache.
   * `position`: the vessel's position (Signal K navigation.position), centre of the SMOC resident area; null when unknown.
   */
  | { type: 'refresh'; force?: boolean; position?: VesselPosition | null }
  /** route worker: adopt the data worker's SMOC run and resident area (shared memory, relayed by the main thread). */
  | { type: 'smoc'; smoc: SerializedSmoc | null }
  /** The data worker's RTOFS run (SharedArrayBuffer views: relaying shares, not copies). */
  | { type: 'rtofs'; rtofs: SerializedRtofs | null }
  /** route worker: adopt the data worker's tidal-harmonic sources (shared constituent blocks, relayed by the main thread). */
  | { type: 'harmonic'; sources: SerializedHarmonic[] }
  /** route worker: the decoded run to read route areas from (null: none yet). */
  | { type: 'forecast'; run: ForecastRunInfo | null }
  /** Settings changed: new config; reload what `reload` names (data worker: forecast, currents and tides; route worker: currents from disk). */
  | {
      type: 'config';
      config: ResolvedConfig;
      reload: { forecast: boolean; currents: boolean; tides?: boolean };
      position?: VesselPosition | null;
    }
  /** avoid: the areas to avoid marked on Signal K notes, read by the main thread (the workers have no Resources API). */
  | { type: 'route'; id: string; request: RouteRequest; avoid?: AvoidArea[]; self?: SelfDesign }
  | { type: 'query'; id: number; kind: QueryKind; args: QueryArgs[QueryKind] }
  /** tiles workers: the data worker's tide run (null: tides off or not loaded). */
  | { type: 'tides-run'; run: ArcoRun | null }
  /** Drop a query that has not started (its HTTP client went away); one that has started completes. */
  | { type: 'query-cancel'; id: number }
  | { type: 'shutdown' };

export type WorkerToMain =
  | { type: 'ready'; role: WorkerRole }
  | { type: 'log'; level: 'debug' | 'info' | 'error'; message: string }
  /** data worker: a decoded run is ready (decoded now or found on disk). */
  | { type: 'forecast'; run: ForecastRunInfo }
  | { type: 'forecast-unchanged'; cycleTimeMs: number }
  /** route worker: forecast memory it holds (the corridor store while a route runs). */
  | { type: 'forecast-memory'; memory: ForecastMemory }
  | { type: 'refresh-error'; message: string }
  /** data worker: forecast loading progress (null when it stops, done or failed). */
  | { type: 'forecast-loading'; loading: ForecastLoading | null }
  | { type: 'currents'; status: DataStatus['currents']; rtofsRun: string | null }
  | { type: 'data-status'; status: DataStatus }
  /** data worker: SMOC run / resident area changed (SharedArrayBuffer views: relaying shares, not copies). */
  | { type: 'smoc'; smoc: SerializedSmoc | null }
  /** data worker: the RTOFS run loaded (SharedArrayBuffer views, relayed to the route and tiles workers). */
  | { type: 'rtofs'; rtofs: SerializedRtofs | null }
  /** data worker: the tide run in use (relayed to tiles workers, which open it themselves). */
  | { type: 'tides-run'; run: ArcoRun | null }
  /** data worker: tidal-harmonic sources loaded (shared constituent blocks). */
  | { type: 'harmonic'; sources: SerializedHarmonic[] }
  | { type: 'progress'; id: string; stage: number; total: number; message: string }
  /** route worker: a search stage's front for display (streamed, never stored): points [lon, lat, timeMs, viaCount], best path [lon, lat]. */
  | { type: 'frontier'; id: string; leg: number; stage: number; total: number; points: number[][]; best: number[][] }
  | {
      type: 'done';
      id: string;
      geojson: Record<string, unknown>;
      skRoute: Record<string, unknown>;
      skeleton: Record<string, unknown> | null;
      /** Every stage's front and best path (see route.ts StageFront), compact: points [lon, lat, timeMs, viaCount]. */
      fronts?: { leg: number; stage: number; total: number; points: number[][]; best: number[][] }[] | null;
      summary: RouteSummary;
    }
  | { type: 'error'; id: string; message: string; cancelled?: boolean }
  /** `complete`: false when an on-demand current / tide load missed its deadline or failed (do not cache). */
  | { type: 'query-result'; id: number; result: unknown; complete: boolean }
  | { type: 'query-error'; id: number; message: string };
