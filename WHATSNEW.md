# What's new

## 0.2.1

- **Wind and wave limits: block or avoid.** Each limit has a mode. Block
  (as before): water over the limit is off limits; the route goes round
  it, or says plainly why it cannot. Avoid: the route may go through, but
  time over the limit counts extra when routes are compared (double by
  default; the Avoid strength sets how much), so it goes round where that
  costs less and through where it does not. The times shown are always
  the real times, and each leg that goes over carries a warning with the
  time spent over. Set them per route in the Route tab's new Limits and
  comfort section, or as defaults.
- **Comfort per route.** The comfort slider (how much the route avoids
  rough water, head seas counting most) is now on the Route tab beside the
  limits, for sail and power boats alike, instead of only in Settings for
  the whole server. Each of these controls shows the server's setting
  until you choose, and "Use server setting" puts it back.
- **Power boats get the limits too.** Motor routes now read the forecast,
  so their wind and wave limits and the comfort weight act, on open water
  and on the charts. Find Route works without a boat name or cruise speed;
  the plugin's motor speed is used.
- **Wider searches.** On a long leg the search could never look more than
  about 80 km off the direct corridor, whatever the effort. It now reaches
  as far as its heading sweep allows, so a detour round bad weather can
  form; on a Placentia Bay to mid-Atlantic leg at Maximum effort the time
  over the wave limit fell by more than a third. The coast near the route
  stays as sharp as before.
- **Every tack costs the tack penalty**, the last one before the
  destination included, so routes are no longer chosen for tacks they do
  not pay for.
- **Polar Management.** With signalk-polar-management installed, its
  active polar and performance factor are used automatically; the
  built-in polars stay selectable per route.
- **The page keeps up with you.** The route's progress and Cancel show
  where you pressed Find Route; Best departure opens from a button beside
  Departure; after a reload a route still computing is followed again, or
  shown if it finished; the map opens on the boat, or on your plan when
  the last visit left one; on an iPad the panel fits the screen.
- **Freeboard: the "Weather-route it" button leaves the route you drew
  alone.** The
  result is a new route of its own, a draft until you save it.
- **Fewer failed routes near the charts.** Chart tiles with no chart data
  are no longer treated as a wall at sea, a leg joins the charts where the
  way by water is shortest, and a destination up a narrow channel is
  reached along the water. The charts' rough cuts are rebuilt once, by the
  first route that needs them.
- **More said, more plainly.** A stretch the router could not search and
  a beat it had to motor are warnings on the route; the data sources say
  on a touch screen too when each run was published and the next is due,
  with Check now; a newer Copernicus run still being written is reported.

## 0.2.0

- **The map comes first on a phone.** The panel is a sheet at the bottom
  of the screen. Drag it down to just its tabs, to half way, or up to the
  full screen, or tap a tab to open it and tap it again to fold it. Find
  Route stays at the bottom of the sheet. Held sideways, the panel is a
  drawer on the right that folds to a strip of tab names. The legend and
  the map credits fold to one line. The conditions at a spot now open in
  a card across the top of the screen (down the left side when the phone
  is held sideways) instead of in a popup that ran off it. On a desktop,
  the arrow in the title row folds the panel to its header.

## 0.2.0-beta.4

- **Signal K keeps much less memory.** Drawing the map tiles ahead of time,
  zooming the map out, and looking at a part of the map not seen before
  each left memory with Signal K that it never gave back. On the test box:
  starting the tile drawing kept 609 MB, now 0.4 MB; a new part of the map
  80 MB, now 12.5 MB; the whole world zoomed out 333 MB, now 18 MB, and
  drawn in 15 s instead of 38 s. Routes and the map look exactly the same.
- **A short wait at the first start after updating.** The plugin now cuts
  the coastline into small tiles once, so it reads only the coast near what
  you look at, never a whole continent: about 15 seconds on a Raspberry Pi 5
  and about 200 MB of disk. The status says *cutting the coastline into
  tiles* meanwhile. The current tiles on the map are also drawn again once.
- **A route that cannot be made says why, in plain words.** For example:
  "Forecast at the start: waves 4.6 m against your 3.0 m limit. It comes
  under the limit about 26 Oct 09:00 UTC. Raise the limit or depart after
  that." The coast, wind dead ahead, a boat that makes no way, or several
  reasons together get their own sentences.
- **No downloads on your own over a metered link.** With the
  signalk-internet plugin installed, while it says the connection is
  metered, offline or behind a captive portal, the forecast, currents,
  tides, chart and coastline downloads wait and no map tiles are drawn
  ahead; they carry on when the connection clears. What you ask for
  (Refresh, a route, the map you look at) still downloads.
- **Watch the search.** While a route computes, a small boat on the map
  sits at the head of the best path found so far and moves on with each
  stage.
- **Fixes:** current tiles are drawn again when you add or replace a tidal
  harmonics file (at the next start); a current source that cannot be
  read no longer leaves map tiles without it for a day.

## 0.2.0-beta.3

- **RTOFS currents for where you are.** The NOAA RTOFS currents now come from
  the regional product your boat is in (for example Samoa around Fiji,
  Honolulu around Hawaii), and change with it as you move. Where no RTOFS
  product covers the boat, nothing is downloaded for its position (extra
  products you ticked still load). To plan somewhere else, tick
  more products under Settings → Currents → *Also load RTOFS products*; each
  shows its area, daily download and memory.
- **Weather in Freeboard's panel.** The Weather Router Plus panel in Freeboard
  has a new Weather tab: one tap for Wind, Waves, Pressure, Sea state, Rain or
  the temperatures, with its colour scale; a time bar over the whole forecast
  to drag, step or play through the days ahead, all layers at the same hour;
  and how fresh the data on the map is, with the same coloured dots, late
  warnings and online line as the web page.
- **See at a glance how fresh your data is.** The top of the panel shows a
  coloured dot for each source (wind, waves, currents, tides): green while
  it is the latest, orange when a newer run is due about now, red when the
  newer run is late and the old one is still in use. Click **Show** for
  each source's age and when its next run is due; a red line says what is
  late.
- **Online or not.** Under the title, a blue *online* or a grey *No
  internet connection since …*. Without a connection the plugin stops
  trying at once instead of retrying for minutes, keeps using what it has,
  and says so, instead of quietly staying on an old forecast.
- **The map keeps working while a new forecast arrives.** Decoding a new
  forecast used to hold up every map tile not drawn before until it was
  done (minutes); it now runs on its own, and the header says *Processing
  new forecast data*.
- **New forecasts found at the right time.** The plugin now knows when
  ECMWF actually publishes each run, so it neither looks too early nor
  picks it up late.
- **Under-keel and overhead clearance** are settings now (Defaults:
  0.5 m and 2 m), the water kept under the keel and the headroom kept above
  the mast on the charts. The higher overhead default keeps you off bridges
  and cables 1–2 m above your mast height that were allowed before.
- **A route that would cross shallow water is repaired first.** When the
  final chart check finds a stretch your boat cannot use, that stretch is
  routed again round it; the route fails only if that does not clear it.
- **Charts download faster and survive a dropped connection**: each chart
  comes as one compressed file (about a third of the size), two at a time,
  and a stopped download carries on where it stopped. **Node.js 22.15 or
  later** is needed for this.
- **GeoJSON download** beside GPX, with every waypoint's times, wind,
  waves, current and depth.
- **Currents are shown the way they flow** ("to W"), as charts and tide
  tables give them.
- **No more routes over islands far from the start and end.** A long route
  could pass over islands outside the area the plugin loaded coastline for
  (seen in the Caribbean). Those are now treated as land.
- **Fixes:** a chart catalogue entry the plugin cannot use is now set aside
  with its reason instead of breaking the chart list; a route name in
  another script no longer downloads as a hidden file; opening bridges are
  reported correctly after a repair.

## 0.2.0-beta.2

- **Trips across the edge of the charts.** A trip that leaves the charts,
  comes into them, crosses open water between two charted areas, or goes from
  one Coast Guard district's charts to the next is now routed on the charts
  wherever they have water, and on the coastline routing only outside them.
  It never takes the coastline routing into charted water, where it knows
  nothing of the depths. Where two ways are equally good, both are worked out
  and the faster one taken.
- **Where the charts meet.** The plugin records, for your boat, where one
  district's charts join the next. It does this when it builds the small map
  of usable water after a chart download; *Rebuild rough cuts* on the plugin
  configuration page builds it again.
- **A beat that cannot be tacked is motored** (refined router, sail threshold
  above 0): where the tacks would lead into a corner the water closes round,
  that stretch is motored, as the standard router does, and the log says so.
  With the sail threshold at 0 the route still fails there.
- **Lighter map tiles in advance.** The tiles drawn ahead of time are now
  finished by the background programs that draw them, so Signal K itself does
  less of the work (on the test box its main thread went from 41 % to 32 % of
  a core while tiles were built, and tiles were built faster).
- **Tiles drawn where you look.** The plugin now works out where your map is
  looking from everything it asked for, not the last few tiles: a zoomed-out
  view of the whole ocean no longer sends it off drawing tiles for one corner
  of it. Zoomed out that far, it keeps drawing where you last looked closer.
- **Much less map drawing in advance.** Wind and waves are drawn ahead only
  at the times the forecast actually has (every 3 hours), and currents at
  the times their own data has (every 3 hours with the usual settings,
  hourly with tidal harmonics), not every hour; the map still shows the
  hours between when you look. And when a map, this one or another app,
  moves somewhere new, only what it shows is drawn ahead there, not a whole
  region at every zoom. On the test box a new forecast now keeps the
  computer busy for minutes, not hours, and moving the map for a minute or
  two.
- **New forecasts sooner.** A new install checks for a new forecast every
  15 minutes instead of every hour. If you already use the plugin, your
  setting stays as it is: change it on the Defaults tab (*Check for a new
  cycle every*).
- **Fixes:** a newly computed route can be published, deleted, named and
  exported straight away; a request that fails no longer leaves the old route
  in the GPX export.
- **No more quiet detours over shallow water.** Until now, when the
  charts could not route a leg, the plugin quietly used the coastline
  routing instead, which knows nothing about depths, and a route could
  cross water too shallow for your boat while still showing "validated".
  A leg inside the charts is now routed on the charts or fails and tells
  you why.
- **Every route is checked against the charts before you see it.** The
  finished route is followed across the charts, and if any part of it
  crosses water too shallow for your draft, a bridge too low for your
  height, a rock, a mark or an area to avoid, the route fails and names
  the places. A route that passes shows *Chart depth checked* with the
  shallowest depth it crosses, how much of it has no charted depth, and
  how much lies outside the charts.
- **Points in shallow water are moved for you.** A start, destination or
  waypoint you drop in water too shallow for your boat (or on a rock, a
  mark, or the land) is moved to the nearest water your boat can use, up to
  1,000 m, and the dotted line shows where from. This uses the charts'
  depths, not just the coastline.
- **Approximate waypoints use the charts.** A trip through approximate
  waypoints is now routed on the chart depths all the way, instead of on
  the coastline outline. A waypoint you drop on land or in shallow water
  is fine: the route goes to the nearest water your boat can use, and
  tells you when that is outside the waypoint's circle.
- **Long trips on the charts.** A trip whose water route swings far out
  (from the Bahamas round the Florida Keys into the Gulf, from Chicago
  through the Straits of Mackinac into Lake Huron) used to be too big for
  the charts. The router now reads the charts piece by piece as its
  search reaches them, so no trip is too long for them. A small map of
  the water your boat can use tells it at once when no water joins the
  start and the end. That map is built after each chart download;
  *Rebuild rough cuts* on the plugin configuration page builds it again.
- **A new request clears the old route.** When you ask for a new route,
  the one on the map goes; if the request fails, the map shows no route and
  the error says why.

## 0.2.0-beta.1

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
  the route and says so instead of quietly motoring it. The sailed
  stretches respect the chart too: no leg crosses water shallower than
  your draft, a bridge lower than your height, or a charted rock, and
  every waypoint shows the charted depth under it.
  A route that starts in a harbour and ends far outside the mesh is routed
  on the charts out to open water and handed over there. Routes the mesh
  cannot take fall back to the coastline routing you had before.
- **A clearer plugin configuration page.** The Chart meshes card shows
  the catalogue's date and a *Check for updates* button, and each mesh
  has buttons that act the moment you click them: Download, Update,
  Download again, Remove, Cancel. No more ticking and saving to fetch a
  mesh. Where a mesh is both downloaded and in your own folder, a
  *downloaded / my folder* choice on its row picks the copy the router
  uses. The Map tiles, Coastline and
  Forecast cards say in plain words what they do and show their state;
  the harmonics row is gone from the page.
- **Drawbridges.** Opening bridges on the charts are planned as open by
  default; when a route passes under one you are told which, with its
  open clearance, and offered a re-plan that avoids them. Defaults →
  Routing → Drawbridges (ask, open or avoid) and a wait time per bridge.
- **Keep your distance.** Defaults → Routing has two new buffers: a
  distance from land that coastline routes keep, and a distance from
  unusable water (too shallow, too low, a rock) that chart routes keep.
  Both start at 0, as before.
- **Tacking costs time.** Defaults → Routing → Tacking penalty, 30 s per
  tack or gybe unless you change it, charged by both routers; a beat is
  now laid out as long tacks, split only where the wind or the land
  forces it.
- **The Plan tab has what you set per route.** Min sail speed, Smoothing,
  Effort and Router sit together on Route → Plan. *Method* is now
  *Effort*. Smoothing applies to both routers.
- **Sliders on the Defaults tab.** Every number is a slider with its value
  and unit beside it; max wind and max wave height have a "no limit" box.
- **Follow the boat.** In LIVE and SIMULATE the map keeps the boat centred
  while the new *Follow the boat* box is ticked; drag the map and it stops,
  tick it again and it follows.
- **The log fills while a route runs.** Until now the Log tab stayed empty
  until a route finished and then showed everything at once.
- **Currents on chart routes.** A chart route planned while the Copernicus
  current data was mid-update had no ocean currents while the rest of the
  route did; it now reads the same currents everywhere.
- **An effort you can choose.** Route tab → *Effort*: Normal
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
