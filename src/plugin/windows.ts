/**
 * Departure windows: the same route computed for a series of departure
 * times across the forecast, so the passage's best time to leave can be
 * picked (POST /api/windows). A window is a series of route jobs, one per
 * departure, submitted one at a time (jobseries.ts JobSeries: following,
 * cancelling, saving and restoring are shared with the ensemble sets).
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

import { randomUUID } from 'node:crypto';
import type { Job, JobManager, JobSeriesOf } from './jobs';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { RouteRequestSchema, validateRouteRequest } from './request_schema';
import type { RouteRequest } from './protocol';
import { DepartureMetricsSchema, finiteNum, JobSeries, type SeriesDeps, type SeriesItem } from './jobseries';

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

/** A window's links (jobseries.ts links): itself, and its cancel. */
export const WindowLinksSchema = Type.Object({ self: Type.String(), cancel: Type.String() });

/** A window as the API answers it (WindowManager.toPublic): the departure computing's last progress line, and links. */
export const WindowPublicSchema = Type.Object({
  ...DepartureWindowSchema.properties,
  progress: Type.Union([Type.String(), Type.Null()]),
  links: WindowLinksSchema,
});
export type WindowPublic = Static<typeof WindowPublicSchema>;

/**
 * The answer to POST /api/windows (202): the window started, by id, with how many departures it has and its links;
 * the window itself is GET /api/windows/{id} (WindowPublicSchema). The one shape the handler answers and the OpenAPI
 * document describes.
 */
export const WindowCreatedSchema = Type.Object({
  id: Type.String(),
  status: WindowStatusSchema,
  departures: Type.Integer({ description: 'How many departures the window has' }),
  links: WindowLinksSchema,
});
export type WindowCreated = Static<typeof WindowCreatedSchema>;

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

/**
 * The notification a finished window sends (its departures' routes send none). The fastest is picked as the Route
 * tab's table ranks (rp-plan.js `_winBest`): of the passages that end within the forecast, since one that runs past
 * it sailed its last legs on conditions held at the last step. SI: the client converts to its user's units.
 */
export function windowNotification(w: DepartureWindow): { state: 'normal' | 'warn'; message: string } {
  const done = w.departures.flatMap(d => (d.metrics ? [{ departure: d.departure, m: d.metrics }] : []));
  if (!done.length)
    return { state: 'warn', message: `departure window finished: no route for any of its ${w.departures.length} departures` };
  const head = `departure window ready: ${done.length} of ${w.departures.length} departures computed`;
  const ranked = done.filter(d => !d.m.beyond_forecast);
  if (!ranked.length) return { state: 'normal', message: `${head}; every passage computed arrives after the forecast ends` };
  const fastest = ranked.reduce((a, b) => (b.m.total_time_s < a.m.total_time_s ? b : a));
  return {
    state: 'normal',
    message: `${head}; the fastest leaves ${fastest.departure} and takes ${Math.round(fastest.m.total_time_s)} s`,
  };
}

export interface WindowDeps extends SeriesDeps {
  /** Last valid time of the forecast loaded now, ms (null before one is loaded). */
  forecastValidToMs: () => number | null;
  /** A window finished: tell the user (Signal K notification). */
  onFinished?: (w: DepartureWindow) => void;
}

export class WindowManager extends JobSeries<DepartureWindow> {
  constructor(
    jobs: JobManager,
    dataDir: string,
    private readonly windowDeps: WindowDeps,
    basePath = ''
  ) {
    super(
      jobs,
      dataDir,
      windowDeps,
      {
        noun: { one: 'departure window', a: 'a departure window', many: 'departure windows' },
        short: 'window',
        item: 'departure',
        folder: 'windows',
        route: 'windows',
        keep: WINDOW_LIMITS.keep,
      },
      basePath
    );
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
    this.start(w);
    return w;
  }

  /** The window as the API shows it: the departures, the progress of the one computing, links. */
  toPublic(w: DepartureWindow): WindowPublic {
    return { ...w, progress: this.progress(w), links: this.links(w.id) };
  }

  protected items(w: DepartureWindow): SeriesItem[] {
    return w.departures;
  }

  /**
   * A saved file holds a window when it is one by the window's own schema (DepartureWindowSchema), every field the
   * manager reads later included: one that is not (a hand edit, an older format) is left as it is and not restored
   * (until 2026-11-07 only `id` and `departures` were checked).
   */
  protected holds(v: unknown): v is DepartureWindow {
    return Value.Check(DepartureWindowSchema, v);
  }

  protected of(w: DepartureWindow): JobSeriesOf {
    return { windowId: w.id };
  }

  protected seriesOfJob(job: Job): string | undefined {
    return job.windowId;
  }

  /**
   * Departure `k`'s route, never published to the Resources API; a departure after the forecast's last step, and every
   * one after a passage that ran past it, is skipped.
   */
  protected nextRoute(w: DepartureWindow, k: number): RouteRequest | null {
    const d = w.departures[k];
    if (w.departures.some(x => x.metrics?.beyond_forecast)) {
      d.status = 'skipped';
      d.error = 'an earlier departure already arrives after the forecast ends';
      return null;
    }
    const validTo = this.windowDeps.forecastValidToMs();
    if (validTo !== null && Date.parse(d.departure) >= validTo) {
      d.status = 'skipped';
      d.error = 'departs after the forecast ends';
      return null;
    }
    const name = `${w.request.route.name?.trim() || 'Departure window'} · ${d.departure.slice(0, 16).replace('T', ' ')}Z`;
    return { ...w.request.route, departure: d.departure, publish: false, name };
  }

  protected finished(w: DepartureWindow): void {
    if (w.status === 'done') this.windowDeps.onFinished?.(w);
  }
}
