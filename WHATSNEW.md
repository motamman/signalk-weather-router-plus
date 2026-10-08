# What's new

## Unreleased

- **Charts to download.** The plugin configuration lists the navigation
  meshes published for each Coast Guard district; tick the ones you sail
  and the plugin downloads them and keeps them current.
- **Routing on the charts.** With a chart mesh configured, routes inside
  it follow charted depths, bridge clearances, rocks, wrecks, marks and
  structures, using your boat's draft and height from Signal K's Vessel
  Base Data. Under power the whole leg runs on the charts; under sail the
  narrow bits are motored along the channel and the open water is sailed.
  Set the sail threshold to 0 and nothing is motored: the narrow bits are
  sailed along the channel too, and a stretch that cannot be sailed fails
  the route and says so instead of quietly motoring it.
  A route that starts in a harbour and ends far outside the mesh is routed
  on the charts out to open water and handed over there. Routes the mesh
  cannot take fall back to the coastline routing you had before.
- **A search method you can choose.** Route tab → *Method*: Normal
  (seconds), Moderate (a better route, about 2 minutes on a long passage)
  or Maximum (the best route, about 6 minutes). On the test boat Moderate
  found a passage 80 minutes shorter and a harbour beat half an hour
  shorter than Normal; a harbour hop takes seconds whichever you pick.
- **Two routers to compare.** Route tab → *Router*: Standard, the
  isochrone search, or Refined, which treats a beat as
  a straight leg at its best VMG, lays the tacks out afterwards in the wind
  of the moment, and nudges waypoints sideways where that arrives earlier.
  On the test boat it was 24 minutes faster on a 5-hour harbour beat and
  26 minutes faster on a 4½-day passage; the same on a reach. Pick either
  per route; the log says which ran.
- **Fewer tabs.** Route now has two sub-tabs: *Plan* (the request and its
  result) and *Options* (what used to be the Setup tab). *Settings* is
  *Defaults*: the server's starting values for every route. Forecast data
  moved to the Log tab.
- **Mixed legs count properly.** A leg that motors out of a harbour and
  then sails now counts its motoring hours in the totals.

## 0.1.2-beta.1

- **Less memory on a small computer.** On a Raspberry Pi, Signal K's
  memory climbed with every map session, forecast and GRIB file and never
  came back down. The heavy, occasional work now runs in separate
  processes that hand their memory back when they finish: building map
  tiles ahead of time, deleting old tiles after a new forecast, and
  decoding regional GRIB files. RTOFS currents are loaded once instead of
  once per worker. On the test Pi, when the tile builders finished and handed back
  their memory, Signal K and the builders together went from 1.4 GB to
  820 MB.
- **Fresher forecasts.** The 06z and 18z ECMWF runs were being skipped
  with some forecast horizons; the plugin now picks up a new forecast
  four times a day.
- **The map follows your route.** When a route comes back, the map zooms
  to show all of it.
- **A check on far waypoints.** A waypoint more than 500 km from the last
  one asks first: add it, start a new route there, or cancel.

## 0.1.1

- **A regular release.** Everything from 0.1.0-beta.9 below, now
  published outside the beta channel.
- **Fix.** In style B of *Current against the waves*, the colour key
  lists only the sea states B draws (choppy, rough, extreme).

## 0.1.0-beta.9

- **Routing around rough water.** The router now weighs how rough the sea
  is as the boat meets it: head seas count more than following seas, and
  above "slight" each hour in rough water counts extra, so routes go round
  heavy seas when it costs little time. The times shown stay the real
  times. Settings → Routing → Comfort weight (default 1, 0 for the fastest
  route).
- **A sea state you can believe.** The sea state index was far too harsh:
  a moderate 2 m wind sea showed as "extreme". It is recalibrated, so a
  2 m wind sea is choppy, 3.5 m rough and 5 m extreme, and long ocean
  swell reads milder than a wind sea of the same height. Strong current
  against the waves still shows as rough.
- **The sea along your route.** Each leg card and the Freeboard panel show
  a Seas row (head seas, on the starboard bow… and how rough), an arrow on
  each leg shows the waves on the map, and each leg shows the range of
  wind and waves along it ("Wind 8–18 kn"), not just one point, so a long
  leg no longer reads as 5 kn of boat speed in 3 kn of wind.
- **New water layers.** *Wave direction* arrows, coloured by wave height
  and longer for long swell, and *Current against the waves*, with three
  styles to try: A arrows at every point; B tide-rip and breaking-wave
  marks only where a current steepens the sea; C three arrows (wind,
  waves, current) so you can see which pair is fighting. Freeboard gets
  both as charts, and its Waves and Sea state groups use them.
- **Notes on the map, and areas to avoid.** Signal K notes show on the
  map; add, edit, move or delete them from the map. A note can mark a
  circle to avoid, and routes go round it.
- **More from the forecast.** Wind gust and cloud cover in the Weather
  API; optional solar, thermal radiation, snowfall and instability fields
  (off by default; they roughly double the download).
- **Smaller things.** Times in the ship's time zone when Signal K has one;
  GPX download of a route; durations of a day or more as "9d 7h"; while
  the server loads its first forecast, one notice with a progress bar
  instead of layers failing one by one; the shortcut smoother is off by
  default.
- **Fixes.** Wind barbs and current arrows came back empty after being
  turned off and on; the gust at the forecast's first hour read 0; a
  failed notes request emptied the notes layer; a departure in the hour
  the clocks skip was sent an hour early.

## 0.1.0-beta.8

- **Routes across 180° with regional wind no longer fail.** A Tonga → New
  Zealand route stopped with "Invalid typed array length" when a regional
  wind source from signalk-grib-downloader lay on the other side of 180°.
  It now reads the right part of that grid, and a source with nothing in
  the route area is skipped instead of failing the route.
- **Regional wind only where it is finer.** A downloader source is now
  used only when its grid is finer than ECMWF's. A GFS area at 0.25° (the
  same spacing as ECMWF) used to replace ECMWF's wind wherever it
  covered; it is now left out, and the header says so. AROME, ARPEGE and
  ICON-EU work as before. This also saves the time and disk a large GFS
  area took to decode (about 540 MB on the test box).

## 0.1.0-beta.7

- **Finer wind where you have it.** Install the signalk-grib-downloader
  plugin and its regional runs (AROME, ARPEGE, ICON-EU) are layered over
  ECMWF: routes use the regional wind wherever it covers the point and
  the time, blended in at its edges and handed back to ECMWF near the end
  of its forecast. Waves stay ECMWF. The route summary says how much of
  the route each model answered; a checkbox turns it off.
- **Freeboard shows your weather routes properly.** Tick a saved weather
  route in Freeboard's Routes list and the plugin's panel opens on its
  legs, with no re-routing. The leg cards are redesigned (when, mode and
  tack; distance, time, SOG and COG in large type; wind, current fair or
  foul, waves), a tap on one centres the chart on that waypoint, and the
  leg the boat is on is outlined and kept in view. Routes computed in the
  web app now carry each point's leg into the saved route, so Freeboard's
  points sheet shows it too.
- **LIVE and SIMULATE follow the boat.** The itinerary card of the next
  point shows live figures, each point passed keeps its closest-approach
  figures, and the map stays on the boat. SIMULATE has Start, Stop and
  Rewind, and draws the track sailed.
- **"In irons" means in irons.** Points of sail come from the route's
  polar: in irons only tighter than the polar's no-go angle, close hauled
  up to its best upwind angle. A leg the router sailed at 34° no longer
  reads "in irons".
- **Routes that go where the wind is.** In open water the search can now
  leave the direct line: Tonga → Auckland went from 207.4 h to 185.7 h,
  faster now than the route you had to force through a waypoint far to
  the west (192.7 h). Routes across the 180° meridian draw and fit the
  short way.
- **Less to set up, more remembered.** The page opens on the boat's
  Signal K position instead of asking the browser for its location; the
  vessel name comes from Signal K; your start, destination, waypoints and
  departure survive a reload; opening a saved route offers to recompute
  it with the current forecast.
- **A clearer header.** One line each for wind, waves, currents and
  tides, naming the model behind it, listing only what applies where you
  are looking, in local time.
- **Your units everywhere.** Settings, progress messages, warnings and
  errors are written in your Signal K unit preferences, angles, times and
  data sizes included.
- **Fixes.** After a restart the plugin keeps serving the forecast it has
  while a newer one downloads (overlays used to go blank for minutes);
  opening a saved route no longer brings the previous route's waypoints
  along; the web app no longer stops loading in Power mode; a regional
  decode no longer stalls the map and the Weather API.

## 0.1.0-beta.6

- **Freeboard's wind barbs from this plugin.** The Weather API now
  answers observations: the conditions right now at any point, from the
  ECMWF forecast, with the surface current where the current data covers
  the point. Freeboard-SK's Wind overlay asks for exactly that, so make
  this plugin the server's default weather provider and its barbs come
  from the same forecast as your routes. Freeboard's currents overlay
  still reads Open-Meteo; a Freeboard change for that is on our list.
- **Approximate waypoints show their circle.** In Approximate mode a
  dashed orange circle of the chosen radius is drawn around every
  waypoint, following the pin as you drag it and the slider as you move
  it, and the route is seen to touch the circle and carry on. Before,
  after a run the pins jumped onto the route, so the route looked as if
  it passed through the waypoint exactly and no circle was visible.
- **Decision lines.** The router's search is drawn only when you ask:
  the switch sits beside Find Route (and in Layers → Base), off by
  default, remembered. The search is still recorded with every route, so
  the switch shows it after the fact too.
- **Routes to windward finish.** The final beat to a waypoint tries
  wider tack angles when the wind shifts along the way, where it used to
  fail; a Gibraltar → Canaries route that stopped 37 km short now
  completes. When no final leg can be sailed at all, the message says
  why, for each leg tried, with the wind and current at the nearest
  point.
- **Fixes from the test box.** Empty tiles left by a power cut no longer
  blank a layer (the map rebuilds them); the web app no longer runs old
  scripts after an update; chart groups in Freeboard are complete from
  the first start; the world-zoom tiles were missing their eastern half;
  the water-grid rebuild had stopped working in the previous beta.
- **Under the hood.** A structural cleanup with no change to the routes
  it produces, checked by golden tests: one definition each for units,
  angles and the map projection, SI settings end to end, the search in
  readable sections, the web app as modules. Two things it did change for
  the better: every candidate now reads the forecast and the currents at
  its own clock, so arrival times with a changing forecast or tide are
  more honest, and the `wrp-route` command runs the full pipeline the
  plugin does.

## 0.1.0-beta.5

- **Weather routing inside Freeboard-SK.** With Freeboard-SK 3.0 or
  later: draw a route on the chart as usual (start, waypoints,
  destination), tap the grid icon at the top right, then **Weather
  route** → **Weather-route it**, and the drawn route becomes the weather
  route, still editable, saved with Freeboard's own Save. Or route from
  your boat to a position or a saved waypoint. Each point shows its ETA,
  sailing or motoring, and the wind.
- **The weather layers in Freeboard-SK too.** Wind, waves, currents, sea
  state, rain, temperatures and tide height appear in Freeboard's Chart
  list, with Freeboard's own time control to play them through the
  forecast.
- **Wind and wave limits.** Set a maximum wind speed or wave height in
  the Plan tab (or in Settings as a default) and the router keeps every
  leg under it, or tells you there is no such route, and why: how many
  of its options were over the limit, and whether it had run past the
  end of the forecast.
- **You can see where the forecast ends.** A route that goes on past the
  last forecast step now shows it: an amber badge with the end time, the
  legs after it drawn dashed with a "forecast ends" marker, a chip on
  those itinerary cards, and a note in the saved route. Those legs run on
  conditions held at the last step. The **Forecast horizon** setting
  (Settings tab, Forecast group) reaches up to 15 days.
- **Simpler vessel settings.** Draught, air draft, length, beam,
  under-keel and overhead margins, maximum wave height and tack penalty
  are gone from the Settings tab and the Plan tab: the router never used
  them (it has no depth or bridge data). What is left is what it does
  use: name, speed under power and polar performance. A working tack
  penalty is on the to-do list; the wave-height limit is now a routing
  setting (above).
- **First setup fixed.** On a fresh install the configuration panel's
  Save button was greyed out until you changed something; it now reads
  "Save and enable the plugin" and works straight away. If you updated
  from an earlier beta, hard-refresh the Admin UI once to get the new
  panel.

## 0.1.0-beta.3 and beta.4

- First start shows "starting: downloading the coastline (…)" instead of
  "plugin not started", and a route requested before the first forecast
  waits for it instead of downloading its own copy.
- Fixed a first-forecast download failure (`ENOENT … rename …grib2.tmp`)
  when two threads fetched the same field at once.
- README corrections.

## 0.1.0-beta.2

- **Polars included.** About 700 boat polars (the OpenCPN
  weather_routing_pi library) now come with the plugin, with a Catalina
  36 as the default, so routes sail straight after installing. Pick your
  boat in the web app's polar list, or create one from your boat's specs.
  Polars you create are kept safe across plugin updates.

## 0.1.0-beta.1: first public beta

Weather routing that runs entirely inside your Signal K server, with no
outside routing service. This is a beta: please report problems on
GitHub.

### Route anywhere

- **Worldwide weather, currents and tides.** ECMWF's global forecast
  (up to 15 days ahead), Copernicus Marine's worldwide currents
  (including tidal currents) and tide heights, with NOAA RTOFS as a
  backup. Tidal-harmonic files you install take priority where they
  cover.
- **Routes find their way through straits.** Lisbon to Palma through
  Gibraltar, the Aegean to the Black Sea through the Dardanelles and the
  Bosphorus: no waypoints needed. The router slows down and keeps several
  options open in narrow passages.
- **Waypoints** end one leg and start the next, and the weather moves on
  with you. Choose **Precise** (exactly through each waypoint) or
  **Approximate** (anywhere inside a circle you set).
- **Clean routes:** needless zig-zags are straightened out when the
  straight line is clear of land and no more than 5% slower. Your own
  waypoints are always kept.
- **Live mode** re-plans from your boat's position as you go.

### Your boat

- Pick a polar from your library for each route and see its diagram.
- **Create a polar from boat specs** (length, beam, displacement, sail
  area, rig). Checked against 441 ORC certificates: typically within
  about 3% of ORC's own predictions.
- **Polar performance:** tell the router how much of the polar your boat
  really makes (for example 85% for a loaded cruiser).

### See the conditions

- Map layers for wind, waves, currents, sea state, rain, air and sea
  temperature, pressure and tide height. They load quickly: the map is
  saved on the server and built ahead of time around your boat and
  wherever you look.
- **Conditions popup** (shift-click anywhere): 72-hour charts of wind,
  waves, sea state, tide and current, pressure, temperature and rain.
- Everything is shown in **your Signal K unit preferences**.

### Easy to set up

- Install, enable, done: on first start the plugin downloads the world
  coastline it needs by itself (149 MB, once).
- Its settings page in the Signal K Admin UI has a **Download coastline**
  button, and shows distances and times in your units.
- Vessel, routing and forecast settings are in the web app's
  **Settings** tab, shared by everyone on board.
- Routes are saved to Signal K, so your chartplotter apps can show them,
  and the forecast is offered to other apps through the Signal K Weather
  API.

### Good to know

- Tide heights are relative to **mean sea level, not chart datum**. Do
  not use them for under-keel clearance.
- The current and tide models are about 9 km: fine along coasts, not
  inside small harbours and narrow channels.
- Open water only: the router avoids land but knows nothing about depths,
  channels or bridges.
- Disk: the forecast uses 1–4 GB (depending on how far ahead), and the
  saved map up to 20 GB (adjustable).
- Current and tide data: *Generated using E.U. Copernicus Marine Service
  Information; https://doi.org/10.48670/moi-00016*. Weather: ECMWF open
  data (CC BY 4.0).

See [CHANGELOG.md](CHANGELOG.md) for the full list.
