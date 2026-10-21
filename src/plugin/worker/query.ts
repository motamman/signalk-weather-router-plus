/**
 * Data / tiles worker: overlay, conditions and Weather API queries read from the decoded run.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ForecastStore } from '../../data/forecast';
import type { DecodedRun, WindowOptions } from '../../data/decoded';
import { LAYER_PARAMS } from '../layers';
import { type BBox } from '../../geo/geodesy';
import {
  conditionsSeries,
  currentPoints,
  fieldGrid,
  type FieldLayer,
  landMaskImage,
  type OverlaySources,
  pressureFeatures,
  windPoints,
  seaPoints,
} from '../overlays';
import { POINT_FORECAST_PARAMS, pointForecasts } from '../weather';
import { type DataStamp, type DataStatus, type QueryArgs } from '../protocol';
import { encodeTile, tileQuery, type TileId } from '../tiles';
import { readWindow, releaseWindow } from './forecast';
import { currentsStatus, prepareSmocForQuery } from './currents';
import { conditionsTide, prepareTidesForQuery, tideSeriesQuery } from './tides';
import type { WorkerState } from './state';

export function overlaySources(st: WorkerState, forecast: ForecastStore | null): OverlaySources {
  return { forecast, currents: st.stack.isEmpty ? null : st.stack, land: st.overlayLand, tides: st.tides };
}

/** Every parameter conditionsSeries samples. The interval/energy parameters are skipped for runs decoded without them. */
const CONDITIONS_PARAMS = [
  '10u',
  '10v',
  'swh',
  'mwp',
  'mwd',
  'msl',
  '2t',
  'skt',
  'tprate',
  '2d',
  'ptype',
  'tcc',
  '10fg',
  'tp',
  'ssrd',
  'sf',
  'strd',
  'str',
  'mucape',
];

const INFO_PARAMS = ['10u', '10v', 'msl', 'swh', 'mwp', 'mwd'];

/** A small box around a point: its bilinear (and nearest) neighbours are inside with the default margin. */
export function pointBox(lon: number, lat: number): BBox {
  return { west: lon, east: lon, south: lat, north: lat };
}

/**
 * The part of the decoded run a query needs, or null when it needs none:
 * map layers read the view (plus margin) at the two steps around the map
 * time; point queries read a few cells around the point for every step.
 * The forecast part of the answer's stamp names the run actually read
 * (WindowRead): readWindow falls back to the run that became current when
 * the one it chose was pruned meanwhile.
 */
export async function queryWindow(
  st: WorkerState,
  kind: string,
  args: QueryArgs[keyof QueryArgs]
): Promise<{ win: ForecastStore; forecast: DataStamp['forecast'] } | null> {
  const read = (
    what: string,
    opts: WindowOptions | ((run: DecodedRun) => WindowOptions)
  ): Promise<{ win: ForecastStore; forecast: DataStamp['forecast'] }> => {
    return (async () => {
      const { store, run } = await readWindow(st, what, opts);
      return { win: store, forecast: { cycleMs: run.index.cycleTimeMs, params: run.index.request.params } };
    })();
  };
  if (!st.run) return null;
  switch (kind) {
    case 'field': {
      const a = args as QueryArgs['field'];
      const params = [...(LAYER_PARAMS[a.layer] ?? [])];
      if (!params.length) return null;
      return read(`${a.layer} map`, run => ({ bbox: a.bbox, params, steps: run.bracket(a.timeMs), marginCells: 2 }));
    }
    case 'wind_points': {
      const a = args as QueryArgs['wind_points'];
      return read('wind arrows', run => ({ bbox: a.bbox, params: ['10u', '10v'], steps: run.bracket(a.timeMs), marginCells: 2 }));
    }
    case 'sea_points': {
      const a = args as QueryArgs['sea_points'];
      return read('sea-state arrows', run => ({
        bbox: a.bbox,
        params: ['10u', '10v', 'swh', 'mwp', 'mwd'],
        steps: run.bracket(a.timeMs),
        marginCells: 2,
      }));
    }
    case 'pressure': {
      const a = args as QueryArgs['pressure'];
      // pressureFeatures pads by one cell and draws at least 8 × 8 cells (2°).
      return read('isobars', run => ({ bbox: a.bbox, params: ['msl'], steps: run.bracket(a.timeMs), marginCells: 10 }));
    }
    case 'conditions': {
      const a = args as QueryArgs['conditions'];
      return read('conditions', { bbox: pointBox(a.lon, a.lat), params: CONDITIONS_PARAMS, marginCells: 2 });
    }
    case 'weather_point': {
      const a = args as QueryArgs['weather_point'];
      // An observation needs only the two steps around its time.
      return read('Weather API point', run => ({
        bbox: pointBox(a.lon, a.lat),
        params: [...POINT_FORECAST_PARAMS],
        marginCells: 2,
        steps: a.observation && a.startMs !== null ? run.bracket(a.startMs) : undefined,
      }));
    }
    case 'forecast_info': {
      const a = args as QueryArgs['forecast_info'];
      return read('forecast samples', { bbox: pointBox(a.lon, a.lat), params: INFO_PARAMS, marginCells: 2 });
    }
    default:
      return null;
  }
}

/** Largest on-demand SMOC / tide area set the data worker keeps between queries (see README, Data). */
const QUERY_AREA_RETAIN_BYTES = 16 * 1024 * 1024;

export async function query(st: WorkerState, id: number, kind: string, args: QueryArgs[keyof QueryArgs]): Promise<void> {
  if (st.cancelledQueries.delete(id)) {
    st.send({ type: 'query-error', id, message: 'cancelled' });
    return;
  }
  try {
    const { result, complete, stamp } = await answer(st, kind, args);
    st.cancelledQueries.delete(id); // a cancel that arrived after the query started
    st.send({ type: 'query-result', id, result, complete, stamp });
    reportStatus(st, kind);
  } catch (err) {
    st.cancelledQueries.delete(id);
    st.send({ type: 'query-error', id, message: (err as Error).message });
  }
}

/**
 * Tiles worker: a tile built ahead of time (prebuild.ts), finished here rather than on Signal K's main thread: its
 * query answered, encoded as the store saves it (encodeTile) and written to `tmp`, the store's temporary file beside
 * the tile; the main thread then only moves it into place (TileStore.adopt). An answer that is not complete is not
 * written. Before (2026-10-13), the answer crossed to the main thread, which encoded and wrote every tile: Signal K's
 * main thread at 47–100 % while the prebuild ran, 6 % a minute after it was turned off (brain, top).
 */
export async function buildTile(st: WorkerState, id: number, tile: TileId, tmp: string): Promise<void> {
  try {
    const { kind, args } = tileQuery(tile);
    const { result, complete, stamp } = await answer(st, kind, args);
    if (!complete) {
      st.send({ type: 'tile-built', id, bytes: 0, complete: false, stamp });
      return;
    }
    const gz = await encodeTile(tile, result);
    await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
    await fs.promises.writeFile(tmp, gz);
    st.send({ type: 'tile-built', id, bytes: gz.length, complete: true, stamp });
  } catch (err) {
    st.send({ type: 'query-error', id, message: (err as Error).message });
  }
}

/** A query's answer, whether it is complete (false: an on-demand current or tide load was late or failed, or was evicted
 * meanwhile), and the identity of the data it was computed from (the main thread serves only what it still holds). */
async function answer(
  st: WorkerState,
  kind: string,
  args: QueryArgs[keyof QueryArgs]
): Promise<{ result: unknown; complete: boolean; stamp: DataStamp }> {
  let win: ForecastStore | null = null;
  try {
    // The refresh runs beside the queries (worker.ts): a new SMOC or tide source can replace the one this query
    // prepared while it awaits; then it is sampled from a source that has not loaded the query's area.
    const smoc0 = st.smoc;
    const smocComplete = await prepareSmocForQuery(st, kind, args);
    // A late background load can evict what was just loaded while this query awaits the rest.
    const evictions = (): number => (st.smoc?.evictions ?? 0) + (st.tides?.evictions ?? 0);
    const evicted0 = evictions();
    const tides0 = st.tides;
    const tidesComplete = await prepareTidesForQuery(st, kind, args);
    const tide = kind === 'conditions' ? await conditionsTide(st, args as QueryArgs['conditions']) : null;
    const qw = await queryWindow(st, kind, args);
    win = qw?.win ?? null;
    // Last await before sampling (synchronous from here), and before this query's own trim below. The stamp is what
    // the answer is computed from: the run the window was read from, and the sources sampled.
    const notEvicted = evictions() === evicted0 && st.smoc === smoc0 && st.tides === tides0;
    const stamp: DataStamp = {
      forecast: qw?.forecast ?? null,
      smoc: st.smoc ? { key: st.smoc.run.key, settled: st.smoc.run.settled } : null,
      rtofs: st.rtofs ? st.rtofs.runMs : null,
      tide: st.tides ? { key: st.tides.run.key, settled: st.tides.run.settled } : null,
    };
    const src = overlaySources(st, win);
    let result: unknown;
    switch (kind) {
      case 'field': {
        const a = args as QueryArgs['field'];
        result = fieldGrid(src, a.layer as FieldLayer, a.bbox, new Date(a.timeMs), a.res);
        break;
      }
      case 'currents': {
        const a = args as QueryArgs['currents'];
        result = currentPoints(src, a.bbox, new Date(a.timeMs), a.res);
        break;
      }
      case 'wind_points': {
        const a = args as QueryArgs['wind_points'];
        result = windPoints(src, a.bbox, new Date(a.timeMs), a.res);
        break;
      }
      case 'sea_points': {
        const a = args as QueryArgs['sea_points'];
        result = seaPoints(src, a.bbox, new Date(a.timeMs), a.res);
        break;
      }
      case 'conditions': {
        const a = args as QueryArgs['conditions'];
        result = conditionsSeries(src, a.lon, a.lat, new Date(a.fromMs), a.hours, a.stepH, tide);
        break;
      }
      case 'tide_series': {
        result = await tideSeriesQuery(st, args as QueryArgs['tide_series']);
        break;
      }
      case 'land_mask': {
        const a = args as QueryArgs['land_mask'];
        result = landMaskImage(src, a.bbox, a.w, a.h, a.mercator ?? false);
        break;
      }
      case 'pressure': {
        const a = args as QueryArgs['pressure'];
        result = pressureFeatures(src, a.bbox, new Date(a.timeMs), a.intervalHpa);
        break;
      }
      case 'weather_point': {
        const a = args as QueryArgs['weather_point'];
        if (!win) throw new Error('no forecast loaded yet');
        result = pointForecasts(win, a.lon, a.lat, a.startMs, a.maxCount, {
          currents: src.currents ?? undefined,
          observation: !!a.observation,
        });
        break;
      }
      case 'forecast_info': {
        const a = args as QueryArgs['forecast_info'];
        if (!win) throw new Error('no forecast loaded yet');
        const f = win;
        if (!f.covers(a.lon, a.lat)) throw new Error('position outside the forecast');
        result = f.steps.map(s => {
          const t = new Date(s.validMs);
          const [ws, wd] = f.at(a.lon, a.lat, t);
          const wave = f.wavesAt(a.lon, a.lat, t);
          const msl = f.mslAt(a.lon, a.lat, t);
          return {
            time: t.toISOString(),
            wind_ms: ws,
            wind_dir_deg: wd,
            msl_pa: Number.isFinite(msl) ? msl : null,
            swh_m: wave?.swh ?? null,
            mwp_s: wave?.mwp ?? null,
            mwd_deg: wave?.mwd ?? null,
          };
        });
        break;
      }
      default:
        throw new Error(`unknown query kind ${kind}`);
    }
    releaseWindow(st, win);
    win = null;
    // On-demand SMOC / tide areas loaded for this query: keep at most a small set.
    st.smoc?.trimOnDemand(QUERY_AREA_RETAIN_BYTES);
    st.tides?.trimOnDemand(QUERY_AREA_RETAIN_BYTES);
    // A conditions tide series that is still downloading (or failed) is not an answer to keep; outside the grid is.
    const tideComplete = !tide || !!tide.series || /outside the sea-level grid/.test(tide.error ?? '');
    return { result, complete: smocComplete && tidesComplete && tideComplete && notEvicted, stamp };
  } catch (err) {
    releaseWindow(st, win);
    throw err;
  }
}

/** The status the main thread reports, refreshed after a query that may have changed it. */
function reportStatus(st: WorkerState, kind: string): void {
  // A new overlay land raster was built: refresh the status the main thread reports.
  // …or SMOC loaded an on-demand area.
  const smocRev = st.smoc ? st.smoc.revision : -1;
  const tidesRev = st.tides ? st.tides.revision : -1;
  if (
    (st.overlayLand && st.overlayLand.builds !== st.reportedLandBuilds) ||
    smocRev !== st.reportedSmocRev ||
    tidesRev !== st.reportedTidesRev ||
    kind === 'conditions' ||
    kind === 'tide_series' ||
    kind === 'field' ||
    kind === 'weather_point'
  ) {
    st.reportedLandBuilds = st.overlayLand ? st.overlayLand.builds : 0;
    st.send({ type: 'data-status', status: dataStatus(st) });
  }
}

export function dataStatus(st: WorkerState): DataStatus {
  st.reportedSmocRev = st.smoc ? st.smoc.revision : -1;
  st.reportedTidesRev = st.tides ? st.tides.revision : -1;
  const r = st.run;
  return {
    forecast:
      r && st.runInfo
        ? {
            cycle: r.cycleTime.toISOString(),
            validFrom: r.validRange[0].toISOString(),
            validTo: r.validRange[1].toISOString(),
            steps: r.index.steps.length,
            params: r.index.request.params,
            hasWaves: r.hasWaves,
            loadedAt: new Date(st.runInfo.loadedAtMs).toISOString(),
            source: st.runInfo.source,
            readyMs: st.runInfo.readyMs,
            decodedDir: r.dir,
            decodedBytes: r.index.bytes,
            decodedDiskBytes: st.diskBytes.decoded,
            gribCacheBytes: st.diskBytes.grib,
          }
        : null,
    lastDecode: st.lastDecode,
    decodingBlockBytes: st.decodingBlockBytes,
    forecastMemory: { ...st.forecastMemory },
    currents: currentsStatus(st),
    rtofsRun: st.rtofs ? new Date(st.rtofs.runMs).toISOString().slice(0, 10) : null,
    land: st.overlayLand ? st.overlayLand.stats() : null,
    tides: st.tides ? st.tides.status() : null,
    tidesError: st.tidesError,
    regional: [...st.regional.values()],
    checks: { ...st.checks },
    connectivity: { ...st.connectivity },
    harmonicErrors: [...st.harmonicErrors],
  };
}
