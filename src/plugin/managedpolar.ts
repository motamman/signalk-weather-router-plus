/**
 * Adapter for the Signal K polars Resource Provider contract. No provider files or HTTP needed. A canonical
 * polarTable 1.0.0, or a polar-format 2 polarSet 2.0.0: routed on its `best` table, with its sail plans' tables kept
 * to name the fastest plan on each stretch (vessel/sailplan.ts).
 */
import { PolarDiagram } from '../vessel/polar';
import type { SailPlanPolar } from '../vessel/sailplan';

export const ACTIVE_POLAR_TOKEN = 'signalk-active';

/** A routing table as PolarDiagram holds it ([TWA][TWS], degrees and m/s); `unavailable`: 1 at a cell with no sailing solution, absent when there is none. */
export interface ManagedTable {
  twa: number[];
  tws: number[];
  speeds: number[];
  unavailable?: number[];
}

/** One sail plan of a polar set: its name (its id when it has none) and its table. */
export interface ManagedSailPlan extends ManagedTable {
  name: string;
}

/** Structured-cloneable, unscaled routing table captured before dispatch to the worker. */
export interface ManagedPolar extends ManagedTable {
  label: string;
  performanceFactor: number;
  /** A polar set's sail plans, in its order; absent for a polarTable or a set without any. */
  sailPlans?: ManagedSailPlan[];
}

export interface PolarProviderApp {
  getSelfPath?: (path: string) => unknown;
  resourcesApi?: { getResource?: (type: string, id: string) => Promise<unknown> };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid polar resource: expected object');
  return value as Record<string, unknown>;
}

/** getSelfPath returns a Signal K value node; accept a direct value too. */
function pathValue(value: unknown): unknown {
  return value && typeof value === 'object' && 'value' in value ? (value as { value: unknown }).value : value;
}

export function activePolarId(value: unknown): string {
  const href = object(pathValue(value)).href;
  const match = typeof href === 'string' ? /^\/resources\/polars\/([^/]+)$/.exec(href) : null;
  if (!match) throw new Error('No valid polars.activePolar: select an active polar in Polar Management');
  return match[1];
}

/**
 * Canonical matrix is [TWS][TWA]; PolarDiagram stores [TWA][TWS]. SI speeds stay unchanged. A polarSet routes on its
 * `best` table and keeps its sail plans' tables; a null cell there (no sailing solution) is held as unavailable, never
 * given a speed.
 */
export function adaptManagedPolar(resource: unknown, id: string, performanceFactor: unknown): ManagedPolar {
  const doc = object(resource);
  const units = object(doc.units);
  const set = doc.kind === 'polarSet' && doc.schemaVersion === '2.0.0';
  if (
    (!set && (doc.kind !== 'polarTable' || doc.schemaVersion !== '1.0.0')) ||
    units.twa !== 'rad' ||
    units.tws !== 'm/s' ||
    units.boatSpeed !== 'm/s'
  )
    throw new Error('Unsupported polar: expected canonical polarTable 1.0.0 or polarSet 2.0.0 with rad/m/s units');
  if (object(doc.symmetry).portStarboardSymmetric !== true) throw new Error('Routing requires a port/starboard symmetric polar');
  const factor = performanceFactor === undefined || performanceFactor === null ? 1 : performanceFactor;
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 1)
    throw new Error('Invalid polars.performanceFactor: expected a ratio from 0 to 1');
  const label = typeof doc.name === 'string' && doc.name ? doc.name : id;
  if (!set) return { label, ...adaptTable(doc, false), performanceFactor: factor };
  const plans = doc.sailplans ?? [];
  if (!Array.isArray(plans)) throw new Error('Invalid polar set: expected sailplans to be an array');
  const sailPlans = plans.map((value): ManagedSailPlan => {
    const plan = object(value);
    if (typeof plan.id !== 'string' || !plan.id) throw new Error('Invalid polar set: every sail plan needs an id');
    return { name: typeof plan.name === 'string' && plan.name ? plan.name : plan.id, ...adaptTable(object(plan.table), true) };
  });
  return { label, ...adaptTable(object(doc.best), true), performanceFactor: factor, ...(sailPlans.length ? { sailPlans } : {}) };
}

/** One table (a polarTable document, or a table of a polarSet: `nulls` allows its null cells) as PolarDiagram holds it. */
function adaptTable(table: Record<string, unknown>, nulls: boolean): ManagedTable {
  const axes = object(table.axes);
  const axis = (value: unknown, min: number, max: number, count: number): number[] => {
    if (
      !Array.isArray(value) ||
      value.length < count ||
      value.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (i > 0 && v <= value[i - 1]))
    )
      throw new Error('Invalid polar axes: expected finite, strictly ascending values in range');
    return value as number[];
  };
  const angles = axis(axes.twa, 0, Math.PI, 2);
  const twa = angles.map(a => (a * 180) / Math.PI);
  const tws = axis(axes.tws, 0, Infinity, 1);
  const matrix = object(table.values).boatSpeedMatrix;
  if (
    !Array.isArray(matrix) ||
    matrix.length !== tws.length ||
    matrix.some(
      row =>
        !Array.isArray(row) ||
        row.length !== twa.length ||
        row.some(v => !(nulls && v === null) && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))
    )
  )
    throw new Error(
      `Invalid polar matrix: expected a complete nonnegative [TWS][TWA] speed table${nulls ? ' (null where no sailing solution)' : ''}`
    );
  const cell = (k: number, i: number): number | null => (matrix[k] as (number | null)[])[i];
  /** The table, with `unavailable` only when a cell has no sailing solution. */
  const out = (twaDeg: number[], speeds: number[], unavailable: number[]): ManagedTable =>
    unavailable.some(v => v === 1) ? { twa: twaDeg, tws: [...tws], speeds, unavailable } : { twa: twaDeg, tws: [...tws], speeds };
  const targets = derivedTargets(table.derived, tws);
  if (targets.size) {
    const union = [
      ...new Set([
        ...angles,
        ...[...targets.values()].flatMap(row => [row.beat?.twa, row.run?.twa].filter((a): a is number => a !== undefined)),
      ]),
    ].sort((a, b) => a - b);
    const diagrams = tws.map((wind, k) => {
      const points = new Map(angles.map((a, i) => [a, cell(k, i)]));
      const row = targets.get(k);
      for (const target of [row?.beat, row?.run]) if (target) points.set(target.twa, target.tbs);
      const ordered = [...points].sort((a, b) => a[0] - b[0]);
      return new PolarDiagram(
        ordered.map(([a]) => (a * 180) / Math.PI),
        [wind],
        ordered.map(([a, speed]) => (speed === null || (row?.beat && a < row.beat.twa) ? 0 : speed)),
        ordered.map(([, speed]) => (speed === null ? 1 : 0))
      );
    });
    const mergedTwa = union.map(a => (a * 180) / Math.PI);
    return out(
      mergedTwa,
      mergedTwa.flatMap(a => diagrams.map((diagram, k) => diagram.boatSpeed(a, tws[k]))),
      mergedTwa.flatMap(a => diagrams.map((diagram, k) => (diagram.unavailableAt(a, tws[k]) ? 1 : 0)))
    );
  }
  return out(
    twa,
    twa.flatMap((_, i) => tws.map((_, k) => cell(k, i) ?? 0)),
    twa.flatMap((_, i) => tws.map((_, k) => (cell(k, i) === null ? 1 : 0)))
  );
}

export function managedDiagram(polar: ManagedTable): PolarDiagram {
  return new PolarDiagram(polar.twa, polar.tws, polar.speeds, polar.unavailable);
}

/** A polar set's sail plans as diagrams, unscaled (none for a polarTable). */
export function managedSailPlans(polar: ManagedPolar): SailPlanPolar[] {
  return (polar.sailPlans ?? []).map(p => ({ name: p.name, polar: managedDiagram(p) }));
}

/** Resolve on demand so edits to the active table (even under the same id) take effect on the next request. */
export async function loadManagedPolar(app: PolarProviderApp): Promise<ManagedPolar> {
  if (!app.resourcesApi?.getResource) throw new Error('Signal K polar source requires the Resources API and a polar provider');
  const active = app.getSelfPath?.('polars.activePolar');
  if (pathValue(active) == null) throw new Error('No active polar: select one in Polar Management');
  const id = activePolarId(active);
  const factor = pathValue(app.getSelfPath?.('polars.performanceFactor'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resource: unknown;
  try {
    resource = await Promise.race([
      app.resourcesApi.getResource('polars', id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Polar provider timed out; retry the request')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // Do not dispatch a stale selection if it changed while the resource was loading.
  if (activePolarId(app.getSelfPath?.('polars.activePolar')) !== id)
    throw new Error('Active polar changed while loading; retry the request');
  return adaptManagedPolar(resource, id, factor);
}

/** Automatic detection is optional: local fallback remains usable without a provider. */
export async function detectManagedPolar(app: PolarProviderApp): Promise<ManagedPolar | null> {
  try {
    return await loadManagedPolar(app);
  } catch {
    return null;
  }
}

/** Explicit local tokens always win. Explicit managed selection must not silently change boats. */
export async function selectManagedPolar(
  app: PolarProviderApp,
  source: 'auto' | 'files' | 'signalk',
  token?: string
): Promise<ManagedPolar | undefined> {
  if (token === ACTIVE_POLAR_TOKEN) return loadManagedPolar(app);
  if (token && token !== 'auto') return undefined;
  if (!token && source === 'files') return undefined;
  return (await detectManagedPolar(app)) ?? undefined;
}

interface DerivedTarget {
  twa: number;
  tbs: number;
}
interface DerivedRow {
  beat?: DerivedTarget;
  run?: DerivedTarget;
}

/** Targets are SI points keyed by wind speed, not by the ordering of derived.rows. */
function derivedTargets(derived: unknown, tws: number[]): Map<number, DerivedRow> {
  const out = new Map<number, DerivedRow>();
  if (derived === undefined || derived === null) return out;
  const rows = object(derived).rows;
  if (rows === undefined) return out;
  if (!Array.isArray(rows)) throw new Error('Invalid derived.rows: expected an array');
  for (const value of rows) {
    const row = object(value);
    if (row.beat == null && row.run == null) continue;
    const k = tws.findIndex(wind => typeof row.tws === 'number' && Math.abs(wind - row.tws) <= 1e-9);
    if (k < 0 || out.has(k)) throw new Error('Invalid derived.rows: expected one target row per matching TWS');
    const targets: DerivedRow = {};
    for (const key of ['beat', 'run'] as const) {
      if (row[key] == null) continue;
      const target = object(row[key]);
      if (
        typeof target.twa !== 'number' ||
        !Number.isFinite(target.twa) ||
        target.twa < 0 ||
        target.twa > Math.PI ||
        typeof target.tbs !== 'number' ||
        !Number.isFinite(target.tbs) ||
        target.tbs <= 0
      )
        throw new Error('Invalid derived target: expected TWA in 0..pi radians and positive boat speed in m/s');
      targets[key] = { twa: target.twa, tbs: target.tbs };
    }
    out.set(k, targets);
  }
  return out;
}
