/**
 * The worker's state: what the role's modules share, created once by worker.ts.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import type { Worker } from 'node:worker_threads';
import type { EcmwfClient, EnsembleModelId } from '../../data/ecmwf';
import type { ForecastStore } from '../../data/forecast';
import type { DecodedRun } from '../../data/decoded';
import type { LandMask } from '../../geo/landmask';
import type { OnDemandLand } from '../../geo/landcache';
import type { WaterGrid } from '../../geo/watergrid';
import type { PolarDiagram } from '../../vessel/polar';
import type { HarmonicCurrentSource } from '../../currents/harmonic';
import type { CurrentStack } from '../../currents/stack';
import type { RtofsClient, RtofsCurrentSource } from '../../currents/rtofs';
import type { SmocClient, SmocCurrentSource } from '../../currents/smoc';
import type { SeaLevelClient, TideSource } from '../../tides/sealevel';
import type { ResolvedConfig } from '../config';
import type { Connectivity, DataStatus, ForecastMemory, ForecastRunInfo, VesselPosition, WorkerRole, WorkerToMain } from '../protocol';

export interface WorkerState {
  readonly role: WorkerRole;
  /** Shared Int32: 1 cancels the running route. */
  readonly cancelFlag: Int32Array;
  readonly send: (m: WorkerToMain) => void;
  readonly log: (level: 'debug' | 'info' | 'error', message: string) => void;
  config: ResolvedConfig | null;
  client: EcmwfClient | null;
  /** RTOFS clients by product (data worker; created as products are wanted). */
  rtofsClients: Map<string, RtofsClient>;
  /** The decoded run in use (on disk; only its index is in memory). */
  run: DecodedRun | null;
  /** How it became current (status). */
  runInfo: ForecastRunInfo | null;
  /** Forecast memory this thread holds (query windows, the route's corridor store). */
  readonly forecastMemory: ForecastMemory;
  /** Last streaming decode (status). */
  lastDecode: DataStatus['lastDecode'];
  /** One-step block size while a decode runs. */
  decodingBlockBytes: number | null;
  /** Bytes of the decoded runs and GRIB cache on disk, refreshed after each forecast check. */
  diskBytes: { decoded: number; grib: number };
  /** On-demand overlay land rasters (data / tiles worker). */
  overlayLand: OnDemandLand | null;
  polar: PolarDiagram | null;
  landCache: { key: string; mask: LandMask } | null;
  harmonic: HarmonicCurrentSource[];
  /** The RTOFS products loaded (data worker) or adopted (route, tiles), finest first. */
  rtofs: RtofsCurrentSource[];
  /** The data worker's last RTOFS choice (status): the product the vessel is in, or why none, and the extents not known. */
  rtofsChoice: { auto: string | null; autoReason: string | null; unknownExtents: string[] } | null;
  smocClient: SmocClient | null;
  smoc: SmocCurrentSource | null;
  /** Last vessel position from the main thread (SMOC resident area centre). */
  vesselPos: VesselPosition | null;
  stack: CurrentStack;
  /** overlayLand.builds when data-status was last sent. */
  reportedLandBuilds: number;
  /** SMOC revision when data-status was last sent. */
  reportedSmocRev: number;
  /** Plugin data directory (cache root). */
  cacheRoot: string;
  /** Regional runs decoded from signalk-grib-downloader, per source (data worker). */
  regional: Map<string, import('../protocol').RegionalDecodeState>;
  /** Copernicus Marine sea level (data worker only). */
  seaLevelClient: SeaLevelClient | null;
  tides: TideSource | null;
  /** Last tide probe / load error (status). */
  tidesError: string | null;
  /** Tide revision when data-status was last sent. */
  reportedTidesRev: number;
  /** Global water grid (route worker). */
  waterGrid: WaterGrid | null;
  /** Builder thread while a rebuild runs. */
  gridBuilder: Worker | null;
  /** The running route's forecast area (released when the route ends). */
  routeWindow: ForecastStore | null;
  /** The running route's regional wind areas (released with the route). */
  routeRegional: ForecastStore[];
  /** Queries the main thread cancelled before they started (its client went away). */
  readonly cancelledQueries: Set<number>;
  /** The last check of each source (data worker). */
  readonly checks: DataStatus['checks'];
  /** What this thread's requests found about the connection (data worker). */
  connectivity: Connectivity;
  /** When a request last found no connection (ms; 0 = never): a refresh round stops asking servers after it. */
  lastOfflineMs: number;
  /** Why background downloads wait now (the main thread's 'internet-hold'), or null (data worker). */
  internetHold: string | null;
  /** A refresh round the owner did not ask for is under way: the internet state starting to hold stops its decode (data worker). */
  backgroundRound: boolean;
  /** Tidal-harmonic files that failed to load (data worker). */
  harmonicErrors: string[];
  /**
   * Tiles worker: the current sources of the last currents reference that could not be read from the disk caches
   * (adoptCurrentsRef). While any are, the current layers' tiles it builds are not kept (buildTile).
   */
  currentsUnread: string[];
  /** Kills the forecast decode child process (plugin stopped). */
  decodeAbort: AbortController | null;
  /** Kills the ensemble download and decode child process (plugin stopped, a hold); null while none runs. */
  ensembleAbort?: AbortController | null;
  /** The ensembles' last pass (data worker, worker/forecast.ts refreshEnsembles): what it is doing, or why it could not. */
  ensembles: Partial<
    Record<
      EnsembleModelId,
      { loading: { cycle: string; done: number; total: number | null } | null; error: string | null; checkedAt: string | null }
    >
  >;
  /**
   * Each chosen ensemble's bytes on disk (decoded runs and GRIB cache): measured by refreshEnsembles at each round and
   * after its pass and prunes, or once by the status for a model not measured yet (worker/forecast.ts ensembleBytesOf).
   */
  ensembleBytes?: Partial<Record<EnsembleModelId, number>>;
}

/** A request's finding about the connection: a server answered ('ok'), or there was no connection ('offline', why). */
export function noteNetwork(st: WorkerState, state: 'ok' | 'offline', reason: string | null): void {
  const now = new Date();
  const c = st.connectivity;
  const online = state === 'ok';
  if (c.online !== online) c.since = now.toISOString();
  c.online = online;
  if (online) {
    c.lastOkAt = now.toISOString();
    c.reason = null;
  } else {
    c.reason = reason;
    st.lastOfflineMs = now.getTime();
  }
}

/** Why a background refresh round (not the owner's) must not download now (the main thread's 'internet-hold'), or null. */
export function backgroundHold(st: WorkerState): string | null {
  return st.backgroundRound ? st.internetHold : null;
}

export function requireInit(st: WorkerState): { config: ResolvedConfig; client: EcmwfClient } {
  if (!st.config || !st.client) throw new Error('worker not initialised');
  return { config: st.config, client: st.client };
}
