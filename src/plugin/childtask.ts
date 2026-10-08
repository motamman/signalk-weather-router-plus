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
 *  - mesh:     route one leg on the chart mesh (engine/mesh): the tiles of
 *              the leg's box are about 1 GB of typed arrays for 6 M
 *              triangles (brain, 2026-10-08), which the route worker must
 *              not keep.
 */

import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RegionalSource } from '../data/regional';
import type { RegionalDecodeResult } from '../data/regionaldecode';
import type { MeshRouteResult, MeshRules } from '../engine/mesh/route';

export type ChildTask =
  | { task: 'rmtree'; dir: string }
  | { task: 'regional'; src: RegionalSource; srcDir: string; dataDir: string; keepRuns: number }
  | { task: 'mesh'; dir: string; start: [number, number]; end: [number, number]; rules: MeshRules };

export interface RmtreeResult {
  /** Saved tiles (.gz) and their bytes that were in the tree. */
  files: number;
  bytes: number;
}

export type ChildTaskResult<T extends ChildTask> = T extends { task: 'rmtree' }
  ? RmtreeResult
  : T extends { task: 'mesh' }
    ? MeshRouteResult
    : RegionalDecodeResult;

const isTs = __filename.endsWith('.ts');

/** Run one task in a fresh child process; resolves with its answer, rejects on its error, exit or timeout. */
export function runChildTask<T extends ChildTask>(task: T, timeoutMs = 30 * 60_000): Promise<ChildTaskResult<T>> {
  return new Promise((resolve, reject) => {
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
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
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
    child.on('message', (m: { ok: boolean; result?: ChildTaskResult<T>; error?: string }) =>
      finish(() => (m.ok ? resolve(m.result as ChildTaskResult<T>) : reject(new Error(m.error ?? `${task.task} child process failed`))))
    );
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
    case 'mesh': {
      const { MeshStore } = await import('../engine/mesh/store');
      const { meshRoute } = await import('../engine/mesh/route');
      return meshRoute(MeshStore.open(t.dir), t.start, t.end, t.rules);
    }
  }
}

// Child side: one task, one answer, then exit.
if (require.main === module && typeof process.send === 'function') {
  process.once('message', (t: ChildTask) => {
    runTask(t).then(
      result => process.send!({ ok: true, result }, () => process.exit(0)),
      err => process.send!({ ok: false, error: (err as Error).message }, () => process.exit(1))
    );
  });
}
