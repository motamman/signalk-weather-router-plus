# signalk-weather-router-plus

Standalone open-water weather routing as a Signal K plugin. No outside
service: everything runs in Signal K's process and in short-lived
processes the plugin starts itself. The plugin downloads ECMWF open-data
forecasts by HTTP byte range, decodes the CCSDS-packed GRIB2 fields in
TypeScript, reads Copernicus Marine SMOC ocean currents (worldwide,
including tides) and the Copernicus Marine hourly sea level (tide
height, total water level, surge) from their Zarr stores with an
in-process Blosc/LZ4 decoder, avoids land with GSHHG coastline polygons, and runs an
isochrone router against the vessel's polar in a worker thread. No
runtime npm dependencies.

The "plus" is the overlays: wind, temperature, tide, current and more,
drawn from the same data the routing uses.

What it does not do: it routes in open water and avoids land, but knows
nothing about depths, channels or bridges. (US inshore routing was too
much for a plugin; it lives in the separate
[router.zeddisplay.com](https://router.zeddisplay.com).)

![A finished route from the western Mediterranean through the Strait of Gibraltar to Lisbon, with wind speed, isobars and the itinerary of legs](public/screenshots/01-route.jpg)


**Status: beta** (0.1.2-beta.1). Please report
problems at https://github.com/motamman/signalk-weather-router-plus/issues.

What changed in this version: [WHATSNEW.md](WHATSNEW.md). Full history:
[CHANGELOG.md](CHANGELOG.md).

## What it provides

| Surface | Path |
|---|---|
| Webapp (map, compute, watch progress) | listed in the Admin UI's Webapps page as **Weather Router Plus**; served at `/signalk-weather-router-plus/` (also `/plugins/signalk-weather-router-plus/ui`) |
| Route job API (REST + Server-Sent Events) | `/plugins/signalk-weather-router-plus/api/…` |
| OpenAPI | `/plugins/signalk-weather-router-plus/api/openapi.json` |
| Finished routes | saved to `/signalk/v2/api/resources/routes/{jobId}` (needs a routes provider, e.g. `resources-provider`) |
| Weather API provider | point forecasts and observations anywhere from the global forecast (read from the decoded run on disk by the data worker) via `/signalk/v2/api/weather/forecasts/point?lat=&lon=` and `/observations`, with `outside.cloudCover` / `wind.gust` when the extra fields are on, `water.level` / `water.levelTendency` (relative to mean sea level) when tides are on and `water.surfaceCurrentSpeed` / `surfaceCurrentDirection` (the set, towards) where a current source covers the point |
| Notifications | `notifications.weatherRouterPlus.{jobId}` on completion or failure |
| CLI (no Signal K) | `wrp-route` |

## Data

- **Forecast:** ECMWF IFS 0.25° open data, `oper`/`wave` streams for every
  cycle: 00z/12z to 360 h (every 3 h to 144 h, then every 6 h), 06z/18z to
  144 h. Fields: `10u`, `10v`, `msl`,
  `swh`, `mwp`, `mwd`. Only those fields are fetched (byte-range
  requests against the published `.index` files, roughly 4.7 MB per
  step instead of 140 MB) and cached on disk under the plugin's data
  directory (`ecmwf/`). The whole globe is decoded at full Float32
  precision (exactly the decoded values), so overlays, conditions, the
  Weather API and routing work anywhere: 1440 × 721 cells × 4 B =
  4.15 MB per field per step. A 72 h horizon (25 steps) is 623 MB with
  the six base fields and 1.35 GB with the extra fields (`2t`, `tprate`,
  `skt`, `2d`, `ptype`, `tcc`, `10fg`).

  **Decoded once per update, kept on disk, read per request.** The
  decoded forecast is not kept in memory. When a new ECMWF run arrives
  the data worker decodes it one step at a time into one reusable
  one-step block (54.0 MB with the extra fields) plus decode buffers
  (20.8 MB: one global field as Uint32 + Float64 + Float32 + Int32) and
  writes each step to `forecast/<yyyymmddHH>/` under the
  plugin data directory: one raw Float32 file per field and step
  (`<step>-<param>.f32`, rows from the south, 1440 × 721, NaN kept, the
  exact in-memory layout) and an `index.json` (cycle, steps and valid
  times, parameters, grid, format version, `complete`). The run is
  written into a temporary directory, every file fsync'd, and renamed
  into place only when complete, so a crash never leaves a run that
  looks complete. It stays there until the next run replaces it
  (`forecast.keepCycles` applies, as for the GRIB cache). At start-up a
  complete decoded run of the current cycle is used as it is, without
  decoding. Each request then reads only what it needs, for as long as
  it needs it: a map layer reads its view (plus two cells) at the two
  steps around the map time; the conditions popup, the Weather API and
  `/api/forecast?lat=&lon=` read a few cells around the point for every
  step; a route reads its corridor box plus 5° (wind and waves, every
  step) into one block before it runs and drops it when it ends. Inside
  what was read every sample is bit for bit the value of the whole
  global store (the unit tests check map grids, arrows, isobars,
  conditions, Weather API points and corridor sampling against it).
  Nothing is cached in the process beyond that: warm reads come from the
  OS page cache (1–2 ms for a map view, below), so an in-process cache
  of field-steps was not added.

  Disk: one run of 72 h with the extra fields is 1,349,712,000 B of
  `.f32` files plus a 3.5 kB `index.json`; with `keepCycles` 2 up to two
  runs are kept, next to the GRIB cache (212.5 MB for one 72 h cycle
  with the extra fields). An update writes the run once:
  1,144,471,552 B written by the plugin process during a forced reload
  (`/proc/<pid>/io` `write_bytes`, measured on a build with the previous
  extra-field set). The GRIB cache stays, so a settings
  change (horizon, extra fields) can decode again without downloading.

  *Measured on a Pi 5 (8 GB, NVMe), 2026-09-28*, the installed build
  (whole forecast in memory) against this design, same settings (72 h,
  extra fields, SMOC, RTOFS, tides), the plugin run with a stand-in
  Signal K app, process RSS sampled every second from `/proc/<pid>/status`:

  | | whole forecast in memory | decoded on disk |
  |---|---|---|
  | RSS after start-up, all loads + 60 s | 1644.0 MiB | 533.8 MiB |
  | peak RSS during a forced forecast reload | 3059.6 MiB | 891.3 MiB |
  | RSS 60 s after the reload | 1987.3 MiB | 806.3 MiB |
  | start-up to forecast ready | 64.6 s (decode from the GRIB cache) | 1.3 s (decoded run on disk); 68.6 s when it has to decode |
  | forced reload (decode from the GRIB cache) | 66.9 s | 69.4 s (includes writing and fsyncing 1.14 GB) |

  Forecast reads from the decoded run (`DecodedRun.window`), cold = page
  cache dropped first: a map view (10° × 8°, wind, 2 steps) 7.1 ms cold,
  1.6–1.7 ms warm; the North Atlantic (70° × 40°) 10.5 / 2.1–2.4 ms; the
  whole world 37.9 / 8.4–9.2 ms (16.6 MB); a point series (11 fields ×
  25 steps) 34.7 / 25–29 ms; a route corridor (5 fields × 25 steps)
  108.6–148.4 ms cold, 27–35 ms warm (3.7–7.4 MB). Route jobs Newport
  RI → Bermuda and → Horta (motor and sail_max) took 196–238 s with the
  whole forecast in memory and 199–239 s decoded on disk; Lisbon →
  Palma 3.2–7.2 s and 6.8–12.9 s (the first Lisbon route of the second
  run downloaded 19.2 MB of SMOC chunks the first run already had on
  disk). Route areas are released when a route ends, so each route
  decodes its CMEMS SMOC area again from the disk cache (2.1–3.4 s
  measured).
- **Land:** GSHHG shorelines as shapefiles (`GSHHS_f_L1.shp` for full
  resolution, automatically including L2–L4 siblings; add `GSHHS_f_L6.shp` for Antarctica) or the OSM
  land-polygons export. Overlay land flags use a raster built on demand
  for each requested bbox at a resolution matched to the request's
  sample spacing (a quarter of it, 0.002° to 0.25°, at most 4 M cells),
  from an in-memory index of the shapefile records; the last 8 rasters
  are kept. Conditions `is_land` uses the exact polygons. For routing,
  land is loaded for the box around the route's corridor (see [Global
  water grid](#global-water-grid)) plus 1° and rasterised at
  the finest resolution that fits the configured cell budget (0.5 m
  arc-seconds to 0.01°). The raster is conservative: cells crossed by a
  coastline edge count as land (an exact supercover of every edge, so a
  water cell contains no coastline). Where the corridor passes a passage
  only a few cells wide, finer patches (down to 0.0005°, about 55 m) are
  rasterised locally. A leg is checked against every raster cell its
  path crosses (the finest patch where one covers it), not points along
  it, so land narrower than the spacing of points cannot be stepped over.
  Endpoints and every leg of the finished route are checked against the
  exact polygons: a leg crossing or touching any coastline edge is a
  land crossing, whatever the width of the land (legs whose cells are all
  water need no polygon test).
- **Depth:** none in this version. There is no bathymetry: depths,
  draught and clearances play no part in the route.
- **Currents:** a stack of sources; where several cover a point the
  highest priority with data wins, and exactly (0, 0) from a source
  means "no data here" (the next one is asked):

  | Priority | Source | Coverage |
  |---|---|---|
  | 10 (from the file) | user-installed tidal harmonics `.npz`, e.g. NECOFS GoM3 | its grid |
  | 3 | **Copernicus Marine SMOC** (below) | worldwide, 80°S–90°N |
  | 2 | NOAA Global RTOFS, depth-averaged `ubaro`/`vbaro`, one regional product | the product's box |
  | 0 (from the file) | FES2014 harmonic extract `.npz` | its grid |

  **SMOC** is product `GLOBAL_ANALYSISFORECAST_PHY_001_024`, dataset
  `cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_202211`: hourly surface
  currents merging the Mercator 1/12° circulation model, FES2014 tidal
  currents and Stokes drift (`utotal`/`vtotal`, m/s), from 2020-11-01 to
  about 10 days ahead, updated once a day. It is read anonymously (no
  account) from the Copernicus Marine ARCO Zarr v2 stores on
  `s3.waw3-1.cloudferro.com` (`timeChunked.zarr`: 1 h × 512 × 2048-cell
  chunks; `geoChunked.zarr`: 4272 h × 16 × 8-cell chunks;
  `downsampled4.zarr`: 1/3°, one chunk per hour for the globe), with the
  chunks' Blosc/LZ4 compression decoded in TypeScript
  (`src/data/blosc.ts`, `src/data/zarr.ts`). Each load takes the layout
  with the lower estimated download (a small box over many hours comes
  from `geoChunked`, a wide area from `timeChunked`).
  - *Resident area:* the vessel's position (Signal K
    `navigation.position`) ± the configured half-width (15°), every step
    from the current hour to the SMOC horizon (72 h) at 3 h (or 1 h)
    spacing, cropped from the decoded chunks and held as Float32 in
    SharedArrayBuffers: the data worker loads it and the route worker
    uses the same memory. It is rebuilt when the window moves on a step,
    when the vessel has moved more than a third of the half-width, or
    for a new run.
  - *On demand:* before a route (route worker) or an overlay /
    conditions query (data worker) whose box the resident area does not
    cover, the plugin loads that box first: all window steps for a
    route or a conditions series, only the one or two steps around the
    requested hour for a map overlay (from the 1/3° store for zoomed-out
    views, lattice ≥ 0.25°). A single area is capped at 128 MB (a route
    box too large at 1/12° is loaded at 1/3°). On-demand areas are not
    kept for long: the route worker releases its route areas when the
    route ends, and the data worker keeps at most 16 MB of areas loaded
    for map / conditions queries (least recently used first; measured on
    a Pi 5 NVMe, 2026-09-28: a map view's area is 0.0–0.2 MB decoded, and
    decoding one again from the disk cache takes 25–89 ms). Overlay queries wait at most
    60 s; a slower load finishes in the background and serves the next
    request. Without a vessel position nothing is resident and
    everything loads on demand.
  - *Runs and cache:* compressed chunks are cached under
    `<data dir>/smoc/<run>/`, where the run is the last hour on the
    store's time axis (it advances by 24 h each day). On every refresh
    tick the plugin reads the 12 kB `.zmetadata` and the STAC record;
    a new run is used once STAC reports the update finished
    (`admp_updated_data` later than the metadata rewrite, no
    `admp_updating_start_date`), the resident area is downloaded again,
    and the previous run's cache is deleted. Offline, the newest cached
    run is used.
  - *Sampling:* bilinear on the 1/12° grid (seamless across the
    antimeridian), linear in time between steps with a ±1 h grace at the
    ends, like RTOFS. Cells the model leaves empty (land, and roughly the
    first cell off the coast) are "no data".
  - *Measured* (2026-09-28, ±15° box = 367 × 367 cells, 72 h): 26 steps
    at 3 h: 181.8 MB download (English Channel, 208 chunks, 9 s on a fast
    line) or 110.9 MB (US East Coast, 104 chunks), 28 MB resident; 74
    steps at 1 h: 219.5 MB (English Channel, from `geoChunked`) or
    315.6 MB (US East Coast), 79.7 MB resident. A one-hour overlay of a
    1.5° × 1° box outside the resident area: 2.7 MB (2 chunks); a
    conditions series at a point: 0.64 MB (4 `geoChunked` chunks, which
    hold every hour of the run). Decoding runs at about 400 MB/s.

  **Coastal display extension.** A ~9 km model has no value in the cells
  next to the coast, so drawn currents would stop short of the
  shoreline. For the map layers only (`/api/field?layer=current` and
  `/api/currents`), SMOC and RTOFS fill an empty grid cell that has
  valid cells within 2 grid cells from those cells (inverse-distance²
  weights, no fade; valid cells never change), so colour and arrows
  reach the coast, where the map's coastline tiles cut
  them. Routing, the conditions popup and the sea-state layer use the
  raw values only.

  **Attribution and licence.** SMOC is *Generated using E.U. Copernicus
  Marine Service Information; https://doi.org/10.48670/moi-00016*. The
  Copernicus Marine licence
  (https://marine.copernicus.eu/user-corner/service-commitments-and-licence)
  grants the licence free of charge (section 2.1) as a worldwide,
  non-exclusive, royalty-free, perpetual licence to use the products and
  to create and distribute value-added products or derivative works
  "for any purpose" (2.2), with the credit above, which the page shows
  in the map's attribution while a current layer is on (2.3–2.4). The
  products come without warranty (4). The service commitments state the
  service is free of charge until the end of the current Copernicus
  Marine Service phase, planned for 30 June 2028.

- **Tides and water level: Copernicus Marine hourly sea level.** Same
  product (`GLOBAL_ANALYSISFORECAST_PHY_001_024`), dataset
  `cmems_mod_glo_phy_anfc_merged-sl_PT1H-i_202411`: 1/12°, 80°S–90°N,
  hourly from 2022-09-01 to about 10 days ahead, updated daily (source
  attribute "MERCATOR GLO12, FES2014"). Read anonymously from the same
  ARCO Zarr stores with the same run detection, disk cache and layouts
  as SMOC (shared code in `src/data/arco.ts`; `src/tides/`). Variables
  used, in metres:
  - `ocean_tide`: the FES2014 ocean tide, "tidal sea surface height
    above mean sea level", i.e. the tide relative to the sea floor, as a
    tide gauge records it. `tide_loading` (sea-floor displacement under
    the tidal load) is **not** added: a gauge and the land move with the
    loaded crust, so the height a mariner sees is the ocean tide alone;
    ocean + load tide (geocentric) matters only for satellite altimetry.
    `total_sea_level` does not include it either.
  - `total_sea_level`: height above the geoid = `ocean_tide` +
    `invert_barometer` + `sea_surface_height` (GLO12 dynamic sea level,
    which includes the mean dynamic topography) +
    `global_mean_steric_variation` + `global_mean_mass_volume_variation`
    (product user manual CMEMS-GLO-PUM-001-024 issue 2.4 and the
    variable's long_name; checked on the data: the sum matches to the
    product's 1 mm quantisation).

  Derived quantities, SI metres **relative to local mean sea level**:

  | Field | Formula |
  |---|---|
  | tide height `tide_m` | `ocean_tide` |
  | MSL offset | mean(`total_sea_level` − `ocean_tide`) over the mean window |
  | surge (non-tidal residual) `surge_m` | `total_sea_level` − `ocean_tide` − offset |
  | total water level `water_level_m` | `total_sea_level` − offset = tide + surge |

  The mean window is every hourly sample of the geoChunked time chunks
  covering the last 60 days of the run (60 to ~210 days: a geo chunk
  holds 3648 h and is downloaded whole anyway), so the offset is fixed
  for a run and place. It removes the geoid-to-MSL separation (mean
  dynamic topography, e.g. −0.44 m at Newport RI, +0.15 m at Sydney) and
  the seasonal mean; the surge is the departure from that recent mean:
  weather set-up, inverse barometer and shorter dynamic signals. Over
  the last 130 days its standard deviation was ~8 cm at Newport and
  Sydney, correlating with the inverse barometer (r = 0.37 and 0.68).

  *Point series* (conditions popup, Weather API): from the geoChunked
  store, bilinear from the 4 surrounding cells; a corner that is model
  land takes the IDW² mean of valid cells within 2 cells and the value
  is flagged `tide_extrapolated`. No valid cell within 2 cells (~18 km)
  → no tide data (e.g. Southampton: the Solent is land at 1/12°). High
  and low waters are those of the tide height: local extrema of the
  hourly samples (pairs less than 3 cm apart dropped), refined with a
  parabola through each extremum and its neighbours; range = mean of
  consecutive high−low differences. Tendency: rising / falling, steady
  within ±2 cm/h. Measured: 0.9–6.7 MB and 0.2–1.5 s per new place (2
  variables × 1–4 chunks of ~0.3–1.6 MB; the whole 3120-hour chunk),
  then served from memory (8 places) or disk for the rest of the run.

  *Tide-height map layer* (`/api/field?layer=tide`): `ocean_tide` only,
  hourly (a 3-hourly step would err by up to ~30 % of the amplitude
  mid-step). A resident area around the vessel (± `tides.halfWidth`,
  default 15°) over now → `tides.horizon` (default 24 h), its start
  aligned to 6 h so it is rebuilt four times a day; views elsewhere load
  their hour on demand (1/3° grid for zoomed-out views); at most 16 MB
  of those on-demand hours are kept between queries. Measured at 15° around Newport: 368 × 368 cells × 31 hourly
  steps, 16.8 MB in memory, 62 timeChunked chunks = 39.9 MB downloaded
  in 3.5 s (about 1.3 MB per hour of window; a new daily run re-downloads
  it). One on-demand hour: 0.74 MB (1/12°, Sydney) or 0.53 MB (1/3°,
  most of the North Atlantic). The same 2-cell coastal extension as the
  current layers is applied for display; the page's land mask clips it.

  **Datum and accuracy caveats.** Heights are relative to **mean sea
  level, not chart datum** (LAT / MLLW): add the local chart-datum-to-MSL
  difference yourself; **not for under-keel clearance**. The model is
  ~9 km: in bays, estuaries and harbours the tide can be earlier and
  smaller than local tide tables (see the Newport check under
  Verification: highs 14–17 cm low and ~1 h early; lows within 2 cm and
  ~30 min early), and small basins may not exist in the model at all.
  Credit: *Generated using E.U. Copernicus Marine Service Information;
  https://doi.org/10.48670/moi-00016* (shown in the map attribution while
  the tide layer is on, and under the Tide chart).

## Using the webapp

- **Planning.** Click the map for the menu: set or move the start, set or
  move the destination, **Add waypoint here** (the clicked point becomes
  the destination and the old destination becomes the last waypoint, so
  waypoints stay in placing order), or **Conditions here**. Holding on
  the map does the direct action (start, then destination, then extend
  the course). Drag any pin to move it. Holding on a computed route pins
  that point as a waypoint. The button under the zoom buttons (⌖)
  centres the map on the boat's Signal K position (`navigation.position`),
  keeping the zoom; a first visit opens on it (the page never asks the
  browser for its location). The route summary (distance, time, arrival,
  sail and motor time, waypoints, highest waves, validation) shows on the
  Route tab and at the top of the Itinerary tab. The plan (start,
  destination, waypoints with their radii, departure) is kept in the
  browser and restored on reload; a departure that has passed is set to
  now, and the status line says so.
- **Header.** One line per quantity with the source it comes from: wind
  (the ECMWF run, plus any regional model), waves, currents, tides, and
  the job queue. Only the sources that apply to the route on the map, or
  to the map view when there is none, are listed; times are local, with
  UTC as a tooltip.
- **Saved routes** (Saved tab): opening one replaces the route on the map
  (its own start, destination, waypoints and precision) and offers
  **Recompute** with the current forecast and settings, or **Keep as
  saved**. **Publish** in the itinerary bar saves it to Signal K's
  Resources; a published route carries each point's leg (time, mode,
  distance, SOG, COG, wind, current, waves) as the point's description,
  in your units, which chartplotters show with the point. **GPX** in the
  same bar downloads the route as a GPX 1.1 file for plotters and apps
  that import GPX: one route whose points carry their name (Start, WP1 …
  End), time and leg, and the route's summary as its description.
- **Units and times.** Every quantity follows the Signal K user's unit
  preferences, with one deliberate exception: a duration of a day or more
  (a passage, the sailing or motoring time, a forecast horizon) is written
  as days, hours and minutes, Signal K's own *duration-compact* format
  ("9d 7h"), whatever the time unit is set to, as "223.0 hour" reads
  badly; shorter durations follow the preference. Clock times are shown
  in **ship's time** when the Signal K server publishes it
  (`environment.time.timezoneRegion`, an IANA zone such as
  `Pacific/Tongatapu`, else `environment.time.timezoneOffset`, e.g. `-930`;
  [signalk-ships-time](https://github.com/meri-imperiumi/signalk-ships-time)
  sets them), else in the browser's time zone, and the departure field is
  read in the same zone. A time a day or more away carries its date
  ("Tue 13 Oct 21:58"), as a weekday alone is ambiguous on a long passage.
- **Points of sail** in the itinerary come from the route's polar at each
  leg's wind speed: in irons tighter than the polar's no-go angle (the
  tightest angle it gives any speed, with the tightest sailable angle
  setting applied), close hauled from there to its best upwind (VMG)
  angle, close reach to 75°, beam reach to 105°, broad reach to 15° short
  of its best downwind angle, then downwind.
- **LIVE and SIMULATE** (Route tab). LIVE follows the real boat along the
  route on the map; it is available when the route starts where the boat
  is. The itinerary card of the point the boat is heading to is
  highlighted with live figures, and each point passed keeps those at its
  closest approach. Off the route by more than the cross-track threshold
  for the sustain time, or at a waypoint, the page computes a re-plan
  from the boat's position through the remaining waypoints and offers it
  in a banner (Accept, Dismiss). SIMULATE sails a simulated boat along
  the route at a chosen speed-up, with **Start**, **Stop** and **Rewind to
  start**, and draws its track. In both the map keeps the boat centred
  while **Follow the boat** (Live vessel panel) is ticked; dragging the
  map unticks it, and ticking it or the centre-on-boat button follows
  again. Both run only while the page is open; the
  re-plan is not published and does not change Freeboard's active course.

  ![Planning: start, destination and waypoints on the map, with the click menu open](public/screenshots/02-planning.jpg)

- **Waypoint behaviour** (Route → Options): **Precision** Precise (each leg
  ends exactly at its waypoint) or Approximate (one search carries the
  route through the circle around each waypoint instead of stopping at
  it), and
  **Waypoint radius** 50–2000 m, default 200 (Approximate only). See
  [Waypoints](#waypoints-legs).
- **Signal K notes** (Layers → Base, on by default): notes from the
  Signal K Resources API that have a position (hazards, warnings and
  remarks, e.g. the area warnings signalk-passage-briefing adds) as
  markers in the map view. Click one for its title, text, link, who
  wrote it and when, and its bearing and distance from the boat, with
  **Edit** and **Delete** (a second press confirms); drag one to move it.
  **Add note here** in the map's click menu writes a new note at that
  point. Notes are saved to Signal K's Resources API, so Freeboard and
  other apps see them; writing needs a Signal K login with write access.
- **Areas to avoid.** A note can mark the area around it to avoid: tick
  **Avoid this area** in the note's form and give a radius. The note turns
  red with a dashed circle, and the router treats the circle as land: no
  candidate or leg may enter it, and a start, waypoint or destination
  inside one is refused with a message naming the note. The radius is
  stored in the note as `properties.avoid.radius_m` (metres), so a note
  another plugin wrote (a passage briefing's area warning) can be marked
  too, and other apps can read it. **Avoid marked areas** in the Plan tab
  (on by default; `avoid_areas` in a request) turns this off for a route;
  the job log lists the areas used. The land-avoiding corridor that guides
  the search does not know the areas, so a circle across a narrow passage
  can leave the search with no way through.
- **Layers** (Base / Weather / Water): each layer is named for the
  quantity it shows. Colour layers are exclusive (one at a time). Colour
  layers, wind barbs and current arrows are drawn tile by tile from
  `/api/tile` (web-map tiles at whole hours, saved on the server, see
  [Map tiles](#get-apitilelayerzxy)); each colour tile is cut at the
  coastline with its own 256 × 256 coastline tile. Their time is the
  overlay time rounded to the hour. Isobars and flow lines are drawn for
  the whole view, from the same saved tiles (see [Map
  layers](#map-layers)). The tide colour scale
  stretches to the largest tide in the tiles loaded (at least ±0.5 m).
  On the tide and current layers, water the source model has no value
  for (narrower than its ~9 km grid) is hatched and labelled "no model
  data".

  ![Current speed and direction in the Aegean, cut at the coastline, with "no model data" hatching in the Euboean Gulf](public/screenshots/03-layers.jpg)

- **Seas along the route** (Layers → Base, on by default): an arrow on
  each leg of the route, pointing the way the waves travel, coloured by
  the encounter index (the sea as the boat meets it, see
  [Comfort](#comfort-rough-water)). The leg cards and the Freeboard
  panel show a **Seas** row for the next leg: where the waves come from
  ("head seas", "on the starboard bow") and the encounter index's band
  and value ("rough (112)").
- **Current against the waves** (Layers → Water, off by default): what
  the current does to the sea, from `/api/tile/seas`, coloured by the
  sea state there (the sea-state heatmap's scale, each band in the colour
  of its legend swatch, shifted slightly darker and outlined so the
  glyphs stay visible over the heatmap). Three styles, chosen under the
  layer's checkbox and remembered in the browser (a trial, to settle on
  one):
  - **A arrows:** an arrow at every point along the way the waves
    travel: two heads meeting in the middle where the current runs
    against the waves (drawn larger the more it steepens them), a double
    chevron where it runs with them, a thin arrow where there is little
    current along them.
  - **B rips & breakers:** a mark only where the current against the
    waves steepens a choppy or rougher sea (index 75 or more): the short
    wavy lines charts use for tide rips when the waves are 10–25 %
    steeper, a breaking wave at 25–50 %, a breaking wave with spray from
    50 %. Nothing elsewhere, and no direction (the wave and current
    arrows carry that).
  - **C wind, waves, current:** three arrows from each point, each
    pointing where it is going: wind thin with a feather at the tail,
    waves wavy, current thick and solid. Where two point at each other
    the sea is rough, and the glyph shows which pair (wind against
    current, waves against current, or wind against waves). Arms within
    20° are spread apart; an arm is left out below 1 m/s of wind, 0.1 m
    of waves or 0.1 m/s of current.

  A and B choose their glyph from the waves against the current only;
  wind against current is in the sea state (the colour) but not in their
  glyph. C shows all three. The thresholds are named constants in
  `public/rp-layers.js`.
- **Wave direction (arrows)** (Layers → Water, off by default): an arrow
  per point along the way the waves travel, from the same
  `/api/tile/seas` points, coloured by the significant wave height on
  the wave-height heatmap's scale (shifted darker and outlined, as
  above) and longer the longer the mean wave period (12 px at 4 s and
  below to 34 px at 16 s and above), so long swell and short chop read
  apart.

- **Conditions popup** (shift-click, or the menu): 72-hour charts for
  Wind, Waves, Sea state (index / Beaufort / Douglas), **Tide & current**
  (tide height, total water level and surge on the left axis; current
  speed as a filled area on the right axis; the current's set as arrows;
  high and low water marked), Pressure, Temp, Precip, and a Raw table.
  Click the chart to move every map layer to that hour.

  ![Conditions popup, Tide & current tab: tide height, total water level and surge against current speed and set, with high and low waters](public/screenshots/04-conditions.jpg)

- **Polars**: the picker lists the default polar and the polars
  directory; "Create polar from boat specs…" generates one.

  ![Polar diagram of the selected polar, and the sailing strategy modes](public/screenshots/06-polars.jpg)

- **Decision lines** (the switch beside Find Route, and the same one in
  Layers → Base; off by default, remembered): the router's search drawn
  as it runs, one line per stage front (the candidates kept after pruning,
  blue → amber by stage; every point has its own arrival time, so they are
  not isochrones) and the best path so far, dashed. The fronts are always
  streamed and kept with the job; the switch only shows or hides them, so
  turning it on after a run shows the search that was made. The finished
  route's fronts stay, faintly, also for a past route opened from the log.
- **Defaults tab**: the web-app settings below (what every route starts from, shared by every client), in the selected units. Numbers are sliders with the value beside the label; max wind and max wave height have a "no limit" box.
- **While the server gets its forecast** (a first start, or after the
  forecast settings changed, when the forecast is decoded again): a notice
  under the header says what it is doing ("Loading the forecast: decoding
  the 06Z cycle, step 12 of 37"), with a progress bar and, once measured
  from the decode itself, the time left. The map layers wait quietly
  meanwhile (no error notes), a route started meanwhile waits for the
  forecast and its log shows the same progress, and when the forecast is
  ready every layer and the units load by themselves. The Freeboard panel
  shows the same in its status line.
- The page references its scripts with `?v=<tag>`, a tag that changes
  whenever a file in `public/` changes, so browsers and proxies in front
  of Signal K always load the current scripts after an update.

## In Freeboard-SK

The plugin is also a **plotter extension** (Signal K Plotter Extensions
API, version 1), so weather routing is available inside Freeboard-SK 3.0
or later without any change to Freeboard: Freeboard finds the extension
through the `plotterExtensions` resource collection the plugin provides,
and the panel runs in a sandboxed iframe served from
`/signalk-weather-router-plus/plotterext/`.

![The Weather Router Plus panel in Freeboard-SK, with a draft route on the chart](public/screenshots/07-freeboard.jpg)

- Tap the grid icon at the top right of the chart to show the extension
  toolbar, then **Weather route**. The panel slides in on the right.
- **Route on the chart** (the usual way): draw the route with Freeboard's
  own **Draw Route** tool (pencil menu), tapping the start, any
  waypoints and the destination on the chart, then Finish; or tick a
  saved route in the Routes list. The panel lists the routes shown on the
  chart (one is picked by itself). **Weather-route it** sends the first
  point as the start, the last as the destination and the points between
  as precise waypoints, and rewrites that route's geometry in place with
  the result, which stays Freeboard's editable draft (or an unsaved edit
  of a saved route). Drag a point and press the button again to re-route;
  **Restore drawn route** puts the drawn points back.
- **From the boat to a position** (the quick way): **From** is the
  vessel's position, kept up to date through Freeboard's own Signal K
  connection (editable; **Use the vessel position** snaps back); **To** is
  typed, **Use the map centre**, or one of your saved waypoints. **Find
  route** places the result on the chart as a new draft route.
- Both use the chosen polar (the same list as the web app), mode (Sail
  max, Fastest, Motor) and, under sail, the **min sail speed** (the boat
  speed under sail below which the router motors; the plugin's routing
  setting by default, in Freeboard's speed unit), and the **Limits**: a
  maximum wind speed and wave height that no leg may exceed (empty = no
  limit; the routing settings' values by default). Progress is shown;
  Cancel stops the job. The map
  is fitted to the result; the panel shows distance and time in
  Freeboard's unit preferences, the sailing/motoring split, the arrival
  time and an **itinerary**: one card per leg with its time, waypoint,
  mode and tack, then distance, time, SOG and COG, then the wind (with
  the point of sail from the route's polar), the current (fair or foul)
  and the waves. A tap on a card centres the chart on its waypoint. Each
  point's description also carries its leg, which Freeboard shows in the
  route's points sheet (the ⇅ icon beside Points); your own point names
  are kept.
- **A saved weather route shows its legs without routing again.** Ticking
  a saved route that carries the plugin's weather (one computed in the
  web app, or here and saved) in Freeboard's Routes list opens the panel
  on that route's legs (a hidden background page of the extension
  watches the routes shown; routes Freeboard shows again in its first
  seconds after starting do not open it).
- **Following the boat.** The card of the leg the boat is on is outlined
  and tagged "boat" and kept in view: the leg nearest the boat's position,
  within 10 nautical miles of the route, else the leg of Freeboard's
  active course when it is this route. Freeboard has no event for a tap
  on a route point, so the cards cannot follow a tap on the chart.
- **Units.** Speed, distance and depth are in **Freeboard's own units**
  (its Settings → Units; wave height follows depth), so nothing changes
  unit from one part of the Freeboard screen to another; angles, times
  and data sizes, which Freeboard has no setting for, follow your Signal
  K unit preferences, except that a duration of a day or more is written
  as days, hours and minutes ("9d 7h"), and clock times are in ship's
  time when the server publishes it, as in the web app; wave periods are
  in seconds. Freeboard's units can
  differ from your Signal K preferences, which the web app uses, until
  Freeboard adopts them (PR-8 in `docs/plans/freeboard-sk-integration.md`).
- **Save route…** opens Freeboard's Route Details dialog and stores the
  route in Signal K's Resources (the plugin does not publish it itself in
  this case, so there is one copy); for a saved route, **Save changes**
  updates it. **Discard** removes a new draft or restores a rewritten
  route.
- The panel keeps running while closed, so a long route finishes in the
  background. Routes started here are ordinary jobs: they appear in the
  web app's run log and in `GET /api/routes`.

**Map overlays.** The eight colour layers (wind speed, wave height,
current speed, sea state, precipitation, air and sea temperature, tide
height) are published as Signal K chart resources, served as PNG tiles
(`/api/tile/<layer>/{z}/{x}/{y}.png`, see [Map layers](#map-layers)) with
a `time` block covering the forecast hours. In Freeboard's **Chart list**
they appear as "Wind speed (Weather Router Plus)" and so on: tick one to
show it, set its opacity and order like any chart, and use the **clock**
action on its row for Freeboard's Time palette (scrub, step, loop, play
through the forecast; **NOW** returns to the current hour). A layer is
listed only while its data is there: currents need a current source,
tides the tide data, waves and the temperatures the forecast fields. The
colours are the web app's; Freeboard has no legend, so the scale is in
the web app's layer legend (`GET /api/legends`). The tide layer uses its
fixed ±3 m scale here. Five glyph layers come with them: **Wind barbs**,
**Current arrows**, **Isobars** (4 hPa, bold every 20 hPa; highs and
lows as blue and red dots; no pressure labels, as the server has no
font), **Current against the waves** (the web app's layer in style A)
and **Wave arrows** (coloured by wave height, longer for a
longer period); the last two need wave data. The layers are also organised as Freeboard **Groups** (resources
menu → Groups), one colour layer each with the glyphs that belong with
it, shown in one tap: *Wind* (speed, barbs), *Waves* (height, wave arrows),
*Currents* (speed, arrows), *Pressure* (isobars, barbs), *Sea state*
(index, current against the waves), *Tide* (height, arrows), *Rain* (precipitation,
isobars), *Air temperature* and *Sea temperature* (with isobars and
arrows). Two colour layers over each other are unreadable, so no group
has more than one. A group holds the layers whose data is there and is
rewritten when the forecast is reloaded; it needs the server's `groups`
collection, which Freeboard creates.

Not yet available in the panel: waypoints in the "from the boat" flow
(draw a route on the chart for those), a departure time other than now,
polar performance and the other web-app settings (they apply as set
in the web app's Defaults tab). A "weather route to here" entry in
Freeboard's map menu needs a change to Freeboard; see
[docs/plans/freeboard-sk-integration.md](docs/plans/freeboard-sk-integration.md).

## Routing engine

A port of the routePlanning `OceanPropagator` (subsector isochrone,
Hagiwara 1989 / Chen & Mao 2024), guided by a corridor from a global
water grid:

1. **Corridor.** A* on the [global water grid](#global-water-grid) finds
   a land-avoiding corridor from the start to the end of each leg (see
   [Waypoints](#waypoints-legs)), wherever the water path goes (Lisbon → Palma goes south through
   the Strait of Gibraltar, far outside the box around the endpoints).
   The route's land raster, the CMEMS SMOC area loaded for the route and
   the first-boot forecast crop cover the corridor's box plus 1°.
2. **Consistency with the route raster.** A flood fill on the route's
   (conservative) land raster, inside a band of grid cells along the
   corridor, must connect start and end. Where it stops, because the
   raster's resolution closes a passage the grid keeps open, the raster
   is refined locally (a finer patch, down to 0.0005°) and the fill
   repeated. A passage still closed at 0.0005° is not navigable for this
   router: its grid cells are blocked and A* runs again (up to 12 times).
   Narrow stretches of the corridor (a passage under 10 raster cells
   wide) are refined the same way so the isochrones have room, and
   stretches under 8 km wide are re-traced on the route raster (a fine
   A* kept to mid-channel), because the grid's 2 km cells cannot place
   the skeleton inside a 700 m strait.
3. **Isochrones.** From each retained parent, 2m+1 candidate headings
   are projected one stage step ahead, aimed at the corridor point one
   step ahead; candidates whose great-circle leg touches land are
   dropped; survivors are timed by a leg simulator that samples wind and
   the polar every `simStepM` metres (mode policy `sail_max`, `fastest`
   or `motor`). Candidates are binned by cross-track offset into 2k
   subsectors and the cheapest per bin is kept.
4. **Narrow passages.** The corridor carries the across-track water
   width at every point. A parent's step never jumps past a point where
   the passage is narrower than a quarter of the step: it may step up to
   that point, and inside the passage it steps at most 4 × the local
   width (not below 1 km); the stage budget grows by the stages this
   costs. Inside a stretch narrower than one subsector bin, candidates
   are binned across the passage (6 bins over its width) instead of by
   the start → end offset, so several branches get through a strait
   (in the test runs Madeira → Cartagena kept 8–12 branches through
   Gibraltar, where it used to get down to 1).
5. **Automatic vias.** Where the corridor crosses a narrow passage the
   grid build recorded (below) that is narrower than one stage step, a
   soft via (a pass-through disc of radius half the width + 500 m, at
   least 1 km) is placed at its narrowest point, so every branch is
   pulled through the passage instead of drifting against the coast
   beside it. Progress messages name them ("auto via at Strait of
   Gibraltar, width 14.2 km"); the GeoJSON lists them in the
   `auto_vias` property and the job summary in `auto_vias`. They are not
   route waypoints and never carry `role: "via"`.
6. **Finish.** The search stops when a branch that crossed every
   automatic via is within one (local) stage step of the leg's end with a
   land-free straight final leg (or, for an approximate waypoint, as soon
   as a branch is inside the waypoint's circle); the terminal is chosen
   among those with a clear final leg. If the planned stages run out
   first, up to K/2 more run.

### Chart mesh (charted depths and obstructions)

With a navigation mesh configured (`meshDir`), a leg inside it is routed
on the charts rather than the coastline: a constrained triangulation of
the chart area (`src/engine/mesh/`) whose triangles carry the charted
depth, vertical clearance, rocks, wrecks and obstructions, marks,
structures and fairways. A triangle is blocked when its charted depth is
under the draught + 0.5 m (outside a fairway, dredged area or recommended
track), its clearance under the air draft + 1 m, a rock or wreck has less
than draught + 0.5 m over it (or no charted depth), it holds a mark (a
channel mark inside a fairway or dredged area excepted) or a structure,
or it lies in an area marked to avoid on a Signal K note. The draught and
air draft are the vessel's Signal K base data (`design.draft.maximum`,
`design.airHeight`; a request can override them with `vessel.draught_m`
and `vessel.air_draft_m`); the mesh is not used until both are set.

- **Motor:** the whole leg is an A* over the mesh's triangle edges with a
  shore and shallow-water penalty, pulled tight by the funnel algorithm.
- **Sailing modes:** the mesh route is the skeleton. Its narrow passages
  (both shores within 1 km of the track) are motored along it; each open
  stretch between them is sailed by the open-water router from the end of
  one passage to the start of the next, with that stretch of the mesh
  route and its passage widths as the search's corridor (water wider than
  the 4 km scan on both sides counts as open). The whole leg is planned in
  the process that holds the mesh: the search, the tack layout, the polish
  and the smoother test every move by walking the mesh triangles it
  crosses and stopping at the first one the boat cannot use (charted depth
  under the draught + 0.5 m off a fairway, clearance under the air draft +
  1 m, a rock or wreck shallower than that or uncharted, a mark, a
  structure, an area to avoid), the same test the mesh route is built
  with. That process reads the forecast window, the regional wind runs,
  the cached currents (RTOFS, CMEMS SMOC, harmonics) and the polar from
  the plugin's files; it never uses the network. With a buffer from
  unusable water (Defaults) every usable triangle within that distance of
  a blocked one is blocked for the leg, by exact distance from the
  boundary, before anything is routed: the mesh route, the passage widths
  and the sailed stretches all keep it, and a passage narrower than twice
  the buffer closes (the mesh then finds no route, or widens its box).
- **Depth:** each waypoint of a mesh leg carries the charted depth of the
  triangle under it (`depth_m` in the GeoJSON, Depth in the itinerary); a
  waypoint on a depth contour reports the usable side.
- **Opening bridges:** the mesh marks bascule, swing, lift, draw and
  transporter bridges (flag bit 7) and stores their open clearance, or
  none when the chart gives none. The clearance rule (air draft + 1 m)
  applies to that open clearance. The Drawbridges setting (Defaults tab;
  a request's `drawbridges` overrides it) is ask, open or avoid: ask plans the route as if
  they open and, when the finished route passes under one, lists the
  bridges in the summary and the log and the web app offers a re-plan
  avoiding them; avoid blocks every opening bridge; the wait setting adds
  time at each one passed. A mesh built before 2026-10-08 has no bit 7
  and its bridges block at their charted (closed) height, as before. With a sail threshold of 0 (never
  motor) the narrow passages are sailed along the mesh route too, tacked
  where the wind needs it (the tacks are checked against the coastline,
  not against the charted depths the mesh route keeps to). An open stretch
  whose search fails is followed along the mesh route under the request's
  own mode: sailed under sail_max (tacks where needed, motor only below a
  positive threshold), walked under fastest; when it cannot be sailed the
  route fails naming the segment rather than motoring it.
- **One end outside the mesh:** the leg runs on the mesh as far as the
  first point after the last narrow passage that is open water with no
  land within 5 km (and stays so at the next point), within 50 km of the
  covered end, and the coastline search takes it from there (the corridor
  cut at that point). A start off an open coast is therefore routed on
  the mesh until it is 5 km out; a leg whose covered end is already open
  water 5 km from any land has no mesh part. A leg still near land
  after 50 km hands over there (the mesh part's memory limit), and the log
  says so.
- Anything the mesh cannot take (a start in a blocked triangle, no route)
  is logged as a WARNING and the leg runs on the coastline search as
  before. The mesh search runs in a child process that exits with the
  leg, so its tile arrays never stay in Signal K's memory.

The mesh files are built outside the plugin by the s57Work chart build
(binary tiles plus an `index.json`; the format is documented in
`src/engine/mesh/store.ts`). The plugin panel lists the published meshes
from a catalogue and downloads the ticked ones (`mesh.catalogUrl`,
`mesh.downloads`); the catalogue is read at start and once a day, or at
once with the panel's "Read the catalogue now" button
(`POST /api/meshes/refresh`). A leg is covered when one downloaded mesh (or the
`meshDir` folder) holds its points, and that mesh is used.
The job log says what the mesh did ("chart mesh: …") and the summary's
`mesh` is true when any leg used it.

### Open-water router: Standard or Refined

The open-water search is selectable: the request's `router`, else the
`routing.router` setting, else `standard` (the search above). The
**refined** router (`src/engine/experimental/`) is the same search with
three changes, kept behind this toggle so the same request can be run
both ways and compared (the Route tab's *Router*: Standard / Refined):

1. **Convex polar.** The search runs on the convex hull of the polar
   (per wind speed), so a leg into the wind is a straight line at the
   beat's exact VMG and the search needs no beat handling.
2. **Legs laid out forward in time.** Afterwards every sailed leg is
   walked in steps of at most 9,260 m: at each step the wind there and
   then decides whether the course to the leg's end is a time-share of
   two polar headings (a tack is placed: alternating sides, 30 s each,
   the last landing on the leg's end) or a heading the polar sails
   directly (one straight step), so a wind that veers along a long leg
   is met where it veers. A tack that would cross land or that the real
   polar cannot sail is tried on the other side, then shorter; a leg that
   still cannot be sailed fails the route with a message naming it, never
   an invented time. Tack points carry `tack: true` in the GeoJSON.
3. **Cross-track polish.** Each interior waypoint is tried a little to
   either side of its track (2 km down to 250 m, capped at a third of the
   shorter adjacent leg) and moved when the route, re-timed from there
   with the real polar, arrives earlier and the legs stay clear of land;
   up to five passes.

Measured on a Raspberry Pi 5 against the isochrone router (same forecast
run, fixed departures): a harbour beat 17,234 s vs 18,659 s, an offshore
reach 36,235 s vs 36,469 s, a 1,240 km passage 382,041 s vs 383,615 s.
The same passage run with a much wider isochrone beam (`routing.stages`
40, `routing.subsectors` 150, `routing.headings` 120 at 0.5°) arrived
377,985 s, 94 minutes earlier than the standard beam, at 21 × the wall
time: the standard pruning is the larger loss on long passages. That
beam and a middle one are the **Method** choice on the Route tab
(request `search`: `normal`, `moderate`, `maximum`; `src/engine/search/presets.ts`),
beside the **Router** choice.

### Comfort (rough water)

The sea-state index describes the water at a point (wind against
current, swell steepened by an opposing current); it knows nothing of
the boat. It is the sum of a wind term (50 in any breeze without a
current, more where wind and current oppose) and a wave term,
`10 × swh² × 5/max(period, 5) × steepening` (`SWELL_COEFF`,
`src/plugin/conditions.ts`), on the bands smooth < 35 ≤ good < 50 ≤
slight < 75 ≤ choppy < 100 ≤ rough < 150 ≤ extreme: a 2 m wind sea is
choppy, 3.5 m rough, 5 m and more extreme, and long swell reads milder
than a wind sea of the same height. Heading into the waves is harder than running before them, so
the router weights the index by the angle between the course and the
direction the waves come from: × 1.3 in head seas, × 1.05 abeam, × 0.8
in following seas, a cosine between (the **encounter index**,
`src/engine/seas.ts`). The weights are a judgement, not derived from
physics, and are kept in one place so they can be tuned.

With a comfort weight above 0 (setting `routing.comfortWeight`, default
1; request field `comfort_weight`), each second the leg simulator sails
in water above an encounter index of 75 (the top of the "slight" band:
with no current the index's wind term alone is 50, which head seas
weight to 65) counts extra in the search's choices: weight × (index −
75) / 100 extra seconds per second, at most 2 × weight. With weight 1,
choppy water at 100 adds 25 %, rough at 125 adds 50 %, extreme at 200
adds 125 %. The cost is used for pruning, the choice of the terminal,
and (when it runs) the smoother; the route's times, ETAs and summary
stay the real times. It needs wave data in the forecast; without it the
cost is 0. Each waypoint carries the sea on the leg into it
(`sea_index`, `seas_angle_deg`, `seas_side`, `seas_sector`,
`encounter_index`).

### Waypoints (legs)

A waypoint is an end point and a start point by another name: it ends
one leg and starts the next (port of the routePlanning
`compute_multi_leg_route`). Each leg is routed as its own route, with its
own corridor, land raster, isochrone search (K stages per leg) and
retries, departing at the previous leg's arrival time so wind, current
and waves move on with the boat. The legs are then stitched: the
duplicate junction point is dropped, distances and sailing/motoring
times are summed, and the junction point of each waypoint carries
`role: "via"` in the GeoJSON (automatic vias stay in `auto_vias` and are
never `role: "via"`). Progress messages are prefixed `leg 2/4: …`.

![A route with waypoints off Rhode Island: an approximate waypoint circle, legs coloured by tack, and the itinerary cards](public/screenshots/05-waypoints.jpg)


`precision` decides where an intermediate leg ends:

- **`precise`** (default): exactly on the waypoint (a straight final leg
  from the last stage to the point, checked against land and simulated
  like the final leg to the destination).
- **`approximate`**: the route only has to pass through the waypoint's
  circle (`arrival_radius_m`, default 200 m, or the waypoint's own
  `radius_m`). As in the reference (`hybrid.py`, collapsed ocean runs),
  consecutive legs joined by approximate waypoints are routed as **one
  search** from the run's start to its end, with each waypoint circle as
  a via the winning branch must pass through in order. The track carries
  on through the waypoint instead of ending there and restarting, and the
  point where it passes the circle carries `role: "via"`. Progress
  messages for such a run read `legs 1–3/3: … through 2 waypoint
  circle(s) … in one search`.

The final destination is always exact. Routes without waypoints are one
leg, unchanged. Where this differs from the reference:
- after a precise waypoint the next leg starts where the previous one
  ended (the reference restarts from the canonical waypoint and trims the
  stitch), so the track is continuous;
- a branch whose next waypoint circle is closer than one stage step also
  gets a candidate that steps straight into the circle. Without it a
  branch reaches a small circle only if a full stage step (tens of km)
  happens to cross it, which failed where the course turns at a waypoint
  (the Baja route in `docs/plans/waypoints-multi-leg.md`);
- if a one-search run still finds no branch through every circle, that
  run's legs are routed one by one (each ends on entering its circle and
  the next starts there) and the log says so, instead of the route
  failing.

The forecast area and the CMEMS SMOC area are read per leg (the leg's
corridor box plus the margin) and released after the leg; everything is
released when the route ends. On brain (Pi 5) one area for all legs took
the same time (Baja, 4 legs: 11.9 / 12.0 s against 11.5 / 11.8 s per leg)
and held more forecast (3.0 MB against at most 2.0 MB per leg) and SMOC
(2.5 MB against at most 0.9 MB).

One deliberate difference from the reference: the stage budget is sized
to the corridor length, not the straight-line distance, so detours around
land fit within the configured number of stages.

If a route arrives after the last forecast step, conditions are held at
the last step. The GeoJSON carries `forecast_valid_to`,
`forecast_horizon_exceeded_s` and `legs_beyond_forecast`, every point
after the last step has `beyond_forecast: true`, and the web app shows
it: an amber badge in the result strip with the end time, the legs after
it drawn dashed with a "forecast ends" marker on the map, a chip on the
itinerary cards, and a note in the saved route's description. The
Freeboard panel shows the same note. The **Forecast horizon** setting
(Defaults tab, Forecast group, 3 h to 360 h) decides how far the forecast
reaches.

**Regional wind (optional).** With the signalk-grib-downloader plugin
installed (AROME, ARPEGE, ICON-EU, GFS), the plugin decodes the 10 m
wind of each complete run whose grid is finer than ECMWF's and layers it
over ECMWF: the regional model where it covers the point and the time,
blended over five grid cells at its border and over its last 3 hours,
ECMWF elsewhere; waves stay ECMWF. A source no finer than ECMWF (GFS at
0.25°, ECMWF's own spacing) is not decoded or used; the header lists it
as "not used: not finer than the global forecast". A regional grid on
either side of 180° works for routes across it.
The job log and the summary's `regional_wind` say which model answered
how much. `wind_model: "ecmwf"` (or unticking "Regional wind where
available" in the Plan tab) routes on ECMWF alone. Install only the
downloader; its companion signalk-grib-weather-provider is not needed.

Where the corridor is open water, each candidate aims the centre of its
heading sweep one step along the skeleton's direction from where it is,
so branches can spread across the ocean to find a detour; in narrow
water it aims at the skeleton itself, which keeps the search in the
channel.

When the search stops, the final leg of every branch with a clear
straight hop to the waypoint (the nearest 64) is simulated, straight or
as a beat, and the branch with the earliest predicted arrival is taken,
not the nearest one: branches advance a fixed distance per stage, so a
slow branch crawling straight at the waypoint is nearest while faster
branches that tacked are further out but ahead in time.

Every stop (start, waypoints, destination) is tested against the exact
coastline polygons before routing. One on land, or within 150 m of the
shore, is moved to the nearest point with 150 m of water around it, within
1,000 m, and reported: in the log (which point, how far), on
the route (`snaps`, `stop_count`, the `start_`/`end_` original, anchor and
snap-distance fields) and on the moved point (`snap_distance_m`,
`original`); the web app draws the tie from the drawn point to the water
and the itinerary says "moved N m". With no water within 1,000 m the
route fails naming the point.

Polar rows closer to the wind than the **Tightest sailable angle**
setting (Defaults tab, Routing group, default 30°, 0 = off) are ignored
for routing: many library polars carry small boat speeds at 5°–25° off
the wind, which would send a route dead upwind at a crawl instead of
tacking. The polar files themselves are not changed.

When a parent's primary heading sweep yields nothing (its headings in
the polar's no-go angle, on land or over a limit), that parent alone gets
the wider sweeps (±120°, then half step, then the full circle at a quarter
step) while its siblings keep their primary candidates; the reference
implementation widened only when the whole stage's sweep was empty, which
left a front beating to windward tacking in place.

The candidate nearest each goal always survives a stage's subsector
pruning (the bin cost prices the remaining distance at motor speed, which
is optimistic to windward and could drop the leading branch), so the best
remaining distance never increases from one stage to the next.

A search that stops making progress once its planned stages are used
(three stages in a row without any candidate coming closer to the
destination; when the front is beating, a tenth or more of its water
candidates dead upwind, the check waits for the hard ceiling of planned
stages plus half the configured count; progress is measured towards the
deepest branch's next via, or the destination once every via is crossed)
fails with "the search is boxed in" (or, with a via still uncrossed, the
vias-not-crossed error that makes the router retry without automatic
vias), counting how many of
the last stage's candidates were over the wind/wave limit, crossed land
or had no boat speed, and naming the forecast end when the search had
run past it. Each stage's progress line also carries those counts.

### Global water grid

`data/water-grid-0.02.bin.gz` (shipped, about 1.99 MB) is a navigability graph
of the whole world at 0.02° (18000 × 9000 cells), built from GSHHG full
resolution levels 1–4 (`GSHHS_f_L1.shp` through `GSHHS_f_L4.shp`):

- **Water and edges.** The coastline is rasterised at 0.005° (4 × 4 fine
  cells per grid cell) in 10° tiles with a 1.2° halo, so edges on tile
  borders and across the antimeridian see the neighbouring tile. A fine
  cell is water when the deepest containing GSHHG level is even (or no polygon contains it). Per grid cell
  the file stores a water bit and two edge bits (east, north). An edge is
  open when a 4-connected path of fine water cells inside the two cells
  crosses it, i.e. when some fine row (or column) has water on both
  sides. A plain "any water in the cell" rule closed the Bosphorus (a
  one-cell thread crossing cells corner to corner); the edge rule keeps
  it open. Diagonal fine contacts do not count: on the conservative
  raster the Bosphorus is closed even with diagonal connectivity, while
  centre sampling with 4-connectivity keeps it open and keeps every
  isthmus in the checks below closed.
- **Split cells.** Where a cell's fine water forms two components that
  both touch its border (the two shores of a spit or isthmus thinner
  than a cell), the grid stores the component of each border fine cell
  and which fine rows cross to each neighbour (57 759 cells worldwide),
  and the search follows components through them. Without this the grid
  leaked across such strips.
- **Moves.** A* moves to the four neighbours through open edges, and
  diagonally only where both L-shaped paths through the two side cells
  are open (never through a split cell), so a diagonal never cuts a land
  corner. Cost is distance times a coast penalty (up to 1.4× next to
  land, fading out 4 cells off), with a heuristic weight of 1.1 (corridor
  cost at most 10 % above optimal; measured +0.3 %). The search window
  grows from the legs' box until the path is found (at most 12 M cells,
  about 84 MB while it runs) and wraps round the antimeridian.
- **Narrow passages.** Per grid cell the build takes the largest
  distance to land of its fine water cells (the clearance) and runs a
  merge tree in local windows (2° cores, 1° margin): cells are added
  from the widest water down, and a cell that joins two basins whose
  widest water is at least 1.5× its own clearance (and 500 m wider, and
  basins at least 2 km wide) is a passage's narrowest point. Windows are
  local on purpose: Messina joins the Tyrrhenian and the Ionian, which
  also connect round Sicily. 4987 passages up to 40 km wide are stored
  with position, width and channel axis; names come from a table of
  well-known straits.
- **Canals.** Known ship canals (Corinth, Cape Cod, Chesapeake and
  Delaware, Kiel, Suez, Panama) are stored as the edges their cut lines
  cross, closed unless **Allow canals** is on. With GSHHG none of them is
  open water at 0.005° (Cape Cod and Corinth only look open when a test
  box lets the water go round the cape or the Peloponnese); three edges
  near the Panama Canal's approaches are recorded, but the canal is
  closed anyway. The setting matters with coastline data that includes
  canals (e.g. OSM land polygons).
- **Memory and loading.** The route worker loads it once (about 20 ms
  to decompress, into one buffer): 62.9 MB of arrays (three 20.25 MB bit
  planes, 1.3 MB of split cells, the passage list) plus 2.3 MB of lookup
  maps; measured process RSS +73 MB. The data worker does not load it.
- **Rebuilding.** The file records the shapefiles it was built from
  (name, size, modification time and a SHA-256 of the size and the first
  and last MiB). When the configured `landShapefiles` differ (another
  GSHHG resolution, L6 Antarctica added, OSM land polygons), the route
  worker keeps routing with the shipped grid and rebuilds a matching one
  in a background thread into the plugin data directory, then switches
  to it. A rebuild needs about 400 MB while it runs (checked against
  "memory kept free" first) and took 74–79 s for GSHHG full L1 and 47 s for
  GSHHG high on an Apple M3; not measured on a Raspberry Pi 5 (expect
  several minutes). To rebuild the shipped file:
  `npm run build:water-grid -- --land /path/GSHHS_f_L1.shp`;
  `npm run check:water-grid` runs the connectivity checks.

## Install

### Requirements

- Signal K server 2.24.0 or later (the configuration panel uses the
  React 19 Admin UI that came with 2.24.0); tested on 2.33.0. Read-only users can use
  the web app on servers that support per-route access (see
  [API](#api)); on older servers every route is admin-only.
- Node.js 20.10 or later (the server's own Node).
- Internet access for the forecast, current, tide and coastline
  downloads.
- Disk in the Signal K data directory: the decoded forecast (about
  1.35 GB for 72 h with the extra fields, 4.6 GB at 360 h), the GRIB files
  of the cached cycles, the coastline (about 156 MB when downloaded),
  current and tide caches, and the saved map tiles (up to the configured
  cap, 20 GB by default).
- Memory: tested on a Raspberry Pi 5 with 8 GB. The resource guard keeps
  the configured amount free (default 1 GB) and refuses a forecast or a
  route that would not fit.

### From the Signal K App Store

Admin UI → **Appstore** → **Available**, search for **Weather Router
Plus**, **Install**, then restart the server. Enable the plugin in
**Server → Plugin Config**; the web app appears on the **Webapps** page.

### From source (development)

```sh
git clone https://github.com/motamman/signalk-weather-router-plus.git
cd signalk-weather-router-plus
npm install
npm run build
```

Then add it to the server as a local package: in `~/.signalk/package.json`
add `"signalk-weather-router-plus": "file:/path/to/signalk-weather-router-plus"`
to `dependencies`, run `npm install` in `~/.signalk`, and restart the
server. Avoid `npm link` and `npm install <tarball>` in `~/.signalk`:
both can remove other plugins that are not listed in its `package.json`.
After a code change, `npm run build` and restart.

### First start

**Coastline:** with no coastline
shapefile configured, the plugin downloads GSHHG 2.3.7 (Wessel & Smith,
LGPL) once from the authors' site,
`https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip`
(149 MB; if that fails, the identical copy at
`https://router.zeddisplay.com/downloads/gshhg-shp-2.3.7.zip`; the
archive's SHA-256 is checked either way), extracts the full-resolution levels 1–4
(`GSHHS_f_L1.shp` through `GSHHS_f_L4.shp`, with their `.shx` and `.prj`) into
`coastline/gshhg-2.3.7/` in the plugin data directory, deletes the
archive and starts; the plugin status shows the progress. The global
water grid shipped with the plugin was built from this same hierarchy, so it
is used as is. The download does not hold up the server's start-up; if
it fails (offline, server error, short file) the plugin status says why
and it is tried again every 10 minutes (or at once with **Download
coastline** in the plugin's configuration panel); stopping the plugin
cancels it.
To use another coastline, or an existing GSHHG copy, set its path in the
plugin configuration. A standard GSHHS layer path automatically includes all four
sibling layers at the same resolution; missing siblings are an error. An older
automatic L1-only installation downloads the complete hierarchy on upgrade.
A configured coastline is never replaced by the
download: if a configured file is missing or unreadable, the plugin does
not start and its status names the file.

The package carries the `signalk-webapp` keyword and a
`public/` folder, so after the restart the webapp appears on the Admin UI's
Webapps page. Writes (computing, cancelling, publishing) need a `readwrite`
login; the page redirects to the server login when it gets a 401. A polar file (`.csv` or `.pol`, knots) enables sailing;
without one every route is motor-only.

## Configuration

Settings are split in two.

**Signal K plugin configuration** (Admin UI → Server → Plugin Config):
installation settings only. The plugin ships its own configuration panel
(keyword `signalk-plugin-configurator`, `public/remoteEntry.js`), which
the Admin UI shows in place of the generated form: the coastline with a
**Download coastline** button and its progress (and **Use the downloaded
coastline** when a path is set), the map overlay cache with the radius
and window in the Signal K user's distance and time units (stored in m
and s; a unit that cannot be read shows "—" and cannot be edited there),
and the other options below. **Save** stores the configuration and
restarts the plugin. The panel is a hand-written Module Federation
container that uses the Admin UI's own React, so the package carries no
React and needs no build step for it.

| Field | Notes |
|---|---|
| `landShapefiles` | comma-separated absolute paths; blank = download GSHHG 2.3.7 full-resolution levels 1–4 once (see [Install](#install)) |
| `mesh.catalogUrl` | the `index.json` listing the published meshes (the s57Work build's `charts/mesh/index.json`); blank = the US-ENC catalogue on R2 |
| `mesh.downloads` | names from the catalogue (`01CGD`, `07CGD`, …) ticked in the plugin panel; each is mirrored into `<data dir>/mesh/<name>/` and kept current (the catalogue is read at start, daily, and on the panel's "Read the catalogue now" button; a newer `build_date` is downloaded again and swapped in); an unticked mesh is deleted. `/api/meshes` and `/api/status` `meshes` list every mesh with its state |
| `mesh.disabled` | downloaded meshes switched off for routing (kept on disk); the panel's *Use* tick |
| `meshDir` | a mesh folder you manage yourself — one mesh (`index.json` and its tiles, or `meshes.json` with cluster sub-folders) or a folder of such mesh folders — used beside the downloaded ones and listed in the panel as *local* with its own *Use* tick; blank = none. See [Chart mesh](#chart-mesh-charted-depths-and-obstructions) |
| `polarFile` | `.csv` (`twa/tws,4,6,…`) or `.pol` (tab-delimited); the default polar (token `default`). Blank = the bundled Catalina 36 |
| `polarsDir` | directory of `.pol`/`.csv` polars listed by `/api/polars`. Blank = the library bundled with the plugin (`data/polars/`: the ~700 polars of the OpenCPN [weather_routing_pi](https://github.com/seandepagnier/weather_routing_pi) library, GPL-3.0), with user polars (generated ones included) kept in `polars/user/` in the plugin data directory, so an update never removes them. Set, user polars are in `<polarsDir>/user/` |
| `currents.harmonicDir` | directory of tidal-harmonic `.npz` files |
| `forecast.mirror` | `ecmwf`, `aws` or `google` |
| `weatherProvider.enabled` | register with the Weather API (default on) |
| `overlayCache.enabled` | build map tiles ahead of time (default on) |
| `overlayCache.radius` | m, around the boat and the map view at zoom 8 and below; halved at each deeper zoom (default 250000, 1000–2000000) |
| `overlayCache.window` | s, how far ahead tiles are built from now; 0 = the whole forecast (default 0, max 1296000) |
| `overlayCache.maxZoom` | deepest zoom built ahead (default 15, 6–18) |
| `overlayCache.diskCap` | bytes for saved tiles, least recently used removed first (default 20e9 = 20 GB, min 100e6) |
| `overlayCache.workers` | processes building tiles ahead (default 2, 1–8); they start when there are tiles to build and exit when the walk is complete |
| `overlayCache.followView` | also build around the area the map shows (default on) |

Stored in SI (metres, seconds, bytes); the configuration panel shows
the radius and window in the user's units and the disk cap in GB.
Tiles the page asks for are saved, whether or not tiles are built
ahead, except those computed while an on-demand current or tide area is
still loading: those are answered but not saved. What is built ahead of time: the colour layers the page
draws (wind, waves, sea state, current, rain, air temperature, sea
temperature, tide height), wind barbs, current arrows and coastline
tiles, for every hour from now to the end of the window (tide height:
to the end of the tide run), at zooms 6 to `maxZoom`. Order: the map
view's area, then the boat's; within each, nearest hour first, then
shallower zoom, then nearest the centre. Tiles already saved are
skipped. A new forecast cycle, currents run or tide run removes the
tiles made from the old one and the walk starts again; so do a new
hour, a boat move of more than 1 km, a new view and a settings change.
No new tile is started while a route runs or the map's own queries are
waiting. The builders are separate processes, not threads: they are
started when the walk has a tile to build and exit when it is complete,
so the memory they used goes back to the system (a thread's memory stays
with Signal K until it restarts). While they run, each holds its own copy
of the current, tide and RTOFS data. Folders of tiles made obsolete by a
new forecast, currents run or tide run are normally deleted by a
short-lived child process; if that process cannot run, the deletion
falls back to Signal K's own process. The boat's last position is kept in `last-position.json` in
the plugin data directory, so the boat's area is known after a restart
before a fix arrives.

**Web-app settings** (the webapp's **Settings** tab, or `GET`/`PUT
/api/settings`): stored on the server in `settings.json` in the plugin
data directory and shared by every client. Values are SI on the wire
(m, m/s, s; degrees for the heading increment); the page shows them in
the Signal K user's unit preferences. Saving needs a `readwrite` login.

| Group | Settings (default) | A change… |
|---|---|---|
| `vessel` | speed under power (6 kt = 3.087 m/s), polar performance (1 = 100%, 0.3–1.2) | applies to the next route |
| `forecast` | horizon (72 h = 259200 s, 3–360 h; above 144 h only 00z/12z cycles qualify), check interval (60 min), cached cycles kept (2), extra fields (on), memory kept free (1 GB = 1e9 B) | horizon / extra fields / memory kept free reload the forecast; the interval restarts the timer |
| `currents` | SMOC on, SMOC horizon (72 h = 259200 s, 6–240 h), SMOC step (3 h = 10800 s; 1 h or 3 h only), SMOC area half-width (15°, 2–30°), RTOFS on, RTOFS product (`west_atl`, …), RTOFS horizon (72 h), RTOFS step (3 h) | reloads currents |
| `tides` | Copernicus Marine sea level on, tide map area half-width (15°, 1–30°), tide map horizon (24 h = 86400 s, 6–240 h) | reloads tides only |
| `routing` | stages (20), subsectors (30), headings (30), heading increment (1°), sail threshold (4.9 kt), tacking penalty (30 s, charged per tack or gybe by both routers), buffer from land (0 m: the route keeps at least this far from the coastline; a start or end closer is moved out to it, a passage narrower than twice it closes), buffer from unusable water (0 m: on a mesh leg the route keeps at least this far from every triangle the boat cannot use), drawbridges (ask: plan as open and report the ones crossed; open; avoid), wait at a drawbridge (0 s), simulation step (200 m), land raster cell budget (25 M), allow canals (off), route simplification (10 m, 0 = off), shortcut smoother (off), comfort weight (1, 0 = off), shortcut may be slower by (0.05 = 5%), finished routes kept (50), max wind (none), max wave height (none) | applies to the next route |
| `publish` | save to the Resources API (on), route name prefix (`WRP`), notifications (on) | applies to the next route |

**Resource guard.** The decoded forecast is on disk, so the guard
checks what actually needs memory. Before a forecast update: the
streaming decoder's one-step block and buffers (66 MB with the extra
fields) against the memory available now (Linux `MemAvailable`, bounded
by a cgroup (container) limit, or reclaimable pages from `vm_stat` on
macOS), leaving "memory kept free"; and the decoded run's exact size
(fields × steps × 4.15 MB) against the free disk space, leaving 1 GB.
Before a route: its corridor store (area × 5 fields × steps × 4 B)
against available memory. If something does not fit, it does not run;
the Signal K plugin status and the page's status line say how much is
needed and available and what would fit (extra fields off, a shorter
horizon, a lower setting, free disk space), and the run in use keeps
serving. A settings change that would not fit is rejected before it is
saved. The global water grid
(about 65 MB in the route worker) is loaded at start-up, so it is already
counted as used; a water grid rebuild is checked the same way before it
starts.

`PUT` takes only the keys to change, e.g. `{"vessel": {"motorSpeed": 3}}`,
validates all of them (same ranges and enums as before), and either saves
all or returns `400 {errors: {"vessel.motorSpeed": "…"}}` and saves nothing.
Per-route values in a route request (`vessel.*`, `stages`,
`sail_thresh_ms`, `publish`) still take precedence over the settings.

Upgrading from a version that kept these in the plugin configuration: on
the first start without `settings.json`, the old values are migrated
(knots converted to m/s, hours and minutes to seconds) and written to
`settings.json`; after that the old keys are ignored. The Signal K
configuration file is not modified. `forecast.region` and
`forecast.regionFromVesselDeg` are gone: the forecast is global.

## API

This section describes every HTTP endpoint of the plugin and what it
publishes into Signal K. It is written from `src/plugin/api.ts` and the
modules it calls. Another app (a dashboard, a chart plotter) can compute
routes, read overlays and read conditions with it alone.

### Overview

**Base path.** Every endpoint below is relative to
`/plugins/signalk-weather-router-plus` on the Signal K server, e.g.
`http://localhost:3000/plugins/signalk-weather-router-plus/api/status`.
The links the plugin returns (`links`, `Location`) are absolute paths
that start with this base path.

**Units.** All values are in Signal K SI units: metres, m/s, Pa, K,
seconds, degrees true. Dimensionless quantities are plain ratios or
indices: relative humidity is 0..1 (`rh`), Beaufort and Douglas are
integers (Douglas with a label, `douglas_label`), and the sea-state
index is a number to one decimal place with a label (`sea_state`).
Precipitation is a depth rate in m/s (`precip_rate_ms`); ECMWF's
kg m⁻² s⁻¹ is converted once, when the field enters the forecast store,
so every endpoint agrees. Nothing is sent in percent, knots or mm/h; the
client converts. Two exceptions, both named in the field: angles in the
plugin's own API are degrees (`*_deg`), while the Signal K Weather API
answers in radians as that API requires ([Weather API
provider](#weather-api-provider)); and the isobar interval of
`/api/pressure` is given and returned in hPa (`hpa`) beside Pa (`pa`).
Directions are named by their convention: wind and waves are the
direction they come FROM (`dir_from`, `wind_dir_deg`, `mwd_deg`),
currents the direction they flow TO (`dir_to`, `current_dir_deg`, the
`dir_deg` of `/api/currents`). Times are ISO 8601 strings in UTC.

**Access.** Authentication is done by the Signal K server (its session
cookie or a bearer token), not by the plugin. On Signal K 2.31 and
later (servers with `router.access()`), read endpoints are open to
`readonly` users and write endpoints to `readwrite` users; the Access
column of each table says which. Older servers keep every plugin route
admin-only, which is the server's default. When a request lacks the
access it needs, the server answers (401 not signed in, 403 not enough
access) before the plugin sees it. A route registered without an access
level stays admin-only on those servers (upstream `asPluginRouter`), so
every plugin route, `/ui` included, is registered with one.

**Errors.** Errors the plugin produces are JSON with a message:

```json
{"error": "bbox must be w,s,e,n"}
```

Some add fields: `GET /api/routes/{id}/result` adds `status` and
`message`, and `PUT /api/settings` adds `errors` (one message per
setting). A parameter or data problem is `400`; the per-endpoint tables
list the other codes. Overlay and conditions requests go to the plugin's
data worker; its failures (for example `no forecast loaded`,
`data worker not ready`, or `query timed out` after 120 s) also come
back as `400` with the message. While the plugin is stopped, the route
job endpoints answer `503 {"error": "plugin not started"}`.

A body that is not valid JSON never reaches the plugin: the Signal K
server parses bodies itself (`body-parser`) and has no JSON error
handler, so it answers with Express's default `400` page, in HTML, not
the JSON shape above.

**CORS.** The plugin sets no CORS headers of its own, apart from
exposing `X-Mask-Width` and `X-Mask-Height` on `/api/land-mask`
(`Access-Control-Expose-Headers`). Cross-origin access is whatever the
Signal K server allows.

**OpenAPI.** `GET /api/openapi.json` returns an OpenAPI 3.0 document of
the API. The same document is given to the Signal K server through the
plugin's `getOpenApi()`, so it also appears in the server's own API
documentation. It is a summary; where it and this section differ, this
section follows the code.

**Webapp.** `GET /ui` (and `/ui/`) serves the plugin's webapp; `GET
/ui/{file}` serves its scripts and styles; both need `readonly` access.
The webapp is also listed on the Admin UI's Webapps page and served by
the Signal K server at `/signalk-weather-router-plus/`.

### Quick start: compute a route from another app

The minimal sequence is: submit a job, wait for it to finish (Server-Sent
Events or polling), then read the result. The values below are examples.

```sh
BASE=http://localhost:3000/plugins/signalk-weather-router-plus
AUTH="Authorization: Bearer $TOKEN"   # a Signal K token with readwrite access
```

**1. Submit the job** and keep its `id` for the next steps (this uses
`jq`; without it, copy `id` from the response by hand):

```sh
ID=$(curl -s -X POST "$BASE/api/routes" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "start": {"lat": 41.44, "lon": -71.36},
  "end":   {"lat": 32.42, "lon": -64.58},
  "waypoints": [{"lat": 41.13, "lon": -71.53}],
  "precision": "precise",
  "departure": "2026-09-28T12:00:00Z",
  "mode": "sail_max",
  "name": "Newport to Bermuda",
  "vessel": {"polar": "a_boat.pol"}
}' | jq -r .id)
echo "$ID"
```

Response `202 Accepted`, with a `Location` header equal to `links.self`:

```json
{
  "id": "5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
  "status": "queued",
  "links": {
    "self": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
    "events": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/events",
    "result": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/result",
    "skeleton": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/skeleton",
    "cancel": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/cancel",
    "publish": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/publish"
  }
}
```

**2a. Follow progress with Server-Sent Events** (the stream ends after
`done` or `error`):

```sh
curl -sN "$BASE/api/routes/$ID/events" -H "$AUTH"
```

```
id: 1
event: status
data: {"status":"queued","position":1}

id: 2
event: status
data: {"status":"running"}

id: 3
event: progress
data: {"time":"2026-09-28T11:58:02.114Z","stage":0,"total":0,"message":"leg 1/2 corridor: searching the global 0.02° water grid (canals blocked)"}

id: 57
event: route
data: {"type":"FeatureCollection","features":[…]}

id: 58
event: done
data: {"status":"done","summary":{"total_distance_m":1183412.6,"total_time_s":461880.2,…}}
```

**2b. Or poll** until `status` is `done`, `failed` or `cancelled`:

```sh
curl -s "$BASE/api/routes/$ID" -H "$AUTH"
```

```json
{
  "id": "5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
  "status": "done",
  "request": {"start": {"lat": 41.44, "lon": -71.36}, "end": {"lat": 32.42, "lon": -64.58}, "…": "…"},
  "created_at": "2026-09-28T11:58:00.021Z",
  "started_at": "2026-09-28T11:58:00.030Z",
  "finished_at": "2026-09-28T11:58:41.577Z",
  "progress": [{"time": "2026-09-28T11:58:40.912Z", "stage": 20, "total": 20, "message": "…"}],
  "summary": {
    "total_distance_m": 1183412.6,
    "total_time_s": 461880.2,
    "sailing_time_s": 420120.0,
    "motoring_time_s": 41760.2,
    "waypoint_count": 38,
    "warnings": 0,
    "departure": "2026-09-28T12:00:00.000Z",
    "arrival": "2026-10-03T20:18:00.200Z",
    "forecast_cycle": "2026-09-28T00:00:00.000Z",
    "current_sources": ["CMEMS-SMOC"],
    "polar": "a_boat.pol",
    "polar_performance": 1,
    "legs": 2,
    "precision": "precise"
  },
  "resource_id": "5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
  "links": {"self": "…", "events": "…", "result": "…", "skeleton": "…", "cancel": "…", "publish": "…"}
}
```

**3. Read the route** as GeoJSON (or `…/signalk` for the Signal K route
record):

```sh
curl -s "$BASE/api/routes/$ID/result" -H "$AUTH"
```

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {"type": "LineString", "coordinates": [[-71.36, 41.44], [-71.402113, 41.301877], "…"]},
      "properties": {
        "total_distance_m": 1183412.6, "total_time_s": 461880.2,
        "motoring_time_s": 41760.2, "sailing_time_s": 420120.0,
        "departure": "2026-09-28T12:00:00.000Z", "arrival": "2026-10-03T20:18:00.200Z",
        "waypoint_count": 38, "validated": true, "repairs_applied": 0, "smoother_drops": 3,
        "forecast_cycle": "2026-09-28T00:00:00.000Z", "max_swh_m": 2.41, "avg_swh_m": 1.37
      }
    },
    {
      "type": "Feature",
      "geometry": {"type": "Point", "coordinates": [-71.36, 41.44]},
      "properties": {
        "lon": -71.36, "lat": 41.44, "time": "2026-09-28T12:00:00.000Z",
        "sog_ms": 0, "cog_deg": 0, "depth_m": null, "mode": "motoring",
        "wind_ms": 7.214, "wind_dir_deg": 225, "leg": "ocean",
        "leg_distance_m": 15612.3, "leg_time_s": 3021.4
      }
    }
  ]
}
```

A finished route is also saved to the Resources API when publishing is
on (the default; [Publishing](#resources-api-publishing)), so a chart
plotter that reads `/signalk/v2/api/resources/routes` sees it there
without calling this API.

### Routes (jobs)

A route request becomes a job. Jobs run one at a time in the route
worker; the others wait in a queue. Each job keeps an event log that
the SSE endpoint replays.

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/api/routes` | readwrite | submit a route request |
| GET | `/api/routes` | readonly | list jobs |
| GET | `/api/routes/{id}` | readonly | job status, progress and summary |
| GET | `/api/routes/{id}/events` | readonly | Server-Sent Events |
| GET | `/api/routes/{id}/result` | readonly | route as GeoJSON |
| GET | `/api/routes/{id}/skeleton` | readonly | coarse corridor skeleton as GeoJSON |
| GET | `/api/routes/{id}/fronts` | readonly | every search stage's front and best path, compact (display only) |
| GET | `/api/routes/{id}/signalk` | readonly | Signal K Resources API route record |
| POST | `/api/routes/{id}/cancel` | readwrite | cancel a queued or running job |
| POST | `/api/routes/{id}/publish` | readwrite | save the route to the Resources API |
| DELETE | `/api/routes/{id}` | readwrite | delete a job |

#### Job lifecycle

| Status | Meaning |
|---|---|
| `queued` | accepted, waiting for the route worker |
| `running` | being computed; only one job runs at a time |
| `done` | finished; `summary`, the result, the skeleton (when one was found) and the Signal K record are available |
| `failed` | finished with an error; `error` holds the message. A request the worker rejects (see below) also ends here |
| `cancelled` | cancelled by `/cancel`; `error` is `"cancelled"` |

- The queue holds at most 16 waiting jobs; a 17th is refused with `429`.
- Finished jobs (`done`, `failed`, `cancelled`) are saved to disk
  (`jobs/<id>.json` in the plugin data directory) and survive a restart.
  Only the newest are kept: the `routing.keepJobs` setting ("finished
  routes kept", default 50, 1–500); older ones are deleted.
- A job that was `queued` or `running` when the plugin stopped is
  loaded as `failed` with `error` "plugin restarted while the job was in
  progress". If the route worker crashes or exits, the running job fails
  with a message that says so.
- The job's event log keeps its last 500 events; `progress` in the job
  status carries the last 20 progress entries.

#### POST /api/routes

Submit a route request. Access: readwrite. Body: JSON `RouteRequest`.

| Field | Type | Unit | Default | Limits and notes |
|---|---|---|---|---|
| `start` | `{lat, lon}` | degrees | required | both numbers |
| `end` | `{lat, lon}` | degrees | required | both numbers; always reached exactly |
| `waypoints` | array of `{lat, lon, radius_m?}` | degrees, m | none | at most 20; each ends one leg and starts the next ([Waypoints](#waypoints-legs)). `radius_m` 0..5000, overrides `arrival_radius_m` for that waypoint, and must be > 0 with `"approximate"` |
| `precision` | `"precise"` or `"approximate"` | | `"precise"` | `precise`: each leg ends exactly on its waypoint; `approximate`: the route only has to pass through the waypoint's circle; consecutive approximate waypoints are normally routed as one search through their circles in order, and leg by leg when no branch passes through all of them |
| `arrival_radius_m` | number | m | 200 | 0..5000; must be > 0 with `"approximate"`. Ignored in precise mode and for the destination |
| `departure` | string | ISO 8601 | now | an empty string also means now |
| `mode` | `"sail_max"`, `"fastest"` or `"motor"` | | `"sail_max"` | mode policy. `motor`: always motor, and no forecast is used; `fastest`: sail when the polar speed beats the motor speed; `sail_max`: sail when the polar speed is at or above `sail_thresh_ms`, otherwise motor (`src/engine/legsim.ts`). The parent routePlanning server also sails above 0.25 m/s VMG or 1.0 m/s whatever the threshold; this plugin does not |
| `stages` | number | count | setting `routing.stages` (20) | 4..200; isochrone stages per leg |
| `sail_thresh_ms` | number | m/s | setting `routing.sailThreshold` | ≥ 0 |
| `max_wind_ms` | number | m/s | setting `routing.maxWind` (none) | 0..100; a leg is not allowed where the forecast wind speed is above this |
| `max_swh_m` | number | m | setting `routing.maxSwh` (none) | 0..30; a leg is not allowed where the significant wave height is above this (needs wave data) |
| `simplify_m` | number | m | setting `routing.simplify` | 0..5000; route simplification tolerance, 0 = off |
| `smoother` | boolean | | setting `routing.smoother` | run the shortcut smoother |
| `smoother_tolerance` | number | ratio | setting `routing.smootherTolerance` | 0..0.5; how much slower a shortcut may be (0.05 = 5%). The Route tab's *Smoothing* (Default / On / Off) sends `smoother`; with `router: refined` the smoother never runs (its polish replaces it) |
| `comfort_weight` | number | | setting `routing.comfortWeight` (1) | 0..3; how much the search avoids rough water as the boat meets it (the encounter index). 0 = off, the fastest route. See [Comfort](#comfort-rough-water) |
| `name` | string | | `<prefix> <lat>,<lon> → <lat>,<lon>` | name of the Signal K route record (trimmed). The default uses the `publish.routeNamePrefix` setting (`WRP`) and the start and end to two decimals |
| `publish` | boolean | | setting `publish.toResources` (on) | save the finished route to the Resources API |
| `no_forecast` | boolean | | false | route with calm wind |
| `no_currents` | boolean | | false | ignore every current source |
| `wind_model` | string | | `auto` | `auto`: regional wind from signalk-grib-downloader where finer and covering, ECMWF elsewhere; `ecmwf`: ECMWF only |
| `avoid_areas` | boolean | | true | treat the areas marked on Signal K notes (`properties.avoid.radius_m` around the note's position) as land |
| `vessel` | object | | the vessel settings | per-route overrides; absent keys use the settings ([Configuration](#configuration)) |
| `vessel.name` | string | | | ignored (accepted so older clients still validate); the vessel name is Signal K's `vessels.self.name` |
| `vessel.motor_speed_ms` | number | m/s | setting (3.087) | 0.01..50 |
| `vessel.polar_performance` | number | ratio | setting (1) | 0.3..1.2; see below |
| `vessel.polar` | string | | the configured `polarFile` | a token from `GET /api/polars`, at most 200 characters; see below |
| `vessel.draught_m` | number | m | Signal K `design.draft.maximum` | 0.1..30; with `air_draft_m`, lets the [chart mesh](#chart-mesh-charted-depths-and-obstructions) route the leg |
| `vessel.air_draft_m` | number | m | Signal K `design.airHeight` | 0.5..100 |
| `router` | `"standard"` or `"refined"` | | setting `routing.router` (`standard`) | the [open-water router](#open-water-router-standard-or-refined) |
| `search` | `"normal"`, `"moderate"` or `"maximum"` | | `normal` | search method (the Route tab's *Method*): `normal` = the routing settings as they are; `moderate` = stages 40, 100 cross-track bins, headings ±60° at 1° (a better route; about 2 min on a 600 nm passage on a Raspberry Pi 5); `maximum` = stages 40, 150 bins, ±60° at 0.5° (the best; about 6 min). An explicit `stages` still wins |

`vessel.polar` is a token from `GET /api/polars`. A file name such as
`a_boat.pol` resolves only inside the polar library (the configured
`polarsDir`, or the bundled library), `user/…` inside the user polar
directory. Use `"default"`, or omit the field, for the default polar
(the configured `polarFile`, or the bundled Catalina 36).

`vessel.polar_performance` (ratio, 0.3..1.2) is the share of the polar's
boat speeds the boat makes under sail; it overrides the vessel setting
of the same name (default 1, the polar as written). Every boat speed in
the polar is multiplied by it before the sail/motor choice, so a lower
value also means more motoring; motor speed is unchanged. Polars are
usually race predictions (flat water, racing sails, full crew), so a
loaded cruising boat is slower than its polar. The job summary carries
`polar_performance` when a polar was used.

Validation happens in two places:

- **At submission** (`400 {"error": …}`, no job is created): a missing
  or non-object body; `start`/`end`/`waypoints` items that are not
  `{lat, lon}` numbers; more than 20 waypoints; `precision`,
  `arrival_radius_m`, `radius_m`, `mode`, `departure`, `stages`,
  `sail_thresh_ms`, `simplify_m`, `smoother`, `smoother_tolerance`,
  `name`, `vessel`, `vessel.polar_performance`
  and `vessel.polar` outside the limits above. The message names the
  field, e.g. `"stages must be 4..200"`.
- **When the job runs** (the job ends `failed` with the message):
  coordinates outside latitude −90..90 or longitude −180..360;
  the other `vessel.*` ranges above (the message uses the internal
  name, e.g. `vessel.motorSpeedMs must be a number in [0.01, 50] (got 60)`);
  a `vessel.polar` token that is not in the library.

| Status | Body |
|---|---|
| 202 | `{id, status: "queued", links}`; header `Location: <links.self>` |
| 400 | `{error}`: invalid request (above) |
| 429 | `{error: "job queue is full"}`: 16 jobs are already waiting |

`links` has `self`, `events`, `result`, `skeleton`, `cancel` and
`publish`, each an absolute path under the base path.

#### GET /api/routes

List jobs, newest first (by creation time). Access: readonly.

| Query | Type | Default | Limits |
|---|---|---|---|
| `limit` | integer | 50 | clamped to 1..500 |

`200`: an array of job status objects (next section).

#### GET /api/routes/{id}

Job status. Access: readonly. `200`: the job; `404 {error: "job not
found"}`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | job id (a UUID) |
| `status` | string | `queued`, `running`, `done`, `failed` or `cancelled` |
| `request` | object | the route request as submitted |
| `created_at` | string | ISO 8601 |
| `started_at` | string | when it started running; absent before |
| `finished_at` | string | when it finished; absent before |
| `progress` | array | the last 20 progress entries `{time, stage, total, message}` |
| `summary` | object | `done` only; see below |
| `error` | string | `failed` / `cancelled` only |
| `resource_id` | string | Resources API id once published (equal to the job id) |
| `publish_error` | string | the last publishing error, when publishing failed |
| `links` | object | as in the `202` of `POST /api/routes` |

Progress entry:

| Field | Type | Notes |
|---|---|---|
| `time` | string | ISO 8601, when the entry was recorded |
| `stage` | number | current isochrone stage; 0 for messages outside the stage loop |
| `total` | number | planned stages (it can grow while the route runs); 0 when not known |
| `message` | string | human-readable text for display, not a stable format. With waypoints it is prefixed with the leg: `leg 2/4: …` for the leg's start line and errors, `leg 2/4 …` for its per-stage messages |

`summary` (a `RouteSummary`; values are not rounded):

| Field | Type | Unit | Notes |
|---|---|---|---|
| `total_distance_m` | number | m | |
| `total_time_s` | number | s | |
| `sailing_time_s` | number | s | |
| `motoring_time_s` | number | s | |
| `waypoint_count` | number | count | points in the route line |
| `warnings` | number | count | entries in the GeoJSON `warnings` |
| `departure` | string | ISO 8601 | time at the first point |
| `arrival` | string | ISO 8601 | time at the last point |
| `forecast_cycle` | string | ISO 8601 | forecast cycle used; absent without a forecast |
| `current_sources` | string[] | | current sources stacked for the route; absent when none or `no_currents` |
| `polar` | string or null | | file name of the polar used; null when motor-only |
| `polar_performance` | number | ratio | present when a polar was used |
| `auto_vias` | `[{name, width_m}]` | m | automatic vias at narrow passages ([Routing engine](#routing-engine)); not route waypoints |
| `legs` | number | count | routes with waypoints only |
| `precision` | string | | routes with waypoints only |
| `mesh` | boolean | | `true` when at least one leg was routed on the [chart mesh](#chart-mesh-charted-depths-and-obstructions) |
| `router` | string | | the open-water router that ran: `standard` or `refined` |
| `search` | string | | the search method the route ran with: `normal`, `moderate` or `maximum` |

#### GET /api/routes/{id}/events

Server-Sent Events for one job. Access: readonly. `404 {error: "job not
found"}` for an unknown id. Headers: `Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `X-Accel-Buffering: no`.

Each event has a numeric `id` (increasing per job, from 1), an `event`
name and JSON `data`:

| Event | `data` | When |
|---|---|---|
| `status` | `{status: "queued", position}` | job accepted; `position` in the queue (1 = next) |
| `status` | `{status: "running"}` | job started |
| `progress` | `{time, stage, total, message}` | progress entry (as in the job status) |
| `route` | the route GeoJSON FeatureCollection | job done, just before `done` |
| `done` | `{status: "done", summary}` | job done |
| `error` | `{status: "failed" or "cancelled", message}` | job failed or was cancelled |
| `status` | `{status, resource_id, publish_error}` | after a publish attempt (automatic or `/publish`) |

Behaviour:

- On connect the stream first replays the logged events whose `id` is
  greater than the request's `Last-Event-ID` header (all of them without
  the header).
- If the job has already finished, the stream ends after the replay.
  Otherwise it stays open, sends new events as they happen, and ends
  after `done` or `error`.
- A comment line `: keepalive` is sent every 15 s.
- A browser `EventSource` reconnects when the server ends the stream;
  close it yourself on `done` or `error`.
- Automatic publishing runs after `done`, so its `status` event comes
  after the live stream has ended. Read `resource_id` / `publish_error`
  from `GET /api/routes/{id}`, or reconnect with `Last-Event-ID`.

#### GET /api/routes/{id}/result

The route as a GeoJSON FeatureCollection: one LineString feature with
the route's properties, then one Point feature per route point.
Access: readonly.

| Status | Body |
|---|---|
| 200 | FeatureCollection |
| 404 | `{error: "job not found"}` |
| 409 | `{error: "job is <status>", status, message}`: not `done`; `message` is the job's `error`, if any |

LineString `properties`:

| Property | Type | Unit | Notes |
|---|---|---|---|
| `total_distance_m` | number | m | 0.1 m |
| `total_time_s` | number | s | 0.1 s |
| `motoring_time_s` | number | s | |
| `sailing_time_s` | number | s | |
| `departure` | string | ISO 8601 | |
| `arrival` | string | ISO 8601 | |
| `waypoint_count` | number | count | route points |
| `validated` | boolean | | |
| `repairs_applied` | number | count | always 0 |
| `smoother_drops` | number | count | points the shortcut smoother removed |
| `forecast_cycle` | string | ISO 8601 | when a forecast was used |
| `auto_vias` | `[{name, lat, lon, width_m, radius_m}]` | degrees, m | automatic vias; present when any |
| `forecast_valid_to` | string | ISO 8601 | the forecast's last step; present when a forecast was used |
| `forecast_horizon_exceeded_s` | number | s | present when the route arrives after the last forecast step |
| `legs_beyond_forecast` | number | count | legs ending after the last forecast step; present with the above |
| `forecast_horizon_note` | string | | explains the above: conditions beyond the last step are held at it |
| `limits_beyond_forecast` | boolean | | `true` when a wind or wave limit was in force on legs beyond the last forecast step (checked against held conditions) |
| `stops` | `[{lon, lat, radius_m?}]` | degrees, m | the stops the route was asked for (start, waypoints, destination; after any snap); `radius_m` on each waypoint in approximate mode |
| `precision` | `"precise"` or `"approximate"` | | the waypoint precision the route was computed with |
| `snaps` | `[{index, original, anchor, distance_m}]` | degrees, m | stops that were on land and were moved to the nearest water; `index` 0 = start, `stop_count - 1` = destination, others = the request's waypoints in order; present when any |
| `stop_count` | number | count | start + waypoints + destination; present with `snaps` |
| `start_original`, `start_anchor`, `start_snap_distance_m` | `[lon, lat]`, `[lon, lat]`, number | degrees, m | present when the start was moved: the drawn point, where the route starts, and the distance between them |
| `end_original`, `end_anchor`, `end_snap_distance_m` | as above | | present when the destination was moved |
| `warnings` | array | | present when any; items `{leg_index, violation, from, to, repaired}`, `violation` `"leg_crosses_land"` or `"leg_too_shallow"`, `from`/`to` `[lon, lat]` |
| `land_crossings` | number | count | present when a warning is `leg_crosses_land` |
| `has_land_crossing` | boolean | | `true` when `land_crossings` is present |
| `max_swh_m` | number | m | highest significant wave height at a route point; present when wave data was sampled |
| `avg_swh_m` | number | m | mean of the same |

Point `properties` (one feature per route point, in order):

| Property | Type | Unit | Notes |
|---|---|---|---|
| `lon`, `lat` | number | degrees | 6 decimals |
| `time` | string | ISO 8601 | time at the point |
| `sog_ms` | number | m/s | speed over ground into the point (0 at the start) |
| `cog_deg` | number | degrees true | course over ground into the point |
| `depth_m` | number or null | m | charted depth under the waypoint from the chart mesh, on mesh legs; null elsewhere |
| `mode` | string | | `"sailing"` or `"motoring"` on the leg into the point |
| `twa_deg` | integer | degrees | true wind angle, 0..180; when wind was sampled |
| `wind_ms` | number | m/s | wind speed |
| `wind_dir_deg` | integer | degrees true | wind direction FROM |
| `swh_m` | number | m | significant wave height |
| `mwp_s` | number | s | mean wave period |
| `mwd_deg` | integer | degrees true | mean wave direction FROM |
| `current_ms` | number | m/s | current speed |
| `current_dir_deg` | integer | degrees true | current set (flows TO) |
| `current_u_ms`, `current_v_ms` | number | m/s | current east and north components |
| `sea_index` | number | index | sea-state index of the water on the leg into the point (wind, current, swell; one decimal); when wind and wave data were sampled |
| `seas_angle_deg` | integer | degrees | angle between the leg's course and the direction the waves come from, 0..180 (0 = head seas, 180 = following) |
| `seas_side` | string or null | | `"port"` or `"starboard"`: the side the waves come from; null dead ahead or astern |
| `seas_sector` | string | | `head` (0–30°), `bow` (30–60°), `beam` (60–120°), `quarter` (120–150°), `following` (150–180°) |
| `encounter_index` | number | index | `sea_index` weighted for the angle: × 1.3 in head seas, × 1.05 abeam, × 0.8 in following seas, a cosine between (`src/engine/seas.ts`); the sea as the boat meets it |
| `leg` | string | | engine that produced the waypoint; always `"ocean"` in this plugin (kept for compatibility with the routePlanning server, which also uses other values) |
| `role` | string | | `"via"` on the junction point of each request waypoint |
| `tack` | boolean | | `true` on a tack or gybe point the experimental router placed |
| `leg_distance_m` | number | m | distance to the next point; absent on the last point |
| `leg_time_s` | number | s | time to the next point; absent on the last point |
| `leg_wind_min_ms`, `leg_wind_max_ms` | number | m/s | lowest and highest wind speed sampled along the leg to the next point (about hourly samples, both ends included); absent on the last point and when no wind data |
| `leg_swh_min_m`, `leg_swh_max_m` | number | m | lowest and highest significant wave height sampled along the leg to the next point; absent on the last point and when no wave data |
| `beyond_forecast` | boolean | | `true` on a point whose time is after the forecast's last step |
| `snap_distance_m`, `original` | number, `[lon, lat]` | m, degrees | present on a start, via or end point that was on land and was moved: how far, and the drawn point |

The optional point properties are present only when the value was
sampled and is finite. Property names match the routePlanning server's
GeoJSON, so consumers of either can read both.

#### GET /api/routes/{id}/skeleton

The coarse corridor that guided the heading sweep, as a FeatureCollection
with one LineString whose properties are `{kind: "skeleton", points}`.
Access: readonly. `404 {error: "job not found"}`, or `404 {error: "no
skeleton for this job"}` when the job has not finished or no skeleton
was found.

#### GET /api/routes/{id}/signalk

The route record the plugin saves to the Resources API (format under
[Resources API publishing](#resources-api-publishing)). Access:
readonly. `200` the record; `404 {error: "job not found"}`; `409
{error: "job is <status>"}` when not `done`.

#### POST /api/routes/{id}/cancel

Cancel a job. Access: readwrite. No body.

| Status | Body |
|---|---|
| 202 | `{id, status: "cancelling"}` for a queued or running job (a queued job is already `cancelled` when this is returned); `{id, status}` with the unchanged status for a finished job |
| 404 | `{error: "job not found"}` |

A queued job is cancelled at once. A running job stops at the route
worker's next cancellation check; it then ends `cancelled` with an
`error` event. No notification is sent for a cancelled job.

#### POST /api/routes/{id}/publish

Save the finished route to the Signal K Resources API. Access:
readwrite. No body. Use it when automatic publishing is off or failed.

| Status | Body |
|---|---|
| 200 | `{id, resource_id, href}`; `href` is `/signalk/v2/api/resources/routes/<resource_id>` |
| 404 | `{error: "job not found"}` |
| 409 | `{error: "job is <status>"}`: not `done` |
| 502 | `{error}`: the server has no Resources API, or it rejected the route (the message asks whether a routes provider such as `resources-provider` is enabled) |

#### DELETE /api/routes/{id}

Delete a job and its saved file. A queued job is also removed from the
queue. The route saved in the Resources API is not deleted. Access:
readwrite.

| Status | Body |
|---|---|
| 204 | none |
| 404 | `{error: "job not found"}` |
| 409 | `{error: "cancel the running job before deleting it"}` |

### Forecast and conditions

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/forecast` | readonly | forecast metadata, and a series at a position |
| POST | `/api/forecast/refresh` | readwrite | check for a new forecast cycle |
| GET | `/api/conditions` | readonly | conditions time series at a point, with tides |
| GET | `/api/status` | readonly | plugin, forecast, currents, tides and queue status |

#### GET /api/forecast

| Query | Type | Unit | Default | Notes |
|---|---|---|---|---|
| `lat` | number | degrees | none | |
| `lon` | number | degrees | none | samples are returned only when both are given |

`200`:

| Field | Type | Notes |
|---|---|---|
| `cycle` | string | forecast cycle (run time), ISO 8601 |
| `valid_from` | string | first step's valid time |
| `valid_to` | string | last step's valid time |
| `steps` | number[] | forecast step hours of the run |
| `params` | string[] | ECMWF parameters decoded (e.g. `10u`, `10v`, `msl`, `swh`, `mwp`, `mwd`, plus the extra fields when on) |
| `coverage` | string | always `"global"` |
| `samples` | array | with `lat` and `lon`: one row per step, `{time, wind_ms, wind_dir_deg (FROM), msl_pa, swh_m, mwp_s, mwd_deg (FROM)}`; values not rounded, null when missing |

`400 {error}`: `lat`/`lon` not numbers, no forecast loaded yet (`forecast
not loaded yet`, or `forecast unavailable: …` after a failed download),
or a position outside the forecast.

#### POST /api/forecast/refresh

Ask the data worker to check for a new cycle. Access: readwrite.

| Query | Type | Default | Notes |
|---|---|---|---|
| `force` | `true` / `1` | false | decode the current cycle again from the GRIB cache |

`202 {status: "refresh requested"}`. The check runs in the background;
watch `/api/status` for the result.

#### GET /api/conditions

A time series of every conditions field at a point, with tide height,
total water level and surge, and the high and low waters. This is what
the webapp's 72-hour conditions popup draws. Access: readonly.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `lat` | number | degrees | required | −90..90 |
| `lon` | number | degrees | required | −180..360 |
| `from` | string | ISO 8601 | the current UTC hour | |
| `hours` | number | h | 72 | 1..240 |
| `step_h` | number | h | 1 | 1..24 |

The series is cut to the forecast's valid range (then `truncated` is
true) and to at most 1000 rows. `400 {error}` for bad parameters (`lon
and lat are required numbers`, `hours must be a number in [1, 240]`, …).

`200`:

| Field | Type | Notes |
|---|---|---|
| `lon`, `lat` | number | as requested |
| `is_land` | boolean | the point is on land |
| `from` | string | first row's time (after truncation) |
| `hours`, `step_h` | number | as requested |
| `forecast_time_range` | `[string, string]` or null | valid range of the forecast |
| `truncated` | boolean | rows were cut to the forecast range or the row limit |
| `series` | array | rows (below) |
| `tides` | object or null | high and low waters (below); null when tides are off or have no data here |
| `tides_error` | string or null | why `tides` is null when tides are on |
| `sources` | object | `{forecast_cycle, currents: [names], tides}`; `tides` is the source name and run, or null |

Row fields (null when the value is not available, e.g. an extra field
that is switched off):

| Field | Unit | Notes |
|---|---|---|
| `time` | ISO 8601 | |
| `wind_ms` | m/s | 10 m wind speed, 2 decimals |
| `wind_dir_deg` | degrees true | FROM |
| `swh_m` | m | significant wave height |
| `mwp_s` | s | mean wave period |
| `mwd_deg` | degrees true | mean wave direction FROM |
| `current_ms` | m/s | current speed (the stacked current sources); null where no current source has data (water narrower than the models' grids, or outside them), which is not slack water |
| `current_dir_deg` | degrees true | current set (TO); null with `current_ms`, or at exactly zero speed |
| `msl_pa` | Pa | mean sea-level pressure |
| `t2m_k` | K | 2 m air temperature (extra fields) |
| `skt_k` | K | skin (sea surface) temperature (extra fields) |
| `precip_rate_ms` | m/s | precipitation depth rate (extra fields) |
| `precip_type` | code | ECMWF precipitation type (WMO table 4.201) |
| `precip_type_label` | string | `none`, `rain`, `freezing rain`, `snow`, `wet snow`, `rain and snow`, `ice pellets`, `freezing drizzle` or `other` |
| `dewpoint_k` | K | 2 m dew point (extra fields) |
| `rh` | ratio | relative humidity 0..1 |
| `feels_like_k` | K | apparent temperature |
| `feels_like_basis` | string | `air`, `wind_chill` or `heat_index` |
| `wind_chill_k` | K | |
| `heat_index_k` | K | |
| `beaufort` | integer | Beaufort force 0..12 |
| `douglas` | integer | Douglas sea state 0..9 |
| `douglas_label` | string | `calm (glassy)` … `phenomenal` |
| `sea_state_index` | number | combined wind/current/swell roughness index, one decimal |
| `sea_state` | string | band: `smooth`, `good`, `slight`, `choppy`, `rough`, `extreme` |
| `sea_state_partial` | boolean | the index was computed without wave data |
| `tide_m` | m | tide height above mean sea level (Copernicus Marine `ocean_tide`, FES2014) |
| `water_level_m` | m | total water level above local mean sea level |
| `surge_m` | m | non-tidal residual (water level − tide) |
| `tide_extrapolated` | boolean | a bilinear corner is model land and took the value of valid cells within 2 cells (~18 km) |
| `tide_tendency` | string | `rising`, `falling` or `steady` (within ±2 cm/h) |

The tide fields are null when tides are off or there is no model water
within 2 cells. Tide heights are relative to mean sea level, not chart
datum: do not use them for under-keel clearance.

`tides` object:

| Field | Type | Notes |
|---|---|---|
| `highs`, `lows` | `[{time, height_m, water_level_m}]` | high and low waters of the tide height, refined with a parabola through the hourly samples; `water_level_m` may be null |
| `range_m` | number or null | mean of consecutive high − low differences (null with fewer than two extrema) |
| `max_range_m` | number or null | largest such difference |
| `of` | string | always `"tide_m"` |
| `source` | string | source and dataset name |
| `run` | string | source run |
| `datum` | string | `"mean sea level"` |
| `msl_offset_m` | number or null | mean of total sea level − tide over `mean_window`, removed from the total level |
| `mean_window` | `{from, to, samples}` | window of that mean |
| `extrapolated` | boolean | any value in the window came from the coastal fill |
| `doi` | string | dataset DOI |

#### GET /api/status

Plugin, forecast, currents, tides and queue status. Access: readonly.
`200`:

| Field | Notes |
|---|---|
| `plugin` | `"signalk-weather-router-plus"` |
| `started` | the plugin is running |
| `workers` | `{data, route}`: each worker is ready |
| `forecast` | null until a decoded run is ready; see below |
| `process_rss_bytes` | resident memory of the Signal K process, bytes |
| `forecast_error` | last forecast refresh error, or null |
| `forecast_loading` | while the data worker gets a forecast: `{phase, why, cycle, done, total, started_at, text}`. `phase`: `checking` (finding the newest ECMWF cycle) or `decoding` (step `done` of `total`, downloading what the GRIB cache lacks); `why`: `first` (no decoded run on disk yet), `redecode` (the runs on disk do not fit the forecast settings or are incomplete) or `update` (a newer cycle while the run in use keeps serving); `text`: the same as one line, e.g. `"loading the forecast: decoding the 06Z cycle, step 12 of 37 (first start)"`. Null when not loading |
| `currents` | the data worker's current sources in priority order: `{name, priority, resolutionM, bbox, validFrom, validTo}`; the CMEMS SMOC entry adds `smoc` (run, resident and on-demand areas, memory, downloads) |
| `currents_route_worker` | the same for the route worker |
| `rtofs_run` | RTOFS run in use, or null |
| `tides` | Copernicus Marine sea-level source status (run, resident and on-demand areas, point cache, memory, downloads), or null when off or not loaded |
| `tides_enabled` | the tides setting, or null before start |
| `tides_error` | last tide source error, or null |
| `overlay_land` | overlay land-raster cache: `{entries, cells, bytes, index_bytes, builds, hits, last_build_ms, disk_hits, disk_writes, disk, polygons}`, or null; `polygons`: the data worker's decoded-coastline cache `{entries, bytes, budget_bytes, hits, decodes, evictions}` |
| `overlay_tiles` | saved map tiles: `{dir, cap_bytes, files, bytes, hits, misses, writes, not_kept, generations, inflight}` (`files`/`bytes` from the totals saved in `.totals.json` in the tile folder, counted once when missing or a day old; `not_kept`: answered but not saved because an on-demand current or tide load was late or failed; `generations`: the data each layer group was built from; `inflight`: tile queries waiting or running), or null before start |
| `starting` | while the plugin is starting and not answering yet, why (e.g. `"starting: downloading the coastline (40 %)"`); null once started. 503 answers carry the same text |
| `overlay_prebuild` | tiles built ahead of time: `{enabled, workers, workers_ready, paused, areas, window, max_zoom, walk_started_at, seen, built, skipped, not_kept, errors, last_error, at, complete, built_total, build_ms_avg}`; `areas`: `[{kind: "view" or "boat", lat, lon, radius_m}]`; `at`: `{area, hour, z}` of the last tile started; `complete`: every tile of the window is saved. Null before start |
| `weather_provider_registered` | the Weather API provider is registered |
| `jobs` | `{running: id or null, queued, total}`, or null before start |
| `vessel`, `polar`, `router`, `land`, `harmonic_dir`, `extra_fields` | the resolved configuration: vessel parameters (internal camelCase names; `draughtM` and `airDraftM` are Signal K's `design.draft.maximum` and `design.airHeight`, null when unset), default polar file, default open-water router, coastline shapefiles, tidal-harmonic directory, extra fields on/off |

`forecast` fields: `cycle`, `valid_from`, `valid_to`, `steps` (number of
steps), `params`, `coverage` (`"global"`), `storage`
(`"decoded-on-disk"`), `loaded_at`, `has_waves`, `source` (`"disk"`: a
complete decoded run was already on disk; `"grib"`: decoded from the
GRIB cache or download), `ready_ms`, `fields_downloaded`, `decoded_dir`,
`decoded_bytes` (this run on disk), `decoded_at`, `decode_ms`,
`decoded_disk_bytes` (all decoded runs kept), `grib_cache_bytes`,
`last_decode` (`{at, cycle, ms, stepBlockBytes, writtenBytes,
downloaded}` or null), and `memory`: `{data_worker_held_bytes,
data_worker_largest_recent_window, route_worker_held_bytes,
route_worker_largest_recent_window, decoding_block_bytes}`. The decoded
forecast is never resident; `memory` is what requests hold now (a
route's corridor store while it runs, a query's window while it is
answered). The OpenAPI document's description of `/api/status` lists the
nested `smoc` and `tides` fields in full.

### Map layers

| Method | Path | Access | Returns |
|---|---|---|---|
| GET | `/api/field` | readonly | JSON value grid for one layer |
| GET | `/api/wind-points` | readonly | wind barb points |
| GET | `/api/currents` | readonly | current arrow points |
| GET | `/api/pressure` | readonly | isobars and highs/lows as GeoJSON |
| GET | `/api/land-mask` | readonly | binary land mask at screen resolution |
| GET | `/api/tile/{layer}/{z}/{x}/{y}` | readonly | one web-map tile of a layer at a whole hour, saved on the server |
| GET | `/api/tile/{layer}/{z}/{x}/{y}.png` | readonly | the same tile as a PNG image, for chartplotters (the eight colour layers, and the `barbs`, `arrows`, `isobars`, `seas` and `wave_arrows` glyph layers) |
| GET | `/api/legends` | readonly | colour ramps for every layer |

**Common parameters.**

| Query | Format | Default | Limits |
|---|---|---|---|
| `bbox` | `west,south,east,north`, degrees | required | south < north, both in −90..90; west and east in −180..360; east − west ≤ 360. `east` < `west` crosses the antimeridian |
| `time` | ISO 8601 | now | forecast layers are interpolated at this time |

Invalid values give `400` with messages such as `bbox must be w,s,e,n`,
`bbox latitudes invalid`, `time "x" is not ISO 8601` or `res must be a
number in [0.002, 2]`.

**One cache for every client.** These endpoints are answered from the
same saved tiles as the page (see [`/api/tile`](#get-apitilelayerzxy)),
so a box another app asks for is built from tiles already on disk (or
built ahead of time), and what it causes to be computed is saved for
everyone:

- `/api/field`, `/api/wind-points`, `/api/currents`: the tiles covering
  `bbox` at the zoom whose sample spacing is nearest `res`, joined. At one
  zoom all tiles sample the same global lattice, so the values are the
  same as a grid computed for the box at that spacing (not resampled).
  The spacing used is in the answer (`res` in `/api/field`); it is the
  tile spacing nearest the one asked for, at most √2 × finer or coarser,
  coarsened as before when the box would exceed the sample cap.
- `/api/land-mask`: read from the coastline tiles at the nearest pixel
  size.
- `/api/pressure`: the pressure tiles at zoom 5 (0.176°) joined, sampled
  at 0.25° as before, and contoured.
- `time` is rounded to the nearest hour for all of them.
- Latitudes beyond ±85.05° (the web-map limit) have no tiles and answer
  null (no points, water in the land mask).

`/api/conditions`, the Weather API point forecasts and tide series, and
the `/api/forecast` samples are saved in the same store, keyed by the
exact query (a Weather API request without a start date starts at the
current hour), and replaced with the data they were computed from.

**Caching headers.** `/api/field`, `/api/wind-points`, `/api/currents`
and `/api/pressure` send `Cache-Control: public, max-age=86400` when the
hour is more than an hour in the past, else `public, max-age=1800`.

#### GET /api/field

A regular grid of values for one layer over `bbox` at `time`, for
drawing a colour layer (heatmap) or streamlines.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `layer` | string | | required | one of the layers below |
| `bbox`, `time` | | | | common parameters |
| `res` | number | degrees | 0.25 | 0.002..2; lattice spacing |

The lattice is snapped to multiples of `res`. If it would have more than
40 000 cells, `res` is doubled until it fits; the response's `res` is
the spacing used.

`200`:

| Field | Type | Notes |
|---|---|---|
| `layer` | string | as requested |
| `time` | string | ISO 8601 |
| `bbox` | `[west, south, east, north]` | as requested |
| `res` | number | spacing used, degrees |
| `lons` | number[] | column longitudes, normalised to −180..180 |
| `lats` | number[] | row latitudes, ascending (south first) |
| `fields` | `{name: rows}` | one grid per field: `rows[i][j]` is at `lats[i]`, `lons[j]`; values rounded to 4 decimals (precipitation rate to 5 significant digits); null = no data |
| `land` | number[][] | same layout; 1 = land, 0 = water |
| `units` | `{name: unit}` | unit of each field |

| `layer` | `fields` (unit) | Notes |
|---|---|---|
| `wind` | `speed_ms` (m/s), `dir_from` (deg) | 10 m wind |
| `waves` | `swh` (m), `mwp` (s), `mwd` (deg, FROM) | 400 when the forecast has no wave data |
| `msl` | `msl` (Pa) | mean sea-level pressure |
| `temperature` | `t2m` (K) | 2 m air temperature; needs the extra fields |
| `sst` | `skt` (K) | skin temperature; needs the extra fields |
| `precip` | `rate` (m/s), `ptype` (code, when loaded) | precipitation depth rate; needs the extra fields |
| `sea_state` | `index` (dimensionless), `signal` (0..1) | roughness index from wind, current and swell; `signal` is its strength, used by the webapp for opacity |
| `current` | `speed_ms` (m/s), `dir_to` (deg) | display values: gridded model currents (CMEMS SMOC, RTOFS) extended up to 2 source-grid cells into the cells the model leaves empty at the coast, for clipping with `/api/land-mask`. Null where the current is exactly zero. Outside the resident SMOC area the area is loaded on demand first (at most 60 s wait). 400 when no current source is loaded |
| `tide` | `tide_m` (m) | tide height above MEAN SEA LEVEL (not chart datum) from Copernicus Marine `ocean_tide` (FES2014) at the hour (linear between hourly steps), with the same 2-cell coastal extension. Outside the resident tide area the hour is loaded on demand (1/3° grid for `res` ≥ 0.25°). 400 when tides are off |

Forecast layers (all but `current` and `tide`) report null outside the
area the forecast covers.

#### GET /api/wind-points

Wind barb points on a lattice.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox`, `time` | | | | common parameters |
| `res` | number | degrees | 0.5 | 0.02..5; coarsened (doubled) to at most 20 000 points |

`200`: `[{lon, lat, speed_ms, dir_deg}]`, `dir_deg` the direction the
wind comes FROM (degrees true, 1 decimal). Points without a forecast
value are left out.

#### GET /api/currents

Current arrow points on a lattice (display values, extended to the coast
as for `/api/field?layer=current`).

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox`, `time` | | | | common parameters |
| `res` | number | degrees | 0.05 | 0.005..5; coarsened (doubled) to at most 20 000 points |

`200`: `[{lon, lat, u_ms, v_ms, speed_ms, dir_deg}]`: east and north
components and speed in m/s, `dir_deg` the direction the current flows
TO (degrees true, 1 decimal). Land points and points slower than
0.005 m/s are left out. An empty array when no current source is
loaded.

#### GET /api/pressure

Isobars and pressure centres as a GeoJSON FeatureCollection, contoured
from the 0.25° forecast grid around `bbox`.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox`, `time` | | | | common parameters |
| `interval` | number | hPa | 4 | 1..20; isobar spacing |

| Feature | Geometry | `properties` |
|---|---|---|
| isobar | LineString | `{kind: "isobar", hpa, pa, bold}`; `bold` is true every 20 hPa and at 1000 hPa |
| label | Point | `{kind: "label", hpa, pa}`: where to write the isobar's value |
| high | Point | `{kind: "high", hpa, pa}` |
| low | Point | `{kind: "low", hpa, pa}` |

`hpa` is in hPa (whole numbers on isobars and labels), `pa` the same in
Pa. Coordinates are `[lon, lat]`, 5 decimals.

#### GET /api/land-mask

A land mask at screen resolution for clipping drawn layers to the
coastline, independent of the data grid.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox` | | | required | common parameter |
| `w` | integer | pixels | 1024 | 16..2048 (rounded) |
| `h` | integer | pixels | 1024 | 16..2048 (rounded) |

`200` with `Content-Type: application/octet-stream`, `Content-Encoding:
gzip`, `X-Mask-Width: <w>`, `X-Mask-Height: <h>` and `Cache-Control:
public, max-age=86400`. After gzip decoding (browsers and most HTTP
clients do this themselves), the body is `w × h` bytes, one per pixel,
1 = land and 0 = water, row by row from row 0 at the north edge. Pixel
`(x, y)` is centred at longitude `west + (x + 0.5) × (east − west) / w`
and latitude `north − (y + 0.5) × (north − south) / h`. The raster
follows the pixel size (finest 0.002°). `400 {error: "no coastline
configured"}` without coastline shapefiles.

#### GET /api/tile/{layer}/{z}/{x}/{y}.png

The colour layers as 256 × 256 PNG image tiles, for chartplotters that
draw image tiles (Freeboard-SK's chart layers; the plugin publishes the
matching chart resources, see [In Freeboard-SK](#in-freeboard-sk)).
`layer` is one of `wind`, `waves`, `current`, `sea_state`, `precip`,
`temperature`, `sst`, `tide` (colour layers), `barbs`, `arrows`, `isobars`,
`seas`, `wave_arrows` (glyph layers); `z`, `x`, `y` and `?time=` as for the data tile below
(time rounded to the nearest hour, default now). A colour layer is what
the web app paints from the data tile: the legend's colour ramp
(`GET /api/legends`), alpha 0.55, land transparent for the layers that
mask it, water without model data hatched for currents and tides; the
tide layer uses its fixed ±3 m scale. A glyph layer draws the web app's
barbs and arrows from the point tiles of the tile and its eight
neighbours (so a glyph on a tile edge is whole; `seas` and `wave_arrows`
both from the `seas` point tiles, in the heatmaps' colour scales shifted
15 % darker, outlined), and isobars from the
joined 0.25° pressure field (`/api/pressure`), without labels. Rendered
on the server from the saved data tiles and kept in memory (48 MB, least
recently used first);
`X-Tile-Cache: hit | miss` says which, and `Cache-Control` is as for the
data tile. While the first forecast loads (no forecast yet, see
`forecast_loading` in the status) every forecast layer answers at once
with 503, `Retry-After: 10` and `{error, loading}` (the status's loading
progress) instead of waiting behind the decode; `land` does not wait.
Errors: 400 for a bad layer, tile or time, 503 before the
plugin has started.

#### GET /api/tile/{layer}/{z}/{x}/{y}

One web-map tile (the usual XYZ scheme: zoom `z`, column `x` from 180° W,
row `y` from the north) of one layer at a whole hour. The tile's box and
sample spacing are fixed by `z`/`x`/`y`, so the same tile at the same
hour is always the same answer: the plugin saves it on disk and answers
it again from disk without its data worker. A tile being computed for
several clients is computed once; a request whose client goes away
before its query has started is dropped from the data worker's queue.

| Path / query | Values |
|---|---|
| `layer` | `wind`, `waves`, `msl`, `temperature`, `sst`, `precip`, `sea_state`, `current`, `tide` (colour layers), `barbs` (wind barbs), `arrows` (current arrows), `seas` (the points for current against the waves and wave arrows), `land` (coastline) |
| `z` | 0–18 |
| `x`, `y` | 0 to 2^z − 1 |
| `time` | ISO 8601, default now; rounded to the nearest hour. Ignored for `land` |

`200`, `Content-Encoding: gzip`, `X-Tile-Cache: hit` (from disk) or
`miss` (computed now), and the caching headers of the map layers
(`land`: `max-age=86400`). Bodies after gzip decoding:

- colour layers: as [`/api/field`](#get-apifield) for the tile's box
  extended by one sample spacing on every side (so a tile's edge pixels
  interpolate between samples), spacing = tile width ÷ 64, clamped to 0.002°–2°;
- `barbs`: as [`/api/wind-points`](#get-apiwind-points), 7 across a tile;
- `arrows`: as [`/api/currents`](#get-apicurrents), 5 across a tile;
- `seas`: 5 across a tile, points with wave data only:
  `[{lon, lat, idx, swh_m, mwp_s, to_deg, rel, steepen}]` — `idx` the
  sea-state index, `swh_m` the significant wave height, `mwp_s` the mean
  wave period (null when the forecast has none), `to_deg` the direction the waves travel TO (degrees true), `rel`
  the current along the waves (`opposing`, `following`, or `none` below
  0.1 m/s), `steepen` the factor the opposing current steepens them by
  (1 = none), `wind_ms` and `wind_to_deg` the wind and the way it blows
  TO (null without wind data), `cur_ms` and `cur_to_deg` the current and
  its set (0 and null without a current source);
  for all three, points on the tile's east and north edges belong to the
  neighbouring tile;
- `land`: 256 × 256 bytes, 1 = land, row 0 at the north edge, rows
  evenly spaced in Web Mercator y (the map's own rows), columns evenly
  spaced in longitude.

`400` as for the per-box endpoints (e.g. `no wave data in the
forecast`), or for a layer, zoom or tile number out of range. Saved
tiles live in `overlay-tiles/` in the plugin data directory, one
directory per data generation (a new forecast cycle, currents run or
tide run replaces its layers' tiles), under the `overlayCache.diskCap`
byte cap. A tile computed while an on-demand current or tide area was
still loading (60 s wait) is answered but not saved.

#### GET /api/legends

Colour ramps for the colour layers, in SI. Sent with `Cache-Control:
public, max-age=3600`. `200`: `{key: entry}` for the keys `wind`,
`current`, `waves`, `precip`, `temperature`, `sst`, `sea_state` and
`tide`.

| Field | Type | Notes |
|---|---|---|
| `title` | string | e.g. `"Significant wave height"` |
| `quantity` | string | `speed`, `wave_height`, `precip_depth_rate`, `temperature`, `index` or `sea_level` |
| `category` | string or null | Signal K unit-preference category to format the stop values with (`speed`, `depth`, `temperature`); null for the sea-state index and the precipitation rate |
| `si_unit` | string | `m/s`, `m`, `K`, or `""` for the index |
| `kind` | string | `gradient`, or `bands` for `sea_state` |
| `stops` | `[[value, colour]]` | ascending SI values and CSS colours |
| `bands` | `[[value, label]]` | `sea_state` only: band lower bounds and names |

The `tide` ramp is diverging over −3..+3 m; values beyond take the end
colours.

### Polars

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/polars` | readonly | polar library |
| GET | `/api/polar-angles` | readonly | no-go and best upwind and downwind VMG angles per wind speed |
| GET | `/api/polars/table` | readonly | polar speed table in m/s |
| POST | `/api/polar-from-specs` | readwrite | generate a polar from boat specs |

A polar is named by a token. `default` is the default polar (the
configured `polarFile`, or the bundled Catalina 36); any other token is
a `.pol` or `.csv` file name in the library (for example `a_boat.pol`)
or in the user polar directory (`user/my_boat.csv`,
`user/<account>/<file>`). Tokens outside them are refused.

#### GET /api/polars

`200`: `[{path, label, source}]`. `path` is the token, `label` the name
to show (`"<name> (default)"` for the default, `"user: <name>"` for
user polars), and `source` is `"default"` or `"library"`. The list
holds the default polar, then every `.pol`/`.csv` in the library, then
those in the user polar directory and in each `<account>/` inside it; a
file that is the same as one already listed is left out.

#### GET /api/polar-angles

| Query | Default | Notes |
|---|---|---|
| `path` | the default polar | a token |

`200`: `{tws_ms[], nogo_deg[], beat_deg[], run_deg[]}`: for each true
wind speed of the polar (m/s), the no-go angle (the tightest true wind
angle with any boat speed: in irons below it), and the true wind angle of
best upwind VMG (scanned 20°–89°, 1° steps) and best downwind VMG
(90°–179°). All three are of the polar as the router uses it, with the
`routing.noGoMinAngle` setting (tightest sailable angle) applied: rows
closer to the wind than it are dropped, so the no-go angle is the
polar's first row with speed at or beyond the setting.

#### GET /api/polars/table

| Query | Default | Notes |
|---|---|---|
| `path` | `default` | a token |

`200`: `{path, twa_deg[], tws_ms[], speeds_ms[][]}`. `speeds_ms[i][k]`
is the boat speed (m/s, 4 decimals) at `twa_deg[i]` and `tws_ms[k]`.

Errors for both: `404 {error: "polar not found…"}` for a token not in
the library; `400 {error}` when no polar is configured (`no polar
configured`, `no default polar is configured`) or the plugin is not
started.

#### POST /api/polar-from-specs

Generate a polar with the physics polar calculator
(`src/vessel/vpp_physics.ts`: ORC 2026 sail forces, Delft hull
resistance, a heeling limit; see `docs/plans/vpp-physics.md`), write it
to `<polarsDir>/user/<slug>.csv` in the routing server's CSV layout, and
return it. Access: readwrite.

Body `{name, specs, overwrite?}`:

| Field | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `name` | string | | required | 1–60 characters. Slugified to the file name: lower case, spaces to `_`, only `[a-z0-9_-]` kept; must keep at least one letter or digit |
| `overwrite` | boolean | | false | replace an existing polar of that name |
| `specs.loa_m` | number | m | required | 3..50 |
| `specs.lwl_m` | number | m | required | 2..50, and not more than `loa_m` + 0.01 |
| `specs.beam_m` | number | m | required | 0.5..15 |
| `specs.draft_m` | number | m | required | 0.1..8 |
| `specs.displacement_kg` | number | kg | required | 50..500000 |
| `specs.sail_area_upwind_m2` | number | m² | required | > 0 (main + 100% jib) |
| `specs.ballast_kg` | number or null | kg | null | |
| `specs.sail_area_downwind_m2` | number | m² | 0 | accepted but not used: no spinnaker is assumed (a value > 0 adds a warning) |
| `specs.mast_height_m` | number or null | m | null | |
| `specs.rig_type` | string | | `sloop` | `sloop`, `cutter`, `ketch`, `yawl`, `cat` |
| `specs.keel_type` | string | | `fin` | `fin`, `bulb`, `wing`, `full`, `centerboard`, `swing` |
| `specs.hull_type` | string | | `monohull` | `monohull`, `catamaran`, `trimaran` (only monohulls are modelled) |

| Status | Body |
|---|---|
| 200 | `{path, label, warnings, polar}`: `path` is `user/<slug>.csv`, a `vessel.polar` token; `label` is `"user: <name>"`; `warnings` lists specs outside typical ranges (displacement-length ratio outside 50–400, SA/D outside 8–30, an unused downwind sail area); `polar` is `{path, twa_deg[], tws_ms[], speeds_ms[][]}` as served by `/api/polars/table` |
| 400 | `{error}`: invalid specs or name, or no `polarsDir` configured |
| 409 | `{error}`: the file exists and `overwrite` is not true |
| 422 | `{error}`: a multihull, which the calculator does not model |
| 500 | `{error: "VPP failed: …"}`: the calculation failed |

Against 441 ORC 2026 non-spinnaker certificates it was not fitted on,
the calculator's median error is 3.3% upwind, 3.2% reaching and 3.3%
running (6–20 kn). ORC's speeds are race predictions; use the polar
performance setting for a cruising boat. In the webapp, use "Create
polar from boat specs…" under the polar picker.

### Settings

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/settings` | readonly | web-app settings and their schema |
| PUT | `/api/settings` | readwrite | change some settings |

The settings, their groups and defaults are listed under
[Configuration](#configuration). They are stored in `settings.json` in
the plugin data directory and shared by every client. Values on the
wire are SI (m, m/s, s; degrees for the heading increment); a client
shows them in the Signal K user's unit preferences.

#### GET /api/settings

Sent with `Cache-Control: no-store`. `200`: `{values, schema}`.
`503 {error: "plugin not started"}` when the plugin is not running.

- `values`: `{group: {key: value}}` for the groups `vessel`,
  `forecast`, `currents`, `tides`, `routing` and `publish`.
- `schema.groups`: `[{id, label, help}]`.
- `schema.settings`: one entry per setting:

| Field | Notes |
|---|---|
| `key` | `group.key`, e.g. `vessel.motorSpeed` |
| `group` | group id |
| `label`, `help` | text for display |
| `type` | `number`, `integer`, `boolean`, `string` or `enum` |
| `unit` | SI unit of the value (`m`, `m/s`, `s`, `deg`); absent for dimensionless values |
| `quantity` | display quantity for unit conversion: `speed`, `depth`, `wave_height`, `short_distance`, `ratio`, `megabytes`, `hours`, `minutes`, `seconds`, `angle` or `count` |
| `min`, `max` | range |
| `multipleOf` | value must be a whole multiple of this (e.g. 3600 s) |
| `oneOf` | value must be one of these (e.g. `[3600, 10800]`) |
| `default` | default value |
| `nullable` | null is allowed (e.g. no maximum wave height) |
| `enum` | allowed strings |
| `maxLength` | for strings |
| `reload` | what a change re-does: `forecast`, `currents`, `tides`, `refresh_timer`, `jobs`, `next_job` (nothing now; the next route uses it) or `cache` (used at the next cache prune) |

#### PUT /api/settings

Body: only the keys to change, nested by group, in SI, e.g.
`{"vessel": {"motorSpeed": 3}}`. Every key is validated (type, range,
enum); either all are saved and applied, or none.

| Status | Body |
|---|---|
| 200 | `{values, changed, reloaded}`: all values after the change; `changed` lists the `group.key` names whose value changed; `reloaded` is `{forecast, currents, tides, refresh_timer, jobs}`, each true when the change re-did it |
| 400 | `{error, errors}`: `errors` is `{"group.key": message}` (or `{group: message}` for an unknown or non-object group, `{"": message}` for a non-object body); nothing is saved |
| 503 | `{error}`: plugin not started |
| 500 | `{error}`: any other failure |

What a change re-does: a new forecast horizon, extra-fields choice or
"memory kept free" reloads the forecast; SMOC and RTOFS settings reload
currents; tide settings reload tides only; the check interval restarts
the refresh timer; "finished routes kept" trims the job list; everything
else applies to the next route. A forecast change that the device
cannot hold (memory for one decode step, disk for the decoded run) is
refused with `400` before anything is saved, with the reason under the
setting's key. Per-route values in a route request (`vessel.*`,
`stages`, `sail_thresh_ms`, `simplify_m`, `smoother`,
`smoother_tolerance`, `publish`) take precedence over the settings.

### Signal K integration

#### Weather API provider

When the Signal K plugin configuration has `weatherProvider.enabled`
(the default) and the server has the Weather API, the plugin registers
as a Weather API provider named "Weather Router Plus (ECMWF open data)"
once the first forecast run is ready. `/api/status` reports
`weather_provider_registered`. The server answers
`/signalk/v2/api/weather/…` requests through its registered providers.

| Weather API method | Result |
|---|---|
| point forecasts (`/signalk/v2/api/weather/forecasts/point?lat=&lon=`) | one entry per forecast step, anywhere on the globe |
| observations (`/signalk/v2/api/weather/observations?lat=&lon=`) | one entry: the conditions now, interpolated between the two forecast steps around the current time (answered per 5-minute slot, so a chartplotter's lattice of points reuses the data worker's reads) |
| daily forecasts | empty list |
| warnings | empty list |

Both carry `water.surfaceCurrentSpeed` (m/s) and
`water.surfaceCurrentDirection` (rad, the set: the direction the water
flows towards, as Signal K's `environment.water.current.setTrue`) from
the loaded current sources (Copernicus SMOC, RTOFS, harmonic files)
where one covers the point: the resident area around the vessel and the
areas loaded for routes. Elsewhere the two fields are left out. Freeboard-
SK's wind overlay asks the Weather API for an observation at each point
of a lattice over the chart, from the server's default provider; make
this plugin the default provider (`POST /signalk/v2/api/weather/
_providers/_default/signalk-weather-router-plus`, as an admin; the server
remembers it) and its barbs come from the ECMWF forecast. Its
currents overlay still reads Open-Meteo directly (PR-9 in
[docs/plans/freeboard-sk-integration.md](docs/plans/freeboard-sk-integration.md)).

For point forecasts the server passes the options `startDate` and
`maxCount`, from the Weather API query parameters `date` and `count`
(beside `lat`, `lon` and `provider`; upstream
`src/api/weather/index.ts`, `parseQueryOptions`). Steps that ended more than 3 hours before `startDate` (or
now, without it) are skipped, and at most `maxCount` entries are
returned. A position outside the forecast is an error.

Each entry (Signal K units: m/s, rad, Pa, K, m, s, ratio):

| Field | Source | Notes |
|---|---|---|
| `date` | step valid time | ISO 8601 |
| `type` | | `"point"` |
| `description` | | `"ECMWF IFS 0.25° open data, cycle <ISO>, +<h> h"` |
| `wind.speedTrue` | 10 m wind | m/s |
| `wind.directionTrue` | 10 m wind direction FROM | rad |
| `wind.gust` | `10fg`, 10 m wind gust | m/s; extra fields only |
| `outside.pressure` | `msl` | Pa |
| `outside.temperature` | `2t` | K; extra fields only |
| `outside.dewPointTemperature` | `2d` | K; extra fields only |
| `outside.relativeHumidity` | from `2t` and `2d` | ratio 0..1; extra fields only |
| `outside.cloudCover` | `tcc`, total cloud cover | ratio 0..1; extra fields only |
| `outside.precipitationVolume` | `tp`, total precipitation | m; energy fields only, the depth of the interval ending at the step valid time |
| `water.temperature` | `skt` | K; extra fields only |
| `water.waveSignificantHeight` | `swh` | m |
| `water.wavePeriod` | `mwp` | s |
| `water.waveDirection` | `mwd` (FROM) | rad |
| `water.level` | Copernicus Marine hourly sea level | m, total water level (tide + surge) relative to local mean sea level, not chart datum; tides on only |
| `water.levelTendency` | same | `increasing`, `decreasing` or `steady` (within ±2 cm/h), `not available` |

A field is left out when its value is not available. With the energy fields on, point forecasts carry `outside.precipitationVolume` (m, the `tp` interval depth); observations omit it, because their time falls inside an interval that has not ended. When the water-level series cannot be fetched, the two `water.level*` fields are left out and the rest is returned.

#### Resources API publishing

When a job finishes and publishing is on (the request's `publish`, else
the `publish.toResources` setting, default on), the plugin saves the
route with the server's Resources API as
`/signalk/v2/api/resources/routes/{jobId}`: the resource id is the job
id. This needs a routes provider such as `resources-provider`. A failure
is logged and recorded in the job's `publish_error`; `POST
/api/routes/{id}/publish` retries. `GET /api/routes/{id}/signalk`
returns the same record.

| Field | Notes |
|---|---|
| `name` | the request's `name`, or the default name (see `POST /api/routes`) |
| `description` | `"Weather route, <nm> nm, <h> h"` (one decimal each) |
| `distance` | total distance, m |
| `start`, `end` | departure and arrival times, ISO 8601 |
| `feature` | GeoJSON Feature with a LineString of `[lon, lat]` |
| `feature.properties.source` | `"signalk-weather-router-plus"` |
| `feature.properties.total_time_s`, `motoring_time_s`, `sailing_time_s` | s |
| `feature.properties.departure`, `arrival` | ISO 8601 |
| `feature.properties.coordinatesMeta` | one item per coordinate, in order: `name` (`"Start"`, `"WP1"`, `"WP2"`, …, `"End"`) plus the point properties of the GeoJSON result (`lon`, `lat`, `time`, `sog_ms`, `cog_deg`, `depth_m`, `mode`, and the wind, wave, current, `leg` and `role` fields when present; not `leg_distance_m` / `leg_time_s`) |

#### Notifications

When the `publish.notifications` setting is on (default), the plugin
sends a delta for the own vessel on the path
`notifications.weatherRouterPlus.<jobId>`:

| When | `state` | `message` |
|---|---|---|
| route done | `normal` | `route ready: <nm> nm, <h> h` |
| route failed | `alert` | `route failed: <error>` |

The value is `{state, method: [], message, timestamp}`. Cancelled jobs
send no notification. The plugin emits no other deltas.

#### OpenAPI

The plugin gives its OpenAPI document to the server (`getOpenApi()`)
and serves it at `GET /api/openapi.json` (readonly).

## CLI

```sh
wrp-route --start 41.44,-71.36 --end 32.42,-64.58 \
  --land /path/GSHHS_f_L1.shp --polar catalina36.csv \
  --mode sail_max --hours 72 --cache ./ecmwf-cache -o route.geojson
```

`--no-forecast` routes with calm wind; `--via "lat,lon[@radius_m];…"` adds
waypoints (each ends a leg), `--precision precise|approximate` (default
precise) and `--radius <m>` (approximate circle, default 200; `@radius_m`
overrides it per waypoint).
The corridor uses `data/water-grid-0.02.bin.gz` (or a rebuilt grid matching
`--land`); `--water-grid <file>` picks another, `--no-water-grid` uses the old
per-route skeleton, `--allow-canals` opens the known canals.

## Verification

- Water grid: `npm run check:water-grid` floods the grid between point
  pairs inside tight boxes (so going round an island or peninsula does
  not count). Open: Gibraltar, Messina, Bonifacio, Dover, Dardanelles,
  Bosphorus, Øresund, Bab-el-Mandeb, Hormuz, Singapore, Magellan, Kerch.
  Closed with canals blocked (and still closed with canals allowed, since
  GSHHG has no canal water): Corinth, Cape Cod, Panama, Suez, Kra, Kiel,
  Chesapeake and Delaware, Perekop. `src/geo/watergrid.test.ts` and
  `src/engine/corridor.test.ts` cover the edge rule (a one-cell staircase
  thread, a diagonal-only contact, one-sided slivers), split cells, tile
  border and antimeridian edges (a synthetic shapefile built with the
  real builder), A* (walls, blocked cells, corner cutting, antimeridian
  wrap), the chokepoint merge tree, canal blocking, local refinement and
  re-routing round a passage closed on the route raster.
- Routes (CLI, GSHHG full, Apple M3). Motor, no forecast:

  | Route | Distance | Waypoints | Duration | Corridor A* | Total | Auto vias |
  |---|---|---|---|---|---|---|
  | Lisbon → Palma | 742.2 nm | 23 | 123.7 h | 155 ms | 0.9 s | Gibraltar |
  | Madeira → Cartagena | 846.7 nm | 22 | 141.1 h | 233 ms | 1.0 s | Gibraltar |
  | Cape St Vincent → Alboran | 357.8 nm | 21 | 59.6 h | 78 ms | 0.6 s | Gibraltar |
  | Aegean (39.45 N 25.0 E) → Black Sea | 311.5 nm | 35 | 51.9 h | 63 ms | 1.0 s | Dardanelles ×4, Bosphorus |
  | Tyrrhenian → Ionian | 180.9 nm | 22 | 30.1 h | 75 ms | 0.7 s | Messina |
  | Newport RI → Horta | 1955.7 nm | 26 | 326.0 h | 150 ms | 1.5 s | unnamed passage 41.47 N 70.02 W (17.2 km, east of Nantucket Sound) |
  | Singapore Strait (1.5 N 103 E → 1.5 N 105 E) | 127.0 nm | 21 | 21.2 h | 43 ms | 0.6 s | Singapore Strait |
  | Lisbon → Helsinki | 2176.3 nm | 38 | 362.7 h | 1550 ms | 4.8 s | Dover; 57.42 N 11.46 E (Kattegat); Øresund; 59.76 N 24.44 E (Gulf of Finland) |

  `sail_max` with the ECMWF 2026-09-28 00z forecast (72 h, Catalina 36
  polar): Lisbon → Palma 782.7 nm, 220.1 h; Madeira → Cartagena
  886.1 nm, 226.8 h; Aegean → Black Sea 313.8 nm, 52.3 h; Tyrrhenian →
  Ionian 193.0 nm, 55.9 h; Newport → Horta 2044.4 nm, 419.8 h. Every
  route above has 0 legs crossing land in the exact polygon check.

- `npm test` runs the unit tests. The GRIB2/CCSDS decoder is checked
  against eccodes output stored in `test-data/` (full-array hash).
- The Blosc decoder is checked bit for bit against numcodecs (c-blosc
  1.21.6): a real SMOC `utotal` chunk and 25 synthetic frames covering
  byte / bit / no shuffle, split and unsplit blocks, several blocks with
  a partial last one, raw streams, memcpyed chunks and typesizes 1–8
  (`test-data/blosc/`, regenerated by `tools/gen_blosc_fixtures.py`).
  Against the live store, 154 downloaded chunks (409 MB decoded) matched
  numcodecs exactly, and SMOC samples matched xarray bit for bit at grid
  nodes and to 2.5e-6 m/s between them.
- `npm run test:corpus <dir>` compares the decoder value-for-value
  against an eccodes dump of any GRIB2 corpus (see `tools/verify_grib_corpus.ts`).
  On 30 ECMWF messages (12- and 16-bit, with and without bit maps) it
  matched all 31,147,200 cells exactly.

- Sea level: `src/tides/sealevel.test.ts` compares point series at
  three coastal points (Narragansett Bay, Portsmouth, Sydney Harbour;
  all use the coastal fill) against an independent xarray decode of the
  real store (`test-data/sealevel/`, regenerated by
  `tools/gen_sealevel_fixtures.py`): tide, water level, surge and the
  MSL offset agree to < 1e-6 m. High / low extraction is checked against
  dense sampling of synthetic mixed and double-high tides (times within
  6 min, heights within 1 cm).
- Newport RI against NOAA CO-OPS 8452660 (datum MSL), run 2026100723,
  point 41.49 N 71.33 W (extrapolated from the model cells in Rhode
  Island Sound), 28 Sep – 1 Oct 2026, 15 high and low waters: lows
  within 2.4 cm and 15–33 min early; highs 14–17 cm low and 53–71 min
  early; mean range 1.09 m vs NOAA 1.25 m. Surge on 28 Sep: model
  +0.24 to +0.29 m vs NOAA observed − predicted +0.36 to +0.43 m
  (NOAA's MSL is the 1983–2001 epoch, so part of that residual is
  sea-level rise since, which the model's recent-mean offset removes).
  Total water level vs the observed 6-min level: 0.27 m RMS, −0.22 m
  bias (0.16 m RMS with the means removed).

## Limits

- Open water only. A start or end inside a narrow harbour can fail with
  "stage 1 has no live waypoints"; start from the harbour approach.
- Passages narrower than about 150 m (three 55 m cells of the finest
  local raster) are not navigable for the router; the corridor goes round
  them, or the route fails with a message naming the place when there is
  no way round. Corridors are searched on 0.02° cells: water enclosed at
  that resolution with no open water within 10 km cannot be reached.
- The corridor's box (plus 1°) may be at most 120° × 90°, and one leg's
  grid search at most 12 M cells (about 69° × 69°); longer routes need
  intermediate waypoints.
- Automatic vias fix the passage the corridor chose (e.g. Messina rather
  than round Sicily). If a sailing route would rather take another
  passage, set a waypoint in it.
- Canals are closed unless allowed, and with GSHHG none of the listed
  canals is open water anyway.
- No depth data.
- SMOC areas are loaded whole-chunk: a box outside the resident area
  costs its chunks' download (see the measured sizes above), cached for
  the rest of the day's run.
- Routes beyond the forecast horizon use the last step's conditions
  (shown: badge, dashed legs and marker, itinerary chips; raise the
  Forecast horizon setting to cover more of the passage).
- One route computes at a time (single worker thread); others queue.
- Map layers show the forecast on the hour (tiles are per hour);
  latitudes beyond ±85.05° have no map tiles.
- After an update, the browser can keep running the previous version's
  scripts for up to four hours: Signal K serves the web app's files and
  the configuration panel's script with `cache-control: max-age=14400`
  and no version tag (a caching proxy such as Cloudflare adds to this).
  Hard-refresh the page (reload without cache), or for the web app use
  `/plugins/signalk-weather-router-plus/ui`, which always loads the
  current scripts.
- Right after installing the plugin from the App Store and restarting
  the server, an Admin UI page that was open before the restart shows
  *Module "signalk-weather-router-plus" is not available* instead of the
  configuration panel: the server lists configuration panels once at
  start and writes them into the Admin UI page when it is served. Reload
  the Admin UI once.

## License

[Apache License 2.0](LICENSE). Third-party material included in the
package (OpenLayers, the GSHHG-derived water grid, which is under the
LGPL-3.0 as GSHHG is; texts in `licenses/`) and the data sources
used at run time (ECMWF, Copernicus Marine, NOAA RTOFS, GSHHG) are
credited in [NOTICE](NOTICE), which redistributions must carry. Forks are
welcome; a published modified version must use its own name and icon
(see [CONTRIBUTING.md](CONTRIBUTING.md)).
