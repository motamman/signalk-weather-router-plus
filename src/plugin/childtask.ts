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
 *              not keep;
 *  - mesh-download: mirror one published mesh folder (plugin/meshes.ts)
 *              file by file into a folder, resumable, progress in
 *              `.progress.json` there.
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
  | { task: 'mesh'; dir: string; start: [number, number]; end: [number, number]; rules: MeshRules }
  | { task: 'mesh-download'; base: string; dest: string };

export interface MeshDownloadResult {
  files: number;
  bytes: number;
}

export interface RmtreeResult {
  /** Saved tiles (.gz) and their bytes that were in the tree. */
  files: number;
  bytes: number;
}

export type ChildTaskResult<T extends ChildTask> = T extends { task: 'rmtree' }
  ? RmtreeResult
  : T extends { task: 'mesh' }
    ? MeshRouteResult
    : T extends { task: 'mesh-download' }
      ? MeshDownloadResult
      : RegionalDecodeResult;

const isTs = __filename.endsWith('.ts');

/**
 * Run one task in a fresh child process; resolves with its answer, rejects
 * on its error, exit or timeout. An aborted `signal` kills the child and
 * rejects.
 */
export function runChildTask<T extends ChildTask>(task: T, timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<ChildTaskResult<T>> {
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
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void =>
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error(`${task.task} child process cancelled`));
      });
    signal?.addEventListener('abort', onAbort, { once: true });
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

/**
 * Mirror a published mesh folder: its `index.json` (one cluster) or
 * `meshes.json` and each cluster's `index.json` list every tile file.
 * A file already present with the server's size is kept (resume); the
 * rest are fetched one at a time to a temporary name and renamed.
 * Progress goes to `<dest>/.progress.json` every file.
 */
async function downloadMesh(base: string, dest: string): Promise<MeshDownloadResult> {
  dest = path.resolve(dest);
  fs.mkdirSync(dest, { recursive: true });
  /** The local path of a file the server's lists name; a name that leaves `dest` is refused. */
  const inside = (rel: string): string => {
    const p = path.resolve(dest, rel);
    if (p !== dest && !p.startsWith(dest + path.sep)) throw new Error(`${rel}: outside the mesh folder`);
    return p;
  };
  const getJson = async (rel: string): Promise<unknown> => {
    const target = inside(rel);
    const res = await fetch(new URL(rel, base).toString(), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    const text = await res.text();
    fs.writeFileSync(target, text);
    return JSON.parse(text);
  };
  // The file list.
  const files: string[] = [];
  let clusters: string[] = [''];
  try {
    await getJson('index.json');
  } catch {
    const m = (await getJson('meshes.json')) as { meshes: { dir: string }[] };
    clusters = m.meshes.map(c => c.dir.replace(/\/$/, '') + '/');
    for (const c of clusters) {
      fs.mkdirSync(inside(c), { recursive: true });
      await getJson(c + 'index.json');
    }
  }
  for (const c of clusters) {
    const ix = JSON.parse(fs.readFileSync(inside(c + 'index.json'), 'utf8')) as { tiles: { file: string }[] };
    for (const t of ix.tiles) files.push(c + t.file);
  }
  let bytes = 0;
  let done = 0;
  const progress = (): void => {
    fs.writeFileSync(path.join(dest, '.progress.json'), JSON.stringify({ files: done, total: files.length, bytes }));
  };
  progress();
  for (const rel of files) {
    const target = inside(rel);
    const url = new URL(rel, base).toString();
    let have = -1;
    try {
      have = fs.statSync(target).size;
    } catch {
      // not there yet
    }
    if (have >= 0) {
      const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(60_000) });
      const len = Number(head.headers.get('content-length'));
      if (head.ok && len === have) {
        bytes += have;
        done++;
        progress();
        continue;
      }
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`${rel}: HTTP ${res.status}`);
    const tmp = `${target}.part`;
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
    bytes += fs.statSync(target).size;
    done++;
    progress();
  }
  return { files: done, bytes };
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
    case 'mesh-download':
      return downloadMesh(t.base, t.dest);
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
