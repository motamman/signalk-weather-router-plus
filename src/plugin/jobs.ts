/**
 * Job manager: queue of route requests, one running at a time in the
 * worker, with an event log per job for Server-Sent Events (resumable
 * via Last-Event-ID) and on-disk persistence of finished jobs.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobProgress, JobStatus, RouteRequest, RouteSummary } from './protocol';
import type { JobLinks, JobPublic } from './response_schema';

export interface JobEvent {
  id: number;
  event: 'status' | 'progress' | 'route' | 'done' | 'error' | 'frontier';
  data: Record<string, unknown>;
}

export interface Job {
  id: string;
  status: JobStatus;
  request: RouteRequest;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: JobProgress[];
  summary?: RouteSummary;
  error?: string;
  geojson?: Record<string, unknown>;
  skRoute?: Record<string, unknown>;
  skeleton?: Record<string, unknown> | null;
  /** Every search stage's front and best path, compact (display only). */
  fronts?: unknown[] | null;
  /** Resources API id when published. */
  resourceId?: string;
  /** The departure window this job is one departure of (windows.ts); such jobs are listed and trimmed with their window. */
  windowId?: string;
  /** The ensemble set this job is one member's route of (ensembles.ts); listed and trimmed with its set, as windows' are. */
  ensembleSetId?: string;
  publishError?: string;
  events: JobEvent[];
  nextEventId: number;
}

/** A job as the API answers it: the type comes from its schema (response_schema.ts), as does the OpenAPI document. */
export type { JobPublic };

/** What a finished departure-window job keeps only in its file (see release). */
const RESULT_KEYS = ['geojson', 'skRoute', 'skeleton', 'fronts', 'events', 'progress'] as const;

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running: string | null = null;
  /** Jobs whose route results are only on disk (release): full() reads them back. */
  private released = new Set<string>();
  private readonly dir: string;

  constructor(
    dataDir: string,
    private keepJobs: number,
    private readonly basePath: string
  ) {
    super();
    this.dir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadPersisted();
  }

  private loadPersisted(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as Job;
        if (j.status === 'running' || j.status === 'queued') {
          j.status = 'failed';
          j.error = 'plugin restarted while the job was in progress';
        }
        j.events = j.events ?? [];
        j.nextEventId = j.nextEventId ?? j.events.length + 1;
        this.jobs.set(j.id, j);
        if (j.windowId || j.ensembleSetId) this.release(j);
      } catch {
        // ignore corrupt file
      }
    }
    this.trim();
  }

  private persist(job: Job): void {
    if (job.status === 'queued' || job.status === 'running') return;
    // A released job's results are only in its file: written back with it, not lost.
    const full = this.full(job.id) ?? job;
    const tmp = path.join(this.dir, `${job.id}.json.tmp`);
    // Frontier events are display-only and large: streamed live, not kept.
    fs.writeFileSync(tmp, JSON.stringify({ ...full, events: full.events.filter(e => e.event !== 'frontier') }));
    fs.renameSync(tmp, path.join(this.dir, `${job.id}.json`));
  }

  /**
   * Drop a finished departure-window job's route results from memory; they
   * stay in its file. A window keeps up to WINDOW_LIMITS.maxDepartures jobs
   * and WINDOW_LIMITS.keep windows, all exempt from the keepJobs trim, and
   * once a departure is done the window needs only its metrics (windows.ts),
   * taken from the 'done' event before this runs. Ordinary jobs keep theirs.
   */
  private release(job: Job): void {
    delete job.geojson;
    delete job.skRoute;
    delete job.skeleton;
    delete job.fronts;
    job.events = [];
    job.progress = [];
    this.released.add(job.id);
  }

  /**
   * The job with its route results: a released one's are read from its file,
   * for this answer only (without them if the file cannot be read).
   */
  full(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job || !this.released.has(id)) return job;
    let stored: Partial<Job>;
    try {
      stored = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as Partial<Job>;
    } catch {
      return job;
    }
    const out = { ...job } as Record<string, unknown>;
    for (const k of RESULT_KEYS) if (stored[k] !== undefined) out[k] = stored[k];
    return out as unknown as Job;
  }

  /** Change how many finished jobs are kept (settings) and trim now. */
  setKeepJobs(n: number): void {
    this.keepJobs = n;
    this.trim();
  }

  private trim(): void {
    const finished = [...this.jobs.values()]
      .filter(j => j.status !== 'queued' && j.status !== 'running' && !j.windowId && !j.ensembleSetId)
      .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
    for (const j of finished.slice(this.keepJobs)) this.delete(j.id);
  }

  /**
   * Emit an event to the live listeners and, unless `store` is false, keep
   * it in the job's last-500 buffer that a reconnecting SSE client replays
   * from its Last-Event-ID. Frontier events are not kept: one per stage,
   * large, and they would push the status and progress lines out.
   */
  private emitEvent(job: Job, event: JobEvent['event'], data: Record<string, unknown>, store = true): void {
    const ev: JobEvent = { id: job.nextEventId++, event, data };
    if (store) {
      job.events.push(ev);
      if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    }
    this.emit('event', job.id, ev);
  }

  links(id: string): JobLinks {
    const b = `${this.basePath}/api/routes/${id}`;
    return {
      self: b,
      events: `${b}/events`,
      result: `${b}/result`,
      skeleton: `${b}/skeleton`,
      fronts: `${b}/fronts`,
      cancel: `${b}/cancel`,
      publish: `${b}/publish`,
      meteogram: `${b}/meteogram`,
    };
  }

  toPublic(job: Job): JobPublic {
    return {
      id: job.id,
      status: job.status,
      request: job.request,
      created_at: job.createdAt,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      progress: job.progress.slice(-20),
      summary: job.summary,
      error: job.error,
      resource_id: job.resourceId,
      publish_error: job.publishError,
      window_id: job.windowId,
      ensemble_set_id: job.ensembleSetId,
      links: this.links(job.id),
    };
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** The newest jobs; a departure window's or an ensemble set's jobs only with `withWindows`. */
  list(limit = 50, withWindows = false): Job[] {
    return [...this.jobs.values()]
      .filter(j => withWindows || (!j.windowId && !j.ensembleSetId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get runningId(): string | null {
    return this.running;
  }

  submit(request: RouteRequest, windowId?: string, ensembleSetId?: string): Job {
    const job: Job = {
      id: randomUUID(),
      status: 'queued',
      request,
      createdAt: new Date().toISOString(),
      progress: [],
      events: [],
      nextEventId: 1,
    };
    if (windowId) job.windowId = windowId;
    if (ensembleSetId) job.ensembleSetId = ensembleSetId;
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.emitEvent(job, 'status', { status: 'queued', position: this.queue.length });
    this.pump();
    return job;
  }

  /** Called by the plugin to start the next queued job in the worker. */
  private pump(): void {
    if (this.running || this.queue.length === 0) return;
    const id = this.queue.shift()!;
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') {
      this.pump();
      return;
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.running = id;
    this.emitEvent(job, 'status', { status: 'running' });
    this.emit('start', job);
  }

  onProgress(id: string, stage: number, total: number, message: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const p: JobProgress = { time: new Date().toISOString(), stage, total, message };
    job.progress.push(p);
    if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
    this.emitEvent(job, 'progress', p as unknown as Record<string, unknown>);
  }

  /** A search stage's front: streamed to listeners, not stored (see persist). */
  onFrontier(id: string, front: Record<string, unknown>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.emitEvent(job, 'frontier', front, false);
  }

  onDone(
    id: string,
    geojson: Record<string, unknown>,
    skRoute: Record<string, unknown>,
    summary: RouteSummary,
    skeleton: Record<string, unknown> | null = null,
    fronts: unknown[] | null = null
  ): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.geojson = geojson;
    job.skRoute = skRoute;
    job.skeleton = skeleton;
    job.fronts = fronts;
    job.summary = summary;
    this.emitEvent(job, 'route', geojson);
    this.emitEvent(job, 'done', { status: 'done', summary });
    this.finish(job);
  }

  onError(id: string, message: string, cancelled = false): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = cancelled ? 'cancelled' : 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = message;
    this.emitEvent(job, 'error', { status: job.status, message });
    this.finish(job);
  }

  setPublished(id: string, resourceId: string | null, error?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (resourceId) job.resourceId = resourceId;
    if (error) job.publishError = error;
    this.emitEvent(job, 'status', { status: job.status, resource_id: job.resourceId, publish_error: job.publishError });
    this.persist(job);
  }

  private finish(job: Job): void {
    if (this.running === job.id) this.running = null;
    this.persist(job);
    if (job.windowId || job.ensembleSetId) this.release(job);
    this.trim();
    this.pump();
  }

  /** Returns 'queued' | 'running' | null depending on what was cancelled. */
  cancel(id: string): 'queued' | 'running' | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      this.queue = this.queue.filter(q => q !== id);
      this.onError(id, 'cancelled', true);
      return 'queued';
    }
    if (job.status === 'running') return 'running';
    return null;
  }

  delete(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'running') return false;
    this.queue = this.queue.filter(q => q !== id);
    this.jobs.delete(id);
    this.released.delete(id);
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`));
    } catch {
      // not persisted
    }
    return true;
  }

  /** Mark the running job failed (e.g. worker crashed). */
  failRunning(message: string): void {
    if (this.running) this.onError(this.running, message);
  }
}
