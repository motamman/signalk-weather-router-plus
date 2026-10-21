/**
 * The plugin's two worker threads (`data`, `route`): start, messages,
 * the query round trip to the data worker, cancellation flag, shutdown.
 * What a message means for the plugin is the caller's (index.ts
 * onWorkerMessage); what a crash means for the jobs too.
 *
 * Extracted from index.ts (docs/plans/structural-cleanup.md, phase 2.3).
 */

import { Worker } from 'node:worker_threads';
import type { DataStamp, MainToWorker, QueryArgs, QueryKind, WorkerRole, WorkerToMain } from './protocol';

/** Roles of the two workers the plugin runs (tiles workers: prebuild.ts). */
export type MainRole = Exclude<WorkerRole, 'tiles'>;

export interface WorkerHandle {
  role: MainRole;
  worker: Worker | null;
  ready: boolean;
}

export interface WorkerPoolDeps {
  workerPath: string;
  execArgv: string[];
  queryTimeoutMs: number;
  onMessage: (role: MainRole, msg: WorkerToMain) => void;
  /** `current`: the worker is the one in its slot (not one already replaced by a restart). */
  onError: (role: MainRole, err: Error, current: boolean) => void;
  /** The slot is already cleared and pending data queries rejected when this is called. */
  onExit: (role: MainRole, code: number) => void;
}

export class WorkerPool {
  readonly workers: Record<MainRole, WorkerHandle> = {
    data: { role: 'data', worker: null, ready: false },
    route: { role: 'route', worker: null, ready: false },
  };
  /** Shared Int32: 1 cancels the running route. */
  readonly cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  private queryId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: { result: unknown; complete: boolean; stamp: DataStamp }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly deps: WorkerPoolDeps) {}

  has(role: MainRole): boolean {
    return !!this.workers[role].worker;
  }
  ready(role: MainRole): boolean {
    return this.workers[role].ready;
  }
  setReady(role: MainRole): void {
    this.workers[role].ready = true;
  }
  get pendingCount(): number {
    return this.pending.size;
  }

  rejectPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  post(role: MainRole, msg: MainToWorker): void {
    this.workers[role].worker?.postMessage(msg);
  }

  /**
   * A data-worker query. `signal`: when it aborts before the worker has
   * started the query, the query is dropped (it then rejects with
   * "cancelled"); one already running completes. `complete` is false when
   * an on-demand current / tide load was late or failed. `stamp` names the
   * data the answer was computed from (DataStamp).
   */
  queryFull<K extends QueryKind>(
    kind: K,
    args: QueryArgs[K],
    signal?: AbortSignal
  ): Promise<{ result: unknown; complete: boolean; stamp: DataStamp }> {
    const h = this.workers.data;
    if (!h.worker || !h.ready) return Promise.reject(new Error('data worker not ready'));
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    const id = ++this.queryId;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (this.pending.has(id)) this.post('data', { type: 'query-cancel', id });
      };
      const done = (): void => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done();
        reject(new Error('query timed out'));
      }, this.deps.queryTimeoutMs);
      this.pending.set(id, {
        resolve: v => {
          done();
          resolve(v);
        },
        reject: e => {
          done();
          reject(e);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.post('data', { type: 'query', id, kind, args });
    });
  }

  start(role: MainRole): void {
    // A worker already in the slot (a restart racing with a start) is shut
    // down first, never silently abandoned.
    const old = this.workers[role].worker;
    if (old) {
      old.postMessage({ type: 'shutdown' });
      setTimeout(() => void old.terminate(), 2000);
    }
    const worker = new Worker(this.deps.workerPath, {
      workerData: { cancelFlag: this.cancelFlag.buffer, role },
      execArgv: this.deps.execArgv,
    });
    this.workers[role] = { role, worker, ready: false };
    // After a restart (stop() then start()) the old worker is still shutting
    // down; its late events must not touch the new worker's slot, queries
    // or jobs. Only the worker currently in this.workers[role] is acted on.
    const isCurrent = (): boolean => this.workers[role].worker === worker;
    worker.on('message', (m: WorkerToMain) => {
      if (isCurrent()) this.deps.onMessage(role, m);
    });
    worker.on('error', err => this.deps.onError(role, err, isCurrent()));
    worker.on('exit', code => {
      if (!isCurrent()) return;
      this.workers[role] = { role, worker: null, ready: false };
      if (role === 'data') this.rejectPending('data worker exited');
      this.deps.onExit(role, code);
    });
  }

  /** A query answer from the data worker. */
  resolveQuery(id: number, result: unknown, complete: boolean, stamp: DataStamp): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ result, complete, stamp });
  }
  rejectQuery(id: number, message: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.reject(new Error(message));
  }

  /** Ask every worker to shut down (terminated after 2 s) and clear the slots. */
  stopAll(): void {
    for (const role of ['data', 'route'] as MainRole[]) {
      const h = this.workers[role];
      if (h.worker) {
        this.post(role, { type: 'shutdown' });
        const w = h.worker;
        setTimeout(() => void w.terminate(), 2000);
      }
      this.workers[role] = { role, worker: null, ready: false };
    }
  }
}
