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

import { avoidAreasFromNotes, type AvoidArea } from './geo/avoid';
import { MINUTE_MS } from './geo/units';
import * as path from 'node:path';
import type { IRouter } from 'express';
import {
  CONFIG_SCHEMA,
  resolveConfig,
  rtofsLoadSame,
  smocLoadSame,
  type LegacyPluginConfig,
  type PluginConfig,
  type ResolvedConfig,
  type SelfDesign,
  selfDesignValue,
} from './plugin/config';
import { AIR_DRAFT_M_RANGE, DRAUGHT_M_RANGE } from './vessel/vessel';
import { mergeSettings, reloadsFor, settingsSchema, SettingsStore, SettingsValidationError } from './plugin/settings';
import { SharedPrefsStore } from './plugin/sharedprefs';
import { checkDecodeResources } from './plugin/memguard';
import { siText } from './plugin/unittext';
import { JobManager, type Job } from './plugin/jobs';
import { windowNotification, WindowManager, type DepartureWindow } from './plugin/windows';
import { registerApi } from './plugin/api';
import { NotStartedError } from './plugin/errors';
import { TileService, TileStore, tileGenerationKeys, tileGroup } from './plugin/tiles';
import { hasStep, TilePrebuilder } from './plugin/prebuild';
import { runLastMs, type ArcoRun } from './data/arco';
import { gshhgInstalled, gshhgInstalledAt, unreadableCoastlines } from './geo/gshhg';
import { Coastline } from './plugin/coastline';
import { localMeshes, MeshManager, meshesToOpen, readyMeshDirs } from './plugin/meshes';
import { coarseFile, coarseKey, coarseRulesOf, joinsFile, meshesMeet, pruneCoarse, withBuildLock } from './plugin/meshcoarse';
import * as fs from 'node:fs';
import { runChildTask } from './plugin/childtask';
import { ChartsProvider } from './plugin/charts';
import { makePlotterExtension } from './plugin/plotterext';
import { refreshPublicFileDates } from './plugin/webfiles';
import { tagCacheDirs } from './plugin/cachedir';
import { scanRegional, type RegionalStatus } from './data/regional';
import { WorkerPool, type MainRole } from './plugin/workerpool';
import { BUNDLED_DEFAULT_POLAR, BUNDLED_POLARS_DIR } from './plugin/polars';
import { openApiDocument } from './plugin/openapi';
import { registerWeatherProvider } from './plugin/weather';
import { InternetGate } from './plugin/internet';
import type {
  DataStatus,
  ForecastLoading,
  ForecastMemory,
  ForecastRunInfo,
  MainToWorker,
  QueryArgs,
  QueryKind,
  SourceCheck,
  VesselPosition,
  WorkerToMain,
} from './plugin/protocol';
import {
  arcoFreshness,
  ecmwfFreshness,
  type Freshness,
  harmonicFailure,
  harmonicFreshness,
  regionalFreshness,
  rtofsFreshness,
} from './plugin/freshness';
import { SMOC_NAME } from './currents/smoc';
import { SL_NAME } from './tides/sealevel';
import type { SerializedSmoc } from './currents/smoc';
import { chooseRtofsProduct, readRtofsExtents, rtofsSetForConfig, type SerializedRtofsSet } from './currents/rtofs';
import type { SerializedHarmonic } from './currents/harmonic';

const PLUGIN_ID = 'signalk-weather-router-plus';
const BASE_PATH = `/plugins/${PLUGIN_ID}`;
const QUERY_TIMEOUT_MS = 120_000;
/**
 * How often the vessel position is looked at between refresh rounds: a first
 * fix after a start, or a move into another RTOFS product, refreshes at once
 * instead of at the next round (up to forecast.refreshInterval later).
 */
const POSITION_CHECK_MS = 30_000;

interface SkApp {
  debug: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  setPluginStatus: (s: string) => void;
  setPluginError: (s: string) => void;
  getDataDirPath: () => string;
  /** Writes the plugin's options file (no restart); the panel's mesh actions keep the download list through it. */
  savePluginOptions?: (configuration: object, cb: (err: Error | null) => void) => void;
  getSelfPath?: (path: string) => unknown;
  getFeatures?: (onlyEnabled?: boolean) => Promise<{ plugins: { id: string; enabled: boolean }[] }>;
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
    listResources?: (type: string, params: Record<string, unknown>, providerId?: string) => Promise<Record<string, unknown>>;
  };
  /**
   * The server's security strategy. Not in the plugin API's types, but the app a plugin gets is a copy of the server's
   * (signalk-server, src/interfaces/plugins.ts); with security off it is the dummy strategy, isDummy() true.
   */
  securityStrategy?: { isDummy?: () => boolean };
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
  /** Departure windows (windows.ts): created with the job manager. */
  let windows: WindowManager | null = null;
  /** The decoded run in use (where it is on disk and its index), relayed to the route worker. */
  let forecastRun: ForecastRunInfo | null = null;
  /** Forecast memory the route worker holds (its corridor store while a route runs). */
  let routeForecastMemory: ForecastMemory | null = null;
  /** The data worker's CMEMS SMOC run + resident area (shared memory), relayed to the route worker. */
  let smocShared: SerializedSmoc | null = null;
  /** The data worker's RTOFS products (shared memory), relayed to the route and tiles workers. */
  let rtofsShared: SerializedRtofsSet | null = null;
  /** The data worker's tidal-harmonic sources (shared constituent blocks), relayed to the route worker. */
  let harmonicShared: SerializedHarmonic[] | null = null;
  /** Raw Signal K plugin options from start(). */
  let pluginOptions: PluginConfig | undefined;
  let settings: SettingsStore | null = null;
  /** Current sources last reported by the data worker (name list + RTOFS runs), to tell the route worker to reload. */
  let currentsKey = '';
  let forecastError: string | null = null;
  /** What the last forecast check found (newest, could not check, new run, failed). */
  let forecastCheck: SourceCheck | null = null;
  /** The data worker's forecast loading progress (null when it is not loading one). */
  let forecastLoading: ForecastLoading | null = null;
  /** Routes since the plugin was loaded whose corridor search failed and ran on the coarse skeleton (decision E). */
  let corridorFallbacks = 0;
  let dataStatus: DataStatus | null = null;
  /** The route worker's own current sources (its SMOC on-demand areas and memory). */
  let routeCurrents: DataStatus['currents'] | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let positionTimer: NodeJS.Timeout | null = null;
  /** The position the last refresh round was sent with (null: none was known then). */
  let refreshPosition: VesselPosition | null = null;
  /** The RTOFS product a move last asked a refresh for (asked once per product, not every check). */
  let positionRefreshFor: string | null = null;
  let failedRefreshTimer: NodeJS.Timeout | null = null;
  let weatherRegistered = false;
  let stopped = true;
  let pendingRefresh: { force: boolean; user: boolean } | null = null;
  /** The last refresh round was held by the internet state (internet.ts): one runs as soon as it clears (checkPosition). */
  let refreshHeld = false;
  /** Map overlay tiles on disk (null before start). */
  let tiles: TileService | null = null;
  /** Tiles built ahead of time (null before start or when off). */
  let prebuilder: TilePrebuilder | null = null;
  /** The data worker's tide run (relayed to the tiles workers). */
  let tidesRun: ArcoRun | null = null;
  /** Bumped by every start/stop, so a start still downloading the coastline does not carry on after a stop. */
  let startGen = 0;
  /** A route started before the first forecast was ready: sent to the route worker when it is (see startServices). */
  let waitingForForecast: Job | null = null;
  /** The job last sent to the route worker: only it can be cancelled through the worker's flag (see cancelRunning). */
  let routeAtWorker: string | null = null;

  /** Why the services are not up yet, for API answers and the status (`starting`). */
  function notStartedReason(): string {
    if (stopped) return 'plugin not started';
    if (internet.settling) return 'starting: waiting for the internet state from signalk-internet';
    if (coast.held)
      return `starting: the coastline download waits (${coast.held}); press Download coastline in the plugin configuration to download it now`;
    if (coast.state.downloading) {
      const m = (coast.state.message ?? '').replace(/^coastline:\s*/, '');
      return `starting: downloading the coastline${m ? ` (${m})` : ' (GSHHG, {dataSize:149000000}, once)'}`;
    }
    if (coast.state.error)
      return `starting: the coastline download failed (${coast.state.error}); it is tried again every 10 minutes, or press Download coastline in the plugin configuration`;
    return 'starting';
  }

  /**
   * Send a job to the route worker, with the areas to avoid marked on Signal K
   * notes (read here: the workers have no Resources API). With avoidance on,
   * notes that cannot be read fail the job rather than route without them.
   */
  async function dispatchRoute(job: Job): Promise<void> {
    let avoid: AvoidArea[] = [];
    if (job.request.avoid_areas !== false) {
      let failure: string | null = null;
      if (!app.resourcesApi?.listResources) failure = 'this Signal K server has no Resources API to read notes from';
      else {
        try {
          avoid = avoidAreasFromNotes(await app.resourcesApi.listResources('notes', {}));
        } catch (err) {
          failure = `the Signal K notes could not be read (${(err as Error).message})`;
        }
      }
      if (failure) {
        if (!jobs || jobs.runningId !== job.id) return; // cancelled meanwhile
        jobs.onError(job.id, `${failure}, so the areas to avoid are unknown; try again, or turn off Avoid marked areas`);
        updateStatus();
        return;
      }
    }
    if (!jobs || jobs.runningId !== job.id) return; // cancelled meanwhile
    routeAtWorker = job.id;
    // Cleared here, not by the worker when the route starts: a cancel between this post and the start stays set.
    Atomics.store(pool.cancelFlag, 0, 0);
    pool.post('route', { type: 'route', id: job.id, request: job.request, avoid, self: selfDesign() });
  }

  /** Stop the running job: the route worker checks the flag; one still waiting for the first forecast fails at once. */
  function cancelRunningJob(id: string): void {
    // Still waiting for the first forecast: nothing was sent to the worker.
    if (waitingForForecast && waitingForForecast.id === id) {
      waitingForForecast = null;
      jobs?.onError(id, 'cancelled', true);
      return;
    }
    // Running but not sent yet (dispatchRoute is reading the notes): dispatchRoute clears the flag before it
    // posts the route, so the flag would be lost. Finished here; dispatchRoute sees it is no longer running and drops it.
    if (routeAtWorker !== id) {
      jobs?.onError(id, 'cancelled', true);
      return;
    }
    Atomics.store(pool.cancelFlag, 0, 1);
  }

  /** Send a job waiting for the first forecast to the route worker. */
  function releaseWaitingJob(note: string): void {
    const job = waitingForForecast;
    if (!job) return;
    waitingForForecast = null;
    // It may have failed meanwhile (route worker crash/exit: failRunning).
    if (!jobs || jobs.runningId !== job.id || jobs.get(job.id)?.status !== 'running') return;
    jobs.onProgress(job.id, 0, 0, note);
    void dispatchRoute(job);
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
    // Downloaded meshes live in the data directory (plugin/meshes.ts).
    c.mesh.storeDir = path.join(app.getDataDirPath(), 'mesh');
    return c;
  }

  const log = (msg: string): void => app.debug(msg);
  const publicDir = path.join(__dirname, '..', 'public');
  const isTs = __filename.endsWith('.ts');
  const workerPath = path.join(__dirname, 'plugin', isTs ? 'worker.ts' : 'worker.js');
  const execArgv = isTs ? ['--import', 'tsx'] : [];

  /** Why background downloads wait now (signalk-internet's state), or null. */
  const internet = new InternetGate(app);
  const internetHeld = (): string | null => internet.hold();
  const coast = new Coastline(app, log, internet);
  const meshes = new MeshManager(
    m => log(`meshes: ${m}`),
    name => void rebuildRoughCuts(name),
    internet
  );

  /**
   * The rough cuts of the chart meshes (plugin/meshcoarse.ts, docs/drafts/mesh-no-gshhg-design.md part 4): built
   * for the boat's Signal K draught and air draft after a mesh download or update, and on the configuration panel's
   * Rebuild button; never at start (the owner's choice, 2026-10-12). One mesh folder at a time, each in a child
   * process, with its joins to every other mesh folder whose extent meets it (part 5, meshcoarse.ts); after one mesh
   * is downloaded or updated, the other meshes' joins towards its new build too. A route needing one not built yet
   * builds it itself (worker/route.ts).
   */
  const roughCut: {
    running: string | null;
    done: number;
    total: number;
    again: boolean;
    last: {
      at: string;
      built: number;
      ms: number;
      draught_m: number;
      air_draft_m: number;
      buffer_m: number;
      drawbridges: 'open' | 'avoid';
      removed: number;
    } | null;
    error: string | null;
  } = { running: null, done: 0, total: 0, again: false, last: null, error: null };
  let roughCutCtrl: AbortController | null = null;
  async function rebuildRoughCuts(only?: string): Promise<void> {
    if (!config || stopped) return;
    if (roughCut.running) {
      roughCut.again = true;
      return;
    }
    const dataDir = app.getDataDirPath();
    const self = selfDesign();
    if (self.draughtM === null || self.airDraftM === null) {
      roughCut.error = "the boat's draught or air draft is not set in Signal K (design.draft.maximum, design.airHeight)";
      return;
    }
    // The routes' own rules by default: the buffer from unusable water and the Drawbridges choice (Defaults).
    const rules = coarseRulesOf({
      draughtM: self.draughtM,
      airDraftM: self.airDraftM,
      underKeelClearanceM: config.vessel.underKeelClearanceM,
      overheadClearanceM: config.vessel.overheadClearanceM,
      bufferM: config.routing.navigableBufferM,
      openingBridges: config.routing.drawbridges === 'avoid' ? 'avoid' : 'open',
    });
    const open = meshesToOpen(
      config.mesh.storeDir ? readyMeshDirs(config.mesh.storeDir) : [],
      localMeshes(config.meshDir),
      config.mesh.disabled,
      config.mesh.preferLocal,
      config.mesh.preferDownload
    );
    const all = open.flatMap(m => m.dirs.map(d => ({ name: m.name, dir: d })));
    const dirs = all.filter(d => !only || d.name === only);
    /** The other mesh folders whose extent meets this one's, with their rough-cut map files for the rules. */
    const othersOf = (d: { dir: string }): { dir: string; mapFile: string; name: string }[] =>
      all
        .filter(o => o.dir !== d.dir && meshesMeet(o.dir, d.dir))
        .map(o => ({ dir: o.dir, mapFile: coarseFile(dataDir, o.dir, rules), name: o.name }));
    roughCutCtrl = new AbortController();
    const signal = roughCutCtrl.signal;
    roughCut.error = null;
    roughCut.done = 0;
    roughCut.total = dirs.length;
    const t0 = Date.now();
    try {
      for (const d of dirs) {
        if (signal.aborted) return;
        roughCut.running = `${d.name} (${path.basename(d.dir)})`;
        const out = coarseFile(dataDir, d.dir, rules);
        // One build of a file at a time, here or in a route (worker/route.ts ensureRoughCut): one under way is waited for.
        const { result: r } = await withBuildLock(
          out,
          () => runChildTask({ task: 'mesh-coarse', dir: d.dir, out, rules, joins: othersOf(d) }, 15 * 60_000, signal),
          { signal, onWait: () => (roughCut.running = `${d.name} (${path.basename(d.dir)}): waiting for a route's build of it`) }
        );
        roughCut.done++;
        if (r)
          log(
            `rough cut ${d.name} ${path.basename(d.dir)}: ${r.pieces} pieces, ${r.links} links, ${r.bytes} bytes in ${r.ms} ms` +
              (r.joins.length ? `; joins ${r.joins.map(j => `to ${j.name} ${j.joins} (${j.ms} ms)`).join(', ')}` : '')
          );
        else log(`rough cut ${d.name} ${path.basename(d.dir)}: built meanwhile by a route`);
      }
      // One mesh new or updated: the other meshes' joins towards its new build (their rough cuts already built).
      if (only)
        for (const o of all.filter(x => x.name !== only)) {
          const mapFile = coarseFile(dataDir, o.dir, rules);
          if (!fs.existsSync(mapFile)) continue;
          for (const d of dirs) {
            if (signal.aborted) return;
            if (!meshesMeet(o.dir, d.dir)) continue;
            roughCut.running = `joins of ${o.name} (${path.basename(o.dir)}) to ${d.name}`;
            const { result: j } = await withBuildLock(
              joinsFile(mapFile, d.dir),
              () =>
                runChildTask(
                  {
                    task: 'mesh-joins',
                    dir: o.dir,
                    mapFile,
                    rules,
                    other: { dir: d.dir, mapFile: coarseFile(dataDir, d.dir, rules), name: d.name },
                  },
                  15 * 60_000,
                  signal
                ),
              { signal }
            );
            if (j) log(`rough cut joins ${o.name} ${path.basename(o.dir)} to ${d.name}: ${j.joins} in ${j.ms} ms`);
          }
        }
      const removed = pruneCoarse(dataDir, new Set(open.flatMap(m => m.dirs.map(d => coarseKey(d)))));
      roughCut.last = {
        at: new Date().toISOString(),
        built: dirs.length,
        ms: Date.now() - t0,
        draught_m: rules.draughtM,
        air_draft_m: rules.airDraftM,
        buffer_m: rules.bufferM,
        drawbridges: rules.openingBridges,
        removed,
      };
    } catch (err) {
      if (!signal.aborted) {
        roughCut.error = (err as Error).message;
        app.error(`rough cut: ${roughCut.error}`);
      }
    } finally {
      roughCut.running = null;
      roughCutCtrl = null;
      if (roughCut.again && !stopped) {
        roughCut.again = false;
        void rebuildRoughCuts();
      }
    }
  }
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
      // A decode in progress died with it (the restart's refresh reports afresh).
      if (role === 'data') forecastLoading = null;
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
    if (rtofsShared) m.push({ type: 'rtofs', rtofs: rtofsShared });
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
    const steps = forecastRun?.index.steps;
    tiles.store.setGenerations(
      tileGenerationKeys({
        coast: cfg.landShapefiles.join('|'),
        forecast:
          forecastRun && steps
            ? {
                cycleTimeMs: forecastRun.index.cycleTimeMs,
                params: forecastRun.index.request.params,
                lastValidMs: steps[steps.length - 1].validMs,
              }
            : null,
        currents: dataStatus
          ? {
              sources: currentsKey,
              smoc: smocShared ? `${smocShared.run.key}|${smocShared.run.settled}` : 'off',
              harmonicDir: cfg.currents.harmonicDir ?? '',
              smocStepS: cfg.currents.smocStepS,
              rtofsStepS: cfg.currents.rtofsStepS,
              rtofsHorizonS: cfg.currents.rtofsHorizonS,
            }
          : null,
        tides: !cfg.tides.enabled ? 'off' : dataStatus?.tides ? { run: dataStatus.tides.run, settled: dataStatus.tides.settled } : null,
      })
    );
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

  /** `user`: the owner asked (Refresh): it downloads whatever the internet state (internet.ts). */
  function requestRefresh(force: boolean, user = false): void {
    if (!pool.ready('data')) {
      pendingRefresh = { force: (pendingRefresh?.force ?? false) || force, user: (pendingRefresh?.user ?? false) || user };
      return;
    }
    refreshPosition = vesselPosition();
    const hold = user ? null : internetHeld();
    if (hold && !refreshHeld) log(`forecast and currents: ${hold}; using what is on disk until it is online again`);
    // A Refresh press leaves it: pressed while offline it fails, and the held round must still run once online.
    if (!user) refreshHeld = hold !== null;
    pool.post('data', { type: 'refresh', force, position: refreshPosition, hold });
  }

  /**
   * Between refresh rounds: a refresh at once when the vessel's first
   * position arrives (the round at start often runs before the first fix,
   * leaving SMOC without its resident area and RTOFS without a product), or
   * when the vessel is in another RTOFS product than the data worker chose
   * (by the extents it keeps on disk).
   */
  function checkPosition(): void {
    if (stopped || !config) return;
    if (refreshHeld && !internetHeld()) {
      log('the internet connection is usable again; refreshing');
      requestRefresh(false);
      return;
    }
    const pos = vesselPosition();
    if (!pos) return;
    if (!refreshPosition) {
      log(`vessel position ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)} known now; refreshing`);
      requestRefresh(false);
      return;
    }
    const r = config.currents.rtofsEnabled ? dataStatus?.rtofs : null;
    if (!r) return;
    const product = chooseRtofsProduct(readRtofsExtents(path.join(app.getDataDirPath(), 'rtofs')), pos).product;
    if (product === r.auto) {
      positionRefreshFor = null;
      return;
    }
    if (product === positionRefreshFor) return;
    positionRefreshFor = product;
    log(`vessel moved ${product ? `into RTOFS product ${product}` : `out of RTOFS product ${r.auto}`}; refreshing`);
    requestRefresh(false);
  }

  function jobsSummary(): string {
    if (!jobs) return 'no jobs';
    return `${jobs.runningId ? 1 : 0} running, ${jobs.queueLength} queued`;
  }

  /**
   * The vessel's draught and air draft from Signal K's vessel base data
   * (design.draft.maximum, design.airHeight), null where unset. Like the
   * name, not plugin settings; the chart mesh needs both.
   */
  function selfDesign(): SelfDesign {
    const num = (path: string, key: string | undefined, range: readonly [number, number]): number | null => {
      try {
        return selfDesignValue(app.getSelfPath?.(path) as unknown, key, range);
      } catch {
        return null;
      }
    };
    return { draughtM: num('design.draft', 'maximum', DRAUGHT_M_RANGE), airDraftM: num('design.airHeight', undefined, AIR_DRAFT_M_RANGE) };
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

  /** Does the forecast in use carry waves? */
  function forecastHasWaves(): boolean {
    if (!forecastRun) return false;
    return dataStatus?.forecast?.hasWaves ?? forecastRun.index.steps.every(s => ['swh', 'mwp', 'mwd'].every(p => s.params.includes(p)));
  }

  /** How fresh every source in use is, by its own cadence (plugin/freshness.ts). */
  function freshnessList(nowMs: number): Freshness[] {
    if (!config) return [];
    const cfg = config;
    const out: Freshness[] = [ecmwfFreshness(forecastRun?.index.cycleTimeMs ?? null, cfg.forecast.horizonS, forecastHasWaves(), nowMs)];
    // Regional models layered over the wind: those decoded or waiting to be (not the ones skipped as no finer than ECMWF).
    const decoded = new Map((dataStatus?.regional ?? []).map(d => [d.source, d]));
    for (const s of regionalStatus().sources) {
      const d = decoded.get(s.name);
      if (!s.run || s.problem || d?.skipped) continue;
      out.push(regionalFreshness(s.name, s.model, d?.cycle ?? null, nowMs));
    }
    const currents = dataStatus?.currents ?? [];
    let smoc = false;
    for (const c of currents) {
      if (c.smoc) {
        smoc = true;
        out.push(arcoFreshness(c.name, ['currents'], c.smoc.run, c.smoc.metadata_modified, nowMs));
      } else if (c.name.startsWith('RTOFS-')) {
        const run = rtofsShared?.runs.find(r => `RTOFS-${r.product}` === c.name);
        out.push(rtofsFreshness(c.name, run?.runMs ?? null, cfg.currents.rtofsHorizonS, nowMs));
      } else out.push(harmonicFreshness(c.name));
    }
    if (cfg.currents.smocEnabled && !smoc) out.push(arcoFreshness(SMOC_NAME, ['currents'], null, null, nowMs));
    // An RTOFS product wanted but not loaded is red. None is wanted where no product covers the vessel: no entry,
    // the header says why (status `rtofs`).
    const r = cfg.currents.rtofsEnabled ? dataStatus?.rtofs : null;
    for (const p of new Set([...(r?.auto ? [r.auto] : []), ...(r?.extra ?? [])]))
      if (!currents.some(c => c.name === `RTOFS-${p}`)) out.push(rtofsFreshness(`RTOFS-${p}`, null, cfg.currents.rtofsHorizonS, nowMs));
    for (const e of dataStatus?.harmonicErrors ?? []) out.push(harmonicFailure(e));
    if (cfg.tides.enabled) {
      const t = dataStatus?.tides ?? null;
      out.push(arcoFreshness(SL_NAME, ['tides'], t?.run ?? null, t?.metadata_modified ?? null, nowMs));
    }
    return out;
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
      app.setPluginStatus(`${forecastWaitText()}; ${jobsSummary()}`);
    }
  }

  /** "loading the forecast: 06Z, decoding step 12 of 37 (first start)": what a user waits for. */
  function forecastWaitText(): string {
    const l = forecastLoading;
    if (!l) return 'loading the forecast';
    const why =
      l.why === 'first'
        ? ' (first start)'
        : l.why === 'redecode'
          ? ' (the forecast on disk does not fit the current settings or is incomplete, so it is decoded again)'
          : '';
    if (l.phase === 'checking') return `loading the forecast: finding the newest ECMWF cycle${why}`;
    const cyc = l.cycle ? `${l.cycle.slice(11, 13)}Z ` : '';
    const step = l.total ? `step ${l.done} of ${l.total}` : 'starting';
    return `loading the forecast: decoding the ${cyc}cycle, ${step}${why}`;
  }

  /**
   * While no forecast is loaded (and none has failed for good): what the
   * API answers map and point requests with at once, instead of queueing
   * them behind the decode. Null once a forecast serves.
   */
  function forecastWait(): { error: string; loading: ForecastLoading | null } | null {
    if (stopped || !jobs || forecastRun) return null;
    if (!forecastLoading && forecastError) return null;
    return { error: forecastWaitText(), loading: forecastLoading };
  }

  function notify(job: Job, state: 'normal' | 'alert' | 'warn', message: string): void {
    notifyAt(job.id, state, message);
  }

  /** A departure window finished: one notification for it (its departures' routes send none). */
  function notifyWindow(w: DepartureWindow): void {
    const { state, message } = windowNotification(w);
    notifyAt(w.id, state, message);
  }

  function notifyAt(id: string, state: 'normal' | 'alert' | 'warn', message: string): void {
    if (!config?.publish.notifications || !app.handleMessage) return;
    try {
      app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              {
                path: `notifications.weatherRouterPlus.${id}`,
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
    const job = jobs.full(id);
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
          const { force, user } = pendingRefresh;
          pendingRefresh = null;
          requestRefresh(force, user);
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
      case 'forecast-check':
        if (role !== 'data') return;
        forecastCheck = msg.check;
        // Only a check that reached ECMWF and found the newest run in use (or brought a new one) clears the error line.
        if (msg.check.outcome === 'newest' || msg.check.outcome === 'new-run') forecastError = null;
        updateStatus();
        return;
      case 'forecast-loading': {
        if (role !== 'data') return;
        const prev = forecastLoading;
        forecastLoading = msg.loading;
        updateStatus();
        // A route waiting for the forecast says how far it is, in the same words
        // (a new phase, then every 5 steps, not each one).
        const l = msg.loading;
        if (waitingForForecast && l && (prev?.phase !== l.phase || l.done % 5 === 0 || l.done === l.total))
          jobs?.onProgress(waitingForForecast.id, 0, 0, `waiting for the forecast: ${forecastWaitText()}`);
        return;
      }
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
          // New RTOFS on disk (a new run or another product): the route worker reloads its copy from the cache.
          const key = `${msg.status.map(c => c.name).join('+')}|${msg.rtofsRuns.join(',')}`;
          if (key !== currentsKey) {
            const first = currentsKey === '';
            currentsKey = key;
            updateTileGenerations();
            if (!first || msg.rtofsRuns.length) {
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
      case 'rtofs':
        if (role === 'data') {
          // Products loaded under settings that have since changed are dropped here (and by the workers).
          if (msg.rtofs && !(config && rtofsSetForConfig(msg.rtofs, config.currents.rtofsEnabled, config.currents.rtofsExtra))) return;
          rtofsShared = msg.rtofs;
          pool.post('route', { type: 'rtofs', rtofs: msg.rtofs });
          prebuilder?.broadcast({ type: 'rtofs', rtofs: msg.rtofs });
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
          // A departure window's routes: one notification for the window when it is done (notifyWindow).
          if (!job.windowId)
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
        if (job && !msg.cancelled && !job.windowId) notify(job, 'alert', `route failed: ${siText(msg.message)}`);
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
    const prevConfig = config;
    config = resolve(pluginOptions, settings.values);
    // What the data worker reloads (worker.ts 'config'), and relays again when it has.
    if (out.currents && prevConfig) {
      if (!smocLoadSame(prevConfig, config)) smocShared = null;
      if (!rtofsLoadSame(prevConfig, config)) rtofsShared = null;
    }
    if (out.forecast || out.currents || out.tides) updateTileGenerations();
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
        initMessage: () => ({ type: 'init', role: 'tiles', config: config as ResolvedConfig, cacheDir: dataDir }),
        replayMessages: () => {
          const m = sharedDataMessages();
          m.push({ type: 'tides-run', run: tidesRun });
          m.push({ type: 'refresh', force: false });
          return m;
        },
        vesselPosition,
        // Every layer to the forecast horizon (the owner's decision, 2026-10-22: one horizon); tides also no further
        // than their run.
        lastHourMs: layer => {
          if (!forecastRun) return null;
          const end = forecastRun.index.steps[forecastRun.index.steps.length - 1].validMs;
          if (layer === 'tide') return tidesRun ? Math.min(runLastMs(tidesRun), end) : null;
          return end;
        },
        // Each layer at its data's steps (prebuild.ts hasStep); the map draws the hours between on demand.
        atStep: (layer, hourMs) =>
          hasStep(tileGroup(layer), hourMs, {
            forecast: forecastRun ? forecastRun.index.steps.map(s => s.validMs) : null,
            rtofs: rtofsShared ? [...new Set(rtofsShared.runs.flatMap(r => r.steps.map(s => s.validMs)))] : [],
            smocStepMs: smocShared ? smocShared.settings.stepS * 1000 : null,
            harmonic: !!harmonicShared?.length,
          }),
        layerAvailable: layer => charts.layerAvailable(layer),
        // Held by the internet state too: the builders load SMOC and tide areas they lack from the network.
        busy: () => !!jobs?.runningId || pool.pendingCount > 0 || internetHeld() !== null,
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
      for (const n of loaded.notes) log(`settings: ${n}`);
      config = resolve(options, settings.values);
    } catch (err) {
      app.setPluginError((err as Error).message);
      throw err;
    }
    const gen = ++startGen;
    const dataDir = app.getDataDirPath();
    // Before the first download, so a backup taken meanwhile already skips them.
    for (const p of tagCacheDirs(dataDir)) app.error(`cache directory tag: ${p}`);
    // signalk-internet starts beside this plugin: its first state decides whether the first downloads run. Not awaited.
    void internet
      .settle(() => gen === startGen && !stopped)
      .then(ok => {
        if (ok) startData(options, gen, dataDir);
      })
      .catch(err => {
        if (gen === startGen && !stopped) app.setPluginError(`start failed: ${(err as Error).message}`);
      });
  }

  /** The coastline (configured, or downloaded first), then the services. */
  function startData(options: PluginConfig, gen: number, dataDir: string): void {
    if (!config) return;
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
    // Managed chart meshes: read the catalogue, download the ticked ones, drop the rest; daily thereafter. Not awaited.
    meshes.configure(
      config.mesh.catalogUrl,
      config.mesh.downloads,
      config.mesh.storeDir,
      config.mesh.disabled,
      config.meshDir,
      config.mesh.preferLocal,
      config.mesh.preferDownload
    );
    meshes.run();
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
        // The first forecast was held back (internet.ts), or its round still waits for the data worker: a route is
        // the owner asking, so it downloads now.
        if (refreshHeld || pendingRefresh) requestRefresh(false, true);
        jobs?.onProgress(job.id, 0, 0, `waiting for the forecast: ${forecastWaitText()}`);
        updateStatus();
        return;
      }
      void dispatchRoute(job);
      updateStatus();
    });
    windows = new WindowManager(
      jobs,
      dataDir,
      {
        cancelRunning: cancelRunningJob,
        forecastValidToMs: () => (forecastRun ? forecastRun.index.steps[forecastRun.index.steps.length - 1].validMs : null),
        onFinished: notifyWindow,
      },
      BASE_PATH
    );
    for (const role of ['data', 'route'] as MainRole[]) {
      pool.start(role);
      pool.post(role, { type: 'init', role, config, cacheDir: dataDir });
    }
    requestRefresh(false);
    refreshTimer = setInterval(() => requestRefresh(false), config.forecast.refreshIntervalS * 1000);
    positionTimer = setInterval(checkPosition, POSITION_CHECK_MS);
    updateStatus();
    log(`${PLUGIN_ID} started; data dir ${dataDir}`);
  }

  async function stop(): Promise<void> {
    stopped = true;
    startGen++;
    coast.abort();
    meshes.stop();
    roughCutCtrl?.abort();
    if (refreshTimer) clearInterval(refreshTimer);
    if (positionTimer) clearInterval(positionTimer);
    if (failedRefreshTimer) clearTimeout(failedRefreshTimer);
    refreshTimer = failedRefreshTimer = positionTimer = null;
    refreshPosition = null;
    positionRefreshFor = null;
    refreshHeld = false;
    pool.stopAll();
    pool.rejectPending('plugin stopped');
    // The windows first: failing the running job must not start a window's next departure.
    windows?.close();
    windows = null;
    jobs?.failRunning('plugin stopped');
    waitingForForecast = null;
    routeAtWorker = null;
    jobs = null;
    prebuilder?.stop();
    prebuilder = null;
    tidesRun = null;
    // Awaited: Signal K waits for stop() before a restart's start(), whose store reads the saved totals.
    await tiles?.store.flushTotals();
    tiles = null;
    forecastRun = null;
    forecastLoading = null;
    routeForecastMemory = null;
    smocShared = null;
    rtofsShared = null;
    harmonicShared = null;
    routeCurrents = null;
    currentsKey = '';
    dataStatus = null;
    config = null;
    log(`${PLUGIN_ID} stopped`);
  }

  /** The rough cuts for the panel: what is building, the last build, its error, and the boat they are for. */
  function roughCutStatus(): Record<string, unknown> {
    const self = selfDesign();
    return {
      running: roughCut.running,
      done: roughCut.done,
      total: roughCut.total,
      last: roughCut.last,
      error: roughCut.error,
      draught_m: self.draughtM,
      air_draft_m: self.airDraftM,
    };
  }

  function registerWithRouter(router: IRouter): void {
    registerApi(router, {
      pluginId: PLUGIN_ID,
      basePath: BASE_PATH,
      get jobs(): JobManager {
        if (!jobs) throw new NotStartedError(notStartedReason());
        return jobs;
      },
      get windows(): WindowManager {
        if (!windows) throw new NotStartedError(notStartedReason());
        return windows;
      },
      notReady: notStartedReason,
      forecastWait,
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
              has_waves: forecastHasWaves(),
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
        // What the last check of each source found; ECMWF's as the main thread last heard it.
        checks: { ...(dataStatus?.checks ?? {}), ...(forecastCheck ? { ecmwf: forecastCheck } : {}) },
        // How fresh each source in use is (green / orange / red) by its own cadence.
        freshness: freshnessList(Date.now()),
        // Whether the data worker's last request reached a server; separate from freshness.
        connectivity: dataStatus?.connectivity ?? null,
        currents: dataStatus?.currents ?? [],
        currents_route_worker: routeCurrents ?? [],
        corridor_fallbacks: corridorFallbacks,
        rtofs: dataStatus?.rtofs
          ? {
              auto: dataStatus.rtofs.auto,
              auto_reason: dataStatus.rtofs.autoReason,
              extra: dataStatus.rtofs.extra,
              runs: dataStatus.rtofs.runs,
              unknown_extents: dataStatus.rtofs.unknownExtents,
            }
          : null,
        tides: config?.tides.enabled ? (dataStatus?.tides ?? null) : null,
        tides_enabled: config?.tides.enabled ?? null,
        tides_error: dataStatus?.tidesError ?? null,
        overlay_land: dataStatus?.land ?? null,
        overlay_tiles: tiles ? { ...tiles.store.stats(), inflight: tiles.inflightCount } : null,
        overlay_prebuild: prebuilder ? prebuilder.status() : null,
        starting: !jobs && !stopped ? notStartedReason() : null,
        // What the data worker is doing to get a forecast; also while a newer cycle decodes behind the one in use.
        forecast_loading: forecastLoading
          ? {
              phase: forecastLoading.phase,
              why: forecastLoading.why,
              cycle: forecastLoading.cycle,
              done: forecastLoading.done,
              total: forecastLoading.total,
              started_at: forecastLoading.startedAt,
              text: forecastWaitText(),
            }
          : null,
        coastline: {
          configured: pluginOptions?.landShapefiles?.trim() ? pluginOptions.landShapefiles : null,
          in_use: config?.landShapefiles ?? null,
          downloaded: gshhgInstalled(app.getDataDirPath()),
          downloaded_at: gshhgInstalledAt(app.getDataDirPath()),
          ...coast.state,
        },
        weather_provider_registered: weatherRegistered,
        meshes: meshes.status(),
        regional: regionalStatus(),
        jobs: jobs ? { running: jobs.runningId, queued: jobs.queueLength, total: jobs.list(500).length } : null,
        windows: windows ? { running: windows.running } : null,
        // The name, draught and air draft are Signal K's (vessels.self.name, design.*), not plugin settings.
        vessel: config?.vessel ? { ...config.vessel, ...selfDesign(), name: selfName() } : undefined,
        polar: config?.polarFile,
        router: config?.routing.router,
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
      refreshForecast: force => requestRefresh(force, true),
      cancelRunning: cancelRunningJob,
      publish,
      query,
      tiles: () => tiles,
      regionalRuns: () => (dataStatus?.regional ?? []).map(r => ({ name: r.source, cycle: r.cycle })),
      chartGroups: () => charts.groups(),
      chartRows: () => charts.chartRows(),
      downloadCoastline: () => coast.requestDownload(),
      meshes: () => ({ ...meshes.status(), rough_cut: roughCutStatus() }),
      refreshMeshes: () => meshes.refresh(),
      rebuildRoughCuts: () => {
        if (!config || stopped) throw new NotStartedError();
        void rebuildRoughCuts();
        return roughCutStatus();
      },
      // A mesh action from the panel: the download list changes in the plugin's own options (saved, no
      // restart), the manager takes the new list, and a pass runs. The answer carries the list so the
      // panel's form does not put an old one back on its next Save.
      meshAction: async (name, action) => {
        if (!config || !pluginOptions || stopped) throw new NotStartedError();
        const list = new Set(config.mesh.downloads);
        if (action === 'remove' || action === 'cancel') list.delete(name);
        else list.add(name);
        const downloads = [...list];
        const next: PluginConfig = { ...pluginOptions, mesh: { ...(pluginOptions.mesh ?? {}), downloads } };
        if (app.savePluginOptions)
          await new Promise<void>((resolve, reject) => app.savePluginOptions!(next, err => (err ? reject(err) : resolve())));
        // Only once the options are saved: a failed save leaves no request behind for a later pass to act on.
        pluginOptions = next;
        config.mesh.downloads = downloads;
        meshes.setDownloads(downloads);
        if (action === 'redownload') meshes.redownload(name);
        if (action === 'download' || action === 'update') meshes.request(name);
        if (action === 'cancel') meshes.cancel(name);
        await meshes.refresh();
        return { downloads, ...meshes.status(), rough_cut: roughCutStatus() };
      },
      noteTileRequest: (z, x, y) => prebuilder?.noteRequest(z, x, y),
      publicDir,
      polarLibrary: () => (config ? { polarFile: config.polarFile, polarsDir: config.polarsDir, userDir: config.polarUserDir } : null),
      getSettings: () => {
        if (!settings || stopped) throw new NotStartedError();
        return { values: settings.values, schema: settingsSchema() };
      },
      sharedPrefs: new SharedPrefsStore(app.getDataDirPath()),
      // Unknown (no strategy): treated as security on, so the shared store is never opened by mistake.
      securityOff: () => app.securityStrategy?.isDummy?.() === true,
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
