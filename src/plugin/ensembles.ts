/**
 * Ensemble sets: the same route computed on each member of an ensemble (POST /api/ensemble-sets), so the passage's
 * routes in the weathers the ensemble thinks possible can be compared: where they go, when each arrives, how much each
 * motors, the strongest wind and highest waves each meets. A set is a series of route jobs, one per member, each on
 * that member's forecast (request.forecast_member; worker/route.ts memberRun), submitted one at a time
 * (jobseries.ts JobSeries: following, cancelling, saving and restoring are shared with the departure windows).
 *
 * Per member the set keeps what a comparison needs: the departure windows' metrics (jobseries.ts departureMetrics).
 *
 * SI throughout (m/s, m, s); times ISO 8601.
 */

import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import type { Job, JobManager, JobSeriesOf } from './jobs';
import type { RouteRequest } from './protocol';
import { RouteRequestSchema, validateRouteRequest, ENSEMBLE_MEMBERS_RANGE } from './request_schema';
import { DepartureMetricsSchema, departureMetrics, JobSeries, type SeriesDeps, type SeriesItem } from './jobseries';
import { ENSEMBLE_MEMBER_CHOICES, ENSEMBLE_MODELS, ENSEMBLES, type EnsembleModelId } from '../data/ecmwf';
import { cycleName } from '../data/decoded';

export const ENSEMBLE_SET_LIMITS = {
  /** Finished sets kept (with their route jobs). */
  keep: 10,
  /** Sets computing at once. */
  maxRunning: 2,
};

// The set's route request: a route request's fields but forecast_member, which the set gives each member (a request
// with one is refused: validateEnsembleSetRequest).
const { forecast_member: _perMember, ...SET_ROUTE_PROPERTIES } = RouteRequestSchema.properties;

/** The set request (POST /api/ensemble-sets): the type and the OpenAPI schema. */
export const EnsembleSetRequestSchema = Type.Object({
  route: Type.Object(SET_ROUTE_PROPERTIES, {
    description:
      'The route request, as POST /api/routes takes it, without forecast_member (set per member); publish is false for every member',
  }),
  model: Type.Enum(ENSEMBLE_MODELS, { type: 'string', description: 'The ensemble (downloaded: plugin config Ensemble downloads)' }),
  members: Type.Integer({
    minimum: ENSEMBLE_MEMBERS_RANGE[0],
    maximum: ENSEMBLE_MEMBERS_RANGE[1],
    description: 'How many of its members on disk to route (the control first where there is one)',
  }),
  main_job_id: Type.Optional(
    Type.String({
      description:
        "The same route's job on the main forecast, listed with the members for comparison: the `main` field of GET /api/ensemble-sets/{id}",
    })
  ),
});
export type EnsembleSetRequest = Static<typeof EnsembleSetRequestSchema>;

export const MemberStatusSchema = Type.Enum(['pending', 'queued', 'running', 'done', 'failed', 'cancelled'] as const, {
  type: 'string',
});
export type MemberStatus = Static<typeof MemberStatusSchema>;

export const SetMemberSchema = Type.Object({
  member: Type.Integer({
    minimum: 0,
    maximum: ENSEMBLE_MEMBER_CHOICES[ENSEMBLE_MEMBER_CHOICES.length - 1],
    description: '0 = the control',
  }),
  job_id: Type.Union([Type.String(), Type.Null()]),
  status: MemberStatusSchema,
  error: Type.Optional(Type.String()),
  metrics: Type.Optional(DepartureMetricsSchema),
});
export type SetMember = Static<typeof SetMemberSchema>;

export const EnsembleSetStatusSchema = Type.Enum(['running', 'done', 'cancelled', 'failed'] as const, { type: 'string' });
export type EnsembleSetStatus = Static<typeof EnsembleSetStatusSchema>;

export const EnsembleSetSchema = Type.Object({
  id: Type.String(),
  status: EnsembleSetStatusSchema,
  created_at: Type.String(),
  finished_at: Type.Optional(Type.String()),
  save_error: Type.Optional(
    Type.String({ description: "Why the set's file on disk is behind it (its last save failed); absent once a save succeeds" })
  ),
  error: Type.Optional(Type.String()),
  request: EnsembleSetRequestSchema,
  name: Type.String({ description: "The ensemble's name" }),
  cycle: Type.String({ description: "The ensemble's cycle in use when the set started (ISO 8601)" }),
  members: Type.Array(SetMemberSchema),
});
export type EnsembleSet = Static<typeof EnsembleSetSchema>;

/** A set's links (jobseries.ts links): itself, and its cancel. */
export const EnsembleSetLinksSchema = Type.Object({ self: Type.String(), cancel: Type.String() });

/** A set as the API answers it (EnsembleSetManager.toPublic): the member computing's last progress line, and links. */
export const EnsembleSetPublicSchema = Type.Object({
  ...EnsembleSetSchema.properties,
  main: Type.Union(
    [
      Type.Object({
        job_id: Type.String(),
        status: Type.String(),
        metrics: Type.Optional(DepartureMetricsSchema),
      }),
      Type.Null(),
    ],
    {
      description:
        "The route on the main forecast (request.main_job_id), with the members' metrics; null without one or once that job is gone",
    }
  ),
  progress: Type.Union([Type.String(), Type.Null()]),
  links: EnsembleSetLinksSchema,
});
export type EnsembleSetPublic = Static<typeof EnsembleSetPublicSchema>;

/**
 * The answer to POST /api/ensemble-sets (202): the set started, by id, with how many members it routes and its links;
 * the set itself is GET /api/ensemble-sets/{id} (EnsembleSetPublicSchema). The one shape the handler answers and the
 * OpenAPI document describes.
 */
export const EnsembleSetCreatedSchema = Type.Object({
  id: Type.String(),
  status: EnsembleSetStatusSchema,
  members: Type.Integer({ description: 'How many members the set routes' }),
  links: EnsembleSetLinksSchema,
});
export type EnsembleSetCreated = Static<typeof EnsembleSetCreatedSchema>;

/** Why a set request is not acceptable, or null (what is on disk is checked by the API: membersOnDisk). */
export function validateEnsembleSetRequest(b: unknown): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'JSON body required: {route: {start, end, …}, model, members}';
  const r = b as Partial<EnsembleSetRequest>;
  if (!r.route || typeof r.route !== 'object') return 'route is required: the route request, as POST /api/routes takes it';
  if (!(ENSEMBLE_MODELS as readonly string[]).includes(r.model as string)) return `model must be ${ENSEMBLE_MODELS.join(' or ')}`;
  const n = r.members;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < ENSEMBLE_MEMBERS_RANGE[0] || n > ENSEMBLE_MEMBERS_RANGE[1])
    return `members must be a whole number ${ENSEMBLE_MEMBERS_RANGE[0]}..${ENSEMBLE_MEMBERS_RANGE[1]}`;
  if (r.main_job_id !== undefined && (typeof r.main_job_id !== 'string' || !r.main_job_id || r.main_job_id.length > 64))
    return 'main_job_id must be a route job id';
  if ((r.route as { forecast_member?: unknown }).forecast_member !== undefined)
    return 'route: forecast_member is set per member by the set; leave it out';
  // Each member routes on its own forecast: a set of calm-wind routes would only be the same route again.
  if ((r.route as { no_forecast?: unknown }).no_forecast === true)
    return 'route: no_forecast cannot be combined with an ensemble set (each member routes on its own forecast)';
  const routeErr = validateRouteRequest(r.route as EnsembleSetRequest['route']);
  return routeErr ? `route: ${routeErr}` : null;
}

export interface EnsembleSetDeps extends SeriesDeps {
  /**
   * The cycle (ISO) and members on disk of an ensemble's cycle in use, read now from its record on disk (data/ensemble.ts
   * ensembleCurrentFile, the one record of what is in use, which the members' routes read too: worker/route.ts
   * memberRun); null when it has none; or what is wrong with the record. Until 2026-11-07 it was the data worker's
   * last status, which is behind the record from the moment a new cycle is recorded until the next status: a set made
   * then was pinned to the old cycle, and every member of it failed as "no longer on disk" (PR #7 review).
   */
  onDisk: (model: EnsembleModelId) => { cycle: string; members: number[] } | { problem: string } | null;
}

export class EnsembleSetManager extends JobSeries<EnsembleSet> {
  constructor(
    jobs: JobManager,
    dataDir: string,
    private readonly setDeps: EnsembleSetDeps,
    basePath = ''
  ) {
    super(
      jobs,
      dataDir,
      setDeps,
      {
        noun: { one: 'ensemble set', a: 'an ensemble set', many: 'ensemble sets' },
        short: 'set',
        item: 'member',
        folder: 'ensemble-sets',
        route: 'ensemble-sets',
        keep: ENSEMBLE_SET_LIMITS.keep,
      },
      basePath
    );
  }

  /**
   * Start a set (the request validated by validateEnsembleSetRequest): the first `members` members on disk of the
   * ensemble's cycle in use, read now, the control first where there is one. Refused, with why, when the ensemble or
   * that many members are not on disk, or its record cannot be read.
   */
  create(req: EnsembleSetRequest): { set: EnsembleSet } | { refused: string } {
    const disk = this.setDeps.onDisk(req.model);
    const name = ENSEMBLES[req.model].name;
    if (!disk) return { refused: `${name} is not on disk (plugin config: Ensemble downloads)` };
    if ('problem' in disk) return { refused: `${name}: ${disk.problem}` };
    if (disk.members.length < req.members) return { refused: `${name} has ${disk.members.length} members on disk, ${req.members} asked` };
    const s: EnsembleSet = {
      id: randomUUID(),
      status: 'running',
      created_at: new Date().toISOString(),
      request: req,
      name,
      cycle: disk.cycle,
      members: disk.members.slice(0, req.members).map(member => ({ member, job_id: null, status: 'pending' })),
    };
    this.start(s);
    return { set: s };
  }

  /** The set as the API shows it: the members, the main forecast's route, the progress of the one computing, links. */
  toPublic(s: EnsembleSet): EnsembleSetPublic {
    return { ...s, main: this.main(s), progress: this.progress(s), links: this.links(s.id) };
  }

  /** The main forecast's route of the set (request.main_job_id): its status, and its metrics once done. */
  private main(s: EnsembleSet): EnsembleSetPublic['main'] {
    const id = s.request.main_job_id;
    const job = id ? this.jobs.full(id) : undefined;
    if (!id || !job) return null;
    if (job.status !== 'done') return { job_id: id, status: job.status };
    // Its route could not be read back (reported by JobManager.full): no metrics.
    const metrics = departureMetrics(job);
    return metrics ? { job_id: id, status: job.status, metrics } : { job_id: id, status: job.status };
  }

  protected items(s: EnsembleSet): SeriesItem[] {
    return s.members;
  }

  protected holds(v: unknown): v is EnsembleSet {
    return !!v && typeof v === 'object' && !!(v as EnsembleSet).id && Array.isArray((v as EnsembleSet).members);
  }

  protected of(s: EnsembleSet): JobSeriesOf {
    return { ensembleSetId: s.id };
  }

  protected seriesOfJob(job: Job): string | undefined {
    return job.ensembleSetId;
  }

  /** Member `k`'s route: the set's request on that member's forecast, of the set's cycle, never published. */
  protected nextRoute(s: EnsembleSet, k: number): RouteRequest {
    const m = s.members[k];
    const name = `${s.request.route.name?.trim() || 'Ensemble'} · ${s.name} ${m.member === 0 ? 'control' : `member ${m.member}`}`;
    return {
      ...s.request.route,
      // Every member of the set on the same cycle: one that is gone fails its member, never mixes two runs.
      forecast_member: { model: s.request.model, member: m.member, cycle: cycleName(new Date(s.cycle)) },
      publish: false,
      name,
    };
  }
}
