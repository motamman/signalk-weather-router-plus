/**
 * Worker thread. Two instances run with different roles (protocol.ts):
 *  - data:  refreshes ECMWF, CMEMS SMOC and RTOFS from the network,
 *           decodes each new ECMWF run to disk one step at a time
 *           (decoded.ts; nothing of it stays in memory), loads the SMOC
 *           resident area (SharedArrayBuffers), keeps the current stack
 *           and the on-demand overlay land masks, and answers overlay /
 *           conditions / Weather API queries by reading the grid cells
 *           and steps each one needs from the decoded run into a store
 *           dropped after the answer (loading SMOC on demand first when
 *           the query box is outside what is resident);
 *  - route: before a route, reads the route area (corridor box plus a
 *           margin, the fields the engine uses, every step) of the
 *           decoded run into one block and drops it when the route ends;
 *           uses the SMOC resident memory (relayed by the main thread,
 *           not copied), with RTOFS loaded from the disk cache; before a
 *           route whose box the SMOC resident area does not cover it
 *           loads that area itself (disk cache, else network) and drops
 *           it after the route, so a long route never delays an overlay
 *           query.
 * The data worker also holds the Copernicus Marine sea level (tides):
 * point series for conditions / Weather API queries (geoChunked, on
 * demand) and the tide-height map field (a resident area around the
 * vessel plus on-demand areas). The route worker does not use tides.
 * The route worker also holds the global water grid (corridor search):
 * the shipped grid, or one rebuilt into the data directory by a builder
 * thread when the configured coastline differs from the shipped grid's.
 * Cancellation of the running route is a shared Int32 flag.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { HOUR_S } from '../geo/units';
import * as path from 'node:path';
import { ECMWF_MIRRORS, EcmwfClient } from '../data/ecmwf';
import { DecodedRun } from '../data/decoded';
import { OnDemandLand } from '../geo/landcache';
import { PolarDiagram } from '../vessel/polar';
import { HarmonicCurrentSource } from '../currents/harmonic';
import { CurrentStack } from '../currents/stack';
import { RtofsClient, RtofsCurrentSource, rtofsForRegion } from '../currents/rtofs';
import { SmocCurrentSource } from '../currents/smoc';
import { TideSource } from '../tides/sealevel';
import { type MainToWorker, type WorkerRole, type WorkerToMain } from './protocol';
import { requireInit } from './worker/state';
import { refreshForecast } from './worker/forecast';
import { prepareWaterGrid } from './worker/landgrid';
import {
  loadHarmonic,
  makeSmocClient,
  rebuildStack,
  refreshRtofs,
  refreshSmoc,
  sendCurrents,
  sendRtofs,
  sendSmoc,
} from './worker/currents';
import { makeSeaLevelClient, refreshTides, tideSettings } from './worker/tides';
import { refreshRegional } from './worker/regional';
import { route } from './worker/route';
import { dataStatus, query } from './worker/query';
import type { WorkerState } from './worker/state';

/**
 * The parent: a worker thread's port (data, route), or the IPC channel of a
 * child process (tiles: the prebuilder runs tile building in separate
 * processes that exit when a walk is done, so their memory goes back to the
 * system; see prebuild.ts). Same messages either way.
 */
interface ParentChannel {
  postMessage(m: WorkerToMain): void;
  on(event: 'message', fn: (m: MainToWorker) => void): void;
}
function childProcessChannel(): ParentChannel {
  if (typeof process.send !== 'function') throw new Error('worker.ts must run as a worker thread or a forked child process');
  // The parent is gone (plugin stopped, Signal K exited): nothing left to work for.
  process.on('disconnect', () => process.exit(0));
  return {
    postMessage: m => {
      if (process.connected) process.send!(m);
    },
    on: (_event, fn) => process.on('message', fn as (m: unknown) => void),
  };
}
const port: ParentChannel = parentPort ?? childProcessChannel();
const role: WorkerRole = parentPort ? (workerData.role as WorkerRole) : ((process.env.WRP_WORKER_ROLE as WorkerRole) ?? 'tiles');
const send = (m: WorkerToMain): void => port.postMessage(m);
const st: WorkerState = {
  role,
  // A child process has no shared memory with the parent; nothing cancels tile queries through the flag.
  cancelFlag: new Int32Array(parentPort ? (workerData.cancelFlag as SharedArrayBuffer) : new SharedArrayBuffer(4)),
  send,
  log: (level, message) => send({ type: 'log', level, message: `[${role}] ${message}` }),
  config: null,
  client: null,
  rtofsClient: null,
  run: null,
  runInfo: null,
  forecastMemory: { heldBytes: 0, last: null },
  lastDecode: null,
  decodingBlockBytes: null,
  diskBytes: { decoded: 0, grib: 0 },
  overlayLand: null,
  polar: null,
  landCache: null,
  harmonic: [],
  rtofs: null,
  smocClient: null,
  smoc: null,
  vesselPos: null,
  stack: new CurrentStack([]),
  reportedLandBuilds: 0,
  reportedSmocRev: -1,
  cacheRoot: '',
  regional: new Map(),
  seaLevelClient: null,
  tides: null,
  tidesError: null,
  reportedTidesRev: -1,
  waterGrid: null,
  gridBuilder: null,
  routeWindow: null,
  routeRegional: [],
  cancelledQueries: new Set<number>(),
};

/**
 * Refresh RTOFS (both roles) and, in the data worker, the forecast and
 * CMEMS SMOC. The route worker never decodes a forecast or loads the SMOC
 * resident area itself: it reads the data worker's decoded run from disk
 * (location relayed by the main thread) and adopts its SMOC memory.
 */
export async function refresh(st: WorkerState, force: boolean): Promise<void> {
  const networkAllowed = st.role === 'data';
  await refreshRtofs(st, networkAllowed);
  sendCurrents(st);
  if (st.role === 'data') {
    await refreshForecast(st, force);
    // After the forecast, so a first boot is not held up by the SMOC resident download.
    await refreshSmoc(st);
    sendCurrents(st);
    await refreshTides(st);
    st.send({ type: 'tides-run', run: st.tides?.run ?? null });
    // Last: optional finer wind from signalk-grib-downloader's runs.
    await refreshRegional(st);
  }
}

export async function handle(st: WorkerState, msg: MainToWorker): Promise<void> {
  switch (msg.type) {
    case 'init': {
      st.config = msg.config;
      st.cacheRoot = msg.cacheDir;
      st.client = new EcmwfClient({
        baseUrl: ECMWF_MIRRORS[st.config.forecast.mirror] ?? ECMWF_MIRRORS.ecmwf,
        cacheDir: path.join(msg.cacheDir, 'ecmwf'),
        log: m => st.log('debug', `ecmwf: ${m}`),
      });
      st.rtofsClient = st.config.currents.rtofsEnabled
        ? new RtofsClient({
            cacheDir: path.join(msg.cacheDir, 'rtofs'),
            region: st.config.currents.rtofsRegion,
            log: m => st.log('debug', m),
          })
        : null;
      st.polar = null;
      if (st.config.polarFile) {
        st.polar = PolarDiagram.load(st.config.polarFile);
        if (st.role === 'route')
          st.log('info', `polar loaded: ${st.config.polarFile} (${st.polar.twa.length} TWA rows × ${st.polar.tws.length} TWS columns)`);
      } else if (st.role === 'route') {
        st.log('info', 'no polar configured: routes will be motor-only');
      }
      if (st.config.landShapefiles.length === 0) throw new Error('no land shapefile configured');
      st.overlayLand =
        st.role === 'data' || st.role === 'tiles'
          ? new OnDemandLand(st.config.landShapefiles, {
              log: m => st.log('debug', m),
              // Rasters saved on disk: a map box seen once is never rasterised again.
              cacheDir: st.cacheRoot ? path.join(st.cacheRoot, 'overlay-land') : undefined,
            })
          : null;
      st.smocClient = makeSmocClient(st, st.config);
      st.smoc = null;
      st.seaLevelClient = makeSeaLevelClient(st, st.config);
      st.tides = null;
      st.tidesError = null;
      // The data worker loads the tidal-harmonic files once and relays the
      // shared constituent blocks; the route worker adopts them ('harmonic').
      if (st.role === 'data') {
        loadHarmonic(st, st.config.currents.harmonicDir);
        st.send({ type: 'harmonic', sources: st.harmonic.map(s => s.serialize()) });
      } else st.harmonic = [];
      rebuildStack(st);
      if (st.role === 'route') {
        try {
          prepareWaterGrid(st, st.config);
        } catch (err) {
          st.waterGrid = null;
          st.log('error', `water grid: ${(err as Error).message}`);
        }
      }
      st.send({ type: 'ready', role: st.role });
      return;
    }
    case 'refresh':
      if (msg.position !== undefined) st.vesselPos = msg.position;
      await refresh(st, msg.force ?? false);
      st.send({ type: 'data-status', status: dataStatus(st) });
      return;
    case 'forecast': {
      // Route / tiles worker: where the current decoded run is (nothing is read until a route or tile needs it).
      if (st.role === 'data') return;
      st.run = msg.run ? new DecodedRun(msg.run.dir, msg.run.index) : null;
      st.runInfo = msg.run;
      if (st.run)
        st.log(
          'info',
          `forecast: routes read from the decoded run ${st.run.dir} (cycle ${st.run.cycleTime.toISOString().slice(0, 13)}Z, ${st.run.index.steps.length} steps, ${(st.run.index.bytes / 1e6).toFixed(1)} MB on disk)`
        );
      return;
    }
    case 'config': {
      const prev = requireInit(st).config;
      st.config = msg.config;
      if (msg.reload.currents) {
        st.rtofsClient = st.config.currents.rtofsEnabled
          ? new RtofsClient({
              cacheDir: st.rtofsClient?.cacheDir ?? path.join(st.cacheRoot, 'rtofs'),
              region: st.config.currents.rtofsRegion,
              log: m => st.log('debug', m),
            })
          : null;
        st.rtofs = null;
        st.smocClient = makeSmocClient(st, st.config);
        st.smoc = null;
        rebuildStack(st);
        if (msg.position !== undefined) st.vesselPos = msg.position;
        // Route worker: SMOC comes back from the data worker (relayed 'smoc').
        if (st.role === 'data') {
          sendSmoc(st);
          await refreshSmoc(st);
        }
        await refreshRtofs(st, st.role === 'data');
        sendRtofs(st); // off, another region or the same run again: the other workers follow the data worker
        sendCurrents(st);
        st.log(
          'info',
          `currents reloaded for the new settings (SMOC ${st.config.currents.smocEnabled ? `${st.config.currents.smocStepS / HOUR_S} h steps, ${st.config.currents.smocHorizonS / HOUR_S} h, ±${st.config.currents.smocHalfWidthDeg}°` : 'off'}; RTOFS ${st.config.currents.rtofsEnabled ? st.config.currents.rtofsRegion : 'off'})`
        );
      }
      if (msg.reload.tides && st.role === 'tiles') {
        // The data worker sends its tide run again after its reload.
        st.seaLevelClient = makeSeaLevelClient(st, st.config);
        st.tides = null;
      }
      if (msg.reload.tides && st.role === 'data') {
        if (msg.position !== undefined) st.vesselPos = msg.position;
        // A provisional run's cached chunks may predate its update: drop them with the old client.
        if (st.tides && st.seaLevelClient && !st.tides.run.settled) st.seaLevelClient.dropRun(st.tides.run.key);
        st.seaLevelClient = makeSeaLevelClient(st, st.config);
        st.tides = null;
        st.tidesError = null;
        await refreshTides(st);
        // refreshTides set `tides` (narrowed to null above for the compiler).
        st.send({ type: 'tides-run', run: (st.tides as TideSource | null)?.run ?? null });
        st.log(
          'info',
          `tides reloaded for the new settings (${st.config.tides.enabled ? `map area ±${st.config.tides.halfWidthDeg}°, ${st.config.tides.horizonS / HOUR_S} h` : 'off'})`
        );
      }
      if (msg.reload.forecast && st.role === 'data') {
        st.log(
          'info',
          `forecast settings changed (horizon ${prev.forecast.horizonS / HOUR_S} → ${st.config.forecast.horizonS / HOUR_S} h, extra fields ${prev.forecast.extraFields} → ${st.config.forecast.extraFields}, solar and radiation fields ${prev.forecast.energyFields} → ${st.config.forecast.energyFields}); reloading`
        );
        await refreshForecast(st, false);
      }
      if (st.role === 'data') st.send({ type: 'data-status', status: dataStatus(st) });
      return;
    }
    case 'route':
      if (st.role !== 'route') {
        st.send({ type: 'error', id: msg.id, message: 'route sent to the data worker' });
        return;
      }
      await route(st, msg.id, msg.request, msg.avoid ?? [], msg.self);
      sendCurrents(st);
      return;
    case 'query':
      await query(st, msg.id, msg.kind, msg.args);
      return;
    case 'harmonic': {
      // Route / tiles worker: the data worker's tidal-harmonic sources (shared constituent blocks).
      if (st.role === 'data') return;
      st.harmonic = msg.sources.map(s => new HarmonicCurrentSource(s));
      rebuildStack(st);
      sendCurrents(st);
      st.log(
        'info',
        `currents: adopted ${st.harmonic.length} tidal-harmonic source(s) from the data worker (${(st.harmonic.reduce((a, s) => a + s.blockBytes(), 0) / 1e6).toFixed(1)} MB shared, no copy)`
      );
      return;
    }
    case 'rtofs': {
      // Route / tiles worker: the data worker's RTOFS run (shared memory).
      if (st.role === 'data') return;
      const cur = requireInit(st).config.currents;
      const run = rtofsForRegion(msg.rtofs, cur.rtofsEnabled, cur.rtofsRegion);
      st.rtofs = run ? RtofsCurrentSource.fromSerialized(run) : null;
      rebuildStack(st);
      sendCurrents(st);
      return;
    }
    case 'smoc': {
      // Route / tiles worker: the data worker's run and resident area (shared memory).
      if (st.role === 'data') return;
      const s = msg.smoc;
      const cfgNow = requireInit(st).config;
      if (!s || !cfgNow.currents.smocEnabled) st.smoc = null;
      else if (
        st.smoc &&
        st.smoc.run.key === s.run.key &&
        st.smoc.run.settled === s.run.settled &&
        JSON.stringify(st.smoc.settings) === JSON.stringify(s.settings)
      )
        st.smoc.setResident(s.resident, s.centre);
      else st.smoc = SmocCurrentSource.fromSerialized(s, st.smocClient, m => st.log('info', m));
      rebuildStack(st);
      sendCurrents(st);
      if (st.smoc)
        st.log(
          'debug',
          `smoc: adopted run ${st.smoc.run.key}${st.smoc.resident ? `, resident ${(st.smoc.memoryBytes() / 1e6).toFixed(1)} MB ${st.smoc.resident.u.buffer instanceof SharedArrayBuffer ? 'shared (no copy)' : 'copied'}` : ', nothing resident'}`
        );
      return;
    }
    case 'tides-run': {
      // Tiles worker: open the data worker's tide run (areas load on demand from the shared disk cache).
      if (st.role !== 'tiles') return;
      const cfgNow = requireInit(st).config;
      if (!msg.run || !cfgNow.tides.enabled || !st.seaLevelClient) st.tides = null;
      else if (!st.tides || st.tides.run.key !== msg.run.key || st.tides.run.settled !== msg.run.settled)
        st.tides = new TideSource(msg.run, tideSettings(cfgNow), st.seaLevelClient, m => st.log('debug', m));
      return;
    }
    case 'shutdown':
      if (st.gridBuilder) await st.gridBuilder.terminate();
      process.exit(0);
  }
}

let chain: Promise<void> = Promise.resolve();
port.on('message', (msg: MainToWorker) => {
  // Not chained: it must reach the queue ahead of the query it cancels.
  if (msg.type === 'query-cancel') {
    st.cancelledQueries.add(msg.id);
    return;
  }
  chain = chain
    .then(() => handle(st, msg))
    .catch(err => {
      st.log('error', `worker: ${(err as Error).stack ?? (err as Error).message}`);
      if (msg.type === 'route') st.send({ type: 'error', id: msg.id, message: (err as Error).message });
      if (msg.type === 'refresh') st.send({ type: 'refresh-error', message: (err as Error).message });
      if (msg.type === 'query') st.send({ type: 'query-error', id: msg.id, message: (err as Error).message });
    });
});
