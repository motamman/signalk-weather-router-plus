/**
 * The job document (GET /api/routes, /api/routes/:id), described once as
 * TypeBox schemas: the TypeScript types (JobStatus, JobProgress,
 * RouteSummary, JobPublic) and the OpenAPI document come from them
 * (issue #76, step 2). Field descriptions are the
 * ones the types carried as comments.
 */

import { Type, type Static } from 'typebox';
import { DRAWBRIDGE_CHOICES } from '../engine/mesh/route';
import { ROUTER_KINDS } from '../engine/router';
import { SEARCH_PRESETS } from '../engine/search/presets';
import { RouteRequestSchema } from './request_schema';
import { ENSEMBLE_MODELS } from '../data/ecmwf';

const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T, description?: string) =>
  Type.Union([t, Type.Null()], description ? { description } : {});

export const JobStatusSchema = Type.Enum(['queued', 'running', 'done', 'failed', 'cancelled'] as const, { type: 'string' });
export type JobStatus = Static<typeof JobStatusSchema>;

export const JobProgressSchema = Type.Object({
  time: Type.String(),
  stage: Type.Number(),
  total: Type.Number(),
  message: Type.String(),
});
export type JobProgress = Static<typeof JobProgressSchema>;

export const RouteSummarySchema = Type.Object({
  total_distance_m: Type.Number(),
  total_time_s: Type.Number(),
  sailing_time_s: Type.Number(),
  motoring_time_s: Type.Number(),
  waypoint_count: Type.Number(),
  warnings: Type.Number(),
  departure: Type.String(),
  arrival: Type.String(),
  forecast_cycle: Type.Optional(Type.String()),
  current_sources: Type.Optional(Type.Array(Type.String())),
  polar: Type.Optional(nullable(Type.String(), 'Label of the polar the route was computed with, or null when motor-only.')),
  polar_source: Type.Optional(
    Type.Union([Type.Literal('signalk'), Type.Literal('internal')], { description: 'Source of the polar used for this route.' })
  ),
  polar_performance: Type.Optional(Type.Number({ description: 'Polar performance applied (ratio; 1 = the polar as written).' })),
  auto_vias: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), width_m: Type.Number() }), {
      description: 'Automatic vias placed at narrow passages (not waypoints of the route).',
    })
  ),
  legs: Type.Optional(Type.Number({ description: 'Routes with waypoints: number of legs and the waypoint precision used.' })),
  precision: Type.Optional(Type.Enum(['precise', 'approximate'] as const, { type: 'string' })),
  corridor_fallback: Type.Optional(
    Type.Literal(true, {
      description: "A leg's corridor search failed and ran on the coarse per-route skeleton (counted in /api/status corridor_fallbacks).",
    })
  ),
  regional_wind: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), run: Type.String(), share: Type.Number() }), {
      description:
        "Regional wind models used and the share of the search's wind samples each answered (0..1); absent when only ECMWF was used.",
    })
  ),
  mesh: Type.Optional(
    Type.Literal(true, {
      description: 'At least one leg was routed on the chart mesh (charted depths and obstructions) instead of the coastline search.',
    })
  ),
  depth_checked: Type.Optional(
    Type.Literal(true, {
      description: 'The finished route passed the final depth check against the chart meshes it meets (absent when no mesh meets it).',
    })
  ),
  legs_detail: Type.Optional(
    Type.Array(
      Type.Object({
        leg: Type.Number(),
        source: Type.Enum(['mesh', 'coastline', 'mixed'] as const, { type: 'string' }),
        on_mesh_m: Type.Number(),
        unknown_depth_m: Type.Number(),
        outside_mesh_m: Type.Number(),
        shallowest_m: nullable(Type.Number()),
        shallowest_at: nullable(Type.Tuple([Type.Number(), Type.Number()])),
      }),
      {
        description:
          'Per leg: what planned it (chart mesh, coastline search, or both for a leg leaving the mesh), and what the check found along it: metres on the mesh, with no charted depth, outside the mesh; the shallowest charted depth crossed (m) and where ([lon, lat]), null when none was charted.',
      }
    )
  ),
  drawbridges: Type.Optional(
    Type.Array(Type.Object({ lat: Type.Number(), lon: Type.Number(), clear_m: nullable(Type.Number()), leg_index: Type.Number() }), {
      description: 'Opening bridges the route passes under (mesh legs), and the rule that applied.',
    })
  ),
  drawbridges_rule: Type.Optional(Type.Enum(DRAWBRIDGE_CHOICES, { type: 'string' })),
  router: Type.Optional(Type.Enum(ROUTER_KINDS, { type: 'string', description: 'The open-water router that ran.' })),
  search: Type.Optional(Type.Enum(SEARCH_PRESETS, { type: 'string', description: 'The search method the route ran with.' })),
  ensemble: Type.Optional(
    Type.Object(
      {
        model: Type.Enum(ENSEMBLE_MODELS, { type: 'string' }),
        name: Type.String(),
        cycle: Type.String({ description: "The ensemble's cycle (ISO 8601)" }),
        members: Type.Number(),
        arrival_p10: nullable(Type.String()),
        arrival_p50: nullable(Type.String()),
        arrival_p90: nullable(Type.String()),
        over_wind: Type.Number({ description: 'Members over the wind limit somewhere on the route' }),
        over_waves: Type.Number({ description: 'Members over the wave limit somewhere on the route' }),
        stuck: Type.Number({ description: 'Members in whose weather a leg could not be sailed' }),
      },
      {
        description:
          "The route sailed in each of the ensemble's members' weather, when the request asked for it: the arrival percentiles over the members that arrive (ISO 8601), and how many members go over a limit or get stuck. Each member: GET .../ensemble.",
      }
    )
  ),
});
export type RouteSummary = Static<typeof RouteSummarySchema>;

/** A job's links (JobManager.links). */
export const JobLinksSchema = Type.Object({
  self: Type.String(),
  events: Type.String(),
  result: Type.String(),
  skeleton: Type.String(),
  fronts: Type.String(),
  cancel: Type.String(),
  publish: Type.String(),
  meteogram: Type.String(),
  ensemble: Type.String(),
});
export type JobLinks = Static<typeof JobLinksSchema>;

/** A route job as the API answers it (JobManager.toPublic). */
export const JobPublicSchema = Type.Object({
  id: Type.String(),
  status: JobStatusSchema,
  request: RouteRequestSchema,
  created_at: Type.String(),
  started_at: Type.Optional(Type.String()),
  finished_at: Type.Optional(Type.String()),
  progress: Type.Array(JobProgressSchema),
  summary: Type.Optional(RouteSummarySchema),
  error: Type.Optional(Type.String()),
  resource_id: Type.Optional(Type.String()),
  publish_error: Type.Optional(Type.String({ description: 'Why publishing to the Resources API failed, when it did' })),
  window_id: Type.Optional(Type.String({ description: 'The departure window this job is one departure of (/api/windows)' })),
  links: JobLinksSchema,
});
export type JobPublic = Static<typeof JobPublicSchema>;
