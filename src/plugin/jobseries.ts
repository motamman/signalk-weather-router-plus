/**
 * A series of route jobs (JobManager), submitted one at a time, the next when the one before has finished, so a route
 * asked for meanwhile waits behind one job, not the whole series: a departure window (windows.ts, one route per
 * departure time) and an ensemble set (ensembles.ts, one route per ensemble member). This is the one place for what
 * the two share: following each item's job, submitting the next, cancelling, deleting, keeping the newest finished,
 * saving each series to its file and bringing it back after a restart. Each kind says what its items are, what route
 * an item asks for, and what it does when it finishes.
 *
 * The series' jobs carry its id (Job.windowId or Job.ensembleSetId): they are left out of the job list and its trimming,
 * never published to the Resources API, and go when their series is deleted. Once an item is done, its route is kept
 * only in the job's results file (JobManager.release) and read from there when it is opened; the series keeps what a
 * comparison needs (departureMetrics).
 *
 * SI throughout (m/s, m, s); times ISO 8601.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Type, type Static } from 'typebox';
import type { Job, JobEvent, JobManager, JobSeriesOf } from './jobs';
import type { RouteRequest } from './protocol';
import { loadJsonFiles, removeJson, saveJson, type RecordNoun } from '../util/jsonfiles';

/** Close-hauled: a true wind angle below this, degrees. */
export const UPWIND_TWA_DEG = 60;

const nullableNumber = (description: string) => Type.Union([Type.Number(), Type.Null()], { description });

export const DepartureMetricsSchema = Type.Object({
  arrival: Type.String(),
  total_time_s: Type.Number(),
  sailing_time_s: Type.Number(),
  motoring_time_s: Type.Number(),
  total_distance_m: Type.Number(),
  max_wind_ms: nullableNumber('Strongest wind on any leg, m/s (null when the route carries none).'),
  max_swh_m: nullableNumber('Highest significant wave height on any leg, m.'),
  max_sea_index: nullableNumber('Roughest sea met: the largest encounter (or sea-state) index of a leg.'),
  upwind_time_s: Type.Number({ description: `Time sailed with the true wind less than ${UPWIND_TWA_DEG} degrees off the bow, s.` }),
  beyond_forecast: Type.Boolean({
    description: "The passage ended after the forecast's last step (its last legs ran on conditions held there).",
  }),
  warnings: Type.Number({ description: 'Route warnings (land crossings and the like).' }),
});
export type DepartureMetrics = Static<typeof DepartureMetricsSchema>;

/** A number that is not NaN or infinite. */
export function finiteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

interface PointProps {
  time?: string;
  twa_deg?: number;
  wind_ms?: number;
  leg_wind_max_ms?: number;
  swh_m?: number;
  leg_swh_max_m?: number;
  sea_index?: number;
  encounter_index?: number;
  leg_time_s?: number;
  mode?: string;
}

/** What a finished route job tells about its passage (a done job with its route: JobManager.full for a released one). */
export function departureMetrics(job: Job): DepartureMetrics {
  const s = job.summary;
  if (!s) throw new Error('the job has no summary');
  const features = (
    (job.geojson as { features?: { geometry?: { type?: string }; properties?: Record<string, unknown> }[] } | undefined)?.features ?? []
  ).filter(f => f && f.properties);
  const line = features.find(f => f.geometry?.type === 'LineString')?.properties ?? {};
  const pts = features.filter(f => f.geometry?.type === 'Point').map(f => f.properties as PointProps);
  let maxWind: number | null = null;
  let maxSwh: number | null = null;
  let maxSea: number | null = null;
  let upwind = 0;
  const up = (cur: number | null, v: unknown): number | null => (finiteNum(v) ? (cur === null ? v : Math.max(cur, v)) : cur);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    maxWind = up(up(maxWind, p.wind_ms), p.leg_wind_max_ms);
    maxSwh = up(up(maxSwh, p.swh_m), p.leg_swh_max_m);
    maxSea = up(maxSea, finiteNum(p.encounter_index) ? p.encounter_index : p.sea_index);
    // A point's angle is that of the leg into it; that leg's time is on the point before.
    const legTime = i > 0 ? pts[i - 1].leg_time_s : undefined;
    if (p.mode === 'sailing' && finiteNum(p.twa_deg) && p.twa_deg < UPWIND_TWA_DEG && finiteNum(legTime)) upwind += legTime;
  }
  return {
    arrival: s.arrival,
    total_time_s: s.total_time_s,
    sailing_time_s: s.sailing_time_s,
    motoring_time_s: s.motoring_time_s,
    total_distance_m: s.total_distance_m,
    max_wind_ms: maxWind,
    max_swh_m: maxSwh,
    max_sea_index: maxSea === null ? null : Math.round(maxSea * 10) / 10,
    upwind_time_s: Math.round(upwind),
    beyond_forecast: finiteNum(line.legs_beyond_forecast) && line.legs_beyond_forecast > 0,
    warnings: s.warnings,
  };
}

/** One route of a series: its job once submitted, where it stands, why it failed or was skipped, its metrics once done. */
export interface SeriesItem {
  job_id: string | null;
  status: 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  error?: string;
  metrics?: DepartureMetrics;
}

/** A series as saved and as the API shows it (less its items, which each kind names). */
export interface SeriesRecord {
  id: string;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  created_at: string;
  finished_at?: string;
  /** Why the series' file on disk is behind it (its last save failed); absent once a save succeeds. */
  save_error?: string;
  error?: string;
}

/** What a kind of series is called (its log lines, its restart messages) and how it is kept. */
export interface SeriesKind {
  /** The series: 'departure window', 'a departure window', 'departure windows'. */
  noun: RecordNoun;
  /** Its short name and its items' name, for the restart messages: 'window', 'departure'. */
  short: string;
  item: string;
  /** The folder of its files in the plugin data directory, and its API path below /api. */
  folder: string;
  route: string;
  /** Finished series kept, with their route jobs. */
  keep: number;
}

export interface SeriesDeps {
  /** Stop the route worker's running job (a queued one the job manager cancels itself). */
  cancelRunning: (jobId: string) => void;
  /** Where a failure the series carries, or a file that cannot be read or removed, is reported. */
  log: (msg: string) => void;
}

export abstract class JobSeries<S extends SeriesRecord> {
  private series = new Map<string, S>();
  private byJob = new Map<string, { s: S; k: number }>();
  private readonly dir: string;
  private readonly listener = (id: string, ev: JobEvent, job: Job): void => this.onJobEvent(id, ev, job);

  constructor(
    protected readonly jobs: JobManager,
    dataDir: string,
    protected readonly deps: SeriesDeps,
    private readonly kind: SeriesKind,
    private readonly basePath: string
  ) {
    this.dir = path.join(dataDir, kind.folder);
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadPersisted();
    jobs.on('event', this.listener);
  }

  /** The routes of series `s`, in order (the series' own array: changes to its items are its own). */
  protected abstract items(s: S): SeriesItem[];
  /** A series as saved: anything else in its folder is not restored. */
  protected abstract holds(v: unknown): v is S;
  /** The window or set its jobs are routes of. */
  protected abstract of(s: S): JobSeriesOf;
  /** The series a job is a route of (Job.windowId or Job.ensembleSetId), for jobs left by a series that is gone. */
  protected abstract seriesOfJob(job: Job): string | undefined;
  /**
   * The route request of item `k` of `s`, about to be submitted; or null when the item is settled without one (the
   * kind sets its status: a window's departure skipped).
   */
  protected abstract nextRoute(s: S, k: number): RouteRequest | null;
  /** Series `s` has finished (`done`, `cancelled`), after its last save. */
  protected finished(_s: S): void {}

  /** Stop listening (plugin stop). */
  close(): void {
    this.jobs.off('event', this.listener);
  }

  get running(): number {
    return [...this.series.values()].filter(s => s.status === 'running').length;
  }

  links(id: string): { self: string; cancel: string } {
    const b = `${this.basePath}/api/${this.kind.route}/${id}`;
    return { self: b, cancel: `${b}/cancel` };
  }

  get(id: string): S | undefined {
    return this.series.get(id);
  }

  /** The series, newest first: the first `limit`, or all of them. */
  list(limit?: number): S[] {
    return [...this.series.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  /** The last progress line of the item queued or computing, or null. */
  protected progress(s: S): string | null {
    const active = this.items(s).find(d => d.status === 'running' || d.status === 'queued');
    const job = active?.job_id ? this.jobs.get(active.job_id) : undefined;
    const last = job?.progress[job.progress.length - 1];
    return last ? last.message : null;
  }

  /** Start series `s` (its items pending): its first route is submitted now. */
  protected start(s: S): void {
    this.series.set(s.id, s);
    this.advance(s);
  }

  /** Cancel what is left: items not started, and the one queued or computing. */
  cancel(id: string): boolean {
    const s = this.series.get(id);
    if (!s || s.status !== 'running') return false;
    // Not running from here on, so the cancelled job's event does not submit the next item.
    s.status = 'cancelled';
    for (const d of this.items(s)) if (d.status === 'pending') d.status = 'cancelled';
    for (const d of this.items(s)) {
      if ((d.status === 'queued' || d.status === 'running') && d.job_id) {
        const what = this.jobs.cancel(d.job_id);
        if (what === 'running') this.deps.cancelRunning(d.job_id);
      }
    }
    this.finish(s, 'cancelled');
    return true;
  }

  /** A cancelled series whose item's route worker has not stopped yet: its job ends when the worker answers. */
  stopping(s: S): boolean {
    return this.items(s).some(d => d.job_id !== null && this.jobs.get(d.job_id)?.status === 'running');
  }

  /** Delete a finished series and its route jobs; not while it runs, nor while it is stopping (PR #51 review). */
  delete(id: string): boolean {
    const s = this.series.get(id);
    if (!s || s.status === 'running' || this.stopping(s)) return false;
    for (const d of this.items(s)) {
      if (!d.job_id) continue;
      this.byJob.delete(d.job_id);
      this.jobs.delete(d.job_id);
    }
    this.series.delete(id);
    // A file that cannot be removed stays: the series comes back after a restart.
    const why = removeJson(path.join(this.dir, `${id}.json`));
    if (why) this.deps.log(`${this.kind.noun.one} ${id}: its file could not be deleted (${why}); it comes back after a restart`);
    return true;
  }

  /**
   * An item's route job moved on: running, or done (its metrics taken) or failed or cancelled, then the next item is
   * submitted while the series runs. Events of jobs that are not an item are ignored. It may come while the item's
   * job is being submitted (a job can start, and end, inside JobManager.submit): the item knows its job by then.
   */
  private onJobEvent(jobId: string, ev: JobEvent, job: Job): void {
    const at = this.byJob.get(jobId);
    if (!at) return;
    const { s, k } = at;
    const d = this.items(s)[k];
    if (ev.event === 'status' && ev.data.status === 'running' && d.status === 'queued') {
      d.status = 'running';
      this.persist(s);
      return;
    }
    if (ev.event === 'done') {
      d.status = 'done';
      d.metrics = departureMetrics(job);
    } else if (ev.event === 'error') {
      d.status = ev.data.status;
      d.error = ev.data.message;
    } else return;
    if (s.status === 'running') this.advance(s);
    else this.persist(s);
  }

  /** Submit the next pending item's route, or finish the series when none is left. */
  private advance(s: S): void {
    const items = this.items(s);
    for (let k = 0; k < items.length; k++) {
      const d = items[k];
      if (d.status !== 'pending') continue;
      const request = this.nextRoute(s, k);
      if (!request) continue;
      this.jobs.submit(request, this.of(s), job => {
        d.job_id = job.id;
        d.status = 'queued';
        this.byJob.set(job.id, { s, k });
      });
      // The job's own events moved the item on (and, if it ended at once, submitted the next): saved as it stands.
      this.persist(s);
      return;
    }
    this.finish(s, 'done');
  }

  private finish(s: S, status: 'done' | 'cancelled'): void {
    s.status = status;
    s.finished_at = new Date().toISOString();
    this.persist(s);
    this.trim();
    this.finished(s);
  }

  /**
   * Save the series' file, how it outlives a restart (it runs from memory). A save that fails is the series' to carry,
   * not its caller's: `save_error` says why its file is behind (the API shows it), the failure is reported, and the
   * next change saves it again, clearing it. It never throws into a job event, a request or the start-up.
   */
  private persist(s: S): void {
    delete s.save_error;
    const why = saveJson(path.join(this.dir, `${s.id}.json`), s);
    if (!why) return;
    s.save_error = `its file could not be saved: ${why}`;
    this.deps.log(`${this.kind.noun.one} ${s.id}: ${s.save_error}`);
  }

  /** Finished series beyond `keep`, oldest first, deleted with their route jobs. */
  private trim(): void {
    const finished = [...this.series.values()]
      .filter(s => s.status !== 'running')
      .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));
    for (const s of finished.slice(this.kind.keep)) this.delete(s.id);
  }

  /**
   * The series saved before a restart. One that was running ends failed: its job in progress the job manager has
   * already failed, its items not started are cancelled. Route jobs of series that are gone are deleted.
   */
  private loadPersisted(): void {
    for (const s of loadJsonFiles(this.dir, this.kind.noun, (v: unknown): v is S => this.holds(v), this.deps.log)) {
      this.series.set(s.id, s);
      this.items(s).forEach((d, k) => {
        if (!d.job_id) return;
        this.byJob.set(d.job_id, { s, k });
        if (d.status !== 'queued' && d.status !== 'running') return;
        // Finished after the series was last saved, or lost with the restart (a job in progress is not saved).
        const job = this.jobs.full(d.job_id);
        if (job && (job.status === 'done' || job.status === 'cancelled')) {
          d.status = job.status;
          if (job.status === 'done') d.metrics = departureMetrics(job);
        } else {
          d.status = 'failed';
          d.error = job?.error ?? `plugin restarted while the ${this.kind.item} was being computed`;
        }
      });
      if (s.status === 'running') {
        for (const d of this.items(s)) if (d.status === 'pending') d.status = 'cancelled';
        s.status = 'failed';
        s.error = `plugin restarted while the ${this.kind.short} was in progress`;
        s.finished_at = new Date().toISOString();
        this.persist(s);
      }
    }
    const known = new Set(this.byJob.keys());
    for (const j of this.jobs.list(Number.MAX_SAFE_INTEGER, true)) if (this.seriesOfJob(j) && !known.has(j.id)) this.jobs.delete(j.id);
    this.trim();
  }
}
