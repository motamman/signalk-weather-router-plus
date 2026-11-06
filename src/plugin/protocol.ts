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

import type { ManagedPolar } from './managedpolar';
import type { ConditionsRow } from './overlays';
import type { AvoidArea } from '../geo/avoid';
import type { ResolvedConfig, SelfDesign } from './config';
import type { BBox } from '../geo/geodesy';
import type { DecodedIndex } from '../data/decoded';
import type { EnsembleModelId } from '../data/ecmwf';
import type { SerializedSmoc, SmocStatus } from '../currents/smoc';
import type { SerializedRtofsSet } from '../currents/rtofs';
import type { SerializedHarmonic } from '../currents/harmonic';
import type { BuilderCurrentsRef } from '../currents/fromcache';
import type { TideStatus } from '../tides/sealevel';
import type { ArcoRun } from '../data/arco';
import type { TileId } from './tiles';
import type { RouteRequest } from './request_schema';
import type { JobProgress, JobStatus, RouteSummary } from './response_schema';

/** data: forecast, currents, map queries; route: the engine; tiles: builds map tiles ahead of time (prebuild.ts). */
export type WorkerRole = 'data' | 'route' | 'tiles';

export interface VesselPosition {
  lat: number;
  lon: number;
}

/** The route request: its type comes from the schema that also validates it and documents it (request_schema.ts). */
export type { RouteRequest };

/** The job document's parts: their types come from the schemas that also document them (response_schema.ts). */
export type { JobStatus, JobProgress, RouteSummary };

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
  | 'forecast_info'
  | 'track_conditions';

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
  /**
   * Conditions at each (position, time) of a route's track, for its meteogram (result TrackConditions).
   * `regional`: the regional wind models the route was computed with (its summary's regional_wind), layered over
   * ECMWF as the router layers them, each with the run (yyyymmddHH) the data worker last reported decoded for it
   * (null: none). The query is the saved answer's key (tiles.ts), so a newer run is a new query and a fresh answer;
   * an answer read from another run than the one named is not kept.
   */
  track_conditions: { points: { lon: number; lat: number; tMs: number }[]; regional?: { name: string; cycle: string | null }[] };
}

/** A track row: the conditions, and the wind model that answered its wind (a regional model's name, or ECMWF). */
export type TrackConditionsRow = ConditionsRow & { wind_source: string };

/** The `track_conditions` answer: the runs sampled and one row per point, in order. */
export interface TrackConditions {
  /** Cycle and last valid time of the ECMWF run the rows were sampled from (ISO 8601). */
  cycle: string;
  validTo: string;
  /** The regional wind runs layered over it (cycle ISO 8601). */
  regional: { name: string; cycle: string }[];
  /** Regional models the route used that have no decoded run here now: ECMWF answers there instead. */
  regionalMissing: string[];
  rows: TrackConditionsRow[];
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

/**
 * What the last check of a source found, said plainly:
 *  - newest: the server answered and the run in use is the newest published
 *    (for ECMWF also: the newest cycle due by the clock is already in use);
 *  - could-not-check: the server could not be asked (no connection, or it
 *    failed); the run in use stays, not known to be the newest;
 *  - new-run: a newer run was fetched and is now in use;
 *  - failed: the server answered but the new run could not be loaded
 *    (download, decode, memory or disk guard).
 */
export type CheckOutcome = 'newest' | 'could-not-check' | 'new-run' | 'failed';

export interface SourceCheck {
  outcome: CheckOutcome;
  /** When the check ended, ISO. */
  at: string;
  reason: string | null;
}

/** The data worker's sources, by the key their check is kept under: RTOFS per product (`rtofs:west_atl`). */
export type CheckedSource = 'ecmwf' | 'smoc' | 'tides' | `rtofs:${string}`;

/**
 * RTOFS as the data worker chose it: the product that contains the vessel
 * (null, with the reason, when there is no position or none does), the
 * extra products from the settings, each loaded product's run (yyyy-mm-dd),
 * and the products whose extent is not known yet.
 */
export interface RtofsStatus {
  auto: string | null;
  autoReason: string | null;
  extra: string[];
  runs: { product: string; run: string }[];
  unknownExtents: string[];
}

/** What the data worker's own requests found about the connection (http.ts setNetworkObserver). */
export interface Connectivity {
  /** null until the first request. */
  online: boolean | null;
  /** When the current state began, ISO. */
  since: string | null;
  /** Last answer from any server, ISO. */
  lastOkAt: string | null;
  /** Why it is offline (null when online). */
  reason: string | null;
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
  /** null when RTOFS is off. */
  rtofs: RtofsStatus | null;
  /** On-demand overlay land rasters (LRU). */
  land: LandCacheStatus | null;
  /** Copernicus Marine sea level (tides): run, resident / on-demand map areas, point cache, downloads; null when off or not loaded. */
  tides: TideStatus | null;
  /** Last tide source error (probe or load), null when fine. */
  tidesError: string | null;
  /** Regional runs decoded from signalk-grib-downloader (data worker), per source. */
  regional: RegionalDecodeState[];
  /** The last check of each source, and what it found. */
  checks: Partial<Record<CheckedSource, SourceCheck>>;
  connectivity: Connectivity;
  /** Tidal-harmonic files that failed to load ("file: reason"). */
  harmonicErrors: string[];
  /** The ensembles chosen in the plugin config (data/ensemble.ts), one entry each; empty when ensembles are off. */
  ensembles: EnsembleStatus[];
}

/** One ensemble: the members in use for a route, and what its last pass did. */
export interface EnsembleStatus {
  model: EnsembleModelId;
  name: string;
  /** The cycle in use (ISO), null before the first complete pass. */
  cycle: string | null;
  /** Members on disk for that cycle (0 = the control). */
  members: number[];
  /** Bytes of this ensemble on disk (decoded runs and GRIB cache). */
  bytes: number;
  /** A pass under way: the cycle, steps downloaded and members decoded of the total. */
  loading: { cycle: string; done: number; total: number | null } | null;
  /** Why the last pass could not get the cycle (held, offline, disk, a server error), or null. */
  error: string | null;
  checkedAt: string | null;
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
   * `user`: the owner asked (Refresh, a route): the round downloads whatever the internet state.
   */
  | { type: 'refresh'; force?: boolean; position?: VesselPosition | null; user?: boolean }
  /**
   * data worker: why background downloads wait now, or null (plugin/internet.ts). A background round under way
   * skips the sources it has not reached, and its forecast decode stops.
   */
  | { type: 'internet-hold'; hold: string | null }
  /** route worker: adopt the data worker's SMOC run and resident area (shared memory, relayed by the main thread). */
  | { type: 'smoc'; smoc: SerializedSmoc | null }
  /** The data worker's RTOFS products (SharedArrayBuffer views: relaying shares, not copies). */
  | { type: 'rtofs'; rtofs: SerializedRtofsSet | null }
  /** route worker: adopt the data worker's tidal-harmonic sources (shared constituent blocks, relayed by the main thread). */
  | { type: 'harmonic'; sources: SerializedHarmonic[] }
  /**
   * tiles workers (separate processes, no shared memory): where the data worker's currents are on disk; each loads
   * them itself (currents/fromcache.ts) instead of being sent copies.
   */
  | { type: 'currents-ref'; ref: BuilderCurrentsRef }
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
  | { type: 'route'; id: string; request: RouteRequest; avoid?: AvoidArea[]; self?: SelfDesign; managedPolar?: ManagedPolar }
  | { type: 'query'; id: number; kind: QueryKind; args: QueryArgs[QueryKind] }
  /**
   * tiles workers: answer a tile's query, encode it as the store saves it (tiles.ts encodeTile) and write it to `tmp`
   * (the store's temporary file beside the tile); the main thread moves it into place (TileStore.adopt).
   */
  | { type: 'build-tile'; id: number; tile: TileId; tmp: string }
  /** tiles workers: the data worker's tide run (null: tides off or not loaded). */
  | { type: 'tides-run'; run: ArcoRun | null }
  /** Drop a query that has not started (its HTTP client went away); one that has started completes. */
  | { type: 'query-cancel'; id: number }
  | { type: 'shutdown' };

/**
 * The identity of the data an answer was computed from, as the worker that
 * answered it read it (worker/query.ts answer): the forecast run actually
 * read (readWindow falls back to the run that became current when the one
 * it chose was pruned meanwhile), the SMOC run and settledness, the RTOFS
 * run, and the tide run and settledness, all as sampled. The main thread
 * serves and saves an answer only when this matches what it holds now; on
 * a mismatch it asks again (tiles.ts TileService, prebuild.ts).
 */
export interface DataStamp {
  /** The decoded run read, null when the query kind reads no forecast (the current and arrows layers, the tide series): not compared, unlike a missing source. */
  forecast: { cycleMs: number; params: string[] } | null;
  /** The SMOC run sampled, null when SMOC is off or not loaded. */
  smoc: { key: string; settled: boolean } | null;
  /** The RTOFS products sampled, each with its run; empty when RTOFS is off or not loaded. */
  rtofs: { product: string; runMs: number }[];
  /** The tide run sampled, null when tides are off or not loaded. */
  tide: { key: string; settled: boolean } | null;
}

export type WorkerToMain =
  | { type: 'ready'; role: WorkerRole }
  | { type: 'log'; level: 'debug' | 'info' | 'error'; message: string }
  /** data worker: a decoded run is ready (decoded now or found on disk). */
  | { type: 'forecast'; run: ForecastRunInfo }
  /** data worker: what a forecast check found (the error line clears only on newest or new-run). */
  | { type: 'forecast-check'; check: SourceCheck }
  /** route worker: forecast memory it holds (the corridor store while a route runs). */
  | { type: 'forecast-memory'; memory: ForecastMemory }
  | { type: 'refresh-error'; message: string }
  /** data worker: forecast loading progress (null when it stops, done or failed). */
  | { type: 'forecast-loading'; loading: ForecastLoading | null }
  /** `rtofsRuns`: each loaded RTOFS product and its run ("west_atl 2026-10-22"). */
  | { type: 'currents'; status: DataStatus['currents']; rtofsRuns: string[] }
  | { type: 'data-status'; status: DataStatus }
  /** data worker: SMOC run / resident area changed (SharedArrayBuffer views: relaying shares, not copies). */
  | { type: 'smoc'; smoc: SerializedSmoc | null }
  /** data worker: the RTOFS products loaded (SharedArrayBuffer views, relayed to the route and tiles workers). */
  | { type: 'rtofs'; rtofs: SerializedRtofsSet | null }
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
  | { type: 'query-result'; id: number; result: unknown; complete: boolean; stamp: DataStamp }
  /** tiles worker: a 'build-tile' answered; `complete` false: nothing written (do not keep), else `bytes` written to its `tmp`. */
  | { type: 'tile-built'; id: number; bytes: number; complete: boolean; stamp: DataStamp }
  | { type: 'query-error'; id: number; message: string };
