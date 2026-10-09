/** OpenAPI 3.0 description of the plugin API, served at /api/openapi.json and via getOpenApi(). */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SETTINGS_GROUPS, SETTINGS_SPEC, type SettingSpec } from './settings';
import { routeRequestSchema } from './request_schema';

/** JSON schema of one setting's value (SI). */
function settingValueSchema(s: SettingSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: `${s.label}${s.unit ? ` (${s.unit})` : ''}. ${s.help}` };
  switch (s.type) {
    case 'boolean':
      return { ...base, type: 'boolean', default: s.default };
    case 'string':
      return { ...base, type: 'string', maxLength: s.maxLength, default: s.default };
    case 'enum':
      return { ...base, type: 'string', enum: [...(s.enum ?? [])], default: s.default };
    default:
      return {
        ...base,
        type: s.type === 'integer' ? 'integer' : 'number',
        minimum: s.min,
        maximum: s.max,
        ...(s.multipleOf ? { multipleOf: s.multipleOf } : {}),
        ...(s.nullable ? { nullable: true } : {}),
        default: s.default,
      };
  }
}

/** {group: {key: schema}} for the settings values object. */
function settingsValuesSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const g of SETTINGS_GROUPS) {
    const inner: Record<string, unknown> = {};
    for (const s of SETTINGS_SPEC.filter(x => x.group === g.id)) inner[s.key.split('.')[1]] = settingValueSchema(s);
    props[g.id] = { type: 'object', description: `${g.label}. ${g.help}`, properties: inner };
  }
  return { type: 'object', properties: props };
}

/** The plugin's package.json version (dist/plugin and src/plugin are both two levels below it). */
function packageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export function openApiDocument(basePath: string): Record<string, unknown> {
  const routeRequest = routeRequestSchema();
  const job = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
      request: routeRequest,
      created_at: { type: 'string' },
      started_at: { type: 'string' },
      finished_at: { type: 'string' },
      progress: { type: 'array', items: { type: 'object' } },
      summary: { type: 'object' },
      error: { type: 'string' },
      resource_id: { type: 'string' },
      publish_error: { type: 'string', description: 'Why publishing to the Resources API failed, when it did' },
      links: { type: 'object' },
    },
  };
  return {
    openapi: '3.0.0',
    info: {
      title: 'signalk-weather-router-plus',
      version: packageVersion(),
      description:
        'Standalone open-water weather routing on ECMWF open data. All values SI (m, m/s, s, degrees true). ' +
        'Map endpoints (/api/field, /api/wind-points, /api/currents, /api/land-mask, /api/pressure) are answered from the saved map tiles ' +
        '(/api/tile): the tiles covering bbox at the tile spacing nearest res (the answer reports it), time rounded to the hour, no data beyond ±85.05°. ' +
        '/api/conditions, Weather API point forecasts and /api/forecast samples are saved in the same store.',
    },
    servers: [{ url: basePath }],
    paths: {
      '/api/status': {
        get: {
          summary: 'Plugin, forecast (decoded run on disk, memory held), currents, overlay land cache and queue status',
          description:
            'Top level: plugin, started, workers {data, route}, forecast, forecast_error, forecast_loading, currents, currents_route_worker, rtofs_run, overlay_land, overlay_tiles, overlay_prebuild, ' +
            'weather_provider_registered, jobs, vessel, polar, land, harmonic_dir, extra_fields, tides, tides_enabled, tides_error, process_rss_bytes, ' +
            'meshes (the managed chart meshes, as GET /api/meshes), router (the open-water router the next route runs: "standard" | "refined"). ' +
            '`forecast` (null until a run is ready): {cycle, model, valid_from, valid_to, steps, params, coverage, storage: "decoded-on-disk", loaded_at, has_waves, ' +
            'source: "disk" (a complete decoded run was already on disk, no decode) | "grib" (decoded from the GRIB cache / download), ready_ms, fields_downloaded, ' +
            'decoded_dir, decoded_bytes (this run on disk), decoded_at, decode_ms, decoded_disk_bytes (all decoded runs kept), grib_cache_bytes, ' +
            'last_decode: {at, cycle, ms, stepBlockBytes, writtenBytes, downloaded} | null, memory: {data_worker_held_bytes, data_worker_largest_recent_window, ' +
            'route_worker_held_bytes, route_worker_largest_recent_window, decoding_block_bytes}} — the decoded forecast is never resident; `memory` is what ' +
            "requests hold now (a route's corridor store while it runs, a query's window while it is answered). `process_rss_bytes`: the Signal K process RSS. " +
            "`currents` lists the data worker's current sources in priority order ({name, priority, resolutionM, bbox, validFrom, validTo}); " +
            'the CMEMS-SMOC entry adds `smoc`: {run, run_last_time, stac_updated, settled, step_hours, horizon_hours, half_width_deg, ' +
            'resident: {bbox, centre, steps, valid_from, valid_to, bytes, layout} | null, on_demand: {areas, bytes, budget_bytes, list}, memory_bytes, ' +
            'shared_resident, last_download: {at, reason, bytes, chunks, downloaded, from_disk, seconds, decode_ms} | null, downloaded_bytes_total, disk_cache_bytes, layouts}. ' +
            '`currents_route_worker` is the same for the route worker (its own on-demand SMOC areas). ' +
            '`tides` (null when off or not loaded; `tides_enabled`, `tides_error`): the Copernicus Marine sea-level source {name, doi, datum, run, run_last_time, ' +
            'stac_updated, settled, half_width_deg, horizon_hours, resident: {bbox, centre, steps, valid_from, valid_to, bytes, layout} | null, on_demand: {areas, bytes, budget_bytes, list}, ' +
            'point_cache: {entries, bytes, queries, hits}, memory_bytes, last_download, last_point_query: {at, lat, lon, bytes, chunks, downloaded, from_disk, seconds, cached} | null, ' +
            'downloaded_bytes_total, disk_cache_bytes, layouts, mean_window_days}. ' +
            '`starting`: why the plugin is not answering yet (e.g. "starting: downloading the coastline (40 %)"), null once started; 503 answers carry the same text. ' +
            '`forecast_loading`: while a forecast is fetched and decoded {phase (checking | decoding), why (first | redecode | update), cycle, done, total, started_at, text}, else null; until the first forecast is loaded, map and point requests answer 503 at once with Retry-After and {error, loading}. ' +
            '`overlay_tiles` (null before start): saved map tiles {dir, cap_bytes, files, bytes, hits, misses, writes, not_kept, generations, inflight}. ' +
            '`overlay_prebuild` (null before start): tiles built ahead of time {enabled, workers, workers_ready, paused, areas: [{kind: "view" | "boat", lat, lon, radius_m}], ' +
            'window: {from, to} | null, max_zoom, walk_started_at, seen, built, skipped, not_kept, errors, last_error, at: {area, hour, z} | null, complete, built_total, build_ms_avg}.',
          responses: { 200: { description: 'OK' } },
        },
      },
      '/api/settings': {
        get: {
          summary:
            'Web-app settings (vessel, forecast, currents, routing, publishing) with their schema. Values are SI: m, m/s, s (degrees for the heading increment).',
          responses: {
            200: {
              description:
                '{values, schema: {groups[{id,label,help}], settings[{key, group, label, type, unit, quantity, min, max, multipleOf, step, default, nullable, enum, maxLength, help, reload}]}}',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { values: settingsValuesSchema(), schema: { type: 'object' } } },
                },
              },
            },
            503: { description: 'Plugin not started' },
          },
        },
        put: {
          summary:
            'Update some settings (readwrite). Only the keys sent change; validated all-or-nothing, saved to settings.json and applied live: a new forecast horizon or extra-fields choice reloads the forecast, SMOC and RTOFS settings reload currents, tide settings reload tides only, everything else applies to the next route.',
          requestBody: { required: true, content: { 'application/json': { schema: settingsValuesSchema() } } },
          responses: {
            200: { description: '{values, changed: ["group.key"], reloaded: {forecast, currents, tides, refresh_timer, jobs}}' },
            400: { description: '{error, errors: {"group.key": message}}; nothing saved' },
            401: { description: 'Not signed in' },
            403: { description: 'Needs readwrite access' },
            500: { description: 'Saving failed' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/forecast': {
        get: {
          summary: 'Forecast (global, decoded on disk) metadata, optionally sampled at any position (every step)',
          parameters: [
            { name: 'lat', in: 'query', schema: { type: 'number' } },
            { name: 'lon', in: 'query', schema: { type: 'number' } },
          ],
          responses: { 200: { description: 'OK' }, 400: { description: 'lat/lon not numbers, or no forecast' } },
        },
      },
      '/api/polars': {
        get: {
          summary: 'Polar library: the configured default plus every .pol/.csv in the polars directory',
          responses: { 200: { description: '[{path,label,source}]' }, 400: { description: 'Plugin not started' } },
        },
      },
      '/api/polar-angles': {
        get: {
          summary: 'No-go and best upwind/downwind VMG angles per TWS for a polar, with the tightest sailable angle setting applied',
          parameters: [
            {
              name: 'path',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Token from /api/polars; absent or empty = the configured default',
            },
          ],
          responses: {
            200: {
              description:
                '{tws_ms[], nogo_deg[], beat_deg[], run_deg[]}: nogo_deg the tightest angle with any boat speed (in irons below it)',
            },
            400: { description: 'No polar configured, or plugin not started' },
            404: { description: 'Not in the library' },
          },
        },
      },
      '/api/polars/table': {
        get: {
          summary: 'Polar speed table in SI (m/s) for drawing',
          parameters: [
            {
              name: 'path',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Token from /api/polars; absent or empty = the configured default',
            },
          ],
          responses: {
            200: { description: '{path, twa_deg[], tws_ms[], speeds_ms[][]}' },
            400: { description: 'No polar configured, or plugin not started' },
            404: { description: 'Not in the library' },
          },
        },
      },
      '/api/polar-from-specs': {
        post: {
          summary:
            'Generate a polar from boat specs with the physics polar calculator (ORC sail forces, Delft hull resistance, heeling limit; no spinnaker) and save it to the user polar directory as <slug>.csv (<polarsDir>/user, or polars/user in the plugin data directory when the bundled library is used)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'specs'],
                  properties: {
                    name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 60,
                      description: 'Slugified to the file name: lower case, spaces to _, only [a-z0-9_-] kept',
                    },
                    overwrite: { type: 'boolean', default: false },
                    specs: {
                      type: 'object',
                      required: ['loa_m', 'lwl_m', 'beam_m', 'draft_m', 'displacement_kg', 'sail_area_upwind_m2'],
                      properties: {
                        loa_m: { type: 'number', minimum: 3, maximum: 50 },
                        lwl_m: { type: 'number', minimum: 2, maximum: 50, description: 'Must not exceed loa_m (+0.01)' },
                        beam_m: { type: 'number', minimum: 0.5, maximum: 15 },
                        draft_m: { type: 'number', minimum: 0.1, maximum: 8 },
                        displacement_kg: { type: 'number', minimum: 50, maximum: 500000 },
                        ballast_kg: { type: 'number', nullable: true },
                        sail_area_upwind_m2: { type: 'number', exclusiveMinimum: true, minimum: 0, description: 'Main + 100% jib' },
                        sail_area_downwind_m2: {
                          type: 'number',
                          default: 0,
                          description: 'Accepted but not used: the calculator assumes no spinnaker (a value > 0 adds a warning)',
                        },
                        mast_height_m: { type: 'number', nullable: true },
                        rig_type: { type: 'string', enum: ['sloop', 'cutter', 'ketch', 'yawl', 'cat'], default: 'sloop' },
                        keel_type: { type: 'string', enum: ['fin', 'bulb', 'wing', 'full', 'centerboard', 'swing'], default: 'fin' },
                        hull_type: { type: 'string', enum: ['monohull', 'catamaran', 'trimaran'], default: 'monohull' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description:
                '{path: "user/<slug>.csv" (token for /api/polars and vessel.polar), label, warnings[], polar: {path, twa_deg[], tws_ms[], speeds_ms[][]}}',
            },
            400: {
              description:
                'Invalid specs or name: {error}. For a spec out of range also {field (the specs key), value, min, max} in SI; for an LWL longer than the LOA {field: "lwl_m", value, longer_than: {field: "loa_m", value}}',
            },
            409: { description: 'A polar with that name exists and overwrite is false' },
            422: { description: 'Hull type the polar calculator does not model (multihulls)' },
            500: { description: 'Calculator failed ("VPP failed: …")' },
          },
        },
      },
      '/api/field': {
        get: {
          summary: 'JSON value grid for a heatmap layer over a bbox at one time',
          description:
            'layer=current returns display values: gridded model currents (CMEMS SMOC, RTOFS) are extended up to 2 source-grid cells into the ' +
            'cells the model leaves empty at the coast (inverse-distance weights over valid cells; valid cells unchanged), for clipping with /api/land-mask. ' +
            'When the bbox is outside the resident SMOC area it is loaded on demand first (at most 60 s wait). ' +
            'layer=tide returns `tide_m`: the tide height in metres above MEAN SEA LEVEL (not chart datum) from Copernicus Marine `ocean_tide` (FES2014) at the hour ' +
            '(linear between hourly steps), with the same 2-cell coastal extension for display; outside the resident tide area the hour is loaded on demand ' +
            '(1/3° grid for res ≥ 0.25°).',
          parameters: [
            {
              name: 'layer',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['wind', 'waves', 'msl', 'temperature', 'sst', 'precip', 'sea_state', 'current', 'tide'] },
            },
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
            {
              name: 'res',
              in: 'query',
              schema: { type: 'number', minimum: 0.002, maximum: 2, default: 0.25 },
              description: 'lattice spacing, degrees (coarsened to at most 40k cells)',
            },
          ],
          responses: {
            200: { description: '{layer, time, bbox, res, lons, lats, fields: {name: rows from the south, null = no data}, land, units}' },
            400: { description: 'Bad layer, bbox, time or res, or no forecast' },
          },
        },
      },
      '/api/conditions': {
        get: {
          summary:
            'Hourly point series of every conditions field, plus tide height, total water level and surge with the high and low waters',
          description:
            'Rows: every conditions field (wind_ms, gust_ms, wind_dir_deg, swh_m, mwp_s, mwd_deg, current_ms, current_dir_deg, msl_pa, t2m_k, skt_k, precip_rate_ms, precip_type, precip_type_label, precip_m, snowfall_m, ssrd_wm2, strd_wm2, str_wm2, interval_h, cloud_cover, mucape_jkg, dewpoint_k, rh, feels_like_k, feels_like_basis, wind_chill_k, heat_index_k, beaufort, douglas, douglas_label, sea_state_index, sea_state, sea_state_partial) (current_ms and current_dir_deg are null where no current source has data: not slack water; gust_ms, precip_m, snowfall_m, the fluxes and interval_h are null when the extra or energy fields are off — precip_m/snowfall_m and the W/m² fluxes are the values of the interval_h-hour interval containing the sample time, 3 h to 144 h and 6 h past it) plus `time` and the tide fields `tide_m` (tide height above mean sea level, m; Copernicus Marine ocean_tide, FES2014), ' +
            '`water_level_m` (total water level above local mean sea level, m = total_sea_level − local mean), `surge_m` (non-tidal residual = water level − tide, m), ' +
            '`tide_extrapolated` (a bilinear corner is model land and took the value of valid cells within 2 cells, ~18 km), `tide_tendency` (rising / falling / steady within ±2 cm/h). ' +
            'Tide fields are null when tides are off or there is no model water within 2 cells. ' +
            '`tides`: {highs: [{time, height_m, water_level_m}], lows: [...], range_m (mean of consecutive high−low differences), max_range_m, of: "tide_m", source, run, ' +
            'datum: "mean sea level", msl_offset_m (mean of total_sea_level − ocean_tide over mean_window, removed from the total level), mean_window: {from, to, samples}, extrapolated, doi} ' +
            'or null (`tides_error` says why). High / low waters are those of the tide height, refined with a parabola through the hourly samples. ' +
            'Heights are relative to mean sea level, NOT chart datum: not for under-keel clearance.',
          parameters: [
            { name: 'lon', in: 'query', required: true, schema: { type: 'number' } },
            { name: 'lat', in: 'query', required: true, schema: { type: 'number' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Default: the current hour' },
            { name: 'hours', in: 'query', schema: { type: 'number', minimum: 1, maximum: 240, default: 72 } },
            { name: 'step_h', in: 'query', schema: { type: 'number', minimum: 1, maximum: 24, default: 1 } },
          ],
          responses: {
            200: {
              description:
                '{lon, lat, is_land, from, hours, step_h, forecast_time_range, truncated, series: [row], tides, tides_error, sources: {forecast_cycle, currents, tides}}',
            },
            400: { description: 'Bad parameters' },
          },
        },
      },
      '/api/legends': {
        get: {
          summary:
            'Colour ramps for the heatmap layers: {key: {title, quantity, category, si_unit, kind, stops: [[SI value, css colour]], bands?, fade_below?}}; `category` is the Signal K unit category for display; `fade_below`: values under it fade to transparent (precipitation); `tide`: tide height above mean sea level, −3..+3 m diverging',
          responses: { 200: { description: 'OK' } },
        },
      },
      '/api/currents': {
        get: {
          summary: 'Current arrows on a lattice (display values, extended to the coast as for /api/field?layer=current)',
          parameters: [
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
            {
              name: 'res',
              in: 'query',
              schema: { type: 'number', minimum: 0.005, maximum: 5, default: 0.05 },
              description: 'lattice spacing, degrees',
            },
          ],
          responses: {
            200: { description: '[{lon, lat, u_ms, v_ms, speed_ms, dir_deg (TO)}], land and near-slack points dropped' },
            400: { description: 'Bad bbox, time or res' },
          },
        },
      },
      '/api/wind-points': {
        get: {
          summary: 'Wind barb points on a lattice',
          parameters: [
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
            {
              name: 'res',
              in: 'query',
              schema: { type: 'number', minimum: 0.02, maximum: 5, default: 0.5 },
              description: 'lattice spacing, degrees',
            },
          ],
          responses: {
            200: { description: '[{lon, lat, speed_ms, dir_deg (FROM, degrees true)}]' },
            400: { description: 'Bad bbox, time or res, or no forecast' },
          },
        },
      },
      '/api/pressure': {
        get: {
          summary: 'Mean-sea-level pressure isobars with labels and high/low centres, as GeoJSON',
          parameters: [
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
            {
              name: 'interval',
              in: 'query',
              schema: { type: 'number', minimum: 1, maximum: 20, default: 4 },
              description: 'isobar spacing, hPa',
            },
          ],
          responses: {
            200: {
              description:
                'FeatureCollection. properties.kind: "isobar" (LineString; hpa, pa, bold), "label" (Point; hpa, pa), "high" / "low" (Point; hpa, pa). pa is the SI value.',
            },
            400: { description: 'Bad bbox, time or interval, or no forecast' },
          },
        },
      },
      '/api/land-mask': {
        get: {
          summary: 'Land mask at screen resolution for clipping drawn layers to the coastline',
          parameters: [
            { name: 'bbox', in: 'query', required: true, schema: { type: 'string' }, description: 'west,south,east,north' },
            {
              name: 'w',
              in: 'query',
              schema: { type: 'number', minimum: 16, maximum: 2048, default: 1024 },
              description: 'pixels, rounded',
            },
            {
              name: 'h',
              in: 'query',
              schema: { type: 'number', minimum: 16, maximum: 2048, default: 1024 },
              description: 'pixels, rounded',
            },
          ],
          responses: {
            200: {
              description: 'gzip-encoded bytes, one per pixel (1 = land), row 0 at the north edge; X-Mask-Width/X-Mask-Height headers',
            },
            400: { description: 'Bad bbox, w or h' },
          },
        },
      },
      '/api/tile/{layer}/{z}/{x}/{y}.png': {
        get: {
          summary: 'One colour-layer tile as a 256 × 256 PNG image, for chartplotters (the picture the web app paints from the data tile)',
          description:
            'Layers wind, waves, current, sea_state, precip, temperature, sst, tide. The legend colour ramp (/api/legends), alpha 0.55, land transparent for the layers that mask it, water without model data hatched (current, tide); the tide layer uses its fixed ±3 m scale. ' +
            'Rendered on the server from the saved data tile and kept in memory. The plugin also publishes these layers as Signal K chart resources (/signalk/v2/api/resources/charts, ids wrp-…) with a time block over the forecast hours.',
          parameters: [
            {
              name: 'layer',
              in: 'path',
              required: true,
              schema: {
                type: 'string',
                enum: [
                  'wind',
                  'waves',
                  'current',
                  'sea_state',
                  'precip',
                  'temperature',
                  'sst',
                  'tide',
                  'barbs',
                  'arrows',
                  'isobars',
                  'seas',
                  'wave_arrows',
                ],
              },
            },
            { name: 'z', in: 'path', required: true, schema: { type: 'integer', minimum: 0, maximum: 18 } },
            { name: 'x', in: 'path', required: true, schema: { type: 'integer', minimum: 0 }, description: '0 to 2^z − 1, from 180° W' },
            { name: 'y', in: 'path', required: true, schema: { type: 'integer', minimum: 0 }, description: '0 to 2^z − 1, from the north' },
            {
              name: 'time',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description: 'Default now; rounded to the nearest hour',
            },
          ],
          responses: {
            200: { description: 'image/png; X-Tile-Cache: hit | miss' },
            400: { description: 'Bad layer, z, x, y or time, or the layer has no data' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/tile/{layer}/{z}/{x}/{y}': {
        get: {
          summary: 'One web-map tile of a layer at a whole hour, saved on the server and answered again from disk',
          description:
            'Colour layers: the /api/field body for the tile box extended by one sample spacing (tile width / 64, 0.002°–2°). barbs: /api/wind-points body, 7 across. ' +
            "arrows: /api/currents body, 5 across (points on the tile's east and north edges belong to the neighbour). land: 256 × 256 bytes, 1 = land, row 0 north, " +
            'rows evenly spaced in Web Mercator y. Identical requests are computed once; a request whose client goes away before its query starts is dropped.',
          parameters: [
            {
              name: 'layer',
              in: 'path',
              required: true,
              schema: {
                type: 'string',
                enum: [
                  'wind',
                  'waves',
                  'msl',
                  'temperature',
                  'sst',
                  'precip',
                  'sea_state',
                  'current',
                  'tide',
                  'barbs',
                  'arrows',
                  'seas',
                  'land',
                ],
              },
            },
            { name: 'z', in: 'path', required: true, schema: { type: 'integer', minimum: 0, maximum: 18 } },
            { name: 'x', in: 'path', required: true, schema: { type: 'integer', minimum: 0 }, description: '0 to 2^z − 1, from 180° W' },
            { name: 'y', in: 'path', required: true, schema: { type: 'integer', minimum: 0 }, description: '0 to 2^z − 1, from the north' },
            {
              name: 'time',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Default now; rounded to the nearest hour. Ignored for land',
            },
          ],
          responses: {
            200: { description: 'gzip-encoded body (see description); X-Tile-Cache: hit | miss' },
            400: { description: 'Bad layer, z, x, y or time, or the layer has no data (e.g. no wave data in the forecast)' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/forecast/refresh': {
        post: {
          summary: 'Check ECMWF for a newer cycle',
          parameters: [
            {
              name: 'force',
              in: 'query',
              schema: { type: 'string', enum: ['true', '1'] },
              description: 'Decode the current cycle again from the GRIB cache',
            },
          ],
          responses: { 202: { description: '{status: "refresh requested"}' } },
        },
      },
      '/api/routes': {
        post: {
          summary: 'Submit a route job',
          requestBody: { required: true, content: { 'application/json': { schema: routeRequest } } },
          responses: {
            202: { description: '{id, status, links}; Location header = links.self' },
            400: { description: 'Invalid request' },
            429: { description: 'Queue full (16 queued jobs)' },
            503: { description: 'Plugin not started' },
          },
        },
        get: {
          summary: 'List jobs, newest first',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'number', minimum: 1, maximum: 500, default: 50 } }],
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: job } } } },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/routes/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Job status',
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: job } } },
            404: { description: 'Not found' },
            503: { description: 'Plugin not started' },
          },
        },
        delete: {
          summary: 'Delete a queued or finished job (a running job must be cancelled first)',
          responses: {
            204: { description: 'Deleted' },
            404: { description: 'Not found' },
            409: { description: 'Job is running' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/routes/{id}/events': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Server-Sent Events: status, progress, route, done, error (Last-Event-ID honoured; ends after done/error)',
          responses: {
            200: { description: 'text/event-stream' },
            404: { description: 'Not found' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/routes/{id}/result': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Route as GeoJSON FeatureCollection (LineString + one Point per waypoint)',
          responses: {
            200: { description: 'OK' },
            404: { description: 'Not found' },
            409: { description: 'Not finished: {error, status, message}' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/routes/{id}/skeleton': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Coarse A* skeleton that guided the heading sweep, as a GeoJSON FeatureCollection',
          responses: {
            200: { description: 'OK' },
            404: { description: 'Job not found, or no skeleton for this job' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/routes/{id}/signalk': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Route as a Signal K Resources API route record',
          responses: {
            200: { description: 'OK' },
            404: { description: 'Not found' },
            409: { description: 'Not finished' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/routes/{id}/cancel': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Cancel a queued or running job',
          responses: {
            202: { description: '{id, status: "cancelling" | the current status when already finished}' },
            404: { description: 'Not found' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/routes/{id}/publish': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Save the route to /signalk/v2/api/resources/routes',
          responses: {
            200: { description: '{id, resource_id, href}' },
            404: { description: 'Not found' },
            409: { description: 'Not finished' },
            502: { description: 'Resources API error' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/meshes': {
        get: {
          summary: 'The managed chart meshes: the catalogue rows and their state on this server',
          description:
            '{catalog_url, catalog_updated, catalog_error, store_dir, meshes: [{name, title, description, source: "catalog" | "local", ticked, enabled, state: ' +
            '"absent" | "downloading" | "ready" | "update" | "error" | "removing", progress: {files, total} | null, catalog_build_date, disk_build_date, bytes, error, ' +
            'using, local_dir, local_build_date}]}. The catalogue is read at start and once a day; POST /api/meshes/refresh reads it now.',
          responses: { 200: { description: 'OK' }, 503: { description: 'Plugin not started' } },
        },
      },
      '/api/meshes/refresh': {
        post: {
          summary:
            'Read the mesh catalogue now (readwrite), then download ticked meshes that are missing or have a newer build and delete unticked ones',
          description:
            'Waits for the catalogue read only (the downloads run on). Answers the same body as GET /api/meshes: 200 when the catalogue was read, ' +
            '502 {error: "catalogue not read: …", catalog_url, catalog_updated, catalog_error, store_dir, meshes} when it was not.',
          responses: {
            200: { description: 'The mesh list, as GET /api/meshes' },
            502: { description: 'The catalogue could not be read; the list as it stands' },
            503: { description: 'Plugin not started' },
          },
        },
      },
      '/api/openapi.json': {
        get: { summary: 'This document', responses: { 200: { description: 'OpenAPI 3.0 JSON' } } },
      },
      '/ui': {
        get: { summary: 'The route planner page (readonly)', responses: { 200: { description: 'text/html' } } },
      },
      '/ui/{file}': {
        parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: "The page's scripts and styles (cached for a year when requested with ?v=)",
          responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } },
        },
      },
    },
  };
}
