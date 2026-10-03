# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Display local and online raster XYZ/WMS charts advertised by the shared Signal K chart API in Layers → Base, with remembered selections and map-layer visibility.

## [0.1.0-beta.7] - 2026-10-03

### Added

- **LIVE and SIMULATE follow the boat along the itinerary.** The card of
  the point the boat is heading to is highlighted with live figures
  (distance to it, cross-track, side of the track, speed against the
  plan), and each point passed keeps the figures at its closest approach
  (a point counts as passed once the boat moves away from it again, so
  position noise near it does not pass it early). The map stays centred
  on the boat until it is dragged; the locate button follows again. LIVE
  is available only when the route starts where the boat is (within the
  off-course threshold); otherwise its button is greyed out and says why.
- **SIMULATE: Start, Stop and Rewind to start**, and the sailed track is
  drawn, thinned as it is recorded (a straight run is one segment, every
  turn keeps its corner).
- **Every quantity in the user's Signal K units.** Settings, their help
  text, job progress, warnings and errors carry their quantities as unit
  tokens that the web app and the Freeboard panel write in the user's
  preferences (angles, times and data sizes too); notifications, the
  admin status and the server log, which cannot convert, show them in
  Signal K's base units. The Freeboard panel takes speed, distance and
  depth from Freeboard and the rest from the Signal K user's preferences
  (`public/rp-units.js`, shared with the web app).
- **Forecast times in local time** in the header, with the UTC time as a
  tooltip.

- **Freeboard-SK panel: a weather route's legs without routing again.**
  Ticking a saved weather route in Freeboard's Routes list opens the
  plugin's panel (a hidden background page of the plotter extension
  watches the routes shown) and shows that route's legs: from the
  plugin's own result when it still has it, else from the per-point
  weather saved with the route. Routes Freeboard shows again in its first
  seconds after starting do not open it. The leg cards are redesigned:
  time, waypoint and mode with tack on top; distance, time, SOG and COG
  large; wind with the point of sail, current fair or foul, and waves
  below. A tap on a card centres the chart on its waypoint. The card of
  the leg the boat is on is marked and kept in view, from the boat's
  position (the nearest leg, within 10 nautical miles of the route), else
  from the active course. Wave period is in seconds, as in the web app.

- **The plan is remembered across reloads (#16)**: start, destination,
  waypoints (with the radius a loaded route gave each) and departure are
  kept in this browser and restored on load. A saved departure that has
  passed is not restored: departure stays at now and the status line
  says so.

- **Opening a saved route asks whether to recompute it.** A banner at the
  top of the itinerary offers **Recompute** (current forecast, the Plan
  tab's settings, the loaded start, end and waypoints) or **Keep as
  saved**; it goes away on Find Route or Clear all.

- **The web app header names the source of each quantity**, one line
  each: wind (ECMWF IFS 0.25° run, plus any regional model), waves,
  currents, tides, jobs. It lists only the sources that apply to the
  loaded route, or to the map view when no route is loaded (CMEMS-SMOC,
  worldwide, always; "none here" when nothing else applies), and updates
  as the map moves. `/api/status` `forecast.model` names the global model.

- **Regional wind from signalk-grib-downloader, layered over ECMWF**
  (docs/plans/grib-downloader-enhancement.md). Optional: with the
  downloader installed, the plugin finds its folder (its own setting, else
  `~/.signalk/gribs`; or the new Settings → Forecast → Regional GRIB
  folder), lists its complete runs in `/api/status` (`regional`) and the
  web app header, and decodes each new run's 10 m wind once into its own
  folder (`<data>/regional/<source>/<run>/`, the same format as the ECMWF
  runs; newest runs kept per Forecast → keep cycles). Routes then use the
  regional wind where it covers the point and the time, ECMWF elsewhere:
  its weight ramps from 0 at its grid's border to 1 five cells inside, and
  back to 0 over its last 3 hours of forecast; wind vectors are blended,
  never directions; several regional models apply coarse to fine. Waves
  stay ECMWF. The job log and the route summary (`regional_wind`) give the
  share of the search's wind samples each model answered. Request field
  `wind_model` (`auto`, the default, or `ecmwf`); Plan tab checkbox
  "Regional wind where available". Measured on the test box: an AROME
  0.025° run (52 hourly steps) decodes in 20 s and takes 334 MB. The
  GRIB reader now exposes a field's height, so only 10 m wind is read.
- Reading a whole regional grid made it claim to cover the whole globe
  (the coverage check assumed every grid wraps, as ECMWF's does); a
  regional grid now ends at its edges.

### Fixed

- **The web app no longer stops loading in Power mode.** With the vessel
  type set to power, start-up read the cruise speed before the limits
  table it uses was initialised, a `ReferenceError` that ended the page's
  script.
- **A regional decode no longer holds the data worker.** It decoded a whole
  run in one go (20 s for an AROME run on a Pi 5), during which overlays,
  the Weather API and conditions got no answer; it now reads files
  asynchronously and yields after each field, and a refresh that comes
  while one runs skips the regional pass instead of decoding the same run
  again.
- **A global regional source (GFS from the downloader) is used all the way
  round.** Its first and last columns were treated as a border, so its
  weight fell to 0 around 0° longitude, and a route area entirely west of
  its first column was taken as outside it.

- **Points of sail come from the polar.** "In irons" is tighter than the
  polar's no-go angle at that wind speed (its tightest angle with any
  boat speed, with the tightest sailable angle setting applied as the
  router applies it), and close hauled runs from there to its best
  upwind (VMG) angle; close reach to 75°, beam reach to 105°, broad reach
  to 15° short of its best downwind angle. Before, the web app called a
  leg in irons more than 5° inside the best upwind angle and the
  Freeboard panel below a fixed 35°, so a leg the router sailed at 34°
  read "in irons". `/api/polar-angles` adds `nogo_deg` per wind speed and
  applies the tightest sailable angle setting. Without the route's polar
  no point of sail is shown.

- **Routes computed in the web app now carry their leg details into the
  saved route**, so chartplotters such as Freeboard-SK show each point's
  leg (time, mode, distance, SOG, COG, wind, current, waves) and the
  route's summary in the user's units. The server publishes after it
  reports the route done, when the job's event stream has already closed,
  so the web app never learned the saved route's id and never wrote them;
  it now asks the job for the id. Publish in the itinerary bar wrote the
  server's own copy over them; it now writes them again.

- **A restart no longer leaves the plugin without a forecast while a
  newer cycle downloads.** When a new ECMWF cycle had come out since the
  last run, the plugin served nothing (no overlays, Weather API or
  routes) until it was downloaded and decoded, minutes on a slow link.
  It now serves the newest complete decoded run on disk meanwhile and
  switches to the new cycle when it is ready.

- **GRIB2 fields over a time range (template 4.8) are timed at the end
  of the range.** A maximum gust or an accumulation is valid when its
  range ends, but the reader took the range's start: ECMWF's 3 h gust
  read as 2 h, an hour before the wind in the same file, and the step
  refused to build. The reader now uses the end time from the message and
  reports the range's length (`intervalHours`; 0 at step 0, where ECMWF
  codes an empty range as zeros). No field decoded today is affected
  (every ECMWF, RTOFS and regional wind field is template 4.0); this
  prepares gust and similar fields.

- **The page no longer asks the browser for its location (#13).** A
  first visit opens on the vessel's Signal K position
  (`navigation.position`), whether or not the Own vessel layer is on;
  the browser geolocation call (blocked over plain http, a permission
  prompt over https) is gone.
- **The vessel name is Signal K's (#14).** Settings → Vessel → Name is
  removed; the status shows `vessels.self.name` ("—" when the server has
  none). A stored name in settings.json is dropped on load; the route
  request's `vessel.name` is still accepted but ignored.

- **Opening a saved route kept the previous route's waypoints** when the
  opened route had none of its own, and a re-run then sent them along (a
  route off Morocco went via two waypoints near La Rochelle). Opening a
  route now clears the waypoints first, then restores the opened route's
  own from the job's request: the exact points, their circle sizes and the
  precision, for older routes too.
- **In open water the search can leave the direct line.** Each candidate
  aimed the centre of its ±30° heading sweep at the skeleton (the
  land-avoiding guide line) one step ahead, which pulled every branch that
  drifted off the line back to it: on Tonga → Auckland no candidate got
  more than 170 km off the direct line, while a route via a waypoint
  479 km west was 15 h faster (1214 nm, 192.7 h against 1110 nm,
  207.4 h, same start, end and departure). Where the corridor is open
  water (wider than its probe), a candidate now aims one step along the
  skeleton's own direction from where it is, so a branch keeps its offset
  and the front can widen; narrow water keeps the skeleton aim that finds
  channels. Same number of candidates. A test with a breeze 55 km off the
  line: the front reached 0.21° aimed at the skeleton, 1.6° aimed
  parallel, and the route was 37 % faster.
- **Routes across the antimeridian drawn the long way round.** Loading a
  route that crosses 180° zoomed the map out to the whole world (its
  points sit near both −180° and +180°, so their plain extent is the
  world), and stage fronts, the dashed best path and the skeleton that
  cross 180° were drawn as lines round the globe. Longitudes are now
  unwrapped along each line before drawing, and the map fit uses the
  unwrapped extent and keeps the view in the main world (a view centred
  past 180° showed no route at all); the course arrow at the last point
  before 180° pointed east on a southwest leg, and Live mode's off-course
  check and the warning-to-leg match measured across 180° the long way:
  all take longitude differences the short way now; the Freeboard panel fits a box that crosses 180° as
  west > east, as the Plotter Extensions API defines.

## [0.1.0-beta.6] - 2026-10-02

### Added

- **Weather API observations.** The provider answers
  `/signalk/v2/api/weather/observations?lat=&lon=` with one entry: the
  conditions now, interpolated between the two forecast steps around the
  current time (wind, pressure, temperatures, humidity, waves, water
  level), answered per 5-minute slot. Freeboard-SK's wind overlay asks for
  exactly that at each point of a lattice over the chart, from the
  server's default weather provider, so with this plugin as the default
  its barbs come from the ECMWF forecast. Before, observations were an
  empty list.
- **Surface current in the Weather API.** Point forecasts and
  observations carry `water.surfaceCurrentSpeed` (m/s) and
  `water.surfaceCurrentDirection` (rad, the set, towards) from the loaded
  current sources where one covers the point.

### Fixed

- Review of PR #12: the web files' hash leaves out only the version tags
  the plugin writes, not any `?v=` in the code; the tagged page and
  modules are written beside the file and renamed over it; a change of the
  precision selector or the radius slider marks a route with waypoints as
  stale (a loaded route setting the selector does not). Clear all also
  forgets a loaded route's waypoint radii, so the next waypoints placed
  take the slider's.
- **Waypoint pins stay where you put them, and approximate waypoints show
  their circle.** After a route ran in Approximate mode the web app moved
  each via pin to the point where the route entered its circle, which is
  on the route, so the result looked as if it passed through the
  waypoint exactly and the circle was nowhere to be seen. The route now
  carries the stops it was asked for (`stops`, with each waypoint's
  `radius_m` in approximate mode, and `precision`); the pins go back
  there, and a dashed orange circle of that radius is drawn around every
  via waypoint in Approximate mode, following the pin as it is dragged
  and the radius slider as it moves. Nothing is drawn in Precise mode.
- **Stale web-app modules after an update, properly this time.** The
  cache buster of the cleanup tags the page only on the plugin's own
  `/ui` route; the webapp link everyone uses is Signal K's static mount of
  `public/`, served untouched, so a browser kept running old modules
  after an update (seen on the test box: the new map module on disk, the
  old one in the page). On the first start after the web files change the
  plugin now writes the version tag into the files on disk: the page's
  script and style tags and the modules' import lines. The hash leaves
  those tags out, so it stays stable; the files are written beside and
  renamed over.
- **Damaged saved tiles no longer break the map.** An unclean shutdown
  leaves the tiles written in the seconds before it as empty files (ext4
  delayed allocation; brain, 2 Oct: 363 of them after a crash), and the
  server served them as 200 with nothing in them, which the map showed as
  "Unexpected end of JSON input" under the tidal current and tide height
  legends. The tile store now treats a saved file that is empty or not a
  gzip body as a miss, removes it and rebuilds the tile; `/api/status`
  counts them under `corrupt`. The map names an empty or unreadable tile
  as such.
- **The beat to a waypoint tries wider tack angles.** The two legs of the
  final beat were laid at the polar's tightest sailable angle plus 3°;
  over legs of tens of kilometres the wind direction shifts more than
  that, the leg runs into the no-go angle and the beat fails. Margins of
  3°, 8°, 15°, 25° and 40° are now tried and the fastest beat that sails
  on both legs wins. Found on a Gibraltar → Canaries test: four
  candidates 27° off the wind, "no beat possible" with 3°.
- **"Terminal hop could not be simulated" now says why.** When no
  candidate's final leg can be sailed, the error counts the legs tried by
  cause (over the wind/wave limit, dead upwind with no beat possible,
  stopped by a current stronger than the boat, no boat speed, crossing
  land) and gives the conditions at the nearest candidate: its distance
  and time, the final leg's bearing, the wind and the current there. A
  current sample above 10 m/s, faster than any tidal race, is read as no
  data and counted, instead of stopping a leg. Found on a Gibraltar →
  Canaries test that failed 37 km from the destination with the old
  message and succeeded with currents off.
- **The water-grid builder thread could not start** after the cleanup
  moved its caller into `plugin/worker/`: the thread was started from a
  path one folder too deep, so every rebuild failed and routes stayed on
  the per-route skeleton. (PR #11 review.)
- **The shore-snap check read the coastline of the whole route**: one
  land mask over every stop decoded every polygon in that box, both
  coasts of an ocean for a crossing, on every request. It now builds one
  small mask (0.02°) per stop.
- **Chart groups missed the current, sea-state and tide layers on a fresh
  start**: the groups were written on the forecast message, which comes
  before the data status and the tide run. They are now also written when
  those arrive (a write happens only when a group changes).
- **The validation warning called every warning a land crossing**; wind
  and wave limit warnings are now counted on their own.
- **Tiles wider than 180° (zoom 0 and 1) lost their eastern half**: the
  colour and glyph tile samplers wrapped the longitude offset into ±180°
  instead of 0..360°, as the web app does.
- **Frontier events no longer sit in the job's replay buffer**, where a
  long search pushed the status and progress lines out and a reconnecting
  client replayed every front; they reach live listeners only.
- A coastline download that kept failing added one abort listener per
  retry; a worker crash followed by a stop and start within five seconds
  could leave a second worker running. Both closed.
- `tools/golden_tiles.sh` stops on an HTTP error and exits nonzero when
  tiles differ. README and WHATSNEW wording about panel waypoints and the
  wave-height limit corrected.

### Changed

- **Decision lines switch.** The stage fronts display is now a switch
  beside Find Route, with the same switch in Layers → Base (moved out of
  Weather), **off by default** and remembered. The fronts are still
  streamed during a run and kept with the job; the switch only shows or
  hides them, so turning it on after a run shows the search that was made.
- **One place for units and geodetic constants** (`src/geo/units.ts`):
  the knot, nautical mile, hour and minute factors, the Earth radius,
  degrees/radians, metres per degree and the precipitation-rate factor
  were defined in nine to fifteen places with three different knot
  values; every copy now imports the one definition (structural cleanup,
  `docs/plans/structural-cleanup.md`, phase 1.1). Consequences:
  - Legend colour stops authored in knots (wind, current) and the wind
    barb speed classes use the exact knot (1852/3600 m/s) instead of
    0.514444: the stop values move in the sixth significant digit.
  - Polar tables computed from boat specs (empirical and physics VPP)
    use the exact knot for the table's wind speeds; the parity tests
    against the Python reference evaluate at the Python's wind speeds
    (which used the rounded knot) so the comparison is of the VPP alone.
  - The metre-per-degree heuristics for land-sampling step, smoother
    tolerance and tile radius used 111 195, 111 000 and 111 320 m; all
    use 111 194.93 m (R_EARTH_M · π/180) now. The golden routes
    (`src/engine/golden.test.ts`) are unchanged by this.
- **One place for angle arithmetic** (`src/geo/angles.ts`, phase 1.2):
  longitude wrap, eastward offset, unwrap across the seam, and the
  true-wind-angle fold were written inline about sixty times; each form
  is now one function with the same operations, so results are
  bit-identical (held by the golden sampler and route tests).
- **One Web Mercator** (`src/geo/mercator.ts`, phase 1.3): tile
  numbering, tile boxes and the projected row latitude were written out
  in five tile modules; one definition each now.
- **Resolved configuration in SI** (phase 1.4): the settings were
  already SI (seconds) but the resolved configuration carried hours and
  minutes, and the code converted back and forth. It carries seconds now,
  the forecast, current and tide clients take seconds at their entry
  points, and the smoother tolerance is a ratio throughout. Hours remain
  only inside the ECMWF/RTOFS step ladders and the decoded run's on-disk
  index, which are those formats' own units. Status JSON fields
  (`horizon_hours`, `step_hours`) are unchanged.
- **Web app: SI under the hood, the user's units on screen** (phase 1.5).
  The minimum-sail-speed slider holds m/s (a saved knot value is converted
  once on first load) and its default is 2.6 m/s (about 5 kt, as before).
  The power boat's cruise speed is typed in the user's speed unit like the
  wind and wave limits and kept in SI (a saved knot value is converted
  once). The page no longer carries a copy of the heatmap colour ramps:
  they come from `GET /api/legends` and the layers wait for that answer;
  the precipitation layer's fade threshold is part of that legend
  (`fade_below`). The streamline colours now use the legend ramp through
  the same 256-step lookup as the heatmaps.
- **The isochrone search in sections** (phase 2.1): the 1,040-line
  `computeRoute` is now a 12-line sequence over modules under
  `src/engine/search/` (context, skeleton, narrow-passage guide,
  proposal, stage loop, terminal choice, assembly). Same arithmetic, same
  progress messages; the golden routes are identical.
- **The worker thread in modules** (phase 2.2): `plugin/worker.ts` keeps
  the message handling; forecast, land/water grid, currents, tides, the
  route and the queries are modules under `plugin/worker/` sharing one
  explicit state object instead of thirty module-level variables.
- **The plugin entry in modules** (phase 2.3): the coastline download,
  the worker pool, the chart resources provider, the plotter extension,
  the web-file dating and the Weather API registration are their own
  modules under `plugin/`; `index.ts` keeps start, stop, settings and the
  API wiring.
- **Web app functions in parts** (phase 2.4): route drawing, the
  itinerary, the job stream handlers, the conditions popup and its chart
  are each a handful of named functions instead of one long one. No
  behaviour change.
- **One heap, one string-pull, one ring iterator** (phase 3.1) for the
  three A* searches; same exploration order, golden routes identical.
- **One bilinear sampler** (phase 3.2) for the forecast, Copernicus
  area and coastal-fill grids; one difference: a coordinate below zero
  now clamps to the first cell where the Copernicus corner lookup read
  out of bounds.
- **One HTTP retry policy** (phase 3.3) for the ECMWF, Copernicus Marine
  and RTOFS clients, with a test; RTOFS now honours `Retry-After`.
- **One route pipeline** (phase 3.5): the leg pipeline (corridor, land
  mask, forecast and current areas, isochrone search with the retry
  without automatic vias, simplification, smoothing, re-validation,
  forecast-horizon warning) lives in `src/engine/pipeline.ts`; the route
  worker and the `wrp-route` CLI both run it. The CLI therefore gains
  the vias retry, RDP simplification, the shortcut smoother and the
  re-validation it lacked, using the plugin's default routing settings.
- **One physics step** (phase 3.4) shared by the leg simulator and the
  batched candidate scorer, and then one loop: the straight-leg
  simulator (final legs, beats, smoother shortcuts) is the batched scorer
  with one candidate, so every leg is timed under the same rules as the
  search's candidates. And those rules changed: every candidate now
  samples the forecast and the currents at its own clock (departure plus
  the time its own steps took) instead of one shared motor-speed clock
  per step. Routes and arrival times with a time-varying forecast or
  tide can change, for the better: a 9.5 h sailing leg was being read
  against wind hours away from when the boat was there.
- **Web app duplicates removed** (phase 3.6): one HTML escape, one
  skeleton loader, one time formatter (clock times now follow the
  browser's locale rather than en-US), one overlay reload, one colour
  tile layer factory for the eight heatmaps, one particle layer for the
  wave and wind flow lines.
- **One request schema, one layer table, one cache buster** (phase 4):
  the route request's fields and ranges are described once and drive the
  API validation, the OpenAPI document (unchanged) and the worker; the
  API now also rejects non-finite or out-of-range coordinates and
  non-boolean flags with a 400 instead of a failed job. The map layers
  and the forecast parameters each reads are one table. index.html is no
  longer rewritten on disk at start by this phase: the served page carries
  the version tag. (The Fixed entry above brought the on-disk tagging
  back, for the files Signal K serves itself.)
- **Smaller things** (phase 5): dead code removed (unused helpers, an
  unused land-sampling step option, an always-null message field, a
  job event nobody listened to, the page's `ROUTER` alias and a stub);
  one error hierarchy for the engine (`EngineError` with a code and a
  fatal flag; cancellation is one class, never a message match) and the
  API maps HTTP status by error class; one progress-callback shape;
  tests moved next to what they test; the web app's scripts are linted
  (four assignments-in-conditions fixed); comments that described the
  code by reference to the former server say what the code does; the
  GeoJSON / Signal K route formats, the conditions derivations and the
  isobar tracer moved from the engine to the plugin layer.

### Added

- **The web app is ES modules** (decision C of the structural cleanup):
  `rp-plan.js` and `rp-settings.js` are the entries, `rp-layers.js` and
  `rp-core.js` below them, each importing what it uses by name (25 names
  from the core, 21 from the map module). The route display and route
  library code moved from the core file to the planning file, the marker
  sources and the legends box to the map file, so no file reaches back
  to one loaded after it; shared state that another file changes goes
  through a setter. The fifteen layer checkboxes are wired from one
  table in the map file instead of inline `onchange` attributes, which
  also holds their saved state. The plugin gives module import
  specifiers the same `?v=` tag as the script tags, so a browser loads
  one copy of each file and a new install never runs a stale one. The
  page scripts are linted as modules with `no-undef` on.
- `/api/status` reports `corridor_fallbacks`: how many routes since the
  plugin loaded ran on the coarse per-route skeleton because the
  water-grid corridor search failed; such a route's summary carries
  `corridor_fallback: true` and the server log says so.

## [0.1.0-beta.5] - 2026-09-30

### Added

- **Weather routing inside Freeboard-SK.** The plugin is now a plotter
  extension (Signal K Plotter Extensions API, version 1): Freeboard-SK
  3.0 and later shows a **Weather route** button in its extension
  toolbar, which opens a panel. Draw a route on the chart with
  Freeboard's own tool (start, waypoints, destination by tapping) or show
  a saved one, and **Weather-route it** rewrites it in place with the
  weather route (first point = start, last = destination, the others =
  precise waypoints), still Freeboard's editable draft; or route from the
  vessel to a typed position, the map centre or a saved waypoint as a new
  draft. Each point carries its ETA, the leg's mode and the wind;
  **Save route…** opens Freeboard's own Route Details dialog and stores
  the route in Signal K. Needs no change to Freeboard. The
  panel is served as part of this webapp (`/signalk-weather-router-plus/
  plotterext/`) and is versioned, so an update never runs a cached copy.
- **Map overlays as chart layers.** The eight colour layers (wind speed,
  wave height, current speed, sea state, precipitation, air and sea
  temperature, tide height) are also served as **PNG image tiles**
  (`GET /api/tile/<layer>/{z}/{x}/{y}.png?time=<ISO>`, the picture the web
  app paints, rendered on the server from the same cached data tiles) and
  published as Signal K **chart resources** (`/signalk/v2/api/resources/
  charts`, ids `wrp-wind-speed` …) with a `time` block covering the forecast
  hours. Freeboard-SK lists them in its Chart list with opacity and order,
  and its Time palette scrubs, steps and plays them through the forecast
  with no change to Freeboard. A layer is listed only while its data is
  there (currents, tides, waves, the extra fields). Display settings a
  plotter saves on a layer (opacity, minimum zoom, image adjustment) are
  kept in `chart-overrides.json` in the plugin data directory. The tide
  layer uses its fixed ±3 m scale here (the web app's auto-scale spans
  tiles). Three glyph layers too: wind barbs, current arrows and isobars
  (`barbs`, `arrows`, `isobars`; ids `wrp-wind-barbs`,
  `wrp-current-arrows`, `wrp-isobars`), drawn as the web app draws them;
  isobars without pressure labels, highs and lows as dots. The layers are
  also written as Freeboard resource Groups into the server's `groups`
  collection when it exists: one colour layer per group with its glyphs
  (Wind, Waves, Currents, Pressure, Sea state, Tide, Rain, Air
  temperature, Sea temperature), each holding the layers whose data is
  there.

- **The search, live on the map.** The web app's new **Stage fronts**
  layer (Layers, on by default) draws the router's search as it runs: the
  front of every stage (the candidates kept after pruning, sorted across
  the track, coloured blue → amber by stage; each point keeps its own
  arrival time, so these are not isochrones) and the best path so far
  (dashed). Streamed as `frontier` events on the job's event stream
  (never stored with the job); the finished job's fronts come from
  `GET /api/routes/:id/fronts` and are drawn faintly, also for past
  routes from the log.
- **Wind and wave limits.** Settings `routing.maxWind` and
  `routing.maxSwh` (empty = none) and per-request `max_wind_ms` /
  `max_swh_m`: a leg is not allowed where the forecast wind speed or the
  significant wave height exceeds the limit. The search samples waves
  along every candidate (batched, only when a wave limit is set), the
  single-leg simulator, the final hop and the smoother respect the same
  limits, a route with no way through says so ("… or over the wind/wave
  limit"), and legs whose waypoints exceed a limit carry a
  `wind_over_limit` / `waves_over_limit` warning. Fields in the web app's
  Plan tab (in your units) and in the Freeboard panel.
- **A drawn point on land is moved to the nearest water, and the route
  says so.** Before routing, every stop (start, waypoints, destination)
  is tested against the exact coastline polygons; one on land, or within
  150 m of the shore, is moved to the nearest point with 150 m of water
  around it, within 1,000 m (the search tests legs against a land raster
  whose finest cell is about 55 m, so a point 50 m off the shore sits in a
  land cell and no final leg to it is ever clear: an East River run ended
  "boxed in … 0 km from the destination"). The log says which point and
  how far
  ("your point 5 of 21 (waypoint 4) is on land according to the coastline
  data; moved 120 m into the water"), and the route carries it: `snaps`
  (index, original, anchor, distance) and `stop_count` on the route, the
  web app's `start_`/`end_original`, `_anchor`, `_snap_distance_m` fields,
  and `snap_distance_m` plus `original` on the moved point (GeoJSON and the
  Signal K route's `coordinatesMeta`). The web app draws the dashed
  original-to-anchor tie and lists the moves in the result strip; the
  itinerary cards and point descriptions carry "moved N m"; the Freeboard
  panel shows a line per moved point and tags its leg cards. With no
  water within 1,000 m the error names the point ("your point 5 of 21
  … move it into the water") instead of "leg 4/20: end point … is on
  land". Found on a hand-drawn East River route whose 5th point lay a few
  metres inside the Brooklyn shore.
- **The Freeboard panel no longer shows the previous route's result after
  a failed run.** The result card and itinerary are hidden while a job
  runs and a failure is shown in their place; before, a failed attempt
  left the last route's numbers on screen under the newly selected route
  (a 308 km route around Montauk under a 25 nm East River route).
- **The Freeboard panel follows the boat.** When the weather route is the
  route Freeboard is navigating (Signal K `navigation.course.activeRoute`),
  the card of the leg the boat is on is outlined, tagged "boat" and
  scrolled into view, and moves on as points are passed. The route is
  matched by its stored id (after a save) or by its ends and point count;
  a route edited after routing, or sailed in reverse, is not followed.
  Freeboard has no event for a tap on a route point, so the cards cannot
  follow a tap (PR-7 in docs/plans/freeboard-sk-integration.md).
- **Where the forecast ends is now visible on the route.** When a route
  arrives after the forecast's last step, the result strip shows an amber
  "N legs beyond the forecast" badge (it opens Settings) with the end
  time, the legs after it are drawn dashed with a "forecast ends" marker
  where the route crosses that time, the itinerary cards carry a chip,
  and the saved route's description and point descriptions say so; the
  Freeboard panel shows the same warning and marks its leg cards. The
  GeoJSON carries `forecast_valid_to`, `legs_beyond_forecast` and
  `beyond_forecast` on each point after the end; `limits_beyond_forecast`
  says a wind/wave limit was checked against held conditions there.
  Before, the only sign was one line in the Log tab and a grey note in
  the panel.
- **A boxed-in search says why.** Once the planned stages are used, three
  stages in a row without any candidate coming closer to the destination
  end the search with "the search is boxed in", counting how many of the
  last stage's candidates were over the wind/wave limit, crossed land or
  had no boat speed, and naming the forecast end (and how far past it the
  search was) when it had run beyond the forecast. The per-stage progress
  line carries the same counts, and a run that exhausts its stages far
  from the destination reports that instead of "terminal hop … could not
  be simulated". Found on a Cadiz → Greenland test with a 15.4 m/s wind
  limit and a 72 h forecast: the front shuffled 1,340 km from the goal for
  28 stages, held on conditions frozen 10 days earlier. The counts tell
  no-go-angle candidates ("dead upwind") from the rest, and each stage
  line gives the date of its best candidate, so the forecast end can be
  seen going past.

### Removed

- Eight vessel settings that the router never used: draught, air draft,
  LOA, beam, under-keel margin, overhead margin, maximum wave height and
  tack penalty. They are gone from the Settings tab, `GET/PUT
  /api/settings` and the route request's `vessel` object (sent there,
  they are ignored); an existing `settings.json` that still holds them
  loads normally and drops them. The vessel settings that remain are
  name, speed under power and polar performance. A working tack penalty
  and maximum wave height are planned (docs/TODO.md).
- Web app: the Tack penalty and Under-keel clearance sliders, and LOA,
  draught and air draft in the power-boat form (they were required but
  not used; a power boat now needs only a name and a cruise speed). The
  "Solver & safety tuning" section is now "Solver tuning".

### Fixed

- **A long beat no longer tacks in place.** The wider heading sweeps
  (±120°, then half step, then the full circle at a quarter step) used to
  run only when a whole stage's primary sweep was empty. On a passage dead
  to windward with a narrow primary sweep (±30° at 1°, the default) the
  parents facing upwind got nothing whenever one sibling had a survivor,
  so the front shrank to 1–4 members and alternated between two positions
  (an eastern Mediterranean test: best remaining 1,356 → 1,430 → 1,356 km
  for seven stages). The fallback ladder now runs per parent, for the
  parents whose own sweep came up empty. On a 600 km synthetic beat the
  route went from 1,175 km / 82 h to 997 km / 72 h and the best remaining
  distance falls at every stage.
- **The final choice is the earliest arrival, not the nearest branch.**
  Candidates advance a fixed distance per stage, so when the search stops
  a slow branch crawling straight at the waypoint is the nearest while
  faster branches that tacked are further out but hours ahead. The
  terminal choice used to be the nearest branch (elapsed time only as a
  tie-break). Now the final leg of every branch with a clear straight hop
  (nearest 64) is simulated, straight or as a beat, and the branch with
  the earliest predicted arrival is taken; the log says when that differs
  from the nearest. Found on a Long Island Sound test with the library's
  Amel 55 polar: leg 5 sailed 69 km straight at 3.6 kn, 19° off the wind,
  for 10.5 h while four tacking branches were 12–14 km out at about 5 h.
- **Tightest sailable angle** (Settings → Routing, default 30°): polar
  rows closer to the wind than this are ignored for routing. Many library
  polars carry small boat speeds at 5°–25° off the wind (the Amel 55 file:
  1.8 kn at 10°, 3.1 kn at 19° in 15.6 kn of wind), which let a route go
  dead upwind at a crawl instead of tacking at a 5.8 kn VMG. 0 = the
  polar as written. The polar library files are not changed; the log
  says when rows were ignored.
- **The leading branch can no longer be pruned away.** The subsector
  pruning keeps one candidate per cross-track bin by elapsed time plus
  remaining distance at cruise (motor) speed, which is optimistic to
  windward: on a Samothrace → Egypt test a branch 217 km further back but
  30 h earlier took every bin of the leader and the best remaining
  distance jumped from 545 km to 762 km. The candidate nearest each goal
  now always survives the stage, so the best remaining distance never
  increases. The stall detector that stops a boxed-in search waits for
  the hard stage ceiling when the front is beating (a tenth or more of
  its water candidates dead upwind), since a beat sails well beyond the
  planned distance; otherwise it fires once the planned stages are used.
  Progress is measured towards the deepest branch's next via (or the
  destination once every via is crossed), and a search boxed in before
  every via is crossed raises the vias-not-crossed error, so the router
  retries without the corridor's automatic vias as it does when the
  stages run out (a Samothrace → Libya test: the Kythira branch died on
  the wind limit, the branch east of Crete reached 7 km from the
  destination with that via behind it, and the plain "boxed in" error
  had skipped the retry).
- **The final approach to windward is now sailed as a beat.** The last
  straight hop into a waypoint or the destination has one bearing; when
  that lay inside the polar's no-go angle the route failed ("terminal
  hop … stuck under sail_max"). The router now beats to it on two
  close-hauled legs (the polar's tightest sailable angle plus 3°) meeting
  at a tack point, in whichever order is faster and clear of land, and
  says so in the log. Mid-route, candidates the polar cannot sail stay
  "stuck" rather than motoring, which is what makes the router widen its
  heading sweep and tack; a min sail speed of 0 therefore means "sail
  whenever the polar gives any speed".
- Configuration panel: on a fresh install the Save button stayed greyed
  out until some field was changed, yet a save is the only way the Admin
  UI enables a plugin that has no saved configuration ("Save
  configuration to enable this plugin"). The button is now enabled at
  first setup and reads "Save and enable the plugin". (Verified on a
  fresh App Store install on Signal K 2.33.0.)
- **Stale web files after an update.** Files installed by npm carry
  npm's fixed date (26 Oct 1985); Signal K sends it as `Last-Modified`
  with no ETag, so a browser that already had the web app's page, the
  configuration panel's script or the plotter panel was told "not
  modified" after an update and kept the old copy until the URL changed.
  The plugin now sets its web files' dates to the time of the first start
  after they changed (a hash of `public/` is kept in the data directory),
  so the next conditional request gets the new file; the plotter panel's
  URL also carries a hash of its files.

### Known issues

- Right after installing the plugin from the App Store and restarting
  the server, an Admin UI page that was open before the restart shows
  *Module "signalk-weather-router-plus" is not available* instead of the
  configuration panel, until it is reloaded once. This is the server's
  doing (it lists configuration panels once at start and writes them
  into the Admin UI page as it is served); no plugin change can avoid
  it.

## [0.1.0-beta.4] - 2026-09-30

### Fixed

- README: the introduction wrongly described this plugin as a
  server-free sibling of `signalk-weather-router`. It now says what the
  "plus" is (the map overlays, drawn from the same data the routing
  uses) and that inshore routing (depths, channels, bridges) is not done
  here but by the separate router.zeddisplay.com.

## [0.1.0-beta.3] - 2026-09-30

### Changed

- **First start:** while the coastline downloads, the API answers and the
  web app's status line say so ("starting: downloading the coastline
  (40 %)") instead of "plugin not started" (status field `starting`), and
  the page checks the status every 5 s until the first forecast is in.
- **A route started before the first forecast** waits for it ("waiting
  for the first forecast") instead of downloading its own copy of the
  same fields alongside: on a fresh install such a route took 170 s
  (brain, measured); it now runs as soon as the forecast is ready. It can
  be cancelled while waiting; if the forecast download fails, it runs as
  before.

### Fixed

- On a fresh install the first forecast download could fail with
  `ENOENT … rename …grib2.tmp-<pid>` (it was retried and succeeded 10
  minutes later): two threads fetching the same GRIB field at once, e.g.
  a route computed before the first forecast was ready, wrote the same
  temporary file. Temporary files (GRIB downloads, the water grid rebuild,
  generated polars) are now unique per writer, and a field
  another writer has just saved is taken as it is.

## [0.1.0-beta.2] - 2026-09-30

### Added

- **Polars included.** The plugin now ships the ~700 polars of the
  OpenCPN weather_routing_pi library (GPL-3.0, credited in NOTICE) and a
  Catalina 36 default, used when no polar library or default polar is
  configured, so routes sail out of the box; 0.1.0-beta.1 had none and
  routed motor-only until a polar was configured. With the bundled
  library, polars you generate are kept in `polars/user/` in the plugin
  data directory, so updating the plugin never removes them. A configured
  `polarsDir` / `polarFile` works as before.

### Fixed

- A polar with an empty cell (two tabs with nothing between, as in
  weather_routing_pi's `Figaro_1-1.pol`) failed to load; the cell is now
  filled from the rows around it.

## [0.1.0-beta.1] - 2026-09-30

First public beta: weather routing that runs entirely inside the Signal K
server, with no outside routing service. The history of the development
builds before this release, with their measurements, is in
[docs/development-notes.md](https://github.com/motamman/signalk-weather-router-plus/blob/main/docs/development-notes.md).

### Added

#### Routing

- Isochrone router (a TypeScript port of the routePlanning subsector
  router) in a worker thread, against the vessel's polar. Modes
  `sail_max` (sail when the polar speed reaches the sail threshold,
  motor otherwise), `fastest` and `motor`, with a motor speed. (This
  entry also listed a tack penalty, under-keel and overhead margins and a
  maximum wave height; those settings existed but the router did not use
  them. They were removed in 0.1.0-beta.5.)
- **Routes through straits anywhere:** a global water grid shipped with
  the plugin (0.02°, built from GSHHG full-resolution level 1, with 4,987
  narrow passages) gives each route a corridor; routes such as Lisbon →
  Palma through Gibraltar or the Aegean → Black Sea through the
  Dardanelles and the Bosphorus need no waypoints. Where the corridor
  crosses a passage narrower than a stage step, an automatic
  pass-through point is placed at its narrowest point and steps shorten
  there. Known canals are closed unless **Allow canals** is on.
- **Waypoints as legs:** each waypoint ends a leg; the next departs at
  the arrival time. **Precise** (exactly through the waypoint) or
  **Approximate** (through a circle of 50–2000 m, one search across
  consecutive approximate waypoints). The destination is always exact.
- **Route simplification:** waypoints within 10 m of a straight line are
  dropped, and runs of waypoints become one straight leg when it stays
  clear of land and is at most 5% slower. Your own waypoints are kept.
- **Polar performance** (default 100%, 30–120%): the share of the
  polar's speeds the boat actually makes under sail.
- Every leg is checked for land against every raster cell it crosses
  during the search and against the exact coastline polygon edges at the
  end, so land of any width is found.
- Route jobs with progress over Server-Sent Events; results as GeoJSON,
  saved to the Signal K Resources API, with a notification on completion
  or failure. **Live mode** re-plans from the boat's position.
- `wrp-route` command-line tool (no Signal K needed).

#### Weather, currents and tides

- **ECMWF open data**, global at 0.25°: wind, pressure and waves;
  optional air and sea temperature, precipitation, dew point and
  precipitation type. Every cycle (00z/12z to 360 h, 06z/18z to 144 h),
  horizon 3–360 h (default 72 h). Fetched by byte range and decoded in
  the plugin.
- **The forecast is decoded once to disk**, not held in memory: about
  1.1 GB for 72 h with the extra fields, 3.9 GB at 360 h. The forecast
  is ready 1.3 s after a restart when the current run is already decoded
  (Raspberry Pi 5, measured). On that Pi (8 GB), the whole Signal K
  process, with this plugin, its two tile build workers and the server's
  other plugins, used 1.9 GB after 7 hours (measured 30 September).
- A resource guard refuses a forecast, a route or a setting the device
  cannot hold (memory kept free, default 1 GB; 1 GB of disk kept free)
  and says what to change.
- **Currents:** Copernicus Marine SMOC (worldwide, hourly, including
  tidal currents), NOAA Global RTOFS as a backup, and tidal-harmonic
  files you install (FES2014, NECOFS) taking priority where they cover.
- **Tides and water level:** Copernicus Marine hourly sea level: tide
  height, total water level and surge, high and low waters.

#### Web app

- Plan on the map: click menu, draggable start, destination and
  waypoints, course extension, itinerary cards per leg with the tack,
  saved routes, run log.
- Map layers named for the quantity shown: wind speed (colour) and flow
  lines, wind barbs, wave height and direction lines, current speed and
  arrows, sea state, precipitation, air and sea temperature, pressure
  isobars with highs and lows, tide height, OpenSeaMap seamarks and your
  own vessel. Colour layers stop at the coastline; water the current and
  tide models cannot resolve is hatched "no model data".
- **Map tiles saved on disk and built ahead of time:** colour layers,
  barbs and arrows load as fixed tiles on the hour, answered from disk
  (11–27 ms per tile measured on the Pi against a 10 s median before
  caching). Worker threads build the tiles around the boat and the area
  the map shows for every hour of the forecast (zoom 6–15, 250 km radius
  to zoom 8, half of it at each deeper zoom). Disk cap 20 GB by default.
- **Conditions popup** (shift-click): 72-hour charts of wind, waves, sea
  state, tide and current, pressure, temperature and precipitation, and
  a raw table. Where no current model has data (water narrower than
  their grids) it says so instead of showing 0 kn.
- **Centre on the boat** button under the zoom buttons; the route
  summary also at the top of the Itinerary tab.
- **Units from your Signal K unit preferences**; values are SI
  everywhere else.
- **Settings tab** for vessel, forecast, currents, tides, routing and
  publishing, shared by every client.

#### Polars

- Polar library (default polar plus a polars directory), polar diagram
  and point-of-sail angles, polar per route.
- **Create polar from boat specs:** a physics model (ORC VPP 2026 sail
  forces, Delft hull series resistance, heeling limit with crew on the
  rail). Checked against 441 ORC 2026 non-spinnaker certificates: median
  error 3.3% upwind, 3.2% reaching, 3.3% running. No spinnaker assumed.

#### Signal K integration

- **Configuration panel** in the Admin UI: coastline with a Download
  button and progress, the map cache settings in your units, and the
  other plugin options.
- **Coastline downloaded on first start** when none is configured: GSHHG
  2.3.7 full-resolution level 1 (149 MB, once) from the authors' site,
  or an identical copy on router.zeddisplay.com, checked by SHA-256.
- **Weather API provider:** point forecasts anywhere, including
  temperature, dew point, humidity, water temperature, water level and
  its tendency.
- REST API with an OpenAPI document; every map and point answer is shared
  by all clients through the same disk cache.

### Known issues

- Tide heights and water level are relative to **mean sea level, not
  chart datum**. Do not use them for under-keel clearance.
- Currents and tides come from ~9 km models: fine along coasts, not
  inside small harbours or narrow channels.
- Open water only; no depths, fairways or bridges. Passages narrower than
  about 150 m are not navigable for the router. A start or end deep
  inside a harbour can fail; start from the approach.
- One route computes at a time; others queue. Routes beyond the forecast
  horizon use the last forecast step.
- Map layers show the forecast on the hour; latitudes beyond ±85° have no
  map tiles.
- After an update, the browser could keep the previous version's web
  app page, configuration panel script and plotter panel: files installed
  by npm all carry npm's fixed date (26 Oct 1985), Signal K serves that as
  `Last-Modified` with no ETag, so a browser that had the file was told
  "not modified" and kept its copy until the URL changed (fixed in
  0.1.0-beta.5: the plugin re-dates its web files on the first start after
  they changed, and the plotter panel's URL carries a content hash). Hard-
  refresh, or open `/plugins/signalk-weather-router-plus/ui`, which always
  loads the current scripts.
- The configuration panel has been tested on Signal K server 2.33.0.

[Unreleased]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.7...HEAD
[0.1.0-beta.7]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.6...v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.5...v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.4...v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.3...v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/motamman/signalk-weather-router-plus/releases/tag/v0.1.0-beta.1
