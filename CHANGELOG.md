# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Accept `auto` and `signalk-active` selections when submitting routes and
  departure windows. Their provider check stays at dispatch; local file tokens
  are still checked before queuing. Tokenless previews follow `polarSource`,
  and failed polar-list refreshes discard pending preview responses.
- Preserve Polar Management beat/run targets stored in `derived.rows`, using
  the existing linear polar model and per-wind-speed no-go floors.
- Keep the polar picker filter during automatic refresh; motor-only routes
  accept managed-polar tokens without resolving them as local files.
- **A computation still running shows again after a reload.** A route
  or a Best departure window runs on the server whether the page is open
  or not, but after a reload (or the window closed and opened again) the
  page looked idle. A route this browser started is now followed again,
  with its progress and Cancel, or shown if it finished meanwhile; a
  route another device started is left alone. A Best departure window
  still running opens its section, where its table was already being
  followed but out of sight.
- **A saved route's corridor and stage fronts stay off the route opened
  after it.** Opening a route still computing, or pressing Find Route,
  before a saved route's corridor (blue) and stage fronts had loaded
  drew them over the new search when they came.


### Added

- Automatically use a valid active Polar Management resource as the sailing
  polar, including its shared performance factor, with the internal default
  as fallback. Internal library polars remain selectable as route overrides.
  The picker and preview identify the active source and refresh every 30 seconds;
  completed route summaries include `polar_source`.
- A `polarSource` configuration preference (`auto` or `files`) and `auto` /
  `signalk-active` API polar tokens. Managed tables are adapted from canonical
  SI resources into the existing `PolarDiagram`; interpolation and routing math
  are unchanged. Each sailing route uses a fixed provider snapshot.

### Changed

- The Signal K App Store lists Polar Management (`signalk-polar-management`)
  as a recommended plugin, beside signalk-internet (`signalk.recommends` in
  `package.json`).

## [0.2.1-beta.1] - 2026-10-29

### Fixed

- Point answers and overlay tiles are never served, or saved, from data that was replaced while they were being answered (issue #47). Every query answer and tile built by a worker now carries a stamp naming the data it was computed from: the forecast cycle and parameters actually read (a window whose run was pruned mid-read is retried against the run now current, and the stamp and the window's step indices name that one), the SMOC run and settled flag, the RTOFS products' runs, and the tide run and settled flag. The main thread serves and saves an answer only when its stamp names exactly the data it holds now; on a mismatch it asks the worker again, and the loop ends when they match — no attempt count. The stamp names only the sources the answer read, so answers that read no forecast (the current and arrows layers, the Weather API tide series) are accepted while one is loaded. An answer computed from the data now held is served even when its generation changed while the query ran (the worker's refresh runs beside its queries, so this is the common case, not the exception). The saved-answer read stays generation-checked: a file lives under the generation directory it was written with, so a swap while reading is exact. A tile built ahead of time is adopted only when its stamp names the data held (settings changes, and a tide run the builders learn through `tides-run`). Previously a query that straddled a run swap (a decode finishing mid-request) served and, before the swap's message landed, cached answers computed from the replaced run. A mismatch is asked again only once the data the plugin holds has moved since the check (`dataChanged`, called wherever that data changes): while the main thread's stamp has moved but the worker still answers from the old data — a settings change reloads it behind any query in flight — the request waits out the change instead of sending identical queries until the worker catches up.
- **The Late line names the run in use by when it was published.** For
  SMOC and sea level it said "still on 2026110623": the store's name for
  a run is its last data hour, which reads as a date days ahead. It now
  says "next run was due Thu, 04:09 AM EDT; still using the run published
  Wed, 04:09 AM EDT", for every source, on the web page and in the
  Freeboard panel; the header's tides row says when the sea-level run was
  published instead of "run 07 Nov 23Z". `freshness[].run` is that date
  for SMOC and sea level (yyyy-mm-dd, as RTOFS's); the store key stays in
  `currents[].smoc.run` and `tides.run`.
- **A newer SMOC or sea-level run that Copernicus Marine is still writing
  is reported.** The plugin keeps the run in use until Copernicus marks
  its update finished, but said nothing of the newer run: the check's
  reason was built from the run kept, so it was empty. It now says "a
  newer run appeared Thu, 04:40 AM EDT, but Copernicus Marine has not
  finished writing it", and the run stays red past its due time. New in
  `/api/status`: `freshness[].pending_since`, and `pending`
  (`{run, appeared_at}`) and `updating` (an update has started while the
  store still holds the run in use) in `currents[].smoc` and `tides`.
- **Weather-route it in Freeboard leaves the route you drew alone.** It
  wrote the result's points over the drawn route, so the route you drew
  was gone (4 points became 10), and the next press sent every one of the
  result's points as a precise waypoint: the route could only follow the
  first result, and a stop the router had moved was sent back where the
  route passed, on the edge of the water it was moved away from, where a
  search can fail. The result is now a new route of its own, named after
  the drawn one with the departure time, a draft until you save it under
  a name of your choosing; pressed again, the button routes through the
  drawn points as drawn, and replaces the previous result unless it was
  saved. **Restore drawn route** is gone: there is nothing to restore. The
  point descriptions say "moved N m to water the boat can use" instead of
  "the drawn point was on land", which was wrong for a shoal.
- **The Itinerary tab's route bar fits a narrow panel.** The route name
  kept its width and the last buttons (Delete among them) ran off the
  panel's edge; the buttons now go to a second line.
- **A stretch the router could not search, and a beat it had to motor,
  are warnings on the route.** Both were only a WARNING line in the job
  log: the route showed 0 warnings and "validated", while a chart-mesh
  stretch whose search failed fell back to the chart's own route (brain:
  64 points of short tacks instead of 7, 16 minutes slower), and the
  refined router motored a beat it found no room to tack in. The route
  now carries `search_failed` (the stretch's ends and the search's
  reason) and `beat_motored` (the leg's ends and its motoring seconds):
  the web page's badge counts them and its list says what each means
  ("search failed: this stretch follows the chart's route instead, so it
  may be slower, with many short tacks"; "motored a beat: no room to tack
  there, 12 min under motor"), and the Freeboard panel counts them. The
  re-check for land after simplification no longer drops them.

## [0.2.0] - 2026-10-28

### Changed

- **The map comes first on a phone.** The panel is a bottom sheet with
  three heights: folded to its tab bar, half, or open; drag its grip, or
  tap a tab to open it and the same tab again to fold it. Find Route stays
  pinned at the sheet's bottom. The legend folds to one line naming its
  rows and sits just above the sheet; the map credits fold to their
  button, with the OpenStreetMap credit kept visible beside it. A phone
  held sideways gets a drawer on the right that folds to a rail of the
  tab names. On a desktop a chevron in the title row folds the panel to
  its header. Each layout remembers its last state. The conditions at a
  tapped spot open in a card, across the top of an upright phone and down
  the left side of one held sideways, the chart as wide as the card up to
  500 px, with the panel folded; the popup anchored to the spot ran off
  the screen. The sideways drawer is chosen from the screen itself, so
  the on-screen keyboard does not turn a phone's sheet into the drawer
  while typing.

  On a phone the sheet's heights, the meteogram's cap and the zoom
  buttons below it are shares of the visible screen (CSS `dvh`), not of
  the full viewport, so they follow the browser's address and tool bars
  as they show and hide; a browser without `dvh` keeps the `vh` heights.

## [0.2.0-beta.4] - 2026-10-26

### Added

- The OpenAPI document describes the job document in full: `window_id`, the
  `progress` items, every `summary` field and the `links`, with which fields
  are always present; and the answers of `GET /api/windows` and
  `GET /api/windows/{id}`. Nothing else in the document changes.
- **The search's boat.** While a route computes, a small boat on the map
  sits at the head of the search's best path so far, with that path
  behind it and the stage beside it, and moves on with each stage, so
  the map shows the search going on. It uses the job's stage fronts,
  which the page already received but drew only with the decision lines
  on. It comes with the first stage, as the start as drawn can be on
  land, and goes when the job ends; a repair detour after the search
  does not move it.
- **No background downloads on a metered link.** With the signalk-internet
  plugin installed, while its `network.internet.state` is `metered`,
  `offline` or `captive`, the forecast, current and tide refresh rounds use
  what is on disk, the coastline download at first start and the chart
  meshes' daily pass wait, and map tiles are not built ahead; work of theirs
  under way when the state turns stops, and held work resumes as soon as it
  clears. The plugin follows the state with one subscription: no lookups, no
  wait at start, no timers. Refresh, Download coastline, the mesh panel's
  buttons, routes and the map still download. Without signalk-internet
  nothing changes. signalk-internet is recommended in the App Store
  (`signalk.recommends`).
- **An (i) beside Effort.** It opens the routers page at a new Effort
  section: what Normal, Moderate and Maximum set (stages, cross-track
  bins, headings), what each cost and gained on the measured requests,
  and which to pick. Its only explanation was the label's tooltip, which
  a touch screen never shows. The page and README now call the choice
  Effort, as the Route tab does, instead of Method.

### Changed

- The route request, the job document and the departure-window documents are
  each described once, as a schema (TypeBox, the plugin's first runtime
  dependency, `typebox` ^1.4.3): the TypeScript types and the OpenAPI document
  come from it, so a field can no longer be in one and missing from the other
  (issue #76). Requests, answers and error texts are unchanged.
- **A route that cannot be made says why in plain words.** When every move
  is over the wind or wave limit, the message names the value against the
  limit, where, when it eases, and what to do: "Forecast at the start: waves
  4.6 m against your 3.0 m limit. It comes under the limit about 26 Oct
  09:00 UTC. Raise the limit or depart after that." The coast, a dead-upwind
  start and a boat that makes no way get their own sentences. The counts of
  candidates tried stay in the job's progress log. One module writes these
  sentences (the engine's `refusal.ts`), so the other route errors convert
  to it one by one.
- `npm run typecheck` also type-checks the web app's scripts
  (`tsconfig.public.json`, `checkJs`). The scripts gained JSDoc types, and
  six date checks and subtractions now go through `getTime()` (same
  results); the page behaves as before.

### Fixed

- Saved current tiles are drawn again when a tidal-harmonic file in the
  configured folder is added, replaced or removed (picked up at the next
  start). They were filed by the folder's path, so tiles from the old files
  were served until the next SMOC or RTOFS run. Saved current tiles are
  drawn again once after this update. A tile builder reads the folder only
  while its files are as the plugin read them at start: one changed since
  keeps no current tiles until the plugin restarts (it would have saved
  tiles from the new files as the old ones').
- **Signal K's memory no longer jumps when the map tiles are built ahead.**
  Each tile builder was sent the currents (SMOC, RTOFS, tidal harmonics) as
  copies made on Signal K's main thread, twice per builder. Glibc kept that
  memory after it was freed. When the two builders started, Signal K grew
  by 609 MB, and a trim left 477 MB of it held (brain). That happened with
  every new forecast cycle, currents or tide run, new map view, or boat
  move of over 1 km. A builder is now told where the currents are on disk
  and reads them itself, as the chart-mesh process already did. Signal K
  grew by 0.4 MB when the builders started, and the tiles are byte for byte
  the same. A builder that cannot read a current source (an RTOFS product
  or a tidal-harmonic file) keeps none of the current layers' tiles it
  builds until it can, and reads the source again with the next update:
  such tiles, saved as the new run's, would have been served without that
  source (or from the run before) until the next run. A builder or the
  chart-mesh leg finding an RTOFS file missing from the cache gives up at
  once: it was retried as a download that could not happen, about 62 s per
  product.
- **The coastline is read in 0.5° tiles, never a whole continent.** GSHHG
  keeps each continent as one record: North America is 14.0 MB, Eurasia
  18.6 MB. Any land question near a coast decoded the whole record and
  dropped it: the map's land pictures (twice each), the land point test,
  every route's land mask and every snapped start or end. On brain, a map
  area nobody had viewed yet added 80 MB that Signal K kept. At start the
  plugin now cuts the coastline into tiles once per coastline, in its own
  process: 14.6 s for GSHHG full resolution on brain, 196 MB on disk in
  `coast-tiles/`. Each question then reads only the tiles near it. A new
  map area added 12.5 MB, and a box's coastline loads in 3–16 ms instead of
  68–95 ms. The answers are the same. On real GSHHG, 18 land rasters showed
  0 cells changed. Thousands of point, leg and keep-off-distance checks
  near coasts and on tile borders showed 0 differences. A water-grid
  region rebuild and a route rerun were identical too.
  The map's land pictures and the water grid build are drawn straight from
  the tiles' bytes, with no piece decoded and nothing cached. On brain, the
  map's 16 land tiles of the whole world, none saved yet, grew Signal K by
  333 MB (still held 30 s later) and took 37.8 s; drawn from the bytes they
  grew it by 18 MB and took 14.6 s, and the 16 tiles and 16 land rasters
  were byte for byte the same. Routes and the land point test still decode
  the pieces near them.

## [0.2.0-beta.3] - 2026-10-22

### Added

- **Weather tab in the Freeboard panel** (issue #53). The plotter-extension panel
  has a Weather and a Route tab; routing is unchanged. The Weather tab shows
  the chart groups as presets (`chart.setVisibility`, `chart.setOrder`), the
  preset's legend from `/api/legends`, a forecast time bar over the whole run
  (days in the ship's zone, now, drag, step, play) that sets one hour on all
  the plugin's layers (`chart.setTime`), and how fresh the data is, from
  `/api/status` as the web page shows it: a pill per source the shown layers
  are drawn from (`freshness`, coloured by its own cadence, the worst
  colouring the line), a Late line for a red one, failed checks, the
  connection on a line of its own (`connectivity`), and the forecast run
  out past `valid_to`. It follows changes made in the host's chart
  list and Time palette (`chart.*` events). The manifest lists `charts` and
  `charts.time` as optional.
- `GET /api/chart-groups`: the chart groups with the charts that have their
  data now, colour layer first, and the colour layer's legend key; and
  `chart_rows`, the freshness rows each chart is drawn from.
- Chart `time` blocks carry `forecast: true` and, for the layers drawn from
  the forecast alone, `issued` (the run's time), as proposed in
  SignalK/freeboard-sk#1075. Hosts ignore fields they do not know.
- **Best departure** (Route tab): the route computed for a series of
  departures across the forecast, compared in a table (passage time, the
  strongest wind and highest waves met, motoring, time close-hauled) with
  the best by the chosen measure starred and each row opening its route.
  `POST /api/windows` and `GET`, cancel, `DELETE /api/windows/{id}`
  (`windows.ts`): one ordinary route job per departure, submitted one at a
  time so other routes wait behind one job; the jobs carry `window_id`,
  are left out of the job list and `routing.keepJobs`, never published,
  and notify once for the window (its fastest picked as the table ranks:
  of the passages that end within the forecast). Departures after the
  forecast, and those after a passage that already arrives past it, are
  skipped. A done
  departure's route is kept only in its job file (`JobManager.release`)
  and read from there when it is opened; in memory the window holds its
  metrics.
- **Meteogram** (Itinerary → Meteogram): the weather along the route,
  as TimeZero's. Wind and gust, the boat (speed over ground, true wind
  angle, motoring shaded), waves, pressure and precipitation where the
  boat is at each step of the passage, stacked on one time axis and drawn
  by the conditions popup's chart renderer (now sized per chart). Hover
  reads out the values and marks the boat's place on the route; a click
  sets the map's overlays to that hour. Served by
  `GET /api/routes/{id}/meteogram?step_s=` (`meteogram.ts`): the boat's
  position along each leg's great circle at the leg's pace, and the
  conditions there from the data worker's new `track_conditions` query,
  which reads a dozen samples at a time (their box, the steps around their
  times) rather than the box of the whole route. The wind is the route's:
  the regional models it was computed with are layered over ECMWF as the
  router layers them (`LayeredWind.atManyAtWithSource`), each row naming
  the model that answered. Every chunk is read from the runs taken at the
  start; a run replaced meanwhile leaves the answer incomplete (not kept),
  one pruned meanwhile is read again on the new run. The saved answer is
  keyed by its query, which names each of the route's regional models
  with its newest decoded run: a new run is a fresh answer, and the other
  saved point answers stay (the regional runs are not part of their
  generation). One read from a run decoded since the data worker's last
  report is answered but not kept. On a screen up to 768 px wide (a
  phone held upright) the bottom sheet takes at most 35 % of the height
  while the meteogram is open at the top (65 % otherwise), so the route
  is fitted between the two: at 390×844 the map between them was about
  15 px with the sheet at 65 % and is about 269 px now (measured in a
  browser). The zoom and locate buttons, which sat on the meteogram's
  title there, move to just below it while it is open.
- **Setup choices with security off** (`src/plugin/sharedprefs.ts`,
  `GET`/`POST /api/prefs`). Signal K has no users and keeps no application
  data with security off, so the choices stayed in each browser. The
  plugin now keeps one set for every browser, `prefs.json` in its data
  directory; the web app and the Freeboard panel read and write it as
  they do a user's application data (JSON Patch, string values, 64 KB at
  most). It is not a cache: it sits outside the `CACHEDIR.TAG`
  directories, so backups keep it. With security on the endpoint answers
  405, which stops the page's writes; unlike a write to a user's
  application data, a write to it reads no login status first. After security is
  switched on or off, a browser's choices from the other side are asked
  about (Keep / Discard), not dropped or sent.
- **How fresh each source is, in the page header** (`plugin/freshness.ts`,
  `/api/status` `freshness`): a green, orange or red pill per source (ECMWF
  wind and waves, regional wind, CMEMS SMOC, RTOFS, sea level, tidal
  harmonics) with the run's age, from the source's own publication cadence:
  green until 30 min before the next run is due, orange until 60 min after,
  red later than that or with nothing loaded (the owner's thresholds). When
  each run is due: ECMWF from the measured publication times below, RTOFS
  from its NOMADS file times (one day measured: f024/f048 at 09:36Z, f072
  09:42Z, f144 15:38Z), SMOC and sea level a day after their store last
  updated, AROME by run hour (measured 2026-10-16..19: 00z 2.9 h, 03z 2.8 h,
  06z 5.6 h, 09z 4.3 h, 12z 4.2 h, 15z 3.9 h, 18z 5.3 h, 21z 4.2 h after the
  run), the other regional models by signalk-grib-downloader's own schedule
  (not measured here); harmonics are green when loaded, red for a file that
  failed. A red line under the header names what is late. The header
  collapses to one line of coloured dots per row (Show / Hide, remembered
  in the browser); expanded, every source has its own line, and a source
  that does not cover the route or the map view says so.
- **The connection, separately from freshness** (`/api/status`
  `connectivity`, a line under the title): blue "online" when the data
  worker's last request reached a server, grey "No internet connection since
  …" when it found none. Data can be fresh while the connection is down.
- **Every check says what it found** (`/api/status` `checks`, per source):
  `newest`, `could-not-check` (the server could not be asked; the run in use
  stays, not known to be the newest), `new-run`, or `failed` (the server
  answered but the new run could not be loaded). An ECMWF check that falls
  back to the cached cycle offline is reported as could not check; it was
  reported as unchanged. Online, a check that failed shows its line under
  the header ("ECMWF check failed at …: HTTP 503"). The forecast error line
  clears only on a check that reached ECMWF.
- **"Processing new forecast data: 00Z, step 12 of 37"** under the header
  while a new run decodes behind the one in use.
- **Mesh catalogue rows are checked when the catalogue is read**
  (`meshes.ts` `catalogEntryProblem`): every field the plugin reads (a safe
  name, `archive` as a bare `.tar.zst` file name, `build_date`, `bytes`,
  `triangles`, `clusters` with valid boxes). A bad row is set aside with its
  reason on its own panel row and never downloaded; rows without a usable
  name are listed in `/api/meshes` `catalog_problems`. A row missing
  `clusters`, `bytes`, `triangles` or `build_date` made `/api/meshes` and
  `/api/status` fail as a whole; one without `archive` failed its download
  with a bare TypeError. An `archive` that is a URL or a path (a catalogue
  sending downloads to another address) is refused.
- **Under-keel and overhead clearance** (vessel settings, defaults 0.5 m and
  2 m; request overrides `vessel.under_keel_clearance_m`,
  `vessel.overhead_clearance_m`): the margins over the draught and the air
  draft on chart-mesh legs, which were fixed at 0.5 m and 1 m. The higher
  overhead default blocks bridges and cables 1–2 m above the air draft that
  passed before. Rough cuts carry them in their
  rules and file names (`COARSE_VERSION` 6; existing rough cuts are rebuilt
  once, on demand).
- **The final depth check repairs before it fails** (`worker/route.ts`
  `repairViolations`): each segment that crosses water a chart mesh blocks for
  the boat is routed again with the leg search at a sail threshold of 0 and
  the detour spliced in, the later waypoints shifted by the time it added; at
  most 2 passes and 5 detours. A detour that motors on a `sail_max` route is
  a `detour_motored` warning (under `fastest` motoring is chosen whenever it
  is quicker, so it says nothing about the wind). Warnings and opening
  bridges after a detour move with its waypoints, and the detour's own
  opening bridges are reported. A route still crossing such water fails as
  before. `repairs_applied` reports the detours (it was always 0).
- **GeoJSON download** beside GPX in the Itinerary tab: the route line and
  every waypoint with its times, wind, waves, current and depth.
- **Route request fields `tack_penalty`** (s, 0..3600; overrides
  `routing.tackPenalty`) **and `smoother_sim_step_m`** (m, 50..5000; the
  smoother's own step, overriding `routing.simStep` for the smoother only).
  API only; absent, routes are as before.
- **Backups skip the caches.** The forecast, current and sea-level
  downloads, the decoded runs, the meshes' rough cuts and the saved map
  tiles each get a `CACHEDIR.TAG` (https://bford.info/cachedir/) at start
  (`plugin/cachedir.ts`), so backups leave them out: Kopia by default,
  restic, Borg and GNU tar with `--exclude-caches`. A tag without the
  signature is written again. On one boat running
  0.1.1 these directories held 4.78 GB (`du -sb`), and files written in
  the last 24 h made up 4.78 GB of it (`find -newermt`), so the hourly
  backups stored a new copy of nearly all of it every day. Settings,
  jobs, polars, the coastline and the downloaded meshes
  are still backed up: they change rarely, and offshore they cannot be
  downloaded again.

### Changed

- **One horizon for every source** (the owner's decision, 2026-10-22;
  `config.ts`, `settings.ts`). The forecast horizon is now SMOC's, RTOFS's and
  the tide map's too, each to the end of its own data when that comes first
  (SMOC's run, about 10 days; RTOFS's last file, 144 h; the tide run), and the
  map's tide tiles and tide chart stop there too instead of at the end of the
  tide run. The SMOC horizon, RTOFS horizon and tide map horizon settings are
  gone (a stored value is ignored). A horizon change reloads currents and
  tides as well as the forecast. On brain the three had drifted apart (72 h,
  115 h and 24 h against a 72 h forecast): RTOFS waited each day for its
  `f144` file, about 15:40Z, and the tide tiles ran 7.5 days hourly. The tide
  map now holds the forecast's horizon (72 h by default, 24 h before), about
  three times the memory at the default.
- **RTOFS follows the vessel** (issue #61; `currents/rtofs.ts`,
  `plugin/worker/currents.ts`). The RTOFS regional product loaded is the one
  that contains the vessel, the finest grid where two overlap (`samoa`, not
  the 1° `trop_paci_lowres`, around Fiji), and it changes at the next
  refresh round when the vessel moves into another. Where no product covers
  the vessel (Europe, the Mediterranean, the Indian Ocean, the South
  Atlantic, Australia) nothing is downloaded for its position (extra
  products still load), and the header's currents row
  says so with no pill. Before, one product, `west_atl` by default, was
  downloaded and decoded wherever the vessel was: a boat in Fiji fetched
  3 × 38,387,040 bytes of West Atlantic currents a day it could never use.
  Each product's extent is read from the grid definition at the start of
  its `f024` file (a 4 KB range request, once; kept in the cache's
  `extents.json`).
- **A refresh as soon as the vessel's position is known** (`index.ts`
  `checkPosition`). The refresh round at start often ran before Signal K had
  the first fix (brain, 2026-10-22: the round 12 s after the start), and the
  position was read again only at the next round, up to 15 min later: SMOC
  had no resident area and RTOFS no product until then. The position is now
  looked at every 30 s between rounds; a first fix, or a move into another
  RTOFS product, refreshes at once.
- **A currents settings change reloads only what it concerns**
  (`worker.ts` `config`, `config.ts` `smocLoadSame` / `rtofsLoadSame`).
  Every currents setting emptied SMOC and RTOFS and loaded both again: ticking
  an extra RTOFS product on brain (2026-10-22) also decoded the product
  already loaded and reloaded SMOC's resident area, and Signal K's RSS went
  from 1,040,720 kB to 2,239,440 kB before it settled at 1,160,704 kB three
  minutes later. Now SMOC is loaded again only for a SMOC setting, the RTOFS
  products only for the RTOFS horizon, step or switch; an extra product is
  added or dropped alone.
- **A settings change replaces only the map tiles made from what changed**
  (`tiles.ts` `tileGenerationKeys`). Every tile group's key also carried a
  counter bumped by any settings change that reloaded the forecast, currents
  or tides: ticking an RTOFS product on brain (2026-10-22) built 30,800 wind
  and wave tiles and 14,988 tide tiles again besides the 15,378 current
  tiles. Each group's key is now only what its tiles are made from: the
  forecast's cycle, fields and last hour; the current sources and runs and
  the SMOC and RTOFS steps and RTOFS horizon; the tide run.
- **Extra RTOFS products** (`currents.rtofsExtra`, Settings → Currents →
  *Also load RTOFS products*): products loaded wherever the vessel is, for a
  passage planned elsewhere, each with its area, daily download (measured on
  the 2026-10-21 run) and memory beside it. It replaces `currents.rtofsRegion`:
  a settings.json or old plugin config that chose a product other than
  `west_atl` (the old default, which a stored file cannot tell from a choice)
  gets it as an extra product. Settings have a new type for it, `enumList`
  (a list of `enum` values, checkboxes on the Settings tab; `enumHelp` for
  the text beside each).
- **Each RTOFS product is its own current source** (`RTOFS-<product>`,
  priority 2, finest first), with its own freshness pill and its own check
  (`/api/status` `checks` `rtofs:<product>`). `/api/status` `rtofs_run` is
  replaced by `rtofs`: `{auto, auto_reason, extra, runs: [{product, run}],
  unknown_extents}`. The route and tiles workers and the chart-mesh process
  use every product loaded; a mesh leg reads only the products its box meets.
- **Setup choices are kept per Signal K user** (`public/rp-prefs.js`).
  The polar, sail or power, the power boat, the Route → Options settings
  and the search and router choices were kept in the browser's
  localStorage only, so another browser or device, the kiosk, or a private
  window started again from the default polar. They are now also stored
  in the user's Signal K application data and read when the page opens:
  the server's value wins. localStorage is not split by user, so the
  browser records whose choices it holds (`rp:prefsUser`, from
  `/skServer/loginStatus`): a choice only it has is sent up for that user
  and dropped when another user logs in there (also when the read fails);
  one made while the page cannot tell who is logged in (nobody is, or the
  login status did not answer) leaves the browser without an owner, so the
  choices wait for the answer below. Choices from before this
  change have no owner: they stay in use in that browser and go up only
  when the user keeps them (a banner asks: Keep, or Discard and reload
  with the defaults). The knots they held for the min sail speed and the
  power boat's cruise speed are converted to m/s first, so the converted
  values wait for that answer too; start-up itself stores nothing (sail
  or power is stored when clicked). Changes are sent as
  JSON Patch, one request at a time and batched (a slider drag is one
  request); a change the server did not take is sent again later. Each
  request, a retry too, first reads `/skServer/loginStatus` again: another
  user or nobody logged in by then (another tab, a logout), no answer, or
  no user known when the page opened stops the writes as a 401 does, and
  the queue is dropped; the choices stay in the browser. Not covered: a
  login changing between that check and the request, and the closing
  page's keepalive request, which cannot wait for one. The
  upload at start-up is not waited for. The map view, tabs, layer
  toggles and the plan stay per browser. Module start-up waits for the one
  read (3 s at most); the legend box and the position poll, which waited
  for the page's `load` event, start at once when it has already fired.
  With security on but without a login with write access the choices
  stay in the browser.
  The Freeboard panel keeps its polar, mode, min sail speed and limits
  (max wind and wave height, the web app's `routeVar:maxWind:si` and
  `routeVar:maxSwh:si`) in the same store. Its own `wrp-plotterext-*`
  keys from before are moved to the store's keys (where the browser has
  none of those) when the store loads, so another user's are dropped and
  ownerless ones wait for Keep / Discard like the web app's. Its controls work
  before the store has read the server: a choice made meanwhile is kept
  over the stored one and sent up. README, Users: the user is the Signal K login name
  (`req.skPrincipal.identifier`, as `loginStatus` reports it), nothing is
  per user without a login, and a read-only user owns nothing.
- **The ECMWF decode runs in a child process, and the data worker's network
  work beside its queries** (`plugin/forecastdecodetask.ts`, child task
  `forecast-decode`; `worker.ts`). A refresh round, a decode and a settings
  reload no longer hold the data worker's queue, so map tiles, the
  conditions popup and the Weather API are answered from the run in use
  meanwhile. Measured on the test box (2026-10-19), the same forced 00z
  re-decode (172 s from the GRIB cache): before, an uncached map tile timed
  out at 120 s and the next took 49.8 s; after, 14 of 14 answered in
  17–64 ms. The decode's buffers leave with the child (memory not measured
  yet). A refresh asked for while one waits to start joins it; one asked
  for while one runs is done once after it (they queued up before). A query
  whose SMOC or tide source is replaced while it waits is answered as
  incomplete and not cached.
- **ECMWF publication times are measured, per cycle** (`ecmwf.ts`
  `publishedAt`): 00z/12z 454 min after the run, 06z/18z 387 min (the
  `Last-Modified` of every cycle from 2026-10-16 00z to 2026-10-19 00z, to
  the minute). The fixed 400 min looked for 00z/12z 54 min early and found
  06z/18z 13 min late.
- **No connection fails at once** (`http.ts`): a request whose name does not
  resolve, or with no route to any network (`ENOTFOUND`, `EAI_AGAIN`,
  `ENETUNREACH`, `ENETDOWN`), is not retried and does not try the other
  ECMWF mirrors, and the rest of that refresh round asks no server (each
  source uses what it has and says why). A refused connection, an
  unreachable host and a timeout are still retried and fail over: one
  server's failure, or a slow link.
- **Chart meshes download as their archives, two at a time.** Each mesh
  is fetched as the catalogue's `<name>_mesh.tar.zst` (about a third of the
  unpacked size: 7.2 GB for all eight published meshes against 21.3 GB),
  resumed with a Range request where a download stopped, unpacked by the
  plugin itself (zstd from Node's zlib, its own tar reader: plain files and
  folders only, nothing outside the mesh folder), and checked before it is
  swapped in: every tile the index lists present, their total equal to the
  catalogue's `bytes`. A free-disk check comes first. The file-by-file
  download is gone; the panel shows the archive's progress (downloading,
  then unpacking).
- **Node.js 22.15 or later** is required (was 20.10): the mesh archives
  are zstd, which Node's own zlib unpacks from 22.15 on. Signal K 2.33
  itself needs Node 22.
- **Min sail speed 0 and a stretch the boat cannot sail or tack out of** fails
  the route saying "set Min sail speed above 0" (refined router).
- **Currents are shown as the direction they flow to** ("0.2 kn to W (265°)")
  in the itinerary, its text and the plotter panel, as the API gives them;
  they were turned round and shown as "from".
- **Headings and directions in whole degrees**, with no space before ° or %.
- **Softer coast on the land-masked colour layers** (waves, current, sea
  state, precipitation, sea temperature, tide), in the web app and the
  chartplotter PNG tiles alike: the tile's alpha is blurred (σ 1 px), so the
  colour fades over about 2 px at the shore instead of stopping at a hard
  edge; edges of no-data areas soften the same way. The no-data hatch stays
  sharp.
- **Shorter legend titles:** Wave height, Precipitation, Air temperature,
  Sea-surface temperature.
- **`POST /api/routes`** refuses a `vessel.polar` that is not in the library
  (400) and a body over 64 KB (413) before the job is queued; the polar was
  found missing only when the job ran.
- **Polar calculator:** where no reef or flattening keeps the heel within the
  limit, the boat speed is 0 (it was the fully depowered speed past the limit).

### Fixed

- **A stalled RTOFS extent read held the data worker** (`currents/rtofs.ts`
  `fetchExtent`, PR #68 review). The 4 KB read of a product's file had no
  timeout once the headers had arrived, so a server that stalled after them
  kept that refresh, and every forecast, SMOC and tide refresh queued behind
  it, waiting. The read is now cancelled at the client's timeout and that
  product is left unknown.
- **A queued refresh ran on an older vessel position** (`worker/refreshqueue.ts`,
  PR #68 review). A settings change queued ahead of a refresh set the
  position it was sent with when it ran, after the refresh had stored the
  newer one, so RTOFS could choose the product for where the vessel had
  been until the next round. The refresh now puts back the newest position
  it was sent when it starts.
- **RTOFS products across the antimeridian answered on one side only**
  (`RtofsCurrentSource.contains`). The product's box was tested with plain
  longitudes, so `alaska`, `arctic`, `bering`, `samoa` and `trop_paci_lowres`
  (east edge past 180°) had no current east of the antimeridian. It is now
  tested as an offset east of the box's west edge.
- **Deleting the route on the map leaves nothing of it in use**
  (`_clearDisplayedRoute()` in `public/rp-plan.js`). Itinerary → Delete
  cleared the map and the result strip but kept the route's state, as
  Reset does not. GPX then still exported the deleted route. The plan
  hint still said to click the route. The next marker change brought
  back the deleted route's result strip, marked stale, with "Markers
  changed — press Find Route to recompute".
- **A forecast update stalled the map** (see the decode above): every map
  tile not already saved waited for the whole decode.
- **Offline, the forecast stayed on an old cycle without a word**: the check
  fell back to the cached cycle and reported "unchanged" (test box,
  2026-10-18/19: the Wi-Fi dropped at 23:06 local and the 12z run served
  until a reboot nine hours later, the header unchanged). It now says it
  could not check, the connection line shows the outage, and the freshness
  pills turn orange and red.
- **The forecast error line never cleared** after a later check succeeded
  without a new run.
- **A dropped connection threw away mesh archive bytes already received**
  (`mesharchive.ts`): the stream pipeline discarded the chunks still queued
  towards the file, so the part could be empty after half the archive had
  arrived (the resume test failed on CI that way). Each chunk is now written
  before the next is read, a partial write continued.
- **A mesh archive's index could name tiles outside the mesh**
  (`mesharchive.ts` `checkUnpacked`): a listed `../01CGD/x.bin` was found in
  the copy already on disk and passed for a tile the archive lacked. Every
  cluster folder and tile must lie inside the unpacked folder and every tile
  be a file.
- **Opening bridges after a repair detour pointed at the wrong waypoint**,
  and a bridge the detour passed under was not reported.
- **A route name with no ASCII letters downloaded as `.geojson`** (or
  `.gpx`), a hidden file; it is now `weather_route`.
- **The same rough cut could be built twice at once**: the rebuild after a
  mesh download (or the Rebuild button) and a route needing that rough cut
  each started their own child process. A lock file beside the rough cut
  (and beside each joins file) now lets one build at a time; the other waits
  and uses its result. A lock left by a process that is gone is cleared.
- **A server-only update could leave a browser on old web scripts**: npm's
  copies of unchanged web files are untagged and dated 1985, and the
  re-tagging ran only when their content changed. It now also runs when
  index.html does not carry the current tag.
- **Rough-cut tile edges used the fixed margins** (`coarse.ts`
  `boundarySeeds`): with any other clearance the tile-boundary record
  disagreed with the rough cut and its name. On the test box (2026-10-18) the
  0.5 m and 1 m records now differ for two of three meshes.
- **A cancel during the notes read was lost** (`index.ts`): the route worker
  clears its cancel flag when a route starts, so a job cancelled before it was
  sent to the worker ran anyway. It is now finished at once.
- **Server-Sent Events replayed nothing** when `Last-Event-ID` was not a
  number; it now replays everything.
- **Repair warnings** named the detour's own threshold ("set Min sail speed
  above 0") as if it were the user's setting, and `detour_motored` gave the
  leg number where every other warning gives the segment; warnings after a
  detour now move with its waypoints.
- **A mesh leg ran without CMEMS SMOC** when the worker's answer came from an
  area of another layout than the one the leg box alone would pick ("chunk …
  is not cached and the network is disabled"); the mesh process now loads the
  layout that answered.
- **A rough cut built for a boat or buffer differing past the centimetre was
  refused and never rebuilt** (a buffer saved in feet, 9.999999999999988 m):
  the rules are rounded to the centimetre the file name carries.
- **Tidal-harmonic currents on long routes** predicted whole grids again and
  again (more bins than the grid cache holds); points at their own times now
  predict only the cells they read. Same values.
- **The snap refusal** names the destination when its water cannot be
  reached from a stop, instead of telling the user to move the stop.
- **The OpenAPI document** lists `POST /api/meshes/rough-cut` and
  `POST /api/coastline/download`.
- **Routes no longer cross land outside the route's box**
  (`geo/landmask.ts`): a point or leg outside the land raster's box was
  counted as water, and with no coastline loaded there, routes went over
  islands (Caribbean, 2026-10-15: Aruba, Curaçao, Bonaire, Venezuela,
  Barbados); each such check also scanned every coastline ring near the
  leg (up to 1.8 s a check; the polish took 9 minutes on that route).
  Outside the box is now land. The map overlays' land rasters reach one cell
  past the view (`landcache.ts` `forBBox`), so the view's own north and east
  edges are not counted as land.

## [0.2.0-beta.2] - 2026-10-13

### Changed

- **No coastline fallback inside a chart mesh** (the owner's rule,
  2026-10-12; docs/drafts/mesh-no-gshhg-design.md part 1). A leg both of
  whose ends one mesh holds is routed on the mesh or fails with the
  mesh's reason (`pipeline.ts`): no route in the box, an end in a blocked
  triangle, a stretch against the current, no draught or air draft, no
  decoded forecast yet, or the mesh process failing. Before, each of these
  handed the leg to the coastline search with a WARNING line only; on the
  test box a Bahamas → Gulf route hit the 16 M triangle cap and the
  coastline search took it 123–140 km through water the mesh blocks for a
  2 m draught, drying at -1.2 m, marked validated with no warning. The
  mesh leg's refusal now carries its reason (`MeshRefusal`, `legrun.ts`,
  `meshlegtask.ts`) instead of "the mesh cannot take the leg (see the
  log)". Unchanged until their own parts: legs through waypoint circles,
  and legs with one end outside the mesh or the ends in two meshes.

- **The final depth check fails a stretch any covering mesh blocks**
  (`check.ts` `cover`). Where two districts' meshes overlap, the first mesh
  walked decided a stretch and the second was not heard: water one
  district's charts call too shallow passed if the other's called it
  usable. Their charts disagree in 3.6% of points in the 07CGD/08CGD
  overlap, 3.2% in 01CGD/05CGD, 0.1% in 05CGD/07CGD (test box, 100 points
  per shared tile, 2026-10-12).

### Added

- **Across the limits of the charts** (docs/drafts/mesh-no-gshhg-design.md
  part 5; `engine/mesh/waters.ts` `planWaters`, `plugin/meshwaters.ts`, child
  task `mesh-waters`, `pipeline.ts` `chartsLeg`). Any leg whose area a chart
  mesh meets is planned through the waters it crosses: a leg leaving the
  charts, entering them, crossing open water between them (out-in-out,
  in-out-in), or going from one district's mesh to another. The mesh decides
  wherever it has triangles; the coastline search plans only water outside
  every mesh, with every mesh's water as land; a leg moves between them only
  where a mesh's usable water meets open water (an exit or entry,
  `engine/mesh/exit.ts`), or between two meshes where both call the water
  usable (a transfer, from the joins below). The way taken has the fewest
  changes between charts and open water, then the fewest transfers between
  meshes; ways still tied are each planned and the cheapest taken (the
  owner's choices, 2026-10-13). The charts alone are tried first and the
  open-water map is built only when they hold no way (test box: Charleston →
  Chesapeake changed meshes in 4.8 s; the open-water map alone took 29.8 s).
  Replaces the exit and transfer handovers built earlier in this release
  (`pipeline.ts` `meshExitLeg`, `meshTransferLeg`, now removed; the files
  `engine/mesh/transfer.ts`, `plugin/meshexit.ts`, `plugin/meshtransfer.ts`
  and their child tasks are left in place, unused by the pipeline). A leg no
  mesh comes near is the coastline search's, as before.
- **Joins between meshes** (`engine/mesh/joins.ts`, child task `mesh-joins`):
  which piece of one mesh's water joins which piece of another's for this
  boat, recorded per pair and direction when a rough cut is built (both
  directions differ: 01CGD → 05CGD 192 piece joins, 05CGD → 01CGD 79) and
  read by the planner; tiles an area to avoid recomputes are scanned again
  under the request. Rough-cut builds with joins on the test box: 01CGD 47 s,
  05CGD 80 s, 07CGD/w090n17 146 s, 08CGD 124 s.
- **Refined router: motor if stuck** (`experimental/propagator.ts` `layOut`;
  the owner's choice, 2026-10-13): with a sail threshold above 0, a beat the
  tack layout cannot tack in the water there is timed straight by the
  simulator, which motors in the no-go angle, as the standard router does,
  with a WARNING naming it. At a threshold of 0 such a beat still fails the
  route (test box: the Cape Cod Canal replay 7306dc97, an open issue).
- **Tile builders finish their own tiles** (`plugin/worker/query.ts`
  `buildTile`, `TileStore.adopt`, message `build-tile`): a prebuilt tile is
  answered, encoded and written to a temporary file beside it by the builder
  process; Signal K's main thread only checks the data generation and moves
  the file into place (a tile built while the data changed is deleted).
  Before, every prebuilt answer crossed to the main thread, which encoded and
  wrote it. Test box, 180 s each: Signal K's main thread 41.3 % → 31.9 % of a
  core, the whole process 68.7 % → 43.2 %, 124 → 183 tiles a second (not the
  same tiles: indicative).
- **The prebuild follows the map's whole view** (`plugin/prebuild.ts`
  `ViewTracker`): the view is taken from a burst of tile requests once no new
  tile has come for 5 s, as the middle of all its distinct tiles at its
  deepest zoom; a view shallower than zoom 6 (the shallowest built) leaves
  the last view as it is. Before, the view was the deepest zoom asked for in
  the last 5 s: with a zoomed-out Atlantic view's tiles answered in 12–21 s,
  that was its north-east corner tile, and the prebuild built northwest
  Russia down to zoom 15 for every hour (test box, 2026-10-13). Test box
  after: the view followed the map to Jamnagar, the Strait of Messina and the
  Channel Islands, each the middle of the map's own requests.
- **Each layer built ahead at its own data's steps** (`plugin/prebuild.ts`
  `hasStep`, the prebuilder's `atStep`): the forecast's layers (wind, waves,
  rain, air and sea temperature, barbs, isobars) at its 3-hourly steps, the
  current layers (current, sea state, arrows) at an RTOFS or SMOC step (every
  3 h with the default settings; every hour when tidal harmonics are
  loaded), tide height every hour. The map draws the hours between on
  demand, interpolated as before; routes are unaffected (they never use
  tiles). Before, every layer was built for every hour, so two of every three
  wind, wave and current tiles were interpolations built ahead, and every new
  forecast cycle built them again.
- **A map view builds what the map showed** (`plugin/prebuild.ts`
  `ViewTracker`, `coveringTiles`): the view's tiles at its zoom (and the
  isobar tiles over them), every step of the window; the boat keeps the
  pyramid round it. Before, every place a map paused on got the boat's whole
  pyramid (zoom 6 to the deepest, the full radius): on the test box a few pans
  by another app's map built over 60,000 tiles in 24 minutes, two cores busy,
  and had not finished. Test box after (2026-10-14): a pan to southwest
  Florida built 2,127 tiles for its final view in 77 s; the 06Z forecast cycle
  rebuilt about 70,000 tiles in about 7 minutes at 180–200 a second, and the
  box went quiet (5.8 % busy) for the rest of the hour. The night before,
  after the 00Z cycle, the builders were still busy 8½ hours later.
- **New installs check for a new forecast cycle every 15 minutes**
  (`plugin/settings.ts`, `forecast.refreshInterval` default 900 s, was
  3600 s): a check is a few small requests to the mirror, and a new cycle is
  picked up up to 45 minutes sooner. Existing installs keep the value in
  their settings.json; it is on the Defaults tab.
- **A stop the mesh snap moved is reached on its circle** (`multileg.ts`
  `Stop.snapped`; the owner's choice): a moved waypoint or destination
  becomes approximate, its circle the distance it was moved, in either
  precision; the mesh routes it as an approximate waypoint (part 3). The
  moved point is on the edge of unusable water; under sail alone the last
  2.6 m into a shoal's corner, dead upwind, could not be laid out (test box,
  replays 1c7e6fa5 and 7443bcb9).
- **Refined layout: tacks as long as the water allows, no fixed 500 m
  minimum** (`experimental/propagator.ts`, `LandTest.clearAlong`: exact on
  the chart mesh, to the raster's cell on the coastline): a tack cut short
  for land is cut to the room on its heading instead of halved down to
  500 m, and halving for the wind stops at the simulator's step. A beat up
  a channel narrower than 500 m can now be laid out (test box: the last
  97 m into a waypoint, 45 and 137 m of water either side, failed under
  sail only). A tack ends only where the boat can go on (nearer
  the target, and the target straight from there or room on the next
  tack's heading): a tack taken to the bank at a bend boxed the boat in
  (test box, the Cape Cod Canal replay 7306dc97); the edge is tried first,
  then ends back along the tack, halving: from the shore down to the walk's
  own precision, for the wind down to the simulator's step (a 200 m floor on
  both left a 239.5 m first tack from a corner with no shorter try, though
  119.7 m left 214.7 m for the next; replay d6d067cb).
- **A point on a corner or an edge belongs to every triangle it touches**
  (`PagedMesh.locateAll`; the tile-extent test with the walk's tolerance):
  the reach and the snap take the route's water if any of those triangles
  is in it, and the mesh search starts from all of them and arrives at any
  (`meshAstar` with several start and end triangles). A snapped waypoint on
  a corner shared with a separate pocket was refused ("no water connects",
  test box 2026-10-12, replays 1c7e6fa5 and 7443bcb9).
- **Snapping on the chart mesh** (docs/drafts/mesh-no-gshhg-design.md part 2;
  child task `mesh-snap`, `plugin/meshcoarse.ts`): in water a mesh covers,
  the start, destination and exact waypoints are moved, by the mesh and not
  the coastline, to the nearest water the boat can use that connects to the
  route (the rough cut's groups), within 1,000 m (the owner's choice; farther
  is an error naming the nearest usable water); a stop in water that does
  not connect (a pond) moves out with a WARNING. Approximate waypoints are
  left to their circles. Stops outside the meshes keep the coastline snap.
  A point's triangle is now found with the walk's own tolerance
  (`paged.ts` `locateIn`, width.ts `U_TOL`), and the mesh search finds its
  ends preferring usable water: a snapped stop lies on the edge of usable
  water and, handed on as lon/lat, was judged in the buffer (test box,
  2026-10-12: a start moved 684 m, then refused).
- **Refined router: light-air motoring under sail_max is kept**
  (`experimental/propagator.ts` `sailedThrough`, `legsim.ts`
  `motoringNoGoSeconds`): the tack layout refused any piece the simulator
  motored, so a stretch the sail threshold motors in light air failed the
  route ("cannot be sailed under the sail_max policy"; the Gulf coast
  replays on the test box, 5.1 kt held past the forecast's end). The
  simulator now books the seconds motored in the polar's no-go angle
  apart, and only those split a piece into tacks. The error's advice to
  raise the sail threshold is now what happens.
- **The mesh's straight walk at corners and edges** (`engine/mesh/width.ts`
  `walkMesh`, one walk for the land test, the depth check, opening bridges,
  passage widths and a route's end triangle): a walk starting at, or passing
  through, a triangle corner or edge enters the triangle its direction goes
  into, and a direction along an edge (within the walk's own tolerance)
  takes the usable side: touching blocked water is not crossing it. Before,
  a mesh route's own segments, which turn at corners of blocked water, were
  rejected by the land test: 57 of 11,967 segments over the 50 test cases
  on the test box, 0 after (2026-10-12); 11 of the 13 routes failing in the
  sail layout failed on such a segment.
- **The rough cut answers for the search** (docs/drafts/mesh-no-gshhg-design.md):
  built from the paged mesh's own tile reads (`buildCoarseMap` over
  `PagedMesh`), so its blocked sets are the search's: the buffer from
  unusable water and the Drawbridges choice are in it and in its key
  (`-v3-d…-a…-b<buffer>-<o|x>`); a tile's blocked set and buffer are now
  computed in the tile's own frame, the same for every leg. Areas to
  avoid are applied per request (`PieceGraph` recomputes the tiles they
  touch). The reach task finds each approximate waypoint's aim (the
  nearest usable water connected to the start, `nearestUsable` with a
  filter) and the leg searches to it. Fixes a waypoint aimed at a pond and
  a search that read 42.6 M triangles (2.3 GB, 114 s) before finding no
  water the rough cut had called connected (test box, 2026-10-12). Rebuild
  the rough cuts after updating.
- **Approximate waypoints on the mesh** (docs/drafts/mesh-no-gshhg-design.md
  part 3): a leg through waypoint circles inside one mesh is no longer sent
  to the coastline search. `searchMeshRun` searches start → circle → … → end
  on the paged mesh, each piece cut where it enters its circle
  (`trimAtCircle`); the open stretches get the circles as vias, the reach
  (`mesh-reach`) goes through them. An approximate waypoint the boat cannot
  use is aimed at the nearest usable water (`PagedMesh.nearestUsable`, exact,
  no distance limit), with a WARNING when that is outside its circle (the
  owner's choice). `meshRulesFor` no longer refuses legs with vias.
- **The mesh read on demand, no search area** (docs/drafts/mesh-no-gshhg-design.md
  part 4 revised; `engine/mesh/paged.ts`): the mesh search, the sailed
  stretches' land (`MeshLand`) and the final depth check read the mesh a
  tile at a time as they reach it, with global triangle ids; the search
  (`astar.ts`) keeps its bookkeeping per tile and drops a tile's chart data
  when no node of its frontier lies there (checked every 1024 expansions),
  the leg drops its tiles after each stretch, the depth check after each
  5 km piece. Replaces the boxes of 0.5°, 1° and 2° around a leg's ends,
  their 16 M triangle cap and the corridor of the first part 4 build.
  Measured on brain with read-only scripts (31 legs): every leg routed,
  median 1.16 M triangles read, the largest leg 1.1 GB held instead of
  2.8 GB, route cost unchanged by the dropping.
- **The rough cut** (`engine/mesh/coarse.ts`, `plugin/meshcoarse.ts`, child
  tasks `mesh-coarse` and `mesh-reach`): per mesh build, draught and air
  draft, the usable water as pieces per tile linked across tile edges,
  in `mesh-coarse/` in the data folder (`<key>-v2-d…-a….json`, and `.bnd`
  with the tile-boundary triangles blocked for the boat and the opening
  bridges among them). Before a leg inside one mesh is searched it says
  whether water connects the ends (else the leg fails with the reason)
  and gives the box of the tiles that water runs through, added to the
  forecast and currents area. The buffer from unusable water is grown per
  tile as it is read, seeded across tile edges from the `.bnd` file
  (`growBlocked` `outerSeeds`). Built after a download or update, on the
  panel's *Rebuild rough cuts* button (`POST /api/meshes/rough-cut`,
  status in `GET /api/meshes` `rough_cut`), and by a route that needs
  one; not at start (the owner's choice). Version 1 files are removed by
  the next rebuild's prune.
- **Final depth check** (`engine/mesh/check.ts`, `plugin/meshchecktask.ts`,
  child task `mesh-check`): every finished route is walked through every
  mesh it meets, triangle by triangle with `MeshLand.forEachTriangleAlong`
  (which now reports each triangle's stretch and how far it got), against
  the route's blocking rules without the buffer. Any blocked crossing
  fails the route, naming up to three places and the count. Per leg the
  route records its source (`legSources`: mesh, coastline, mixed) and what
  it crossed (`depthCheck`); the summary has `depth_checked` and
  `legs_detail`, the GeoJSON `depth_check`, the log a "depth check:" line.
- **Web app:** the result strip shows *Chart depth checked* (shallowest
  depth, distance with no charted depth, distance outside the mesh, legs on
  coastline data). A new request removes the route on the map (line,
  skeleton, fronts, strip, name; the markers stay); a failed request leaves
  no route on the map (the owner's choice, 2026-10-12, replacing the
  earlier-route mark).

### Fixed

- **A point's triangle in any tile that reaches it** (`engine/mesh/paged.ts`
  `tilesAt`): the lookup searches every tile whose extent holds the point.
  It searched the 3 × 3 index cells round the point, and missed a triangle
  about 40 km across in 07CGD's tile (4, 42) covering a point two cells away,
  and two joins in the Gulf for the same reason (test box, 2026-10-13). A
  point a hair west or south of a tile's extent (a lon/lat round trip) is
  found too: the lookup grid's cell is clamped and the triangle test decides.
- **The nearest usable water lets go of what it scans**
  (`PagedMesh.nearestUsable`): the tiles it reads are dropped once checked,
  but the one holding its answer; with a filter (water connected to the
  route) it could otherwise hold every tile of a district mesh.
- **Web app:** a new route keeps its job: Publish, Delete, the name bar and
  the points of sail work on it (the job's id and name were cleared as the
  request started). A request that fails leaves no route behind: the plan
  hint no longer says "Click the route" and GPX does not export the previous
  route.
- **README:** the `POST /api/routes` table says a destination the chart
  mesh's snap moved is reached within the distance it was moved, not
  exactly.

## [0.2.0-beta.1] - 2026-10-09

### Added

- **Follow the boat** (Live vessel panel, LIVE and SIMULATE): a checkbox,
  on by default, that keeps the map centred on the boat. A real drag of
  the map (more than 10 px) unticks it; before, any pointer movement with
  the button down, a wobbling tap included, stopped the following silently
  and only the centre-on-boat button or restarting the mode resumed it.
  Ticking the box, the centre-on-boat button, or starting LIVE or SIMULATE
  follows again.
- **Your copy or the download**: a mesh that is both downloaded and in
  your own folder gets a *downloaded / my folder* choice on its row
  (`mesh.preferLocal`, `mesh.preferDownload`, saved with Save), the copy
  in use ticked; until you click, the newer build is used, as before. The mesh
  list says which copy is in use and why (`using_why`: your choice, the
  newer build, or the only copy; `copy_choice`). Review of PR #37: an
  action arriving while the loop's pass is downloading is applied by one
  more pass straight after; *Download again* fetches even when your
  folder's copy is newer, and a failed fresh fetch is retried at the
  next pass; Save is disabled while a mesh action is in flight; the
  action route's path parameters are declared in the OpenAPI document.
  Found by the new test: a stop during a running pass armed the daily
  timer after the abort, leaving a day-long timer behind; no timer is
  armed once stopped. Second review: Download and Update pressed on the
  panel fetch past a newer copy in your folder (the daily pass still
  leaves it alone), and a Download again pressed while that mesh is
  downloading is kept for the next pass.
- **Plugin configuration page reworked** (`public/remoteEntry.js`):
  the Chart meshes card has the catalogue line and a "Check for updates"
  button on the card, one table (Mesh, Area, Published, On this server,
  Use, Actions) with per-mesh buttons that act at once through
  `POST /api/meshes/{name}/{action}` (readwrite): Download, Update,
  Download again (the current build fetched afresh into the temporary
  folder and swapped in when complete; the served copy is untouched
  meanwhile), Remove, and Cancel while downloading. The plugin keeps the
  download list in its own options (`app.savePluginOptions`, no
  restart) and answers the list, which the form adopts so a later Save
  does not put an old list back. Your own folder's meshes are in the
  same table; a kept name that is neither published nor in your folder
  reads "unknown name" with Remove. The Tidal currents card and its
  Harmonics folder row are off the page (the setting and the code stay).
  The Map tiles card says in plain words what each setting does and
  shows what is built; the Coastline card shows when the coastline was
  installed (`/api/status` `coastline.downloaded_at`); the Forecast card
  shows the last run fetched; the banner is one line.
- **Read the catalogue now** (plugin panel, Chart meshes → Where meshes
  come from): `POST /api/meshes/refresh` (read-write) reads the mesh
  catalogue at once, answers with the mesh list as `GET /api/meshes` does,
  and then runs the usual pass (download ticked meshes that are missing or
  have a newer build, delete unticked ones). Until now the catalogue was
  read only at start and once a day, so a catalogue published after the
  plugin started was not seen for up to a day.

- **Managed chart meshes** (`src/plugin/meshes.ts`): the plugin panel
  lists the meshes a catalogue publishes (`mesh.catalogUrl`, default the
  US-ENC catalogue on R2) with a description built from the catalogue
  (area, chart and mesh dates, size, triangles) and a tick box each;
  ticked meshes are mirrored file by file into `<data dir>/mesh/<name>/`
  by a child process, swapped in when complete, re-downloaded when the
  catalogue's build is newer (checked daily), deleted when unticked.
  `GET /api/meshes` and `/api/status` `meshes` report each mesh's state.
  The route worker uses whichever ready mesh covers a leg (multi-cluster
  meshes as one store per cluster), beside the `meshDir` folder.
- **Chart mesh routing** (`src/engine/mesh/`). With a navigation mesh
  configured (`meshDir` in the plugin config), a leg inside it is routed
  on the charts: triangles carry charted depth, vertical clearance,
  rocks, wrecks and obstructions, marks, structures and fairways, and
  are blocked against the vessel's draught and air draft (Signal K
  `design.draft.maximum` and `design.airHeight`; `vessel.draught_m` and
  `vessel.air_draft_m` in a request override them). Motor legs run as an
  A* over the mesh with the funnel algorithm; sailing legs motor the
  narrow passages (both shores within 1 km) and sail the open stretches
  with the open-water router; a leg with one end outside the mesh is
  routed on it to the first open water after the last narrow passage
  within 50 km and handed to the coastline search there. The mesh search
  runs in a child process that exits with the leg. Summary `mesh`.
- **Search method** on the Route tab (request `search`: `normal`,
  `moderate`, `maximum`; `src/engine/search/presets.ts`): `moderate` is
  stages 40, 100 cross-track bins and headings ±60° at 1°, `maximum` 150
  bins at 0.5°; `normal` is the routing settings untouched. Measured on a
  Raspberry Pi 5: on a 1,240 km passage `moderate` arrives 80 minutes
  earlier than the standard beam in 128 s (17 s standard), `maximum` 94
  minutes earlier in 363 s; on a 5 h harbour beat 29 and 32 minutes earlier in about 5 s.
  The summary carries `search`.
- **Open-water router toggle**: request `router` (`standard` or
  `refined`), setting `routing.router`, a selector on the Route tab
  beside Method; the summary and `/api/status` say which runs. An (i)
  beside it opens `public/routers.html`: how each router works, where
  they differ, and the measurements, with diagrams.
- **Refined router** (`src/engine/experimental/`): the isochrone
  search on a convexified polar (a beat is a straight leg at its exact
  VMG), every sailed leg laid out afterwards forward in time in steps of
  at most 9,260 m (at each step the wind there decides between a tack,
  30 s each, and a straight step; a leg that cannot be sailed fails the
  route rather than getting an invented time), and a cross-track polish that moves waypoints sideways where the
  route then arrives earlier. GeoJSON points carry `tack: true` on tack
  points. Measured on a Raspberry Pi 5 against the isochrone router
  (same forecast run, fixed departures): harbour beat 17,234 s vs
  18,659 s; offshore reach 36,235 s vs 36,469 s; 1,240 km passage
  382,041 s vs 383,615 s.
- Mixed sail/motor legs carry their split, so the totals count the
  motored part of a leg that starts under power and ends under sail.

### Changed

- **Defaults tab: every number is a slider**, the value and unit beside
  the label, bounds and step from the setting's schema (`step`, SI, new
  in `/api/settings`' schema and the OpenAPI description) converted to the
  user's unit. The two settings that can be "none" (max wind, max wave
  height) have a "no limit" box. A value saved earlier that is off the
  slider's step shows as saved until the slider moves. Text boxes are
  gone, so the finest value is the step (0.1 kt for speeds, 1 m for
  simplification, 5 s for the tacking penalty, 30 s for the bridge wait,
  10 m for the buffers and the simulation step, 1 h for horizons).
- **Drawbridges** is a Defaults setting only (`routing.drawbridges`,
  default ask); the Plan sub-tab's select is removed. The "re-plan
  avoiding drawbridges" button sends `drawbridges: avoid` for that one
  request and leaves the setting as it is. The Plan sub-tab's Method
  label reads Effort.
- **Buffer from land** (Defaults → `routing.landBuffer`, metres, default
  0): on a coastline leg the route keeps at least this far from the
  shoreline. The land raster is grown by the buffer (`LandMask.withBuffer`,
  a two-pass dilation; local patches the same) and the exact polygon tests
  count a point within the buffer of a shoreline edge as land and a move
  that comes within it as crossing land, so the search, the smoother and
  the final check all keep it. A start or end closer than the buffer is
  moved out to it (the 150 m clearance becomes the buffer when larger); a
  corridor passage narrower than twice the buffer fails the route naming
  the passage. On a mesh leg the mesh's own edge is not yet grown by it
  (the growth of the blocked set is being reworked for speed).
- **Buffer from unusable water** (Defaults → `routing.navigableBuffer`,
  metres, default 0): on a chart-mesh leg the blocked set is grown once
  per leg by exact distance from its boundary (`growBlocked` in
  `src/engine/mesh/route.ts`: a usable triangle whose nearest point is
  within the buffer of an edge between blocked and usable triangles is
  blocked too), so the mesh route, the passage widths, the search, the
  tack layout and the polish all keep that distance. A start or end
  inside the buffer is refused with the distance; a passage narrower than
  twice the buffer closes. The log reports the triangles added and the
  time. The growth is one nearest-first flood over the triangles, which
  misses a few tenths of a percent of the triangles within the buffer
  (measured on brain, the exact walk being 3 to 12 times slower); the
  exact alternative is described in the code.
- **Opening bridges** (the mesh build of 2026-10-08 marks them, flag bit
  7, and stores their open clearance): the clearance rule applies to the
  open clearance; a request's `drawbridges` (or Defaults →
  `routing.drawbridges`, default `ask`) is `ask` (plan as open, report the
  bridges crossed in the summary, the log and the web app, which offers a
  re-plan avoiding them), `open` or `avoid` (every opening bridge
  blocked). `routing.bridgeWait` (seconds, default 0) is added at each
  bridge passed under; the GeoJSON carries `drawbridges`. Older meshes
  have no bit 7 and behave as before.
- **Tacks as long as the wind and the land allow** (the refined router's
  layout): a beat is laid as two legs, one tack, and a leg is split only
  when the real polar cannot sail it all the way under sail (the forecast
  wind veering into the no-go angle) or it crosses land or the mesh; then
  the longest piece that can be sailed is taken and the layout looks
  again from there. Until this evening tacks were chopped at a fixed 5 nm
  whatever they cost, so the tacking penalty added time but could never
  lengthen a tack (measured 2026-10-08: 22 tacks with the penalty, 16
  without, on a test beat).
- **Tacking penalty** (Defaults → `routing.tackPenalty`, seconds, default
  30): the time lost on every tack or gybe, charged by both routers. The
  standard search charges it on a move that puts the wind on the other
  side of the boat from its parent's heading (time and rank) and on the
  final beat's tack; the refined router's layout uses the setting in place
  of its 30 s constant.
- **Min sail speed** on the Route tab's Plan sub-tab, beside Method,
  Router and Smoothing (it was under Options → Sailing strategy); same
  control, same request field (`sail_thresh_ms`), remembered per browser.
- **Smoothing** on the Route tab's Plan (Default / On / Off): the
  request's `smoother`, beside Method and Router, remembered per browser.
  The shortcut smoother runs for both routers (2026-10-08, the owner's
  decision; before that evening it was forced off for Refined): it times
  every shortcut with the real polar, so two laid-out tacks become one
  straight leg only where that course is sailable within the tolerance.
- **Web app tabs.** The Setup tab is gone: its sections (vessel, sailing
  strategy, waypoint behaviour, solver tuning, live re-plan triggers) are
  the **Options** sub-tab of the Route tab, beside **Plan**; the stages
  slider is dropped (the Method choice replaces it). The Settings tab is
  **Defaults**. The forecast-data block (what is loaded, refresh) is on
  the Log tab; the units note is in the Defaults header.
- The open-water search is reached through one seam (`src/engine/router.ts`)
  for a plain leg and for each open stretch of a mesh leg.
- `MinHeap.peekKey()` (engine/heap.ts).

### Measured, not changed

- A wider isochrone beam (`routing.stages` 40, `routing.subsectors`
  150, `routing.headings` 120 at 0.5°) arrives 94 minutes earlier on a
  1,240 km passage than the standard beam, at 21 × the wall time (363 s
  vs 17 s on a Raspberry Pi 5), and 32 minutes earlier on a harbour beat.
- Displacement (motion-compensated) interpolation of the forecast in
  time, tested by rebuilding dropped frames of a decoded run: no gain
  over the linear blend (speed RMSE 0.95 vs 0.88 m/s at 6 h gaps on a
  slow-moving pattern). Not adopted.

### Fixed

- Review of PR #34, seven code points: (1) a leg whose ends lie in two
  different meshes was planned as one mesh leg, the runner opened the
  start's mesh, the search reported the end outside and the whole leg fell
  back to the coastline search; one mesh must now hold both ends, else the
  handover applies (`src/engine/pipeline.ts`, the runner prefers the mesh
  holding both). (2) A mesh download interrupted and resumed after the
  catalogue published a newer build kept tiles of the old build when
  their size matched; `.progress.json` now records the base URL and build
  and a folder started for another is cleared (`childtask.ts
  downloadMesh`). (3) A `01CGD.old` folder left by a swap counted as a ready
  mesh of its own; `.old` is skipped and removed with an unticked mesh.
  (4) The tacking penalty was in the total but not in the sailing time, so
  sailing plus motoring fell short of the total by the penalty per tack
  (golden beat: sailing 30121 s against a total of 30391 s, nine tacks);
  it counts as sailing time in the search and the final beat, and the
  golden fixture is re-recorded (sailing 30391 s). (5) A multi-segment mesh
  leg lost `smoother_drops` in the stitch. (6) A Signal K draught or air
  height outside the vessel bounds (0.1–30 m, 0.5–100 m; an air height in
  the wrong unit) made every route throw; it now reads as unknown and only
  disables the mesh (`selfDesignValue`). (7) `GET /api/meshes` and
  `POST /api/meshes/refresh` in the OpenAPI document, with `meshes` and
  `router` in the status description. Text: the off-course tooltip and
  README named tabs that no longer exist; the panel's mesh help; the
  README said narrow-passage tacks are checked against the coastline (they
  are tested against the mesh) and three places said the refined router
  never smooths.
- **A leg starting (or ending) just off an open coast inside a chart mesh
  never used the mesh**: the mesh handover looked only for narrow water
  (both shores within 2 km across the track), so a start 3.4 km off a
  straight coast (Lake Superior's south shore, 2026-10-09, distance to
  GSHHG full-resolution land) read as open water and the coastline search
  took the whole leg, with no charted depths, shoals or hazards near the
  shore. The handover now also needs
  the corridor to be clear of land: the first point after the last narrow
  one with no land within 5 km (`SHORE_CLEAR_M`; 2 km was tried first and
  left a start 3.4 km off the same shore to the coastline search; a new
  per-point distance to land on the corridor, `Corridor.shoreM`), staying
  clear at the next point. Within the 50 km scan cap as before; a leg still near land at the
  cap hands over there, and the log says which (`Handover.reason`).
- **A local chart mesh blocked a newer published mesh of the same name**:
  a ticked catalogue mesh whose name matched a mesh in the `meshDir`
  folder was never downloaded, however new the published build, and the
  router always tried a downloaded copy before a local one, older or not.
  Now the newer of the two is used (`localWins`): the local mesh's
  sidecar `build_date` against the catalogue's (for the download) or the
  marker's (for the router, `meshesToOpen`); a local mesh without a
  sidecar date loses. The plugin panel shows one row per name, saying
  which copy is routed on (`using`, `local_dir`, `local_build_date` in
  `GET /api/meshes`), and its Use box covers both copies.
- **Mesh legs had no CMEMS SMOC currents while the Copernicus run was
  provisional** (its store update still being written, hours at a time):
  the chunk cache on disk was written only for a settled run, and the
  mesh process reads the disk only, so it fell back to lower-priority
  sources while the coastline legs of the same route had SMOC. A
  provisional run now has its own cache directory, `<run>.provisional`,
  and every run is cached and read alike; the settled run of the same
  key never reads it, and it is dropped when the settled run replaces it
  or pruned afterwards (`ArcoClient.dropProvisionalRun`, `pruneRuns`
  by run). The same client serves the sea-level (tides) store.
- **Mesh legs asked SMOC for a different area than the worker had loaded**:
  the worker loaded the leg's start-to-end box padded 0.5°, the mesh
  process asked for the mesh search box (padded up to 2° when the mesh
  route does not fit) plus a margin, and a chunk outside the worker's box
  was not on disk. The worker now loads the forecast and the currents for
  the widest box the mesh search can use (`MESH_BOX_PAD_MAX_DEG`), and
  passes the SMOC box and step list it loaded to the mesh process in the
  task, which asks for exactly those, so both sides pick the same layout
  and the same chunks. The mesh log line says which run and how many
  steps were read.
- The job's event stream (`/api/routes/:id/events`) reached the browser
  only when the job ended: Signal K gzips responses the browser accepts
  compressed, and gzip buffers the stream to its end, so the web app's
  Log tab stayed empty for every running job and filled in one lump on
  done or failed. The stream is now sent with `Cache-Control: no-cache,
  no-transform`, which the compression layer honours; lines and
  keepalives arrive as written. Live re-plans use the same stream.
- On a chart-mesh leg the simplification and the shortcut smoother did
  not run at all (they ran only after the coastline search, and the mesh
  leg's planner, moved into the mesh process on 2026-10-08, had neither),
  so the Smoothing choice did nothing there and even the Standard router's
  route kept every search step. Each searched stretch of a mesh leg now
  gets the same two steps as a coastline leg, with the mesh as land, so a
  shortcut is taken only where the mesh allows it, for both routers.
- A mesh leg's open stretch whose search failed was motored whatever the
  request asked (job 1c1fda5b, 2026-10-08: 106 km around the outside of
  Cape Cod motored under sail_max with a sail threshold of 0). It now
  follows the mesh route under the request's own mode: under sail_max it
  is laid out as the refined router lays out its legs (tacks where the
  wind there and then needs them, motor only below a positive threshold)
  and fails the route naming the segment when a stretch cannot be sailed;
  under fastest it is walked choosing per step. With a sail threshold of
  0 the narrow passages are sailed along the mesh route the same way
  instead of motored.
- **The sailed stretches of a mesh leg ignored charted depth** (job
  20e5c6ef, 2026-10-08: off Monomoy the search cut across 2 m shoals and
  put waypoints on them; it tested its legs against the coastline alone,
  which has no depths and draws the island differently from the chart).
  The whole mesh leg is now planned in the child process that holds the
  mesh (`src/plugin/meshlegtask.ts`, `src/engine/mesh/legrun.ts`): the
  search, the tack layout, the polish and the smoother test every move by
  walking the mesh triangles (`src/engine/mesh/land.ts`, the walk that
  measures passage widths), so no leg of a mesh route can cross a
  triangle the boat cannot use. The child reads the forecast window, the
  regional runs, the cached currents and the polar from disk (the worker
  fetches on-demand current areas first, as before) and streams its
  progress and stage fronts. The land checks the routers make are typed
  on a `LandTest` interface the coastline raster and the mesh both
  answer. A leg the mesh cannot take still falls back to the coastline
  search; a leg that cannot be sailed as asked fails the route with the
  reason, as before.
- **Waypoint depth**: `depth_m`, always null until now, is the charted
  depth of the mesh triangle under each waypoint of a mesh leg (a contour
  corner reports the usable side); the itinerary shows it.
- With the chart's shallows blocked, the refined router's tack layout
  could not gybe inside the passage south of Monomoy (job a0a18bcb: a
  channel narrower than the shortest tack, dead downwind) and failed the
  route although the polar runs dead downwind. When no tack fits and the
  real polar sails the course straight along a clear line, the course is
  sailed straight; only a course the polar cannot sail fails.
- A search candidate landing exactly on the destination (the stage step
  dividing the distance) got a final hop of millimetres, so the route
  ended with the same point twice and a zero-length leg; a final leg
  under 1 m is dropped and the candidate's waypoint takes the exact end.
- A mesh leg whose route must swing further out than half a degree beyond
  the box around its ends was a silent "no route on the mesh" and fell back
  to the coastline search (job aeedeb52, 2026-10-08: Block Island to the
  canal's east end, the way round Nauset at 69.91°W outside a box ending
  at 69.96°W). When the search finds no route the box is widened to 1°,
  then 2°, and searched again, unless the wider box would read more than
  16 M triangles (about 2.2 GB in the child process by arithmetic from
  the array sizes; the first box of that job read 8.2 M, its 1° box
  11.8 M by the index); the log says when the box was widened, and the
  failure names the box and the cap.
- The open-water search between two narrow passages of a mesh route drew
  its own coarse skeleton on the coastline instead of using the mesh
  route (job 219300ca, 2026-10-08: the coarse
  skeleton cut across the tip of Monomoy, every first-stage candidate
  towards it was on land, the one survivor went up the wrong side of the
  island and the search was boxed in after 20 stages). The mesh route and
  its passage widths are now the search's corridor (`meshCorridor` in
  `src/engine/pipeline.ts`); water that reached the ray walk's 4 km cap
  on both sides counts as open, so the search keeps its freedom to leave
  the line. Measured on brain from the same start: 19 stages, arrival
  13:58Z, where the coastline skeleton was boxed in.
- The mesh funnel could emit a corner vertex twice when the crossed edges
  fan around it (a zero-length leg in the mesh route; the motored walk hid
  it, the tack layout refused it). A point equal to the last one emitted is
  skipped, as Recast's `appendVertex` does; the route's geometry is
  unchanged, with one point fewer where a corner was emitted twice.
- Apply the GSHHG L1/L2/L3/L4 land/water hierarchy to global water grids,
  route rasters, refined masks and exact polygon checks. The full global
  grid is rebuilt from all four levels; old overlay caches are invalidated.
  Lake Michigan is water and routable while Michigan remains land, with
  regression coverage including the beta.6 `wrp-route` full pipeline.

## [0.1.2-beta.1] - 2026-10-06

Memory work on a Raspberry Pi 5 (8 GB). Signal K's memory stepped up with
use and never came back down. Measured on brain on 2026-10-06: Signal K
used about 600 MB without the plugin and 2,550 MB after six hours with
it (0.1.1). The plugin's own data was not growing: heavy bursts of work
inside Signal K's process freed memory that glibc kept for the process.
This release moves the bursty work out of Signal K's process, or stops
it holding duplicate data.

### Added

- **Zoom to a computed route.** When a route comes back from the router
  the map fits the whole track beside the panel, as it already did for a
  route opened from the library.
- **Confirmation for a far waypoint.** Adding a waypoint more than
  500 km from the previous one asks first: add it, clear the route and
  start a new one at that point, or cancel. Distances are shown in the
  Signal K user's distance unit.
- **`overlay_land.polygons` in `/api/status`:** the per-thread cache of
  decoded coastline polygons (entries, bytes, budget, hits, decodes,
  evictions).

### Changed

- **Tiles are built ahead of time by separate processes, not threads.**
  The builders start when the walk has a tile to build and exit when it
  is complete, so their memory goes back to the system. A thread's
  memory stays with Signal K until it restarts. Measured on brain: when
  the two builders exited at the end of a walk, Signal K plus the
  builders went from 1,404 MB to 820 MB. While they run, each builder
  holds its own copy of the current, tide and RTOFS data (about 280 MB
  each measured), because shared memory cannot cross processes. The
  `overlayCache.workers` setting now counts processes.
- **RTOFS is loaded once and shared.** The data worker loads it into
  shared memory and passes it to the route worker, the way the SMOC
  currents already were. Before, every worker loaded its own 46 MB copy.
  Measured on brain: the data worker's buffers went from 154–228 MB
  (0.1.1) to 47 MB.
- **Old map tiles are deleted by a separate process.** A new forecast,
  currents run or tide run makes a whole folder of tiles obsolete
  (about 823,000 files after one forecast on brain). Deleting them on
  Signal K's main thread left 537 MB that was never handed back
  (measured, 0.1.1); a child process now counts and deletes them and
  exits. The saving in this release is not measured yet.
- **Regional GRIB runs are decoded by a separate process.** Runs from
  signalk-grib-downloader are decoded in a child process that exits when
  done. Measured in 0.1.1: each decode left 86 MB with Signal K. The
  saving in this release is not measured yet.
- **The tile store keeps its totals.** The file count and size are saved
  in `.totals.json` in the tile folder and read at start, instead of
  walking every saved tile (over a million on brain) on Signal K's main
  thread at each start; a removed folder is subtracted, and a day-old
  total is recounted in the background without building a list.
- **Coastline polygons are decoded once per thread** and kept in a small
  cache (24 MB, records over 2 MB not kept), for routes and map land
  masks alike; the shapefile reader and the current/tide chunk decoder
  free their large buffers after each read.

### Fixed

- **06z and 18z forecast runs are used again.** With a forecast horizon
  that is not a multiple of 3 hours (110 h on brain), the rule for which
  run should be published rejected every 06z and 18z run, because their
  last 3-hourly step (108 h) fell short of the horizon. The plugin
  stayed on the 00z run all day while the 06z run had been out for
  hours. A run now counts when it reaches the horizon (06z/18z: 144 h),
  so the forecast updates four times a day instead of twice.
- **The chunk decoder frees its buffers when a load fails,** not only
  when it succeeds.
- **Tile-store totals stay correct** when a tile is written again, when a
  save overlaps another, and when the plugin stops (the totals are saved
  before a restart starts the plugin again).

## [0.1.1] - 2026-10-05

### Changed

- **Published as a regular release, outside the beta channel.** 0.1.1
  carries everything in 0.1.0-beta.9 (below) plus the fix that follows.

### Fixed

- **Style B's legend lists only the sea states it draws.** "Current
  against the waves" in style B marks only a choppy or rougher sea, but
  its colour key showed all six bands; it now shows choppy, rough and
  extreme. Styles A and C, which draw at every point, keep all six.

## [0.1.0-beta.9] - 2026-10-04

### Added

- **Cloud cover and wind gust in the Weather API.** With the extra
  fields on (the default) the plugin also fetches ECMWF's total cloud
  cover `tcc` and 10 m wind gust `10fg` with every forecast, and point
  forecasts and observations carry `outside.cloudCover` (ratio 0..1)
  and `wind.gust` (m/s), the two fields the Signal K Weather API schema
  defines and consumers such as energy predictors and stow advisories
  read. Without the extra fields the run decodes as before and the two
  fields stay left out. A decoded run made for the previous extra-field
  set no longer matches the settings, so the first update after this
  change decodes the current cycle again: the nine existing fields come
  from the GRIB cache and only the two new fields' messages are
  downloaded (HTTP byte ranges, tens of MB); one extra-field step is
  54.0 MB on disk instead of 45.7 MB (about 1.35 GB per 72 h run
  instead of 1.14 GB).
- **Solar, thermal radiation, snowfall and instability fields, behind
  their own setting (off by default).** Settings → Forecast → "Solar,
  thermal radiation, snowfall and instability" fetches ECMWF's total
  precipitation `tp`, surface solar radiation `ssrd`, snowfall `sf`,
  surface thermal radiation down and net `strd`/`str`, and most-unstable
  CAPE `mucape`. The five accumulated fields (everything but `mucape`)
  are published as totals since the forecast start; the decode now runs
  a step-subtraction pass that turns each into its per-interval value —
  a depth in m for `tp` and `sf`, an average W/m² over the interval for
  the three fluxes — and each step carries its interval length (3 h to
  144 h, 6 h past it; step 0's range is empty and holds no interval
  values). `tp` finally fills the Weather API's `outside.precipitationVolume`
  (the interval depth ending at each point forecast; an observation's
  interval has not ended, so it is left out there). The rest go through
  the plugin's own API and the conditions popup, which gains an Energy
  tab (solar and infrared fluxes), a depth line in the Precip tab, a gust
  line in the Wind tab and cloud, solar and gust columns in the Raw
  table. The setting is off by default: the six fields roughly double
  the download (about +177 MB per 72 h cycle) and add about 830 MB of
  decoded data on disk, so a metered connection only pays for them on
  purpose. The memory and disk guard knows the new field set and suggests
  turning the setting off when a run would not fit.

- **Ship's time (#19).** Clock times in the web app and the Freeboard
  panel are shown in the ship's time zone when the Signal K server
  publishes one (`environment.time.timezoneRegion`, an IANA zone, else
  `environment.time.timezoneOffset`, (-)hhmm), else in the browser's, and
  the departure field is read and written in the same zone. Checked every
  10 minutes; a change redraws the times and keeps the departure's moment.
  A departure typed in the hour the clocks skip (spring forward) moves on
  past the gap (02:30 → 03:30), as the browser does with its own zone,
  and the field shows the time used.
- **Signal K notes on the map (#20).** Layers → Base → Signal K notes
  (on by default) shows the Resources API's notes that have a position,
  for the map view, as markers; a click shows the note's title, text and
  link, who wrote it and when, and its bearing and distance from the
  boat, with **Edit** and **Delete** (a second press confirms); a note
  can be dragged to a new position. **Add note here** in the map's click
  menu writes a new note (title, text) at that point. Notes are ordinary Signal K resources (`POST`, `PUT`, `DELETE`
  `/signalk/v2/api/resources/notes`; an edit keeps the note's other
  fields), so Freeboard and other apps see them; writing needs a Signal K
  login with write access. A failed notes request keeps the notes already
  shown (logged to the console) instead of emptying the layer.
- **Areas to avoid.** A note can mark a circle around it to avoid (its
  form's "Avoid this area" and a radius, stored as
  `properties.avoid.radius_m`). The router treats every such circle as
  land: candidates and legs inside one are dropped, and a route point
  inside one is refused with a message naming the note. Plan tab "Avoid
  marked areas" (on by default) and the request field `avoid_areas`; the
  job log lists the areas used. The main thread reads the notes from the
  Resources API at each job's start; the land mask gets a per-route view
  with the circles (`LandMask.withAvoid`), the cached mask unchanged.
- **GPX export (#22).** The itinerary bar's GPX button downloads the route
  on the map as a GPX 1.1 route: each point with its name (Start, WP1 …
  End), time and leg description in the user's units, and the route's
  summary as its description.
- **Comfort: routing around rough water.** The router weights the
  sea-state index by the angle of the waves to the course (× 1.3 in head
  seas, × 1.05 abeam, × 0.8 following, a cosine between: the "encounter
  index", `src/engine/seas.ts`), and with a comfort weight each second
  sailed above an encounter index of 75 counts extra in the search's
  choices (weight × (index − 75) / 100, at most 2 × weight; with 1,
  choppy water adds 25 %, rough 50 %, extreme 125 %). Setting
  `routing.comfortWeight` (0–3, default 1, 0 = off) and request field
  `comfort_weight`. The cost steers pruning, the terminal choice and the
  smoother; the route's times stay real. Needs wave data.
- **The sea on each leg.** Route points carry `sea_index`,
  `seas_angle_deg`, `seas_side`, `seas_sector` and `encounter_index` for
  the leg into them. The leg cards and the Freeboard panel show a
  **Seas** row (where the waves come from and the encounter index's
  band); Layers → Base → **Seas along the route** (on by default) draws
  an arrow on each leg along the waves' travel, coloured by the encounter
  index.
- **Current against the waves.** Layers → Water (off by default), from
  the new point tile layer `/api/tile/seas` (points with the sea-state
  index, waves, wind and current), coloured by the sea state there. Three
  styles to compare, chosen under the layer's checkbox: **A** an arrow
  at every point along the waves' travel (heads meeting where the
  current opposes the waves, larger the more it steepens them, a double
  chevron where it runs with them, a thin arrow with little current);
  **B** a mark only where the current against the waves steepens a
  choppy or rougher sea (tide-rip lines from 10 % steeper, a breaking
  wave from 25 %, with spray from 50 %); **C** three arrows from each
  point, wind, waves and current, each pointing where it is going, so a
  pair pointing at each other shows what makes the sea rough. The
  legend shows each glyph over its meaning.
  All seas glyphs (these arrows, the route arrows, the Seas row's chip)
  use the sea-state heatmap's colour scale, shifted slightly darker and
  outlined.
- **Wave direction (arrows).** Layers → Water (off by default): an arrow
  per point along the waves' travel, coloured by the significant wave
  height on the wave-height heatmap's scale, longer for a longer mean
  period. The `seas` tile points now carry `mwp_s`.
- **Sea state and wave arrows in Freeboard.** Two new chart layers, drawn
  on the server as the web app draws them: "Current against the waves"
  (style A) and "Wave arrows" (Weather Router Plus), PNG glyph layers `seas` and
  `wave_arrows` (`/api/tile/<layer>/{z}/{x}/{y}.png`), listed while the
  forecast has wave data. The Freeboard groups now pair each colour layer
  with its own glyphs: *Waves* shows wave arrows (was wind barbs) and
  *Sea state* shows the current against the waves (was current arrows).

- **Leg cards show the wind and wave range of the leg, not just its end
  point.** The shortcut smoother can merge many hours of routing into one
  leg, and the itinerary card then presented a single end-of-leg wind
  sample (say 2.9 kn) beside the leg's average speed over ground — a
  38-hour leg sailed mostly in a fresh breeze could read as an impossible
  5 kn in light air. Each leg is now sampled about once per hour along
  its track (both ends included, at most 25 samples) and the extremes
  are published on the departing point as `leg_wind_min_ms` /
  `leg_wind_max_ms` and `leg_swh_min_m` / `leg_swh_max_m` (Signal K
  route `coordinatesMeta` included). The webapp itinerary card, the
  Freeboard leg descriptions and the Freeboard panel cards show these
  as a range (e.g. "Wind 2.9–18.4 kn from NE") whenever the leg's ends
  differ; single-sample legs are unchanged.

### Changed

- **The sea-state index no longer flags ordinary long-period ocean swell as
  extreme.** The swell term was a plain quadratic in wave height, so any
  open-ocean cell above about 2.23 m — a routine 2.25 m trade swell at
  12 s — scored over 150 and landed in the `extreme` band even in light
  wind and slack current. The swell term is now scaled by
  `5 / max(mwp, 5)`, which leaves steep short-period coastal seas (period
  5 s or less, and the missing-wave-data default of 5 s) undamped and
  cuts a 12 s swell to 5/12, shifting standard trade swells back into
  the `slight`/`good` bands. The band cuts themselves (35 / 50 / 75 /
  100 / 150) are unchanged.
- **The sea-state index no longer calls a moderate wind sea extreme.**
  Even with the period damping, the wave term `30 × swh²` put any sea of
  about 2.2 m or more in the `extreme` band: off the US east coast on
  2026-10-04 (2–2.4 m at 6–7 s in 15 kn, Douglas 4 "moderate") the map
  was extreme throughout. Its weight is now 10 (`SWELL_COEFF`) at every
  period, so seas of 5 s or less score lower than before too; it is
  calibrated on twelve seas pinned by a test: a 2 m wind sea is
  `choppy`, 3.5 m `rough`, 5 m and more `extreme`, long swell milder than
  a wind sea of the same height, and strong current against the waves
  (a tide race, the Gulf Stream against 2 m seas) still `rough`. The band
  cuts are unchanged. Everything that reads the index follows: the sea
  state colours and arrows, the route Seas rows, and the comfort cost in
  routing (its limits 75 and 100 are index values, so routes keep away
  from rough water less often in moderate seas). Saved sea-state tiles
  and point answers made with the old index are dropped at once (cache
  revision `ss3` and point answers rev 3).

- **Waiting for the forecast is said once, calmly.** While the server gets
  its first forecast (a first start, or a decode after the forecast
  settings changed, e.g. the new gust and cloud cover fields), the web app
  shows one notice with the progress ("decoding the 06Z cycle, step 12 of
  37"), a progress bar and the time left measured from the decode; the
  map layers no longer fail one by one with "query timed out" after
  120 s, and everything (layers, units) reloads by itself when the
  forecast is ready. Map and point requests are answered at once with 503,
  `Retry-After` and the progress; `/api/status` has `forecast_loading`;
  the Signal K plugin status, a waiting route's log and the Freeboard
  panel show the same progress. A 503 no longer winds up the web app's
  request backoff.

- **The shortcut smoother is off by default** (`routing.smoother`). It
  can still be turned on in the settings or per request (`smoother`).

- **Durations of a day or more read as days, hours and minutes (#24).**
  "223.0 hour" is now "9d 7h": a duration of 24 h or more is written in
  Signal K's duration-compact format whatever the user's time unit, in
  the web app, the Freeboard panel and the plugin's messages; shorter
  durations follow the time unit as before. A deliberate, documented
  exception to following the Signal K unit preferences (Signal K has one
  time unit for every duration). A clock time a day or more away now
  carries its date ("Tue 13 Oct 21:58").
- **"Calculating" instead of "Submitting" (#21)** on the Find Route button
  and in the Freeboard panel while a route is computed.

### Fixed

- **Wind barbs and current arrows came back empty** when turned off and
  on again without moving the map: turning a point layer off cleared its
  points but kept OpenLayers' record of the tiles already loaded, so
  nothing was fetched again. It is now refreshed instead (also for the
  new sea state and wave arrows, which share one tile source).

- **The step-0 wind gust is no longer published as 0 m/s.** ECMWF codes
  the gust's step 0 (an empty maximum-over-time range) as 0 everywhere,
  which is not a real value; the step is decoded without a gust field and
  the first three hours answer without one. From step 3 on every step
  carries the real maximum over the past interval.


## [0.1.0-beta.8] - 2026-10-03

### Fixed

- **Regional wind is used only where it is finer than ECMWF.** Every
  signalk-grib-downloader source was layered over ECMWF at full weight
  wherever it covered, so a GFS 0.25° area (the same spacing as ECMWF's
  open data) replaced ECMWF's wind over the whole area. A source is now
  decoded and used for routes only when its grid is finer than the global
  forecast's; the others are listed with "not used: not finer than the
  global forecast".

- **A route across 180° failed with "Invalid typed array length" when a
  regional wind source lay on the other side of 180°** (a Tonga → New
  Zealand route with a downloader source around Tonga). The check that a
  regional grid meets the route area compared longitudes the short way,
  but the columns read were worked out the long way, which gave a
  negative number of columns. Both now take the short way, and a source
  whose grid has no cells in the area is skipped with a line in the job
  log instead of failing the route.

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
    evaluate at the wind speeds their recorded tables were made at
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
  (four assignments-in-conditions fixed); comments say what the code
  does; the GeoJSON / Signal K route formats, the conditions derivations and the
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

- README: the introduction now says what the "plus" is (the map
  overlays, drawn from the same data the routing uses) and that the
  plugin does not route on depths, channels or bridges.

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

- Isochrone router (a subsector isochrone search) in a worker thread,
  against the vessel's polar. Modes
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

[Unreleased]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.2.1-beta.1...HEAD
[0.2.1-beta.1]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.2.0...v0.2.1-beta.1
[0.2.0]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.2.0-beta.4...v0.2.0
[0.2.0-beta.4]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.2.0-beta.3...v0.2.0-beta.4
[0.2.0-beta.3]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.2.0-beta.2...v0.2.0-beta.3
[0.2.0-beta.2]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.2.0-beta.1...v0.2.0-beta.2
[0.2.0-beta.1]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.2-beta.1...v0.2.0-beta.1
[0.1.2-beta.1]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.1...v0.1.2-beta.1
[0.1.1]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.9...v0.1.1
[0.1.0-beta.9]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.8...v0.1.0-beta.9
[0.1.0-beta.8]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.7...v0.1.0-beta.8
[0.1.0-beta.7]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.6...v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.5...v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.4...v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.3...v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/motamman/signalk-weather-router-plus/releases/tag/v0.1.0-beta.1
