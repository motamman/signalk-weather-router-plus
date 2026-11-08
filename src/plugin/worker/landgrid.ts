/**
 * Route worker: the per-route land mask and the global water grid (shipped, or rebuilt by a builder thread).
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { checkWaterGridBuildMemory } from '../memguard';
import { type BBox } from '../../geo/geodesy';
import { LandMask } from '../../geo/landmask';
import { CoastTiles } from '../../geo/coasttiles';
import { WaterGrid } from '../../geo/watergrid';
import { chooseWaterGrid } from '../../geo/watergrid_store';
import { type GridBuilderData, type GridBuilderMessage } from '../gridbuilder';
import { type ResolvedConfig } from '../config';
import type { WorkerState } from './state';

export function landMaskFor(st: WorkerState, bbox: BBox, maxCells: number, shapefiles: string[]): LandMask {
  const res = LandMask.chooseResolution(bbox, maxCells);
  const key = `${shapefiles.join('|')}|${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}|${res}`;
  // Never refined itself: a route refines a view of its own (route.ts landFor, LandMask.routeView).
  if (st.landCache && st.landCache.key === key) return st.landCache.mask;
  const t = Date.now();
  const mask = LandMask.fromCoastline(CoastTiles.open(shapefiles, st.cacheRoot), bbox, { resolutionDeg: res });
  st.log(
    'info',
    `land mask: ${mask.pieces} coastline pieces drawn, ${mask.nx}x${mask.ny} cells at ${res}° (${((mask.nx * mask.ny) / 1e6).toFixed(1)}M), ${Date.now() - t} ms`
  );
  st.landCache = { key, mask };
  return mask;
}

/**
 * Route worker: load the water grid built from the configured coastline
 * (shipped or rebuilt), else the best available one while a builder
 * thread rebuilds it into the data directory.
 */
export function prepareWaterGrid(st: WorkerState, cfg: ResolvedConfig): void {
  const t = Date.now();
  const choice = chooseWaterGrid(cfg.landShapefiles, st.cacheRoot);
  for (const n of choice.notes) st.log('info', `water grid: ${n}`);
  st.waterGrid = choice.grid;
  if (st.waterGrid) {
    st.log(
      'info',
      `water grid: loaded ${choice.file} in ${Date.now() - t} ms, ${(st.waterGrid.bytes() / 1e6).toFixed(1)} MB resident, ${st.waterGrid.chokepoints.length} narrow passages, ${st.waterGrid.splits.length} split cells`
    );
  } else {
    st.log(
      'error',
      'water grid: none available; routes use the per-route skeleton (limited to the box around start, end and waypoints) until one is built'
    );
  }
  if (choice.needsRebuild) startGridRebuild(st, cfg, choice.rebuildPath);
}

export function startGridRebuild(st: WorkerState, cfg: ResolvedConfig, outFile: string): void {
  if (st.gridBuilder) return;
  const mem = checkWaterGridBuildMemory(cfg.forecast.memoryHeadroomBytes);
  if (!mem.ok) {
    st.log('error', `water grid: ${mem.message} [${mem.source}]`);
    return;
  }
  st.log('info', `water grid: rebuilding from ${cfg.landShapefiles.join(', ')} into ${outFile} (${mem.message}); this takes a few minutes`);
  const data: GridBuilderData = { shapefiles: cfg.landShapefiles, tilesRoot: st.cacheRoot, outFile };
  const isTs = __filename.endsWith('.ts');
  const w = new Worker(gridBuilderEntry(), {
    workerData: data,
    execArgv: isTs ? ['--import', 'tsx'] : [],
  });
  st.gridBuilder = w;
  w.on('message', (m: GridBuilderMessage) => {
    if (m.type === 'progress') st.log('debug', `water grid rebuild: ${m.done}/${m.total} tiles (${m.message})`);
    else if (m.type === 'error') st.log('error', `water grid rebuild failed: ${m.message}`);
    else if (m.type === 'done') {
      try {
        const g = WaterGrid.load(m.file);
        g.setCanalsAllowed(st.waterGrid?.canalsAreAllowed ?? false);
        st.waterGrid = g;
        st.log(
          'info',
          `water grid: rebuilt in ${m.seconds.toFixed(0)} s, ${(m.bytes / 1e6).toFixed(2)} MB on disk, now in use (${(g.bytes() / 1e6).toFixed(1)} MB resident; process peak RSS ${(m.peakRssBytes / 1e6).toFixed(0)} MB)`
        );
      } catch (err) {
        st.log('error', `water grid: cannot load the rebuilt grid: ${(err as Error).message}`);
      }
    }
  });
  w.on('error', err => st.log('error', `water grid rebuild crashed: ${err.message}`));
  w.on('exit', () => {
    st.gridBuilder = null;
  });
}

/** The grid builder thread's module: it lives in plugin/, one folder above this worker folder. */
export function gridBuilderEntry(): string {
  const isTs = __filename.endsWith('.ts');
  return path.join(__dirname, '..', isTs ? 'gridbuilder.ts' : 'gridbuilder.js');
}
