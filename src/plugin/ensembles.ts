/**
 * Ensemble sets: the same route computed on each member of an ensemble (POST /api/ensemble-sets), so the passage's
 * routes in the weathers the ensemble thinks possible can be compared: where they go, when each arrives, how much each
 * motors, the strongest wind and highest waves each meets. Each member is an ordinary route job (JobManager) on that
 * member's forecast (request.forecast_member; worker/route.ts memberRun), submitted one at a time when the one before
 * has finished, as departure windows submit theirs (windows.ts), so a route asked for meanwhile waits behind one job.
 * Those jobs carry the set's id: they are left out of the job list and its trimming, never published to the Resources
 * API, and go when their set is deleted. Once a member is done its route is kept only in the job's file
 * (JobManager.release) and read from there when it is opened.
 *
 * Per member the set keeps what a comparison needs: the departure windows' metrics (windows.ts departureMetrics).
 *
 * SI throughout (m/s, m, s); times ISO 8601.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import type { JobEvent, JobManager } from './jobs';
import { RouteRequestSchema, validateRouteRequest, ENSEMBLE_MEMBERS_RANGE } from './request_schema';
import { departureMetrics, DepartureMetricsSchema } from './windows';
import { ENSEMBLE_MODELS, ENSEMBLES, type EnsembleModelId } from '../data/ecmwf';
import { cycleName } from '../data/decoded';

export const ENSEMBLE_SET_LIMITS = {
  /** Finished sets kept (with their route jobs). */
  keep: 10,
  /** Sets computing at once. */
  maxRunning: 2,
};

/** The set request (POST /api/ensemble-sets): the type and the OpenAPI schema. */
export const EnsembleSetRequestSchema = Type.Object({
  route: Type.Object(RouteRequestSchema.properties, {
    description: 'The route request, as POST /api/routes takes it; forecast_member and publish are set per member',
  }),
  model: Type.Enum(ENSEMBLE_MODELS, { type: 'string', description: 'The ensemble (downloaded: plugin config Ensemble downloads)' }),
  members: Type.Integer({
    minimum: ENSEMBLE_MEMBERS_RANGE[0],
    maximum: ENSEMBLE_MEMBERS_RANGE[1],
    description: 'How many of its members on disk to route (the control first where there is one)',
  }),
});
export type EnsembleSetRequest = Static<typeof EnsembleSetRequestSchema>;

export const MemberStatusSchema = Type.Enum(['pending', 'queued', 'running', 'done', 'failed', 'cancelled'] as const, {
  type: 'string',
});
export type MemberStatus = Static<typeof MemberStatusSchema>;

export const SetMemberSchema = Type.Object({
  member: Type.Number({ description: '0 = the control' }),
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
  error: Type.Optional(Type.String()),
  request: EnsembleSetRequestSchema,
  name: Type.String({ description: "The ensemble's name" }),
  cycle: Type.String({ description: "The ensemble's cycle in use when the set started (ISO 8601)" }),
  members: Type.Array(SetMemberSchema),
});
export type EnsembleSet = Static<typeof EnsembleSetSchema>;

/** A set as the API answers it (EnsembleSetManager.toPublic): the member computing's last progress line, and links. */
export const EnsembleSetPublicSchema = Type.Object({
  ...EnsembleSetSchema.properties,
  progress: Type.Union([Type.String(), Type.Null()]),
  links: Type.Object({ self: Type.String(), cancel: Type.String() }),
});
export type EnsembleSetPublic = Static<typeof EnsembleSetPublicSchema>;

/** Why a set request is not acceptable, or null (what is on disk is checked by the API: membersOnDisk). */
export function validateEnsembleSetRequest(b: unknown): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'JSON body required: {route: {start, end, …}, model, members}';
  const r = b as Partial<EnsembleSetRequest>;
  if (!r.route || typeof r.route !== 'object') return 'route is required: the route request, as POST /api/routes takes it';
  if (!(ENSEMBLE_MODELS as readonly string[]).includes(r.model as string)) return `model must be ${ENSEMBLE_MODELS.join(' or ')}`;
  const n = r.members;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < ENSEMBLE_MEMBERS_RANGE[0] || n > ENSEMBLE_MEMBERS_RANGE[1])
    return `members must be a whole number ${ENSEMBLE_MEMBERS_RANGE[0]}..${ENSEMBLE_MEMBERS_RANGE[1]}`;
  if ((r.route as { forecast_member?: unknown }).forecast_member !== undefined)
    return 'route: forecast_member is set per member by the set; leave it out';
  const routeErr = validateRouteRequest(r.route as EnsembleSetRequest['route']);
  return routeErr ? `route: ${routeErr}` : null;
}

export interface EnsembleSetDeps {
  /** Stop the route worker's running job (a queued one the job manager cancels itself). */
  cancelRunning: (jobId: string) => void;
  /** The cycle (ISO) and members on disk of an ensemble's cycle in use, or null when none is. */
  onDisk: (model: EnsembleModelId) => { cycle: string; members: number[] } | null;
  log?: (msg: string) => void;
}

export class EnsembleSetManager {
  private sets = new Map<string, EnsembleSet>();
  private byJob = new Map<string, { s: EnsembleSet; k: number }>();
  private readonly dir: string;
  private readonly listener = (id: string, ev: JobEvent): void => this.onJobEvent(id, ev);

  constructor(
    private readonly jobs: JobManager,
    dataDir: string,
    private readonly deps: EnsembleSetDeps,
    private readonly basePath = ''
  ) {
    this.dir = path.join(dataDir, 'ensemble-sets');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadPersisted();
    jobs.on('event', this.listener);
  }

  /** Stop listening (plugin stop). */
  close(): void {
    this.jobs.off('event', this.listener);
  }

  get running(): number {
    return [...this.sets.values()].filter(s => s.status === 'running').length;
  }

  links(id: string): EnsembleSetPublic['links'] {
    const b = `${this.basePath}/api/ensemble-sets/${id}`;
    return { self: b, cancel: `${b}/cancel` };
  }

  /**
   * Start a set (the request validated by validateEnsembleSetRequest): the first `members` members on disk of the
   * ensemble's cycle in use, the control first where there is one. Throws when the ensemble or that many members are
   * not on disk.
   */
  create(req: EnsembleSetRequest): EnsembleSet {
    const disk = this.deps.onDisk(req.model);
    const name = ENSEMBLES[req.model].name;
    if (!disk) throw new Error(`${name} is not on disk (plugin config: Ensemble downloads)`);
    if (disk.members.length < req.members) throw new Error(`${name} has ${disk.members.length} members on disk, ${req.members} asked`);
    const s: EnsembleSet = {
      id: randomUUID(),
      status: 'running',
      created_at: new Date().toISOString(),
      request: req,
      name,
      cycle: disk.cycle,
      members: disk.members.slice(0, req.members).map(member => ({ member, job_id: null, status: 'pending' })),
    };
    this.sets.set(s.id, s);
    this.advance(s);
    return s;
  }

  get(id: string): EnsembleSet | undefined {
    return this.sets.get(id);
  }

  list(limit = 20): EnsembleSet[] {
    return [...this.sets.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  /** The set as the API shows it: the members, the progress of the one computing, links. */
  toPublic(s: EnsembleSet): EnsembleSetPublic {
    const active = s.members.find(m => m.status === 'running' || m.status === 'queued');
    const job = active?.job_id ? this.jobs.get(active.job_id) : undefined;
    const last = job?.progress[job.progress.length - 1];
    return { ...s, progress: last ? last.message : null, links: this.links(s.id) };
  }

  /** Cancel what is left: members not started, and the one queued or computing. */
  cancel(id: string): boolean {
    const s = this.sets.get(id);
    if (!s || s.status !== 'running') return false;
    // Not running from here on, so the cancelled job's event does not submit the next member.
    s.status = 'cancelled';
    for (const m of s.members) if (m.status === 'pending') m.status = 'cancelled';
    for (const m of s.members) {
      if ((m.status === 'queued' || m.status === 'running') && m.job_id) {
        const what = this.jobs.cancel(m.job_id);
        if (what === 'running') this.deps.cancelRunning(m.job_id);
      }
    }
    this.finish(s, 'cancelled');
    return true;
  }

  /** A cancelled set whose member's route worker has not stopped yet: its job ends when the worker answers. */
  stopping(s: EnsembleSet): boolean {
    return s.members.some(m => m.job_id !== null && this.jobs.get(m.job_id)?.status === 'running');
  }

  /** Delete a finished set and its route jobs; not while it runs, nor while it is stopping. */
  delete(id: string): boolean {
    const s = this.sets.get(id);
    if (!s || s.status === 'running' || this.stopping(s)) return false;
    for (const m of s.members) {
      if (!m.job_id) continue;
      this.byJob.delete(m.job_id);
      this.jobs.delete(m.job_id);
    }
    this.sets.delete(id);
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
    const { s, k } = at;
    const m = s.members[k];
    if (ev.event === 'status' && ev.data.status === 'running' && m.status === 'queued') {
      m.status = 'running';
      this.persist(s);
      return;
    }
    if (ev.event !== 'done' && ev.event !== 'error') return;
    const job = this.jobs.get(jobId);
    if (ev.event === 'done' && job) {
      m.status = 'done';
      try {
        m.metrics = departureMetrics(job);
      } catch (err) {
        m.error = (err as Error).message;
      }
    } else {
      m.status = ev.data.status === 'cancelled' ? 'cancelled' : 'failed';
      m.error = String(ev.data.message ?? job?.error ?? 'failed');
    }
    if (s.status === 'running') this.advance(s);
    else this.persist(s);
  }

  /** Submit the next member, or finish the set. */
  private advance(s: EnsembleSet): void {
    for (let k = 0; k < s.members.length; k++) {
      const m = s.members[k];
      if (m.status !== 'pending') continue;
      // Each member is its own route job, on that member's forecast, never published to the Resources API.
      const name = `${s.request.route.name?.trim() || 'Ensemble'} · ${s.name} ${m.member === 0 ? 'control' : `member ${m.member}`}`;
      const job = this.jobs.submit(
        {
          ...s.request.route,
          // Every member of the set on the same cycle: one that is gone fails its member, never mixes two runs.
          forecast_member: { model: s.request.model, member: m.member, cycle: cycleName(new Date(s.cycle)) },
          publish: false,
          name,
        },
        undefined,
        s.id
      );
      m.job_id = job.id;
      this.byJob.set(job.id, { s, k });
      // Started at once and failed at once: its error event came before byJob knew the job, so it is taken here.
      if (job.status === 'failed' || job.status === 'cancelled') {
        m.status = job.status;
        m.error = job.error ?? 'failed';
        continue;
      }
      m.status = job.status === 'running' ? 'running' : 'queued';
      this.persist(s);
      return;
    }
    this.finish(s, 'done');
  }

  private finish(s: EnsembleSet, status: EnsembleSetStatus): void {
    s.status = status;
    s.finished_at = new Date().toISOString();
    this.persist(s);
    this.trim();
  }

  private persist(s: EnsembleSet): void {
    const tmp = path.join(this.dir, `${s.id}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, path.join(this.dir, `${s.id}.json`));
  }

  private trim(): void {
    const finished = [...this.sets.values()]
      .filter(s => s.status !== 'running')
      .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));
    for (const s of finished.slice(ENSEMBLE_SET_LIMITS.keep)) this.delete(s.id);
  }

  /**
   * Sets from before a restart. One that was computing ends failed: its job in progress the job manager has already
   * failed, its members not started are cancelled. Route jobs of sets that are gone are deleted.
   */
  private loadPersisted(): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch {
      /* none */
    }
    for (const f of files) {
      let s: EnsembleSet;
      try {
        s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as EnsembleSet;
      } catch {
        continue; // ignore a corrupt file
      }
      if (!s || !s.id || !Array.isArray(s.members)) continue;
      this.sets.set(s.id, s);
      s.members.forEach((m, k) => {
        if (!m.job_id) return;
        this.byJob.set(m.job_id, { s, k });
        if (m.status !== 'queued' && m.status !== 'running') return;
        const job = this.jobs.full(m.job_id);
        if (job && (job.status === 'done' || job.status === 'cancelled')) {
          m.status = job.status;
          if (job.status === 'done') m.metrics = departureMetrics(job);
        } else {
          m.status = 'failed';
          m.error = job?.error ?? 'plugin restarted while the member was being computed';
        }
      });
      if (s.status === 'running') {
        for (const m of s.members) if (m.status === 'pending') m.status = 'cancelled';
        s.status = 'failed';
        s.error = 'plugin restarted while the set was in progress';
        s.finished_at = new Date().toISOString();
        this.persist(s);
      }
    }
    const known = new Set(this.byJob.keys());
    for (const j of this.jobs.list(Number.MAX_SAFE_INTEGER, true)) if (j.ensembleSetId && !known.has(j.id)) this.jobs.delete(j.id);
    this.trim();
  }
}
