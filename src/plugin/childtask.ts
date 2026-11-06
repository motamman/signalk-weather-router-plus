/**
 * One-shot child processes for bursty work: a separate Node process does
 * the job, sends back the answer and exits, so every byte it allocated goes
 * back to the operating system. Work done inside Signal K's own process
 * (its main thread or the plugin's worker threads) frees memory that glibc
 * keeps for the process until Signal K restarts (brain, 2026-10-06:
 * deleting a superseded tile generation on the main thread left 537 MB;
 * a regional GRIB decode in the data worker left 86 MB).
 *
 * Tasks:
 *  - rmtree:   count and delete one directory tree (a superseded tile
 *              generation: hundreds of thousands of files);
 *  - regional: decode one signalk-grib-downloader run (decodeRegionalRun);
 *  - mesh-leg: plan one leg on the chart mesh (plugin/meshlegtask.ts,
 *              engine/mesh/legrun.ts): the tiles the search reads, up to
 *              about 1.1 GB on the longest leg measured (brain,
 *              2026-10-12, tiles dropped as the search leaves them),
 *              which the route worker must not keep; the task streams
 *              its progress before its answer;
 *  - mesh-download: one published mesh's archive downloaded (resumable)
 *              and unpacked into a folder (plugin/mesharchive.ts), progress
 *              in its working folder's `progress.json`;
 *  - mesh-check: the final depth check of a finished route on the chart
 *              meshes (plugin/meshchecktask.ts, engine/mesh/check.ts),
 *              reading the tiles along the route as the walk reaches them;
 *  - mesh-coarse: build one mesh's rough cut for one boat
 *              (plugin/meshcoarse.ts, engine/mesh/coarse.ts): every tile
 *              read once, 0.25–0.53 GB on brain (2026-10-12);
 *  - mesh-reach: a leg's reach on the rough cut (whether water connects
 *              its ends for the boat, and the box of the tiles it runs
 *              through);
 *  - mesh-snap: the route's exact stops in one mesh moved to usable water
 *              connected to the route (part 2);
 *  - mesh-exit: where a leg leaving the chart mesh crosses to the
 *              coastline, and the mesh's water as land for the coastline
 *              part (part 5);
 *  - mesh-transfer: where a leg from one chart mesh to another changes
 *              meshes in their overlap (part 5 step 2);
 *  - mesh-joins: one mesh's joins to another for one boat, on their own
 *              (meshcoarse.ts; the rough-cut build makes them otherwise);
 *  - mesh-waters: a leg's way across the limits of the charts: the
 *              waters it goes through, where it crosses between them, and
 *              every mesh's water as land for the coastline parts (part 5);
 *  - forecast-decode: one ECMWF cycle downloaded and decoded to disk
 *              (plugin/forecastdecodetask.ts), so the data worker keeps
 *              answering map queries meanwhile; streams its progress;
 *  - ensemble-decode: the chosen ensembles' members of that cycle
 *              downloaded and decoded to disk (data/ensemble.ts), after the
 *              forecast, the same way;
 *  - coast-cut: the coastline cut into its tiles (geo/coasttiles.ts), once
 *              per coastline: every record read, the continents included
 *              (about 750 MB at its peak for GSHHG full resolution, brain
 *              2026-10-25).
 */

import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RegionalSource } from '../data/regional';
import type { RegionalDecodeResult } from '../data/regionaldecode';
import type { RouteDepthCheck } from '../engine/mesh/check';
import type { MeshCheckTask } from './meshchecktask';
import type {
  MeshCoarseResult,
  MeshCoarseTask,
  MeshJoinsTask,
  MeshReachResult,
  MeshReachTask,
  MeshSnapResult,
  MeshSnapTask,
} from './meshcoarse';
import type { MeshExitTask, MeshExitTaskResult } from './meshexit';
import type { MeshLegEvent, MeshLegResult, MeshLegTask } from './meshlegtask';
import type { MeshTransferTask, MeshTransferTaskResult } from './meshtransfer';
import type { MeshWatersTask, MeshWatersTaskResult } from './meshwaters';
import type { MeshDownloadResult, MeshDownloadTask } from './mesharchive';
import type { EnsembleDecodeTask, ForecastDecodeEvent, ForecastDecodeResult, ForecastDecodeTask } from './forecastdecodetask';
import type { EnsembleModelResult } from '../data/ensemble';
import type { CutResult } from '../geo/coasttiles';

/** Cut the coastline `paths` into its tile store under `root` (geo/coasttiles.ts). */
export interface CoastCutTask {
  task: 'coast-cut';
  paths: string[];
  root: string;
}

export type ChildTask =
  | { task: 'rmtree'; dir: string }
  | { task: 'regional'; src: RegionalSource; srcDir: string; dataDir: string; keepRuns: number }
  | MeshLegTask
  | MeshCheckTask
  | MeshCoarseTask
  | MeshReachTask
  | MeshSnapTask
  | MeshExitTask
  | MeshTransferTask
  | MeshJoinsTask
  | MeshWatersTask
  | MeshDownloadTask
  | ForecastDecodeTask
  | EnsembleDecodeTask
  | CoastCutTask;

/** A message a task sends before its answer (the mesh leg's progress and stage fronts, the forecast decode's steps). */
export type ChildEvent = MeshLegEvent | ForecastDecodeEvent;

export interface RmtreeResult {
  /** Saved tiles (.gz) and their bytes that were in the tree. */
  files: number;
  bytes: number;
}

export type ChildTaskResult<T extends ChildTask> = T extends { task: 'rmtree' }
  ? RmtreeResult
  : T extends { task: 'mesh-leg' }
    ? MeshLegResult
    : T extends { task: 'mesh-check' }
      ? RouteDepthCheck
      : T extends { task: 'mesh-coarse' }
        ? MeshCoarseResult
        : T extends { task: 'mesh-reach' }
          ? MeshReachResult
          : T extends { task: 'mesh-snap' }
            ? MeshSnapResult
            : T extends { task: 'mesh-exit' }
              ? MeshExitTaskResult
              : T extends { task: 'mesh-transfer' }
                ? MeshTransferTaskResult
                : T extends { task: 'mesh-joins' }
                  ? { joins: number; ms: number }
                  : T extends { task: 'mesh-waters' }
                    ? MeshWatersTaskResult
                    : T extends { task: 'mesh-download' }
                      ? MeshDownloadResult
                      : T extends { task: 'forecast-decode' }
                        ? ForecastDecodeResult
                        : T extends { task: 'ensemble-decode' }
                          ? EnsembleModelResult[]
                          : T extends { task: 'coast-cut' }
                            ? CutResult
                            : RegionalDecodeResult;

const isTs = __filename.endsWith('.ts');

/**
 * Run one task in a fresh child process; resolves with its answer, rejects
 * on its error, exit or timeout. An aborted `signal` kills the child and
 * rejects. `timeoutMs` null: no time limit (a forecast download over a slow
 * link at sea can take hours; stopping the plugin aborts it). The rejected
 * error keeps the child's error name (OfflineError: no connection).
 */
export function runChildTask<T extends ChildTask>(
  task: T,
  timeoutMs: number | null = 30 * 60_000,
  signal?: AbortSignal,
  onEvent?: (e: ChildEvent) => void
): Promise<ChildTaskResult<T>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${task.task} child process cancelled`));
      return;
    }
    const child = fork(path.join(__dirname, isTs ? 'childtask.ts' : 'childtask.js'), [], {
      execArgv: isTs ? ['--import', 'tsx'] : [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let stderr = '';
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void =>
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error(`${task.task} child process cancelled`));
      });
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(
            () =>
              finish(() => {
                child.kill('SIGKILL');
                reject(new Error(`${task.task} child process timed out after ${Math.round(timeoutMs / 1000)} s`));
              }),
            timeoutMs
          );
    child.stderr?.on('data', d => {
      if (stderr.length < 4000) stderr += String(d);
    });
    child.on('message', (m: { ok?: boolean; result?: ChildTaskResult<T>; error?: string; name?: string; event?: ChildEvent }) => {
      if (m.event) {
        onEvent?.(m.event);
        return;
      }
      finish(() => {
        if (m.ok) {
          resolve(m.result as ChildTaskResult<T>);
          return;
        }
        const err = new Error(m.error ?? `${task.task} child process failed`);
        if (m.name) err.name = m.name;
        reject(err);
      });
    });
    child.on('error', err => finish(() => reject(err)));
    child.on('exit', (code, signal) =>
      finish(() =>
        reject(
          new Error(
            `${task.task} child process exited (${code ?? signal}) without an answer${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`
          )
        )
      )
    );
    child.send(task);
  });
}

/** Files (.gz) and bytes in a tree, counted while walking (no list kept). */
async function countTree(dir: string): Promise<RmtreeResult> {
  const c: RmtreeResult = { files: 0, bytes: 0 };
  const walk = async (d: string): Promise<void> => {
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.gz')) {
        try {
          c.bytes += (await fs.promises.stat(p)).size;
          c.files++;
        } catch {
          // gone since readdir
        }
      }
    }
  };
  await walk(dir);
  return c;
}

/** Count and delete a tree (also used in-process as the fallback when a child process cannot be started). */
export async function rmtree(dir: string): Promise<RmtreeResult> {
  const c = await countTree(dir);
  await fs.promises.rm(dir, { recursive: true, force: true });
  return c;
}

async function runTask(t: ChildTask): Promise<unknown> {
  switch (t.task) {
    case 'rmtree':
      return rmtree(t.dir);
    case 'regional': {
      const { decodeRegionalRun } = await import('../data/regionaldecode');
      return decodeRegionalRun(t.src, t.srcDir, t.dataDir, t.keepRuns);
    }
    case 'mesh-leg': {
      const { runMeshLegTask } = await import('./meshlegtask');
      return runMeshLegTask(t, event => process.send!({ event }));
    }
    case 'mesh-check': {
      const { runMeshCheckTask } = await import('./meshchecktask');
      return runMeshCheckTask(t);
    }
    case 'mesh-coarse': {
      const { runMeshCoarseTask } = await import('./meshcoarse');
      return runMeshCoarseTask(t);
    }
    case 'mesh-reach': {
      const { runMeshReachTask } = await import('./meshcoarse');
      return runMeshReachTask(t);
    }
    case 'mesh-snap': {
      const { runMeshSnapTask } = await import('./meshcoarse');
      return runMeshSnapTask(t);
    }
    case 'mesh-exit': {
      const { runMeshExitTask } = await import('./meshexit');
      return runMeshExitTask(t);
    }
    case 'mesh-transfer': {
      const { runMeshTransferTask } = await import('./meshtransfer');
      return runMeshTransferTask(t);
    }
    case 'mesh-joins': {
      const { runMeshJoinsTask } = await import('./meshcoarse');
      return runMeshJoinsTask(t);
    }
    case 'mesh-waters': {
      const { runMeshWatersTask } = await import('./meshwaters');
      return runMeshWatersTask(t);
    }
    case 'mesh-download': {
      const { downloadMeshArchive } = await import('./mesharchive');
      return downloadMeshArchive(t);
    }
    case 'forecast-decode': {
      const { runForecastDecodeTask } = await import('./forecastdecodetask');
      return runForecastDecodeTask(t, event => process.send!({ event }));
    }
    case 'ensemble-decode': {
      const { runEnsembleDecodeTask } = await import('./forecastdecodetask');
      return runEnsembleDecodeTask(t, event => process.send!({ event }));
    }
    case 'coast-cut': {
      const { cutCoastline } = await import('../geo/coasttiles');
      // The plugin's own cut: other coastlines' stores under its data directory are no longer used.
      return cutCoastline(t.paths, t.root, undefined, true);
    }
  }
}

// Child side: one task, one answer, then exit.
if (require.main === module && typeof process.send === 'function') {
  // The parent is gone (plugin stopped, Signal K exited): nothing left to work for.
  process.on('disconnect', () => process.exit(0));
  process.once('message', (t: ChildTask) => {
    runTask(t).then(
      result => process.send!({ ok: true, result }, () => process.exit(0)),
      err => process.send!({ ok: false, error: (err as Error).message, name: (err as Error).name }, () => process.exit(1))
    );
  });
}
