/**
 * Job manager: queue of route requests, one running at a time in the
 * worker, with an event log per job for Server-Sent Events (resumable
 * via Last-Event-ID) and on-disk persistence of finished jobs. A file that
 * cannot be saved, read or removed is the job's to carry (saveError) or
 * is reported (log); it never stops the queue.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobProgress, JobStatus, RouteRequest, RouteSummary } from './protocol';
import { JOB_STATUSES, type JobLinks, type JobPublic } from './response_schema';
import { loadJsonFiles, removeJson, saveJson } from '../util/jsonfiles';

/** What a job's event says: the end of a job typed (a listener reads its message or summary), the others as sent. */
export type JobEventBody =
  | { event: 'error'; data: { status: 'failed' | 'cancelled'; message: string } }
  | { event: 'done'; data: { status: 'done'; summary: RouteSummary } }
  | { event: 'status' | 'progress' | 'route' | 'frontier'; data: Record<string, unknown> };
/** A job's event, numbered for the SSE replay (Last-Event-ID). Listeners get it with the job: on('event', (id, ev, job)). */
export type JobEvent = JobEventBody & { id: number };

/** The departure window or ensemble set a job is one route of (windows.ts, ensembles.ts): none for a route of its own. */
export interface JobSeriesOf {
  windowId?: string;
  ensembleSetId?: string;
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
  /** Why the job's file on disk is behind it (its last save failed); absent once a save succeeds. */
  saveError?: string;
  events: JobEvent[];
  nextEventId: number;
}

/** A job as the API answers it: the type comes from its schema (response_schema.ts), as does the OpenAPI document. */
export type { JobPublic };

/**
 * A finished job's route results: saved once, when it finishes, in a file of their own (results/<id>.json), and never
 * written again. The job's own file (<id>.json) holds the rest and is saved at each change; it holds these only while
 * their own file is not saved, so no save of the job can lose them. A departure window's or ensemble set's job keeps
 * them only in their file (release).
 */
const RESULT_KEYS = ['geojson', 'skRoute', 'skeleton', 'fronts', 'events', 'progress'] as const;
type JobResults = Pick<Job, (typeof RESULT_KEYS)[number]>;

/** A route as routeformat.ts writes it: a feature collection whose features (the line first, then the points) carry properties. */
function holdsRoute(v: unknown): boolean {
  const features = (v as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return false;
  const shaped = features.every(f => {
    const g = f as { geometry?: { type?: unknown }; properties?: unknown } | null;
    return !!g && typeof g.geometry?.type === 'string' && !!g.properties && typeof g.properties === 'object';
  });
  return shaped && features.some(f => (f as { geometry: { type: string } }).geometry.type === 'LineString');
}

/** Results as saved (resultsOf): the events and progress, and for a done job its route. */
function holdsResults(v: unknown, done: boolean): v is JobResults {
  const r = v as JobResults | null;
  return !!r && typeof r === 'object' && Array.isArray(r.events) && Array.isArray(r.progress) && (!done || holdsRoute(r.geojson));
}

/** A job's results, as saved: its frontier events are display-only and large, streamed live and not kept. */
function resultsOf(job: Job): JobResults {
  const out = {} as Record<string, unknown>;
  for (const k of RESULT_KEYS) out[k] = job[k];
  return { ...(out as JobResults), events: job.events.filter(e => e.event !== 'frontier') };
}

/** A job without its results: what its own file holds. */
function stateOf(job: Job): Omit<Job, (typeof RESULT_KEYS)[number] | 'saveError'> {
  const out = { ...job } as Record<string, unknown>;
  for (const k of RESULT_KEYS) delete out[k];
  delete out.saveError;
  return out as Omit<Job, (typeof RESULT_KEYS)[number] | 'saveError'>;
}

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running: string | null = null;
  /** Jobs whose route results are only on disk (release): full() reads them back. */
  private released = new Set<string>();
  /** Finished jobs whose results file is not saved yet (a save failed): the next save of the job tries again. */
  private resultsUnsaved = new Set<string>();
  private readonly dir: string;
  private readonly resultsDir: string;

  constructor(
    dataDir: string,
    private keepJobs: number,
    private readonly basePath: string,
    /** Where a failure a job carries, or a file that cannot be read or removed, is reported. */
    private readonly log: (msg: string) => void
  ) {
    super();
    this.dir = path.join(dataDir, 'jobs');
    this.resultsDir = path.join(this.dir, 'results');
    fs.mkdirSync(this.resultsDir, { recursive: true });
    this.loadPersisted();
  }

  private resultsFile(id: string): string {
    return path.join(this.resultsDir, `${id}.json`);
  }

  /**
   * The jobs saved before a restart (loadJsonFiles): one that was queued or running is failed. A window's or set's job
   * is released (its results are in their file); any other job's results are read into memory. A job file saved
   * before the results had a file of their own holds them: they are moved to theirs, once. A results file whose job
   * has no file at all (a delete that removed the job's file but not its results, a results save followed by a failed
   * save of the job's file) is removed; one whose job file is there but refused is kept with it, and nothing is removed
   * when the jobs folder could not be listed.
   */
  private loadPersisted(): void {
    /**
     * A job as saved: an id, one of a job's statuses (JOB_STATUSES), its request and when it was created (the lists and
     * the trim order by it); a done one its summary; and its results either all inside (the layout before they had a
     * file of their own: its events with them, as holdsResults wants them) or none (stateOf leaves none). A file with
     * some of them and no events is not one this code wrote. Any other file is not restored.
     */
    const isJob = (v: unknown): v is Job => {
      const j = v as Job | null;
      if (!j || typeof j !== 'object' || typeof j.id !== 'string' || !(JOB_STATUSES as readonly string[]).includes(j.status) || !j.request)
        return false;
      if (typeof j.createdAt !== 'string') return false;
      if (j.status === 'done' && (!j.summary || typeof j.summary !== 'object')) return false;
      return j.events === undefined ? RESULT_KEYS.every(k => !(k in j)) : holdsResults(j, j.status === 'done');
    };
    const noun = { one: 'route job', a: 'a route job', many: 'route jobs' };
    const loaded = loadJsonFiles(this.dir, noun, isJob, this.log);
    for (const j of loaded.records) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed';
        j.error = 'plugin restarted while the job was in progress';
      }
      this.jobs.set(j.id, j);
      if (j.events !== undefined) {
        // Saved with its results inside: they get their file now, and the job's file loses them.
        this.resultsUnsaved.add(j.id);
        this.persist(j);
      } else if (j.windowId || j.ensembleSetId) {
        j.events = [];
        j.progress = [];
        this.released.add(j.id);
      } else {
        Object.assign(j, this.readResults(j) ?? { events: [], progress: [] });
      }
      j.nextEventId = j.nextEventId ?? j.events.length + 1;
    }
    if (loaded.folderRead) this.removeResultsWithoutJob(new Set([...loaded.records.map(j => j.id), ...loaded.leftAsIs]));
    this.trim();
  }

  /** Remove the results files of jobs not among `jobFiles` (the names of every job file, restored or not). */
  private removeResultsWithoutJob(jobFiles: Set<string>): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.resultsDir);
    } catch (err) {
      this.log(`route jobs: ${this.resultsDir} cannot be read (${(err as Error).message}); route results of jobs that are gone stay`);
      return;
    }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (jobFiles.has(id)) continue;
      const why = removeJson(path.join(this.resultsDir, f));
      this.log(
        why
          ? `route job ${id}: gone, but its route results could not be removed (${why})`
          : `route job ${id}: gone; its route results removed`
      );
    }
  }

  /** A job's saved results, or null when their file cannot be read, or does not hold results (reported). */
  private readResults(job: Job): JobResults | null {
    let v: unknown;
    try {
      v = JSON.parse(fs.readFileSync(this.resultsFile(job.id), 'utf8'));
    } catch (err) {
      this.log(`route job ${job.id}: its route results cannot be read (${(err as Error).message}); answered without them`);
      return null;
    }
    if (holdsResults(v, job.status === 'done')) return v;
    this.log(`route job ${job.id}: its route results file does not hold route results; answered without them`);
    return null;
  }

  /**
   * Save a finished job: its results once (their file is never written again), then its own file, at each change.
   * A window's or set's job leaves memory (release) only once its results are saved; until then the job's own file
   * holds them too. A save that fails is the job's to carry: `saveError` says what is behind (the API shows it), the failure is reported, unsaved results stay in
   * memory, and the next change saves again. It never throws into the worker's answer, a request or the queue.
   */
  private persist(job: Job): void {
    if (job.status === 'queued' || job.status === 'running') return;
    delete job.saveError;
    const failed: string[] = [];
    if (this.resultsUnsaved.has(job.id)) {
      const why = saveJson(this.resultsFile(job.id), resultsOf(job));
      if (why) failed.push(`its route results could not be saved: ${why}`);
      else {
        this.resultsUnsaved.delete(job.id);
        if (job.windowId || job.ensembleSetId) this.release(job);
      }
    }
    // While its results have no file of their own, the job's file holds them, as it did before they had one: nothing
    // on disk is ever without them (loadPersisted moves them out at the next start).
    const own = this.resultsUnsaved.has(job.id) ? { ...stateOf(job), ...resultsOf(job) } : stateOf(job);
    const why = saveJson(path.join(this.dir, `${job.id}.json`), own);
    if (why) failed.push(`its file could not be saved: ${why}`);
    if (!failed.length) return;
    job.saveError = failed.join('; ');
    this.log(`route job ${job.id}: ${job.saveError}`);
  }

  /**
   * Drop a finished departure-window job's route results from memory once
   * they are saved in their file (persist). A window keeps up to WINDOW_LIMITS.maxDepartures jobs
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
   * The job with its route results: a released one's are read from their
   * file, for this answer only. A file that cannot be read is reported, and
   * the job is answered without them.
   */
  full(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job || !this.released.has(id)) return job;
    const stored = this.readResults(job);
    return stored ? { ...job, ...stored } : job;
  }

  /** Change how many finished jobs are kept (settings) and trim now. */
  setKeepJobs(n: number): void {
    this.keepJobs = n;
    this.trim();
  }

  /** Finished jobs beyond `keepJobs`, oldest first, deleted; a window's or a set's jobs go with their window or set. */
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
  private emitEvent(job: Job, body: JobEventBody, store = true): void {
    const ev = { ...body, id: job.nextEventId++ } as JobEvent;
    if (store) {
      job.events.push(ev);
      if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    }
    this.emit('event', job.id, ev, job);
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
      save_error: job.saveError,
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

  /**
   * Queue a route request, started at once when none is running. `of`: the window or set it is one route of. `created`:
   * called with the job before it is queued, so a caller that follows its events knows it before the first one (a job
   * can start, and fail, before submit returns).
   */
  submit(request: RouteRequest, of: JobSeriesOf = {}, created?: (job: Job) => void): Job {
    const job: Job = {
      id: randomUUID(),
      status: 'queued',
      request,
      createdAt: new Date().toISOString(),
      progress: [],
      events: [],
      nextEventId: 1,
    };
    if (of.windowId) job.windowId = of.windowId;
    if (of.ensembleSetId) job.ensembleSetId = of.ensembleSetId;
    this.jobs.set(job.id, job);
    created?.(job);
    this.queue.push(job.id);
    this.emitEvent(job, { event: 'status', data: { status: 'queued', position: this.queue.length } });
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
    this.emitEvent(job, { event: 'status', data: { status: 'running' } });
    this.emit('start', job);
  }

  onProgress(id: string, stage: number, total: number, message: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const p: JobProgress = { time: new Date().toISOString(), stage, total, message };
    job.progress.push(p);
    if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
    this.emitEvent(job, { event: 'progress', data: p as unknown as Record<string, unknown> });
  }

  /** A search stage's front: streamed to listeners, not stored (see persist). */
  onFrontier(id: string, front: Record<string, unknown>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.emitEvent(job, { event: 'frontier', data: front }, false);
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
    this.emitEvent(job, { event: 'route', data: geojson });
    this.emitEvent(job, { event: 'done', data: { status: 'done', summary } });
    this.finish(job);
  }

  onError(id: string, message: string, cancelled = false): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const status = cancelled ? 'cancelled' : 'failed';
    job.status = status;
    job.finishedAt = new Date().toISOString();
    job.error = message;
    this.emitEvent(job, { event: 'error', data: { status, message } });
    this.finish(job);
  }

  setPublished(id: string, resourceId: string | null, error?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (resourceId) job.resourceId = resourceId;
    if (error) job.publishError = error;
    this.emitEvent(job, { event: 'status', data: { status: job.status, resource_id: job.resourceId, publish_error: job.publishError } });
    this.persist(job);
  }

  private finish(job: Job): void {
    if (this.running === job.id) this.running = null;
    // Its results are final now: saved once, with the job.
    this.resultsUnsaved.add(job.id);
    this.persist(job);
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

  /** Delete a job and its file (a queued one leaves the queue); a running one is not deleted (false). */
  delete(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'running') return false;
    this.queue = this.queue.filter(q => q !== id);
    this.jobs.delete(id);
    this.released.delete(id);
    this.resultsUnsaved.delete(id);
    // A job file that cannot be removed stays, and its results with it: the job comes back after a restart, whole.
    const why = removeJson(path.join(this.dir, `${id}.json`));
    if (why) {
      this.log(`route job ${id}: its file could not be deleted (${why}); it comes back after a restart, with its route results`);
      return true;
    }
    const whyResults = removeJson(this.resultsFile(id));
    if (whyResults) this.log(`route job ${id}: its route results file could not be deleted (${whyResults})`);
    return true;
  }

  /** Mark the running job failed (e.g. worker crashed). */
  failRunning(message: string): void {
    if (this.running) this.onError(this.running, message);
  }
}
