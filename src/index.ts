/**
 * signalk-weather-router-plus — Signal K plugin entry point.
 *
 * Standalone weather routing: ECMWF open-data forecasts, Copernicus
 * Marine SMOC and NOAA RTOFS currents decoded in-process, harmonic tidal
 * currents, Copernicus Marine hourly sea level (tide height, water level,
 * surge), GSHHG coastline
 * avoidance, vessel polars, isochrone propagation. Two worker threads:
 * `data` (forecast, currents, overlay queries) and `route` (engine).
 * Routes are exposed through the plugin's REST/SSE API, saved to the
 * Resources API, and the forecast is offered through the Weather API.
 * The decoded forecast lives on disk (data/decoded.ts); this thread holds
 * none of it: forecast reads happen in the workers.
 */

import { MINUTE_MS } from './geo/units';
import * as path from 'node:path';
import type { IRouter } from 'express';
import { CONFIG_SCHEMA, resolveConfig, type LegacyPluginConfig, type PluginConfig, type ResolvedConfig } from './plugin/config';
import { mergeSettings, reloadsFor, settingsSchema, SettingsStore, SettingsValidationError } from './plugin/settings';
import { checkDecodeResources } from './plugin/memguard';
import { siText } from './plugin/unittext';
import { JobManager, type Job } from './plugin/jobs';
import { registerApi } from './plugin/api';
import { NotStartedError } from './plugin/errors';
import { TileService, TileStore, type TileGroup } from './plugin/tiles';
import { TilePrebuilder } from './plugin/prebuild';
import { runLastMs, type ArcoRun } from './data/arco';
import { gshhgInstalled, unreadableCoastlines } from './geo/gshhg';
import { Coastline } from './plugin/coastline';
import { ChartsProvider } from './plugin/charts';
import { makePlotterExtension } from './plugin/plotterext';
import { refreshPublicFileDates } from './plugin/webfiles';
import { scanRegional, type RegionalStatus } from './data/regional';
import { WorkerPool, type MainRole } from './plugin/workerpool';
import { BUNDLED_DEFAULT_POLAR, BUNDLED_POLARS_DIR } from './plugin/polars';
import { openApiDocument } from './plugin/openapi';
import { registerWeatherProvider } from './plugin/weather';
import type {
  DataStatus,
  ForecastMemory,
  ForecastRunInfo,
  MainToWorker,
  QueryArgs,
  QueryKind,
  VesselPosition,
  WorkerToMain,
} from './plugin/protocol';
import type { SerializedSmoc } from './currents/smoc';
import type { SerializedHarmonic } from './currents/harmonic';

const PLUGIN_ID = 'signalk-weather-router-plus';
const BASE_PATH = `/plugins/${PLUGIN_ID}`;
const QUERY_TIMEOUT_MS = 120_000;

interface SkApp {
  debug: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  setPluginStatus: (s: string) => void;
  setPluginError: (s: string) => void;
  getDataDirPath: () => string;
  getSelfPath?: (path: string) => unknown;
  handleMessage?: (id: string, delta: unknown) => void;
  registerWeatherProvider?: (provider: unknown) => void;
  registerResourceProvider?: (provider: {
    type: string;
    methods: {
      listResources: (query?: unknown) => Promise<Record<string, unknown>>;
      getResource: (id: string) => Promise<unknown>;
      setResource: (id: string, value: unknown) => Promise<void>;
      deleteResource: (id: string) => Promise<void>;
    };
  }) => void;
  resourcesApi?: {
    setResource: (type: string, id: string, data: Record<string, unknown>, providerId?: string) => Promise<void>;
  };
}

interface SignalKPlugin {
  id: string;
  name: string;
  description: string;
  schema: () => Record<string, unknown>;
  start: (options: PluginConfig, restartPlugin: () => void) => void | Promise<void>;
  stop: () => void | Promise<void>;
  registerWithRouter?: (router: IRouter) => void;
  getOpenApi?: () => Record<string, unknown>;
}

export = function plugin(app: SkApp): SignalKPlugin {
  let config: ResolvedConfig | null = null;
  let jobs: JobManager | null = null;
  /** The decoded run in use (where it is on disk and its index), relayed to the route worker. */
  let forecastRun: ForecastRunInfo | null = null;
  /** Forecast memory the route worker holds (its corridor store while a route runs). */
  let routeForecastMemory: ForecastMemory | null = null;
  /** The data worker's CMEMS SMOC run + resident area (shared memory), relayed to the route worker. */
  let smocShared: SerializedSmoc | null = null;
  /** The data worker's tidal-harmonic sources (shared constituent blocks), relayed to the route worker. */
  let harmonicShared: SerializedHarmonic[] | null = null;
  /** Raw Signal K plugin options from start(). */
  let pluginOptions: PluginConfig | undefined;
  let settings: SettingsStore | null = null;
  /** Current sources last reported by the data worker (name list + RTOFS run), to tell the route worker to reload. */
  let currentsKey = '';
  let forecastError: string | null = null;
  /** Routes since the plugin was loaded whose corridor search failed and ran on the coarse skeleton (decision E). */
  let corridorFallbacks = 0;
  let dataStatus: DataStatus | null = null;
  /** The route worker's own current sources (its SMOC on-demand areas and memory). */
  let routeCurrents: DataStatus['currents'] | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let failedRefreshTimer: NodeJS.Timeout | null = null;
  let weatherRegistered = false;
  let stopped = true;
  let pendingRefresh: { force: boolean } | null = null;
  /** Map overlay tiles on disk (null before start). */
  let tiles: TileService | null = null;
  /** Bumped by settings changes that reload forecast, currents or tides (tile generations). */
  let dataSettingsRev = 0;
  /** Tiles built ahead of time (null before start or when off). */
  let prebuilder: TilePrebuilder | null = null;
  /** The data worker's tide run (relayed to the tiles workers). */
  let tidesRun: ArcoRun | null = null;
  /** Bumped by every start/stop, so a start still downloading the coastline does not carry on after a stop. */
  let startGen = 0;
  /** A route started before the first forecast was ready: sent to the route worker when it is (see startServices). */
  let waitingForForecast: Job | null = null;

  /** Why the services are not up yet, for API answers and the status (`starting`). */
  function notStartedReason(): string {
    if (stopped) return 'plugin not started';
    if (coast.state.downloading) {
      const m = (coast.state.message ?? '').replace(/^coastline:\s*/, '');
      return `starting: downloading the coastline${m ? ` (${m})` : ' (GSHHG, {dataSize:149000000}, once)'}`;
    }
    if (coast.state.error)
      return `starting: the coastline download failed (${coast.state.error}); it is tried again every 10 minutes, or press Download coastline in the plugin configuration`;
    return 'starting';
  }

  /** Send a job waiting for the first forecast to the route worker. */
  function releaseWaitingJob(note: string): void {
    const job = waitingForForecast;
    if (!job) return;
    waitingForForecast = null;
    // It may have failed meanwhile (route worker crash/exit: failRunning).
    if (!jobs || jobs.runningId !== job.id || jobs.get(job.id)?.status !== 'running') return;
    jobs.onProgress(job.id, 0, 0, note);
    pool.post('route', { type: 'route', id: job.id, request: job.request });
  }

  /** The resolved config, with the downloaded coastline when none is configured. */
  function resolve(options: PluginConfig | undefined, values: SettingsStore['values']): ResolvedConfig {
    const c = resolveConfig(options, values);
    if (c.landShapefiles.length === 0 && coast.autoPath) c.landShapefiles = [coast.autoPath];
    // Polars: the bundled library and default polar unless configured. With the
    // bundled library, user polars live in the data directory (an update of the
    // package replaces its own files, never these).
    if (!c.polarsDir) {
      c.polarsDir = BUNDLED_POLARS_DIR;
      c.polarUserDir = path.join(app.getDataDirPath(), 'polars', 'user');
    } else c.polarUserDir = path.join(c.polarsDir, 'user');
    if (!c.polarFile) c.polarFile = BUNDLED_DEFAULT_POLAR;
    return c;
  }

  const log = (msg: string): void => app.debug(msg);
  const publicDir = path.join(__dirname, '..', 'public');
  const isTs = __filename.endsWith('.ts');
  const workerPath = path.join(__dirname, 'plugin', isTs ? 'worker.ts' : 'worker.js');
  const execArgv = isTs ? ['--import', 'tsx'] : [];

  const coast = new Coastline(app, log);
  const pool = new WorkerPool({
    workerPath,
    execArgv,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    onMessage: (role, msg) => onWorkerMessage(role, msg),
    onError: (role, err, current) => {
      app.error(`${role} worker error: ${err.message}${current ? '' : ' (worker already replaced)'}`);
      if (current && role === 'route') jobs?.failRunning(`worker crashed: ${err.message}`);
    },
    onExit: (role, code) => {
      if (stopped) return;
      app.error(`${role} worker exited with code ${code}; restarting in 5 s`);
      if (role === 'route') jobs?.failRunning(`worker exited with code ${code}`);
      // Only for the start this exit belongs to: after a stop and a new start
      // (whose services may still be waiting for the coastline download) the
      // new start brings up its own workers.
      const gen = startGen;
      setTimeout(() => {
        if (!stopped && gen === startGen && config && !pool.has(role)) {
          pool.start(role);
          pool.post(role, { type: 'init', role, config, cacheDir: app.getDataDirPath() });
          if (role === 'data') requestRefresh(false);
          else for (const m of sharedDataMessages()) pool.post('route', m);
        }
      }, 5000);
    },
  });
  const charts = new ChartsProvider({
    app,
    pluginId: PLUGIN_ID,
    basePath: BASE_PATH,
    dataDir: () => app.getDataDirPath(),
    isStopped: () => stopped,
    forecastRun: () => forecastRun,
    tidesRun: () => tidesRun,
    tidesEnabled: () => !!config?.tides.enabled,
    dataStatus: () => dataStatus,
    log,
    error: m => app.error(m),
  });
  const plotterExt = makePlotterExtension({
    app,
    pluginId: PLUGIN_ID,
    publicDir,
    packageDir: path.join(__dirname, '..'),
    isStopped: () => stopped,
    log,
    error: m => app.error(m),
  });

  /** The data worker's shared data a (re)started route or tiles worker must learn: the decoded run, SMOC memory, harmonic blocks. */
  function sharedDataMessages(): MainToWorker[] {
    const m: MainToWorker[] = [];
    if (forecastRun) m.push({ type: 'forecast', run: forecastRun });
    if (smocShared) m.push({ type: 'smoc', smoc: smocShared });
    if (harmonicShared) m.push({ type: 'harmonic', sources: harmonicShared });
    return m;
  }

  function query<K extends QueryKind>(kind: K, args: QueryArgs[K], signal?: AbortSignal): Promise<unknown> {
    return pool.queryFull(kind, args, signal).then(r => r.result);
  }

  function registerWeather(): void {
    if (weatherRegistered || !config?.weatherProvider.enabled) return;
    weatherRegistered = registerWeatherProvider(app, {
      pluginId: PLUGIN_ID,
      tidesEnabled: () => !!config?.tides.enabled,
      hasForecast: () => !!forecastRun,
      pointQuery,
      log,
      error: m => app.error(m),
    });
  }

  /** A point query through the shared store (tiles.ts TileService.point). */
  function pointQuery<K extends QueryKind>(kind: K, args: QueryArgs[K]): Promise<unknown> {
    return tiles ? tiles.point(kind, args) : query(kind, args);
  }

  /**
   * Tile generations: what each group of overlay layers is computed
   * from. A change removes that group's saved tiles (tiles.ts).
   */
  function updateTileGenerations(): void {
    if (!tiles || !config) return;
    const cfg = config;
    const coast = `${cfg.landShapefiles.join('|')}`;
    const wx = forecastRun
      ? `${coast}|${forecastRun.index.cycleTimeMs}|${forecastRun.index.request.params.join(',')}|${dataSettingsRev}`
      : null;
    const smoc = smocShared ? `${smocShared.run.key}|${smocShared.run.settled}` : 'off';
    const cur = wx && dataStatus ? `${wx}|${currentsKey}|${smoc}|${cfg.currents.harmonicDir ?? ''}` : null;
    const t = dataStatus?.tides;
    const tide = !cfg.tides.enabled ? `${coast}|off` : t ? `${coast}|${t.run}|${t.settled}|${dataSettingsRev}` : null;
    // Point answers (conditions, Weather API) read forecast, currents and tides.
    // POINT_ANSWER_REV: bumped when the answer's content changes for the same
    // data (2: current_ms null where no current source has data), so answers
    // saved by an older version are not served.
    const POINT_ANSWER_REV = 2;
    const pt = cur && tide ? `${cur}|${tide}|rev${POINT_ANSWER_REV}` : null;
    const g: Record<TileGroup, string | null> = { wx, cur, tide, land: coast, pt };
    tiles.store.setGenerations(g);
  }

  /** Own-vessel position from Signal K (navigation.position), or null. */
  function vesselPosition(): VesselPosition | null {
    try {
      const raw = app.getSelfPath?.('navigation.position') as { value?: unknown; latitude?: unknown; longitude?: unknown } | undefined;
      const p = (raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw) as
        { latitude?: unknown; longitude?: unknown } | undefined;
      if (!p || typeof p.latitude !== 'number' || typeof p.longitude !== 'number') return null;
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180)
        return null;
      return { lat: p.latitude, lon: p.longitude };
    } catch {
      return null;
    }
  }

  function requestRefresh(force: boolean): void {
    if (!pool.ready('data')) {
      pendingRefresh = { force: (pendingRefresh?.force ?? false) || force };
      return;
    }
    pool.post('data', { type: 'refresh', force, position: vesselPosition() });
  }

  function jobsSummary(): string {
    if (!jobs) return 'no jobs';
    return `${jobs.runningId ? 1 : 0} running, ${jobs.queueLength} queued`;
  }

  /** The vessel's name from Signal K (vessels.self.name), or null when the server has none. */
  function selfName(): string | null {
    const raw = app.getSelfPath?.('name') as unknown;
    const v = raw && typeof raw === 'object' && 'value' in raw ? (raw as { value: unknown }).value : raw;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  // Regional GRIB runs of signalk-grib-downloader (discovery only, read-only):
  // the folder scanned at most every 15 s, for the status. The data worker's
  // decode state is joined on every call, so it is never older than its last
  // report; the cached scan itself is not changed.
  let regionalCache: { at: number; value: RegionalStatus } | null = null;
  function regionalStatus(): RegionalStatus {
    const now = Date.now();
    if (!regionalCache || now - regionalCache.at >= 15_000) {
      regionalCache = { at: now, value: scanRegional(config?.forecast.regionalGribs ?? '', app.getDataDirPath()) };
    }
    const scan = regionalCache.value;
    // The data worker's decode state per source (decoded run, size, time, error).
    const dec = new Map((dataStatus?.regional ?? []).map(d => [d.source, d]));
    return { ...scan, sources: scan.sources.map(s => ({ ...s, decoded: dec.get(s.name) ?? null })) };
  }

  function updateStatus(): void {
    if (stopped) return;
    if (forecastRun) {
      const ix = forecastRun.index;
      const b = new Date(ix.steps[ix.steps.length - 1].validMs);
      const cur = dataStatus?.currents.length ? `, currents ${dataStatus.currents.map(c => c.name).join('/')}` : ', no currents';
      app.setPluginStatus(
        `global forecast ${new Date(ix.cycleTimeMs).toISOString().slice(0, 13)}Z to ${b.toISOString().slice(0, 13)}Z (${ix.steps.length} steps, ${(ix.bytes / 1e6).toFixed(0)} MB decoded on disk)${cur}; ${jobsSummary()}${forecastError ? `; reload refused: ${forecastError}` : ''}`
      );
    } else if (forecastError) {
      app.setPluginError(`forecast unavailable: ${forecastError}`);
    } else {
      app.setPluginStatus(`loading forecast; ${jobsSummary()}`);
    }
  }

  function notify(job: Job, state: 'normal' | 'alert' | 'warn', message: string): void {
    if (!config?.publish.notifications || !app.handleMessage) return;
    try {
      app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              {
                path: `notifications.weatherRouterPlus.${job.id}`,
                value: { state, method: [], message, timestamp: new Date().toISOString() },
              },
            ],
          },
        ],
      });
    } catch (err) {
      app.error(`notification failed: ${(err as Error).message}`);
    }
  }

  async function publish(id: string): Promise<string> {
    if (!jobs) throw new NotStartedError();
    const job = jobs.get(id);
    if (!job || !job.skRoute) throw new Error('job has no route');
    if (!app.resourcesApi?.setResource) throw new Error('this Signal K server has no Resources API');
    try {
      await app.resourcesApi.setResource('routes', job.id, job.skRoute);
      jobs.setPublished(job.id, job.id);
      log(`job ${job.id} published as route resource ${job.id}`);
      return job.id;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      jobs.setPublished(job.id, null, msg);
      throw new Error(`Resources API rejected the route: ${msg} (is a routes provider such as resources-provider enabled?)`, {
        cause: err,
      });
    }
  }

  function onWorkerMessage(role: MainRole, msg: WorkerToMain): void {
    switch (msg.type) {
      case 'ready':
        pool.setReady(role);
        log(`${role} worker ready`);
        // A (re)started route worker learns where the decoded run is.
        if (role === 'route') for (const m of sharedDataMessages()) pool.post('route', m);
        if (role === 'data' && pendingRefresh) {
          const f = pendingRefresh.force;
          pendingRefresh = null;
          requestRefresh(f);
        }
        if (role === 'route') pool.post('route', { type: 'refresh', force: false });
        return;
      case 'log':
        if (msg.level === 'error') app.error(msg.message);
        else log(msg.message);
        return;
      case 'forecast':
        if (role !== 'data') return;
        forecastRun = msg.run;
        void charts.publishGroups();
        updateTileGenerations();
        forecastError = null;
        if (failedRefreshTimer) {
          clearTimeout(failedRefreshTimer);
          failedRefreshTimer = null;
        }
        registerWeather();
        // The route and tiles workers read from the same run on disk.
        pool.post('route', { type: 'forecast', run: msg.run });
        prebuilder?.broadcast({ type: 'forecast', run: msg.run });
        releaseWaitingJob('first forecast ready');
        log(
          `forecast ${new Date(msg.run.index.cycleTimeMs).toISOString().slice(0, 13)}Z ready: decoded run ${msg.run.dir} (${(msg.run.index.bytes / 1e6).toFixed(1)} MB on disk; nothing resident)`
        );
        updateStatus();
        return;
      case 'forecast-memory':
        if (role === 'route') routeForecastMemory = msg.memory;
        return;
      case 'forecast-unchanged':
        if (role === 'data') updateStatus();
        return;
      case 'refresh-error':
        if (role !== 'data') return;
        forecastError = msg.message;
        app.error(`forecast refresh failed: ${msg.message}${forecastRun ? ' (keeping the decoded run in use)' : ''}`);
        releaseWaitingJob(`the first forecast failed (${msg.message}); computing with what can be loaded`);
        if (!failedRefreshTimer) {
          failedRefreshTimer = setTimeout(() => {
            failedRefreshTimer = null;
            if (!stopped) requestRefresh(false);
          }, 10 * MINUTE_MS);
        }
        updateStatus();
        return;
      case 'currents':
        if (role === 'route') routeCurrents = msg.status;
        if (role === 'data') {
          log(`currents: ${msg.status.length ? msg.status.map(c => `${c.name} (p${c.priority})`).join(', ') : 'none'}`);
          // New RTOFS on disk (new run or region): the route worker reloads its copy from the cache.
          const key = `${msg.status.map(c => c.name).join('+')}|${msg.rtofsRun ?? ''}`;
          if (key !== currentsKey) {
            const first = currentsKey === '';
            currentsKey = key;
            updateTileGenerations();
            if (!first || msg.rtofsRun) {
              pool.post('route', { type: 'refresh', force: false });
              prebuilder?.broadcast({ type: 'refresh', force: false });
            }
          }
        }
        return;
      case 'harmonic':
        if (role === 'data') {
          // Shared constituent blocks: the route worker adopts the same memory.
          harmonicShared = msg.sources;
          pool.post('route', { type: 'harmonic', sources: msg.sources });
          prebuilder?.broadcast({ type: 'harmonic', sources: msg.sources });
        }
        return;
      case 'smoc':
        if (role === 'data') {
          // SharedArrayBuffer views: the route worker gets the same memory.
          smocShared = msg.smoc;
          pool.post('route', { type: 'smoc', smoc: msg.smoc });
          prebuilder?.broadcast({ type: 'smoc', smoc: msg.smoc });
          updateTileGenerations();
        }
        return;
      case 'tides-run':
        if (role === 'data') {
          tidesRun = msg.run;
          prebuilder?.broadcast({ type: 'tides-run', run: msg.run });
          // The tide group depends on a tide run; rewritten only when the group key changes.
          void charts.publishGroups();
        }
        return;
      case 'data-status':
        if (role === 'data') {
          dataStatus = msg.status;
          updateTileGenerations();
          updateStatus();
          // The current and sea-state groups depend on the data status.
          void charts.publishGroups();
        }
        return;
      case 'progress':
        jobs?.onProgress(msg.id, msg.stage, msg.total, msg.message);
        return;
      case 'frontier':
        jobs?.onFrontier(msg.id, { leg: msg.leg, stage: msg.stage, total: msg.total, points: msg.points, best: msg.best });
        return;
      case 'done': {
        jobs?.onDone(msg.id, msg.geojson, msg.skRoute, msg.summary, msg.skeleton, msg.fronts ?? null);
        if (msg.summary.corridor_fallback) {
          corridorFallbacks++;
          log(`route ${msg.id}: corridor search failed, coarse-skeleton fallback used (${corridorFallbacks} since load)`);
        }
        const job = jobs?.get(msg.id);
        if (job) {
          notify(
            job,
            'normal',
            // SI: the client converts to its user's units.
            `route ready: ${Math.round(msg.summary.total_distance_m)} m, ${Math.round(msg.summary.total_time_s)} s`
          );
          const wantPublish = job.request.publish ?? config?.publish.toResources ?? false;
          if (wantPublish) publish(job.id).catch(err => app.error((err as Error).message));
        }
        updateStatus();
        return;
      }
      case 'error': {
        jobs?.onError(msg.id, msg.message, msg.cancelled);
        const job = jobs?.get(msg.id);
        if (job && !msg.cancelled) notify(job, 'alert', `route failed: ${siText(msg.message)}`);
        updateStatus();
        return;
      }
      case 'query-result':
        pool.resolveQuery(msg.id, msg.result, msg.complete);
        return;
      case 'query-error':
        pool.rejectQuery(msg.id, msg.message);
        return;
    }
  }

  /**
   * Apply a settings change live: every thread gets the new config (the
   * next route uses it); the forecast reloads only for a new horizon or
   * field set, RTOFS only for RTOFS changes.
   */
  function applySettings(changed: string[]): {
    forecast: boolean;
    currents: boolean;
    tides: boolean;
    refresh_timer: boolean;
    jobs: boolean;
  } {
    const kinds = reloadsFor(changed);
    const out = {
      forecast: kinds.has('forecast'),
      currents: kinds.has('currents'),
      tides: kinds.has('tides'),
      refresh_timer: kinds.has('refresh_timer'),
      jobs: kinds.has('jobs'),
    };
    if (stopped || !settings || changed.length === 0)
      return { forecast: false, currents: false, tides: false, refresh_timer: false, jobs: false };
    config = resolve(pluginOptions, settings.values);
    if (out.currents) smocShared = null;
    if (out.forecast || out.currents || out.tides) {
      dataSettingsRev++;
      updateTileGenerations();
    }
    pool.post('data', {
      type: 'config',
      config,
      reload: { forecast: out.forecast, currents: out.currents, tides: out.tides },
      position: vesselPosition(),
    });
    pool.post('route', { type: 'config', config, reload: { forecast: false, currents: out.currents } });
    prebuilder?.broadcast({ type: 'config', config, reload: { forecast: false, currents: out.currents, tides: out.tides } });
    if (out.refresh_timer) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => requestRefresh(false), config.forecast.refreshIntervalS * 1000);
    }
    if (out.jobs) jobs?.setKeepJobs(config.routing.keepJobs);
    log(
      `settings changed: ${changed.join(', ')}${out.forecast ? '; reloading the forecast' : ''}${out.currents ? '; reloading currents' : ''}${out.tides ? '; reloading tides' : ''}`
    );
    updateStatus();
    return out;
  }

  function startPrebuilder(dataDir: string): void {
    if (!config || !tiles) return;
    const oc = config.overlayCache;
    const store = tiles.store;
    prebuilder = new TilePrebuilder(
      {
        enabled: oc.enabled,
        radiusM: oc.radiusM,
        windowS: oc.windowS,
        maxZoom: oc.maxZoom,
        workers: oc.workers,
        followView: oc.followView,
      },
      {
        store,
        dataDir,
        workerPath,
        execArgv,
        // Its own flag: route cancellation must not reach the tiles workers.
        cancelFlag: new SharedArrayBuffer(4),
        initMessage: () => ({ type: 'init', role: 'tiles', config: config as ResolvedConfig, cacheDir: dataDir }),
        replayMessages: () => {
          const m = sharedDataMessages();
          m.push({ type: 'tides-run', run: tidesRun });
          m.push({ type: 'refresh', force: false });
          return m;
        },
        vesselPosition,
        lastHourMs: layer => {
          if (layer === 'tide') return tidesRun ? runLastMs(tidesRun) : null;
          if (!forecastRun) return null;
          return forecastRun.index.steps[forecastRun.index.steps.length - 1].validMs;
        },
        layerAvailable: layer => charts.layerAvailable(layer),
        busy: () => !!jobs?.runningId || pool.pendingCount > 0,
        log,
        error: m => app.error(m),
      }
    );
    prebuilder.start();
  }

  async function start(options: PluginConfig): Promise<void> {
    stopped = false;
    pluginOptions = options;
    refreshPublicFileDates(publicDir, app.getDataDirPath(), log, m => app.error(m));
    plotterExt.register();
    charts.register();
    try {
      settings = new SettingsStore(app.getDataDirPath());
      // First start with settings.json absent: migrate the old plugin-config keys.
      const loaded = settings.load(options as LegacyPluginConfig);
      if (loaded.created)
        log(
          `settings.json created; migrated from the plugin config: ${loaded.migrated.length ? loaded.migrated.join(', ') : 'nothing set'}`
        );
      for (const p of loaded.problems) app.error(`settings: ${p}`);
      config = resolve(options, settings.values);
    } catch (err) {
      app.setPluginError((err as Error).message);
      throw err;
    }
    const gen = ++startGen;
    const dataDir = app.getDataDirPath();
    if (config.landShapefiles.length > 0) {
      // A configured coastline must be there: it is never replaced by a download.
      const bad = unreadableCoastlines(config.landShapefiles);
      if (bad.length) {
        app.setPluginError(
          `coastline shapefile ${bad.join(', ')}: fix the path in the plugin config (Coastline shapefile(s)), or clear it to download GSHHG`
        );
        return;
      }
      startServices(dataDir);
      return;
    }
    // None configured: download GSHHG (minutes), then start. Not awaited, so the server's start-up is not held up.
    void coast
      .download(dataDir, () => gen === startGen && !stopped)
      .then(ok => {
        if (!ok || !settings || gen !== startGen || stopped) return;
        config = resolve(options, settings.values);
        startServices(dataDir);
      });
  }

  /** Workers, jobs, tiles and timers, once the coastline is known. */
  function startServices(dataDir: string): void {
    if (!config) return;
    tiles = new TileService(
      new TileStore({ root: path.join(dataDir, 'overlay-tiles'), capBytes: config.overlayCache.diskCapBytes, log }),
      (kind, args, signal) => pool.queryFull(kind, args, signal)
    );
    updateTileGenerations();
    startPrebuilder(dataDir);
    jobs = new JobManager(dataDir, config.routing.keepJobs, BASE_PATH);
    jobs.on('start', (job: Job) => {
      // First start: the first forecast is still downloading. The route waits for it
      // rather than downloading its own copy of the same fields alongside.
      if (!forecastRun && !forecastError) {
        waitingForForecast = job;
        jobs?.onProgress(job.id, 0, 0, 'waiting for the first forecast (downloading and decoding; a few minutes on a first start)');
        updateStatus();
        return;
      }
      pool.post('route', { type: 'route', id: job.id, request: job.request });
      updateStatus();
    });
    for (const role of ['data', 'route'] as MainRole[]) {
      pool.start(role);
      pool.post(role, { type: 'init', role, config, cacheDir: dataDir });
    }
    requestRefresh(false);
    refreshTimer = setInterval(() => requestRefresh(false), config.forecast.refreshIntervalS * 1000);
    updateStatus();
    log(`${PLUGIN_ID} started; data dir ${dataDir}`);
  }

  function stop(): void {
    stopped = true;
    startGen++;
    coast.abort();
    if (refreshTimer) clearInterval(refreshTimer);
    if (failedRefreshTimer) clearTimeout(failedRefreshTimer);
    refreshTimer = failedRefreshTimer = null;
    pool.stopAll();
    pool.rejectPending('plugin stopped');
    jobs?.failRunning('plugin stopped');
    waitingForForecast = null;
    jobs = null;
    prebuilder?.stop();
    prebuilder = null;
    tidesRun = null;
    tiles = null;
    forecastRun = null;
    routeForecastMemory = null;
    smocShared = null;
    harmonicShared = null;
    routeCurrents = null;
    currentsKey = '';
    dataStatus = null;
    config = null;
    log(`${PLUGIN_ID} stopped`);
  }

  function registerWithRouter(router: IRouter): void {
    registerApi(router, {
      pluginId: PLUGIN_ID,
      basePath: BASE_PATH,
      get jobs(): JobManager {
        if (!jobs) throw new NotStartedError(notStartedReason());
        return jobs;
      },
      notReady: notStartedReason,
      status: () => ({
        plugin: PLUGIN_ID,
        started: !stopped,
        workers: { data: pool.ready('data'), route: pool.ready('route') },
        forecast: forecastRun
          ? {
              cycle: new Date(forecastRun.index.cycleTimeMs).toISOString(),
              valid_from: new Date(forecastRun.index.steps[0].validMs).toISOString(),
              valid_to: new Date(forecastRun.index.steps[forecastRun.index.steps.length - 1].validMs).toISOString(),
              steps: forecastRun.index.steps.length,
              params: forecastRun.index.request.params,
              // Always ECMWF open data (src/data/ecmwf.ts): wind from the oper stream, waves from the wave stream.
              model: 'ECMWF IFS 0.25°',
              coverage: 'global',
              storage: 'decoded-on-disk',
              loaded_at: new Date(forecastRun.loadedAtMs).toISOString(),
              has_waves:
                dataStatus?.forecast?.hasWaves ??
                forecastRun.index.steps.every(s => ['swh', 'mwp', 'mwd'].every(p => s.params.includes(p))),
              // 'disk': a complete decoded run was found on disk (no decode); 'grib': decoded from the GRIB cache / download.
              source: forecastRun.source,
              ready_ms: forecastRun.readyMs,
              fields_downloaded: forecastRun.downloaded,
              decoded_dir: forecastRun.dir,
              decoded_bytes: forecastRun.index.bytes,
              decoded_at: forecastRun.index.decodedAt,
              decode_ms: forecastRun.index.decodeMs,
              decoded_disk_bytes: dataStatus?.forecast?.decodedDiskBytes ?? null,
              grib_cache_bytes: dataStatus?.forecast?.gribCacheBytes ?? null,
              last_decode: dataStatus?.lastDecode ?? null,
              memory: {
                // Forecast memory actually held now; the decoded run itself is never resident.
                data_worker_held_bytes: dataStatus?.forecastMemory.heldBytes ?? 0,
                data_worker_largest_recent_window: dataStatus?.forecastMemory.last ?? null,
                route_worker_held_bytes: routeForecastMemory?.heldBytes ?? 0,
                route_worker_largest_recent_window: routeForecastMemory?.last ?? null,
                decoding_block_bytes: dataStatus?.decodingBlockBytes ?? null,
              },
            }
          : null,
        process_rss_bytes: process.memoryUsage().rss,
        forecast_error: forecastError,
        currents: dataStatus?.currents ?? [],
        currents_route_worker: routeCurrents ?? [],
        corridor_fallbacks: corridorFallbacks,
        rtofs_run: dataStatus?.rtofsRun ?? null,
        tides: config?.tides.enabled ? (dataStatus?.tides ?? null) : null,
        tides_enabled: config?.tides.enabled ?? null,
        tides_error: dataStatus?.tidesError ?? null,
        overlay_land: dataStatus?.land ?? null,
        overlay_tiles: tiles ? { ...tiles.store.stats(), inflight: tiles.inflightCount } : null,
        overlay_prebuild: prebuilder ? prebuilder.status() : null,
        starting: !jobs && !stopped ? notStartedReason() : null,
        coastline: {
          configured: pluginOptions?.landShapefiles?.trim() ? pluginOptions.landShapefiles : null,
          in_use: config?.landShapefiles ?? null,
          downloaded: gshhgInstalled(app.getDataDirPath()),
          ...coast.state,
        },
        weather_provider_registered: weatherRegistered,
        regional: regionalStatus(),
        jobs: jobs ? { running: jobs.runningId, queued: jobs.queueLength, total: jobs.list(500).length } : null,
        // The name is Signal K's (vessels.self.name), not a plugin setting.
        vessel: config?.vessel ? { ...config.vessel, name: selfName() } : undefined,
        polar: config?.polarFile,
        land: config?.landShapefiles,
        harmonic_dir: config?.currents.harmonicDir,
        extra_fields: config?.forecast.extraFields,
        energy_fields: config?.forecast.energyFields,
      }),
      forecastInfo: async (lat, lon) => {
        if (!forecastRun) throw new Error(forecastError ? `forecast unavailable: ${forecastError}` : 'forecast not loaded yet');
        const ix = forecastRun.index;
        const out: Record<string, unknown> = {
          cycle: new Date(ix.cycleTimeMs).toISOString(),
          valid_from: new Date(ix.steps[0].validMs).toISOString(),
          valid_to: new Date(ix.steps[ix.steps.length - 1].validMs).toISOString(),
          steps: ix.stepHours,
          params: ix.request.params,
          coverage: 'global',
        };
        if (lat !== undefined && lon !== undefined) out.samples = await pointQuery('forecast_info', { lat, lon });
        return out;
      },
      refreshForecast: force => requestRefresh(force),
      cancelRunning: (id: string) => {
        // Still waiting for the first forecast: nothing was sent to the worker.
        if (waitingForForecast && waitingForForecast.id === id) {
          waitingForForecast = null;
          jobs?.onError(id, 'cancelled', true);
          return;
        }
        Atomics.store(pool.cancelFlag, 0, 1);
      },
      publish,
      query,
      tiles: () => tiles,
      downloadCoastline: () => coast.requestDownload(),
      noteTileRequest: (z, x, y) => prebuilder?.noteRequest(z, x, y),
      publicDir,
      polarLibrary: () => (config ? { polarFile: config.polarFile, polarsDir: config.polarsDir, userDir: config.polarUserDir } : null),
      getSettings: () => {
        if (!settings || stopped) throw new NotStartedError();
        return { values: settings.values, schema: settingsSchema() };
      },
      updateSettings: (partial: unknown) => {
        if (!settings || stopped) throw new NotStartedError();
        // Resource guard: refuse a forecast change the device cannot do
        // (memory for one decode step, disk for the decoded run), before
        // saving, so the running forecast and settings stay as they are.
        const prospective = mergeSettings(settings.values, partial);
        if (
          prospective.changed.some(
            k =>
              k === 'forecast.horizon' || k === 'forecast.extraFields' || k === 'forecast.energyFields' || k === 'forecast.memoryHeadroom'
          )
        ) {
          const f = prospective.values.forecast;
          const mem = checkDecodeResources(f.horizon, f.extraFields, f.energyFields, f.memoryHeadroom, app.getDataDirPath());
          if (!mem.ok) {
            const key = prospective.changed.find(k => k.startsWith('forecast.')) ?? 'forecast.horizon';
            throw new SettingsValidationError({ [key]: mem.message });
          }
        }
        const { values, changed } = settings.update(partial);
        const reloaded = applySettings(changed);
        return { values, changed, reloaded };
      },
    });
  }

  return {
    id: PLUGIN_ID,
    name: 'Weather Router Plus',
    description:
      'Standalone weather routing: ECMWF open-data forecasts, Copernicus Marine SMOC and NOAA RTOFS currents and Copernicus Marine hourly sea level (tides) decoded in-process, harmonic tidal currents, GSHHG coastline avoidance, vessel polars. ' +
      'Routes via its own API at /plugins/signalk-weather-router-plus, saved to the Resources API, forecast offered through the Weather API.',
    schema: () => CONFIG_SCHEMA,
    start,
    stop,
    registerWithRouter,
    getOpenApi: () => openApiDocument(BASE_PATH),
  };
};
