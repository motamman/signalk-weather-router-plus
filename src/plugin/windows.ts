/**
 * Departure windows: the same route computed for a series of departure
 * times across the forecast, so the passage's best time to leave can be
 * picked (POST /api/windows). Each departure is an ordinary route job
 * (JobManager), submitted one at a time when the one before has finished,
 * so a route asked for meanwhile waits behind one job, not the whole
 * window. Those jobs carry the window's id: they are left out of the job
 * list and its trimming, never published to the Resources API, and go when
 * their window is deleted. Once a departure is done, its route is kept only
 * in the job's file (JobManager.release) and read from there when the
 * departure is opened.
 *
 * Per departure the window keeps what a choice needs (departureMetrics):
 * arrival, passage time, sailing and motoring time, the strongest wind and
 * highest waves met, the roughest sea, the time close-hauled, and whether
 * the passage ran past the forecast. A departure after the forecast's last
 * step is not computed, and once a passage ends past the forecast the later
 * departures are skipped too: their passages would end later still.
 *
 * SI throughout (m/s, m, s); times ISO 8601.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, JobEvent, JobManager } from './jobs';
import { Type, type Static } from 'typebox';
import { RouteRequestSchema, validateRouteRequest } from './request_schema';

export const WINDOW_LIMITS = {
  /** Departures in one window. */
  maxDepartures: 48,
  /** Seconds between departures: default, smallest, largest. */
  stepS: { default: 6 * 3600, min: 3600, max: 24 * 3600 },
  /** Latest departure at most this long after the earliest, s. */
  maxSpanS: 16 * 86400,
  /** Finished windows kept (with their route jobs). */
  keep: 10,
  /** Windows computing at once. */
  maxRunning: 2,
};

/** Close-hauled: a true wind angle below this, degrees. */
export const UPWIND_TWA_DEG = 60;

/** The window request (POST /api/windows): the type and the OpenAPI schema. */
export const WindowRequestSchema = Type.Object({
  route: Type.Object(RouteRequestSchema.properties, {
    description: 'The route request, as POST /api/routes takes it; departure and publish are set per departure',
  }),
  from: Type.String({ format: 'date-time', description: 'Earliest departure' }),
  to: Type.String({ format: 'date-time', description: 'Latest departure (at most 16 days after from)' }),
  step_s: Type.Optional(
    Type.Number({
      minimum: WINDOW_LIMITS.stepS.min,
      maximum: WINDOW_LIMITS.stepS.max,
      default: WINDOW_LIMITS.stepS.default,
      description: `Seconds between departures (at most ${WINDOW_LIMITS.maxDepartures} departures)`,
    })
  ),
});
export type WindowRequest = Static<typeof WindowRequestSchema>;

export const DepartureStatusSchema = Type.Enum(['pending', 'queued', 'running', 'done', 'failed', 'cancelled', 'skipped'] as const, {
  type: 'string',
});
export type DepartureStatus = Static<typeof DepartureStatusSchema>;

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

export const WindowDepartureSchema = Type.Object({
  departure: Type.String(),
  job_id: Type.Union([Type.String(), Type.Null()]),
  status: DepartureStatusSchema,
  error: Type.Optional(Type.String()),
  metrics: Type.Optional(DepartureMetricsSchema),
});
export type WindowDeparture = Static<typeof WindowDepartureSchema>;

export const WindowStatusSchema = Type.Enum(['running', 'done', 'cancelled', 'failed'] as const, { type: 'string' });
export type WindowStatus = Static<typeof WindowStatusSchema>;

export const DepartureWindowSchema = Type.Object({
  id: Type.String(),
  status: WindowStatusSchema,
  created_at: Type.String(),
  finished_at: Type.Optional(Type.String()),
  save_error: Type.Optional(
    Type.String({ description: "Why the window's file on disk is behind it (its last save failed); absent once a save succeeds" })
  ),
  error: Type.Optional(Type.String()),
  request: WindowRequestSchema,
  departures: Type.Array(WindowDepartureSchema),
});
export type DepartureWindow = Static<typeof DepartureWindowSchema>;

/** A window as the API answers it (WindowManager.toPublic): the departure computing's last progress line, and links. */
export const WindowPublicSchema = Type.Object({
  ...DepartureWindowSchema.properties,
  progress: Type.Union([Type.String(), Type.Null()]),
  links: Type.Object({ self: Type.String(), cancel: Type.String() }),
});
export type WindowPublic = Static<typeof WindowPublicSchema>;

function finiteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The departure times of a window, ms: from `fromMs` every `stepS` up to `toMs` (both ends included). */
export function windowDepartures(fromMs: number, toMs: number, stepS: number): number[] {
  const out: number[] = [];
  for (let t = fromMs; t <= toMs + 1 && out.length <= WINDOW_LIMITS.maxDepartures; t += stepS * 1000) out.push(t);
  return out;
}

/** Why a window request is not acceptable, or null. */
export function validateWindowRequest(b: unknown): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'JSON body required: {route: {start, end, …}, from, to, step_s}';
  const r = b as Partial<WindowRequest>;
  if (!r.route || typeof r.route !== 'object') return 'route is required: the route request, as POST /api/routes takes it';
  const fromMs = Date.parse(String(r.from));
  const toMs = Date.parse(String(r.to));
  if (typeof r.from !== 'string' || !Number.isFinite(fromMs)) return 'from must be an ISO 8601 time';
  if (typeof r.to !== 'string' || !Number.isFinite(toMs)) return 'to must be an ISO 8601 time';
  if (toMs < fromMs) return 'to must not be before from';
  if ((toMs - fromMs) / 1000 > WINDOW_LIMITS.maxSpanS) return `to must be within ${WINDOW_LIMITS.maxSpanS} s of from`;
  const step = r.step_s ?? WINDOW_LIMITS.stepS.default;
  if (!finiteNum(step) || step < WINDOW_LIMITS.stepS.min || step > WINDOW_LIMITS.stepS.max)
    return `step_s must be a number in [${WINDOW_LIMITS.stepS.min}, ${WINDOW_LIMITS.stepS.max}]`;
  // Counted from the span: windowDepartures stops one past the limit.
  const n = Math.floor((toMs - fromMs + 1) / (step * 1000)) + 1;
  if (n > WINDOW_LIMITS.maxDepartures)
    return `the window has ${n} departures; at most ${WINDOW_LIMITS.maxDepartures} (a later from, an earlier to, or a longer step_s)`;
  const routeErr = validateRouteRequest({ ...r.route, departure: new Date(fromMs).toISOString() });
  return routeErr ? `route: ${routeErr}` : null;
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

/** What a finished route job tells about its departure. */
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
    if (i > 0 && p.mode === 'sailing' && finiteNum(p.twa_deg) && p.twa_deg < UPWIND_TWA_DEG && finiteNum(pts[i - 1].leg_time_s))
      upwind += pts[i - 1].leg_time_s!;
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

/**
 * The notification a finished window sends (its departures' routes send none). The fastest is picked as the Route
 * tab's table ranks (rp-plan.js `_winBest`): of the passages that end within the forecast, since one that runs past
 * it sailed its last legs on conditions held at the last step. SI: the client converts to its user's units.
 */
export function windowNotification(w: DepartureWindow): { state: 'normal' | 'warn'; message: string } {
  const done = w.departures.filter(d => d.metrics);
  if (!done.length)
    return { state: 'warn', message: `departure window finished: no route for any of its ${w.departures.length} departures` };
  const head = `departure window ready: ${done.length} of ${w.departures.length} departures computed`;
  const ranked = done.filter(d => !d.metrics!.beyond_forecast);
  if (!ranked.length) return { state: 'normal', message: `${head}; every passage computed arrives after the forecast ends` };
  const fastest = ranked.reduce((a, b) => (b.metrics!.total_time_s < a.metrics!.total_time_s ? b : a));
  return {
    state: 'normal',
    message: `${head}; the fastest leaves ${fastest.departure} and takes ${Math.round(fastest.metrics!.total_time_s)} s`,
  };
}

export interface WindowDeps {
  /** Stop the route worker's running job (a queued one the job manager cancels itself). */
  cancelRunning: (jobId: string) => void;
  /** Last valid time of the forecast loaded now, ms (null before one is loaded). */
  forecastValidToMs: () => number | null;
  /** A window finished: tell the user (Signal K notification). */
  onFinished?: (w: DepartureWindow) => void;
  /** Where a failure the window carries is reported (persist). */
  log: (msg: string) => void;
}

export class WindowManager {
  private windows = new Map<string, DepartureWindow>();
  private byJob = new Map<string, { w: DepartureWindow; k: number }>();
  private readonly dir: string;
  private readonly listener = (id: string, ev: JobEvent): void => this.onJobEvent(id, ev);

  constructor(
    private readonly jobs: JobManager,
    dataDir: string,
    private readonly deps: WindowDeps,
    private readonly basePath = ''
  ) {
    this.dir = path.join(dataDir, 'windows');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadPersisted();
    jobs.on('event', this.listener);
  }

  /** Stop listening (plugin stop). */
  close(): void {
    this.jobs.off('event', this.listener);
  }

  get running(): number {
    return [...this.windows.values()].filter(w => w.status === 'running').length;
  }

  links(id: string): WindowPublic['links'] {
    const b = `${this.basePath}/api/windows/${id}`;
    return { self: b, cancel: `${b}/cancel` };
  }

  /** Start a window (the request validated by validateWindowRequest). */
  create(req: WindowRequest): DepartureWindow {
    const step = req.step_s ?? WINDOW_LIMITS.stepS.default;
    const w: DepartureWindow = {
      id: randomUUID(),
      status: 'running',
      created_at: new Date().toISOString(),
      request: { ...req, step_s: step },
      departures: windowDepartures(Date.parse(req.from), Date.parse(req.to), step).map(t => ({
        departure: new Date(t).toISOString(),
        job_id: null,
        status: 'pending',
      })),
    };
    this.windows.set(w.id, w);
    this.advance(w);
    return w;
  }

  get(id: string): DepartureWindow | undefined {
    return this.windows.get(id);
  }

  list(limit = 20): DepartureWindow[] {
    return [...this.windows.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  /** The window as the API shows it: the departures, the progress of the one computing, links. */
  toPublic(w: DepartureWindow): WindowPublic {
    const active = w.departures.find(d => d.status === 'running' || d.status === 'queued');
    const job = active?.job_id ? this.jobs.get(active.job_id) : undefined;
    const last = job?.progress[job.progress.length - 1];
    return { ...w, progress: last ? last.message : null, links: this.links(w.id) };
  }

  /** Cancel what is left: departures not started, and the one queued or computing. */
  cancel(id: string): boolean {
    const w = this.windows.get(id);
    if (!w || w.status !== 'running') return false;
    // Not running from here on, so the cancelled job's event does not submit the next departure.
    w.status = 'cancelled';
    for (const d of w.departures) if (d.status === 'pending') d.status = 'cancelled';
    for (const d of w.departures) {
      if ((d.status === 'queued' || d.status === 'running') && d.job_id) {
        const what = this.jobs.cancel(d.job_id);
        if (what === 'running') this.deps.cancelRunning(d.job_id);
      }
    }
    this.finish(w, 'cancelled');
    return true;
  }

  /** A cancelled window whose departure's route worker has not stopped yet: its job ends when the worker answers. */
  stopping(w: DepartureWindow): boolean {
    return w.departures.some(d => d.job_id !== null && this.jobs.get(d.job_id)?.status === 'running');
  }

  /** Delete a finished window and its route jobs; not while it runs, nor while it is stopping (PR #51 review). */
  delete(id: string): boolean {
    const w = this.windows.get(id);
    if (!w || w.status === 'running' || this.stopping(w)) return false;
    for (const d of w.departures) {
      if (!d.job_id) continue;
      this.byJob.delete(d.job_id);
      this.jobs.delete(d.job_id);
    }
    this.windows.delete(id);
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`));
    } catch {
      // not persisted
    }
    return true;
  }

  private onJobEvent(jobId: string, ev: JobEvent): void {
    const at = this.byJob.get(jobId);
    if (!at) return;
    const { w, k } = at;
    const d = w.departures[k];
    if (ev.event === 'status' && ev.data.status === 'running' && d.status === 'queued') {
      d.status = 'running';
      this.persist(w);
      return;
    }
    if (ev.event !== 'done' && ev.event !== 'error') return;
    const job = this.jobs.get(jobId);
    if (ev.event === 'done' && job) {
      d.status = 'done';
      try {
        d.metrics = departureMetrics(job);
      } catch (err) {
        d.error = (err as Error).message;
      }
    } else {
      d.status = ev.data.status === 'cancelled' ? 'cancelled' : 'failed';
      d.error = String(ev.data.message ?? job?.error ?? 'failed');
    }
    if (w.status === 'running') this.advance(w);
    else this.persist(w);
  }

  /**
   * Submit the next departure, or finish the window. Departures after the
   * forecast's last step, and all after a passage that ran past it, are skipped.
   */
  private advance(w: DepartureWindow): void {
    const validTo = this.deps.forecastValidToMs();
    const pastForecast = w.departures.some(d => d.metrics?.beyond_forecast);
    for (let k = 0; k < w.departures.length; k++) {
      const d = w.departures[k];
      if (d.status !== 'pending') continue;
      if (pastForecast) {
        d.status = 'skipped';
        d.error = 'an earlier departure already arrives after the forecast ends';
        continue;
      }
      if (validTo !== null && Date.parse(d.departure) >= validTo) {
        d.status = 'skipped';
        d.error = 'departs after the forecast ends';
        continue;
      }
      // Each departure is its own route job, never published to the Resources API.
      const name = `${w.request.route.name?.trim() || 'Departure window'} · ${d.departure.slice(0, 16).replace('T', ' ')}Z`;
      const job = this.jobs.submit({ ...w.request.route, departure: d.departure, publish: false, name }, w.id);
      d.job_id = job.id;
      this.byJob.set(job.id, { w, k });
      // Started at once and failed at once (dispatchRoute without a Resources API to read the notes from): its
      // error event came before byJob knew the job, so it is taken here, and the next departure goes on.
      if (job.status === 'failed' || job.status === 'cancelled') {
        d.status = job.status;
        d.error = job.error ?? 'failed';
        continue;
      }
      d.status = job.status === 'running' ? 'running' : 'queued';
      this.persist(w);
      return;
    }
    this.finish(w, 'done');
  }

  private finish(w: DepartureWindow, status: WindowStatus, error?: string): void {
    w.status = status;
    w.finished_at = new Date().toISOString();
    if (error) w.error = error;
    this.persist(w);
    this.trim();
    if (status === 'done') this.deps.onFinished?.(w);
  }

  /**
   * Save the departure window's file. The file is how the departure window outlives a restart; the departure window itself runs from memory. A save that
   * fails (a full or read-only disk) is the departure window's to carry, not its caller's: `save_error` says why its file is behind
   * (the API shows it), the failure is reported, and the next change saves it again, clearing it. It never throws into
   * a job event, a request or the start-up.
   */
  private persist(w: DepartureWindow): void {
    const file = path.join(this.dir, `${w.id}.json`);
    const tmp = `${file}.tmp`;
    delete w.save_error;
    try {
      fs.writeFileSync(tmp, JSON.stringify(w));
      fs.renameSync(tmp, file);
    } catch (err) {
      w.save_error = `its file could not be saved: ${(err as Error).message}`;
      this.deps.log(`departure window ${w.id}: ${w.save_error}`);
      // Its half-written copy, if the write got that far (existsSync never throws).
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    }
  }

  private trim(): void {
    const finished = [...this.windows.values()]
      .filter(w => w.status !== 'running')
      .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));
    for (const w of finished.slice(WINDOW_LIMITS.keep)) this.delete(w.id);
  }

  /**
   * Windows from before a restart. One that was computing ends failed: its
   * job in progress the job manager has already failed, its departures not
   * started are cancelled. Route jobs of windows that are gone are deleted.
   */
  private loadPersisted(): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch {
      /* none */
    }
    for (const f of files) {
      let w: DepartureWindow;
      try {
        w = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as DepartureWindow;
      } catch {
        continue; // ignore a corrupt file
      }
      if (!w || !w.id || !Array.isArray(w.departures)) continue;
      this.windows.set(w.id, w);
      w.departures.forEach((d, k) => {
        if (!d.job_id) return;
        this.byJob.set(d.job_id, { w, k });
        if (d.status !== 'queued' && d.status !== 'running') return;
        // Finished after the window was last saved, or lost with the restart (a job in progress is not saved).
        const job = this.jobs.full(d.job_id);
        if (job && (job.status === 'done' || job.status === 'cancelled')) {
          d.status = job.status;
          if (job.status === 'done') d.metrics = departureMetrics(job);
        } else {
          d.status = 'failed';
          d.error = job?.error ?? 'plugin restarted while the departure was being computed';
        }
      });
      if (w.status === 'running') {
        for (const d of w.departures) if (d.status === 'pending') d.status = 'cancelled';
        w.status = 'failed';
        w.error = 'plugin restarted while the window was in progress';
        w.finished_at = new Date().toISOString();
        this.persist(w);
      }
    }
    const known = new Set(this.byJob.keys());
    for (const j of this.jobs.list(Number.MAX_SAFE_INTEGER, true)) if (j.windowId && !known.has(j.id)) this.jobs.delete(j.id);
    this.trim();
  }
}
