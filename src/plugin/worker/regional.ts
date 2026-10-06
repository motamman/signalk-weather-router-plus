/**
 * Regional wind from signalk-grib-downloader (data worker): after each
 * forecast check, decode any complete run not yet decoded (10 m wind only,
 * docs/plans/grib-downloader-enhancement.md). Optional: without the
 * downloader nothing happens.
 */

import * as path from 'node:path';
import { scanRegional } from '../../data/regional';
import { runChildTask } from '../childtask';
import type { WorkerState } from './state';

/** ECMWF open data's grid spacing, for when no global run is loaded yet. */
export const GLOBAL_DLON_DEG = 0.25;

/** Is a regional grid finer than the global forecast's (spacings in degrees, a rounding margin allowed)? */
export function isFinerThanGlobal(regionalDLon: number, globalDLon: number): boolean {
  return regionalDLon < globalDLon - 1e-6;
}

// A decode yields to other messages, so a later refresh can arrive while one
// runs: it skips the regional pass rather than decode the same run twice.
let busy = false;

export async function refreshRegional(st: WorkerState): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await refreshRegionalNow(st);
  } finally {
    busy = false;
  }
}

async function refreshRegionalNow(st: WorkerState): Promise<void> {
  if (!st.config || !st.cacheRoot) return;
  const scan = scanRegional(st.config.forecast.regionalGribs, st.cacheRoot);
  if (!scan.root) {
    st.regional.clear();
    return;
  }
  // A source is layered over the global forecast only where it is finer:
  // at the same spacing (GFS 0.25° against ECMWF 0.25°) it would replace
  // ECMWF wherever it covers, for no gain.
  const globalDLon = st.run?.index.grid.dLon ?? GLOBAL_DLON_DEG;
  for (const src of scan.sources) {
    if (!src.run || src.problem) continue;
    const prev = st.regional.get(src.name);
    if (src.domain && !isFinerThanGlobal(src.domain.di, globalDLon)) {
      if (!prev?.skipped)
        st.log(
          'info',
          `regional wind: ${src.name} (${src.domain.di}°) is not finer than the global forecast (${globalDLon}°); not decoded or used for routes`
        );
      st.regional.set(src.name, {
        source: src.name,
        cycle: null,
        dir: null,
        steps: 0,
        bytes: 0,
        decodeMs: 0,
        decodedAt: null,
        error: null,
        skipped: 'not finer than the global forecast',
      });
      continue;
    }
    try {
      // Decoded in a child process: a decode reads whole GRIB files (50+ MB
      // each) and its memory, freed here, stayed with Signal K (brain,
      // 2026-10-06: 86 MB per run). A child's memory goes back when it exits.
      const r = await runChildTask({
        task: 'regional',
        src,
        srcDir: path.join(scan.root, src.name),
        dataDir: st.cacheRoot,
        keepRuns: Math.max(1, st.config.forecast.keepCycles),
      });
      st.regional.set(src.name, {
        source: src.name,
        cycle: r.cycle,
        dir: r.dir,
        steps: r.steps,
        bytes: r.bytes,
        decodeMs: r.decodeMs,
        decodedAt: r.reused ? (prev?.decodedAt ?? null) : new Date().toISOString(),
        error: null,
      });
      if (!r.reused)
        st.log(
          'info',
          `regional wind: decoded ${src.name} run ${r.cycle}: ${r.steps} steps, ${(r.bytes / 1e6).toFixed(0)} MB, ${(r.decodeMs / 1000).toFixed(1)} s`
        );
    } catch (err) {
      const m = (err as Error).message;
      if (prev?.error !== m) st.log('error', `regional wind: ${src.name}: ${m}`);
      st.regional.set(src.name, {
        source: src.name,
        cycle: prev?.cycle ?? null,
        dir: prev?.dir ?? null,
        steps: prev?.steps ?? 0,
        bytes: prev?.bytes ?? 0,
        decodeMs: prev?.decodeMs ?? 0,
        decodedAt: prev?.decodedAt ?? null,
        error: m,
      });
    }
    // Let messages through between sources.
    await new Promise(r => setImmediate(r));
  }
}
