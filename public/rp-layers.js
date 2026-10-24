// Weather Router Plus — route planner UI: map module (imports rp-core.js).
// The map, markers and route styling, weather/water overlays (JSON grids
// drawn on canvas, or the plugin's PNG tiles), streamlines, pressure, the
// layer toggles and the legends box. rp-plan.js imports what it uses.

import { _apiError, _apiErrorText, _fmt, API, authFetch, AuthGate, fmtPressure, fmtWhen, forecastWaiting, fromClockInput, KT_MS, TACK_COLOR, tackSide, UNIT_MISSING, unitDesc } from './rp-core.js';

// --- Marker features and route sources (drawn by the layers below, placed by rp-plan.js) ---
// --- Marker features ---
export const startFeature = new ol.Feature({ name: 'start' });
export const endFeature = new ol.Feature({ name: 'end' });
export const routeSource = new ol.source.Vector();
export const skeletonSource = new ol.source.Vector();

export const markerSource = new ol.source.Vector({
  features: [startFeature, endFeature]
});

const markerStyle = function(feature) {
  const name = feature.get('name');
  if (!feature.getGeometry()) return null;
  let color, label;
  if (name === 'start') {
    color = '#4CAF50'; label = 'S';
  } else if (name === 'end') {
    color = '#F44336'; label = 'E';
  } else {
    // waypoint
    color = '#FF9800';
    label = 'W' + (feature.get('waypoint_index') + 1);
  }
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: 10,
      fill: new ol.style.Fill({ color: color }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
    }),
    text: new ol.style.Text({
      text: label,
      fill: new ol.style.Fill({ color: '#fff' }),
      font: 'bold 11px sans-serif'
    })
  });
};

// Arrival circles around the via waypoints in Approximate mode: their own
// layer, because every feature of the marker layer is draggable.
export const ringSource = new ol.source.Vector({});
export const ringLayer = new ol.layer.Vector({
  source: ringSource,
  zIndex: 15,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: 'rgba(255,152,0,0.95)', width: 2, lineDash: [6, 4] }),
    fill: new ol.style.Fill({ color: 'rgba(255,152,0,0.10)' }),
  }),
});
export const markerLayer = new ol.layer.Vector({
  source: markerSource,
  style: markerStyle,
  zIndex: 20
});

// --- Route layer ---
let _selectedRouteFeature = null;  // the route point whose popup is open: drawn highlighted
export function setSelectedRouteFeature(f) { _selectedRouteFeature = f; }
export function selectedRouteFeature() { return _selectedRouteFeature; }
export const routeLayer = new ol.layer.Vector({
  source: routeSource,
  style: function(feature) {
    const geomType = feature.getGeometry().getType();
    if (geomType === 'LineString') {
      return feature.getStyle();
    }
    if (geomType === 'Point') {
      // Where the forecast runs out along the route (displayRoute): an amber
      // diamond with a label; the legs after it are drawn dashed.
      if (feature.get('kind') === 'forecast_end') {
        const when = feature.get('valid_to') ? fmtWhen(feature.get('valid_to')) : '';
        return [
          new ol.style.Style({
            image: new ol.style.RegularShape({
              points: 4, radius: 11, angle: 0,
              fill: new ol.style.Fill({ color: '#f9a825' }),
              stroke: new ol.style.Stroke({ color: '#fff', width: 2.5 }),
            }),
            text: new ol.style.Text({
              text: 'forecast ends' + (when ? ' ' + when : ''),
              font: 'bold 12px sans-serif',
              offsetY: -20,
              fill: new ol.style.Fill({ color: '#7a4b00' }),
              stroke: new ol.style.Stroke({ color: '#fff', width: 4 }),
            }),
            zIndex: 30,
          }),
        ];
      }
      const cog = feature.get('cog_deg');
      const outCog = feature.get('outgoing_cog');
      const windDir = feature.get('wind_dir_deg');
      // Chevron direction: outgoing_cog (forward-looking)
      const displayCog = outCog != null ? outCog : cog;
      // Tack color: based on NEXT segment's data (forward-looking)
      const nextMode = feature.get('next_mode');
      const nextCog = feature.get('next_cog');
      const nextWind = feature.get('next_wind');
      // Colors match the itinerary-card accents:
      //   sailing/starboard = #2E7D32, sailing/port = #D32F2F,
      //   motoring = #fc4 (amber), arrival (last waypoint) = #88f (blue).
      let color;
      if (nextMode != null) {
        if (nextMode === 'sailing') {
          // Starboard when cog or wind is missing.
          color = TACK_COLOR[tackSide(nextCog, nextWind) || 'starboard'];
        } else {
          color = '#fc4';   // motoring
        }
      } else {
        // Last waypoint (arrival) — blue.
        color = '#88f';
      }
      const styles = [];
      const isSelected = (feature === _selectedRouteFeature);
      // Selection halo — bright cyan double-ring with soft tint.
      if (isSelected) {
        styles.push(new ol.style.Style({
          image: new ol.style.Circle({
            radius: 28,
            fill: new ol.style.Fill({ color: 'rgba(0,229,255,0.18)' }),
            stroke: new ol.style.Stroke({ color: '#00e5ff', width: 3 })
          }),
          zIndex: 8,
        }));
        styles.push(new ol.style.Style({
          image: new ol.style.Circle({
            radius: 22,
            fill: new ol.style.Fill({ color: 'rgba(255,255,255,0)' }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
          }),
          zIndex: 9,
        }));
      }
      // Circle ring at waypoint — radius matches chevron tail length
      styles.push(new ol.style.Style({
        image: new ol.style.Circle({
          radius: 16,
          fill: new ol.style.Fill({ color: 'rgba(255,255,255,0)' }),
          stroke: new ol.style.Stroke({ color: color, width: isSelected ? 5 : 2 })
        }),
        zIndex: 10,
      }));
      // Vessel heading arrow (SVG: shaft + notched arrowhead, points up by default)
      if (displayCog != null) {
        const vesselSvg = '<svg width="20" height="32" viewBox="0 0 20 32" xmlns="http://www.w3.org/2000/svg">' +
          '<rect x="8" y="12" width="4" height="20" fill="' + color + '"/>' +
          '<path d="M10,0 L2,14 L10,10 L18,14 Z" fill="' + color + '"/>' +
          '</svg>';
        styles.push(new ol.style.Style({
          image: new ol.style.Icon({
            src: 'data:image/svg+xml;utf8,' + encodeURIComponent(vesselSvg),
            anchor: [0.5, 0.5],
            rotation: displayCog * Math.PI / 180,
            scale: 1,
          })
        }));
      } else {
        styles.push(new ol.style.Style({
          image: new ol.style.Circle({
            radius: 4,
            fill: new ol.style.Fill({ color: '#333' }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 1 })
          })
        }));
      }
      // Wind arrow (blue SVG arrow, offset upwind, points where wind blows TO)
      if (windDir != null) {
        const windToRad = ((windDir + 180) % 360) * Math.PI / 180;
        const offsetRad = windDir * Math.PI / 180;
        const windSvg = '<svg width="16" height="28" viewBox="0 0 16 28" xmlns="http://www.w3.org/2000/svg">' +
          '<rect x="6" y="10" width="4" height="18" fill="%231565C0"/>' +
          '<path d="M8,0 L1,12 L8,9 L15,12 Z" fill="%231565C0"/>' +
          '</svg>';
        styles.push(new ol.style.Style({
          image: new ol.style.Icon({
            src: 'data:image/svg+xml;utf8,' + encodeURIComponent(windSvg),
            anchor: [0.5, 0.5],
            rotation: windToRad,
            displacement: [Math.sin(offsetRad) * 22, Math.cos(offsetRad) * 22],
            scale: 1,
          }),
          zIndex: 20,
        }));
      }
      return styles;
    }
  },
  zIndex: 15
});

// --- Stage fronts (the router's search as it runs): one line per stage
// front (the candidates kept after pruning, sorted across the track,
// coloured cool → warm by stage) and the best path so far (dashed). Live
// from the job's `frontier` events, then the finished job's /fronts.
export const frontSource = new ol.source.Vector();
function _frontColor(frac, alpha) {
  // blue (early) → amber (late)
  const r = Math.round(40 + 215 * frac), g = Math.round(90 + 70 * frac), b = Math.round(220 - 200 * frac);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}
const frontLayer = new ol.layer.Vector({
  source: frontSource,
  style: f => {
    if (f.get('kind') === 'best') return new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(120,40,160,0.9)', width: 2.5, lineDash: [6, 6] }) });
    const frac = f.get('frac') || 0, final = f.get('final');
    return new ol.style.Style({ stroke: new ol.style.Stroke({ color: _frontColor(frac, final ? 0.45 : 0.85), width: final ? 1.2 : 2 }) });
  },
  zIndex: 14,
  // Off by default: the Decision lines switch (Layers → Base, and beside Find Route) turns it on.
  visible: false,
});
// Draw one stage: points [[lon, lat, timeMs, viaCount], …] sorted across the
// track within each viaCount; best [[lon, lat], …]. `reset` clears earlier
// stages (a new job); `resetLeg` clears only that leg's stages (a re-run of
// one leg's search), keeping the other legs' fronts.
/**
 * [lon, lat] points with each longitude put within 180° of the one before,
 * so a line that crosses the antimeridian is drawn across it (OpenLayers
 * wraps the world) instead of the long way round the globe.
 */
export function unwrapLonLats(points) {
  const out = [];
  let prev = null;
  for (const p of points) {
    let x = p[0];
    if (prev !== null) { while (x - prev > 180) x -= 360; while (x - prev < -180) x += 360; }
    out.push([x, p[1]]);
    prev = x;
  }
  return out;
}

export function drawFront(front, opts) {
  const o = opts || {};
  if (o.reset) frontSource.clear();
  else if (o.resetLeg != null) {
    frontSource.getFeatures()
      .filter(f => f.get('kind') === 'front' && f.get('leg') === o.resetLeg)
      .forEach(f => frontSource.removeFeature(f));
  }
  const total = Math.max(1, front.total || front.totalStages || 1);
  const frac = Math.min(1, (front.stage || 0) / total);
  const groups = new Map();
  for (const p of front.points || []) {
    const k = p[3] || 0;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([p[0], p[1]]);
  }
  for (const [k, lonlats] of groups) {
    const coords = unwrapLonLats(lonlats).map(c => ol.proj.fromLonLat(c));
    const geom = coords.length > 1 ? new ol.geom.LineString(coords) : new ol.geom.Point(coords[0]);
    const f = new ol.Feature({ geometry: geom, kind: 'front', stage: front.stage, leg: front.leg || 0, via: k, frac, final: !!o.final });
    frontSource.addFeature(f);
  }
  if (!o.final && Array.isArray(front.best) && front.best.length > 1) {
    frontSource.getFeatures().filter(f => f.get('kind') === 'best').forEach(f => frontSource.removeFeature(f));
    frontSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(unwrapLonLats(front.best).map(c => ol.proj.fromLonLat(c))), kind: 'best' }));
  }
}
export function drawFronts(fronts) {
  frontSource.clear();
  for (const fr of fronts || []) drawFront(fr, { final: true });
}

// --- Skeleton layer (A* presumptive route, blue) ---
const skeletonLayer = new ol.layer.Vector({
  source: skeletonSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#2060cc', width: 2, lineDash: [8, 4] })
  }),
  zIndex: 16
});

// --- Proposed-route layer (Live mode re-plan preview, dashed purple) ---
// Drawn alongside the active route while the user decides Accept/Dismiss.
export const proposedRouteSource = new ol.source.Vector();
const proposedRouteLayer = new ol.layer.Vector({
  source: proposedRouteSource,
  style: function(feature) {
    if (feature.getGeometry().getType() !== 'LineString') return null;
    return new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: 'rgba(142, 36, 170, 0.75)',   // translucent purple
        width: 4,
        lineDash: [10, 6],
      }),
    });
  },
  zIndex: 17,
});

// --- Track and earlier routes (Live and Simulate) ---
// The path the boat has sailed (solid) and the routes it followed before
// each accepted re-plan (faint dashed, the line only). Kept after Live or
// Simulate ends.
export const trackSource = new ol.source.Vector();
const trackLayer = new ol.layer.Vector({
  source: trackSource,
  style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(0, 150, 170, 0.9)', width: 3 }) }),
  zIndex: 16,
});
export const pastRouteSource = new ol.source.Vector();
const pastRouteLayer = new ol.layer.Vector({
  source: pastRouteSource,
  style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(120, 120, 120, 0.55)', width: 2, lineDash: [6, 6] }) }),
  zIndex: 15,
});

// --- Vessel marker layer (own boat from Signal K) ---
// Rotated to headingTrue when available, else COG. Rendered on top of
// route/skeleton but below the start/end pin markers so dragging pins
// stays unambiguous.
export const vesselMarkerSource = new ol.source.Vector();
const vesselMarkerLayer = new ol.layer.Vector({
  source: vesselMarkerSource,
  style: function(feature) {
    const rot = feature.get('rotation_rad') || 0;
    // Boat-arrow SVG: black outline for visibility on any base map,
    // cyan fill matching the selected-waypoint halo color family.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">' +
      '<path d="M14,1 L26,36 L14,30 L2,36 Z" ' +
      'fill="#00e5ff" stroke="#003a43" stroke-width="1.8" stroke-linejoin="round"/>' +
      '</svg>';
    return new ol.style.Style({
      image: new ol.style.Icon({
        src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
        anchor: [0.5, 0.5],
        rotation: rot,
      }),
      zIndex: 19,
    });
  },
  zIndex: 19,
});

// --- Conditions-point marker ---
// Target ring at the spot the conditions popup describes (shift-click
// or "Conditions here"). Set in openConditionsAt; cleared by the
// popup position listener there whenever the popup closes or moves.
export const condMarkerFeature = new ol.Feature();
const condMarkerSource = new ol.source.Vector({ features: [condMarkerFeature] });
const condMarkerLayer = new ol.layer.Vector({
  source: condMarkerSource,
  style: function(feature) {
    if (!feature.getGeometry()) return null;
    return [
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 11,
          stroke: new ol.style.Stroke({ color: '#fff', width: 5 }),
        }),
      }),
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 11,
          stroke: new ol.style.Stroke({ color: '#ad1457', width: 3 }),
        }),
      }),
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 3.5,
          fill: new ol.style.Fill({ color: '#ad1457' }),
          stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }),
        }),
      }),
    ];
  },
  zIndex: 21,
});

// --- Meteogram marker ---
// The boat where the route puts it at the time under the meteogram's
// cursor (rp-plan.js, Meteogram), pointing along its course.
export const meteoMarkerFeature = new ol.Feature();
const meteoMarkerLayer = new ol.layer.Vector({
  source: new ol.source.Vector({ features: [meteoMarkerFeature] }),
  style: function(feature) {
    if (!feature.getGeometry()) return null;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30">' +
      '<path d="M11,1 L20,27 L11,22 L2,27 Z" fill="#ff6d00" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>' +
      '</svg>';
    return new ol.style.Style({
      image: new ol.style.Icon({
        src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
        anchor: [0.5, 0.5],
        rotation: feature.get('rotation_rad') || 0,
        rotateWithView: true,
      }),
      zIndex: 22,
    });
  },
  zIndex: 22,
});

// OpenStreetMap — the base map. Tiles come from the internet (the
// document's origin-only referrer meta keeps OSM happy behind Signal K's
// no-referrer policy).
const osmLayer = new ol.layer.Tile({
  source: new ol.source.OSM(),
  opacity: 0.6,
  zIndex: 0,
  visible: true,
});

// OpenSeaMap seamarks — buoys, lights, marks — as transparent tiles
// drawn over the base map. Layer minZoom keeps it from rendering when
// zoomed out (fetch-flood rule).
const seamarkLayer = new ol.layer.Tile({
  source: new ol.source.XYZ({
    url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    attributions: '&copy; <a href="https://www.openseamap.org/">OpenSeaMap</a> contributors',
    crossOrigin: 'anonymous',
    maxZoom: 18,
  }),
  zIndex: 2,
  minZoom: 8,
  visible: true,
});

// ─────────── Shared overlay helpers ───────────
// The time every overlay is drawn for: a clicked waypoint / conditions
// hour when set, else the departure input.
let _currentTimeOverride = null;  // set when clicking a waypoint or a conditions hour
/** The hour the timed overlays show instead of the departure (ISO), or null; set by rp-plan.js. */
export function setTimeOverride(iso) { _currentTimeOverride = iso; }
export function timeOverride() { return _currentTimeOverride; }
export function _overlayTimeIso() {
  if (_currentTimeOverride) return _currentTimeOverride;
  const depEl = /** @type {HTMLInputElement} */ (document.getElementById('departure'));
  const dep = fromClockInput(depEl.value);
  return (dep || new Date()).toISOString();
}
// Viewport as [w, s, e, n] in degrees, latitudes clamped to ±85 and a
// dateline-crossing view expressed with e > 180 (the plugin accepts
// longitudes in [-180, 360]).
function _viewBBox() {
  const view = map.getView();
  const extent = view.calculateExtent(map.getSize());
  let [w, s] = ol.proj.toLonLat([extent[0], extent[1]]);
  let [e, n] = ol.proj.toLonLat([extent[2], extent[3]]);
  s = Math.max(-85, s); n = Math.min(85, n);
  if (extent[2] - extent[0] >= 40075016) { w = -180; e = 180; }
  else if (e < w) e += 360;
  return [w, s, e, n];
}
// Per-layer notes ("no wave data in the forecast") shown in the legend
// box next to the layer that could not load.
const _overlayNotes = {};
function _noteOverlay(key, msg) {
  // While the server gets its first forecast every layer waits: the banner says so, not each legend row.
  if (msg && forecastWaiting()) return;
  if (msg) _overlayNotes[key] = msg; else delete _overlayNotes[key];
  updateLegends();
}
// A layer's load failed: logged and noted on its legend row, unless it is only waiting for the forecast.
function _overlayFailed(label, keys, err) {
  if (err.name === 'AbortError' || err.message === 'auth-gate-tripped' || err.waiting || forecastWaiting()) return;
  console.log(label + ' error: ' + err.message);
  for (const k of keys) _noteOverlay(k, err.message);
}
function _bboxParam(b) { return b.map(v => +v.toFixed(5)).join(','); }

// Point overlays (wind barbs, current arrows) loaded per web-map tile at
// the overlay hour (GET /api/tile/barbs|arrows/{z}/{x}/{y}). The source
// keeps the tiles of one zoom level and one hour: a new level or hour
// starts afresh, so zooming out never shows the denser deeper-level points.
const _POINT_TILE_GRID = ol.tilegrid.createXYZ({ tileSize: 256, maxZoom: 18 });
// `toggleId`: the layer toggle a tile error is noted under, or a list of
// them for a source several layers share.
function _pointTileSource(tileLayer, toggleId, toFeature, attributions) {
  const toggles = Array.isArray(toggleId) ? toggleId : [toggleId];
  const src = new ol.source.Vector({
    attributions,
    strategy: ol.loadingstrategy.tile(_POINT_TILE_GRID),
    loader: function (extent, resolution, projection, success, failure) {
      // OpenLayers 9.1 marks the extent loaded after this returns, and
      // failure() does not unmark it: remove it (deferred) so it is retried.
      const fail = () => { failure(); setTimeout(() => src.removeLoadedExtent(extent), 0); };
      const z = _POINT_TILE_GRID.getZForResolution(resolution);
      const n = 2 ** z;
      const c = _POINT_TILE_GRID.getTileCoordForCoordAndZ([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2], z);
      const x = ((c[1] % n) + n) % n, y = c[2];
      if (src._hour === undefined) { src._hour = _overlayHourIso(); src._z = z; }
      // Mid-zoom: this level is not the source's; moveend starts the new level.
      if (z !== src._z) { fail(); return; }
      const hour = src._hour, level = src._z;
      _tileFetch(_tileUrl(tileLayer, z, x, y, hour))
        .then(_tileJson)
        .then(points => {
          // A newer hour or zoom level has cleared the source meanwhile.
          if (src._hour !== hour || src._z !== level || z !== level) { fail(); return; }
          const features = (Array.isArray(points) ? points : []).map(toFeature);
          src.addFeatures(features);
          for (const id of toggles) _noteOverlay(id, null);
          success(features);
        })
        .catch(err => {
          _overlayFailed(tileLayer + ' tile', toggles, err);
          fail();
        });
    },
  });
  return src;
}
// Start a point source afresh when the hour or the zoom level changed.
function _syncPointSource(src) {
  const hour = _overlayHourIso();
  const z = _POINT_TILE_GRID.getZForResolution(map.getView().getResolution());
  if (src._hour === hour && src._z === z) return;
  src._hour = hour;
  src._z = z;
  // refresh(), not clear(): clear() keeps the loaded-extent index, so tiles already seen would not load again.
  src.refresh();
}

// --- Tidal current overlay ---
// Credit required by the Copernicus Marine licence (section 2.4) wherever
// its products are shown; NOAA RTOFS is the backup source. Shown by the
// map's attribution control while a current layer is visible.
const CURRENT_ATTRIBUTION = 'Currents: Generated using E.U. Copernicus Marine Service Information; '
  + '<a href="https://doi.org/10.48670/moi-00016" target="_blank" rel="noopener">doi:10.48670/moi-00016</a>. NOAA Global RTOFS.';
const currentSource = _pointTileSource('arrows', 'currentToggle', p => {
  const f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([p.lon, p.lat])) });
  f.set('speed_ms', p.speed_ms);
  f.set('dir_deg', p.dir_deg);
  f.set('u_ms', p.u_ms);
  f.set('v_ms', p.v_ms);
  return f;
}, CURRENT_ATTRIBUTION);
// Tide height layer: Copernicus Marine hourly sea level (ocean_tide, FES2014).
const TIDE_ATTRIBUTION = 'Tide height: Generated using E.U. Copernicus Marine Service Information; '
  + '<a href="https://doi.org/10.48670/moi-00016" target="_blank" rel="noopener">doi:10.48670/moi-00016</a>. Relative to mean sea level, not chart datum.';

// Pre-build current arrow styles to avoid icon cache thrashing
const _currentStyleCache = new Map();
// Arrow colour classes, lower bound in knots. Shared with the legend.
const CURRENT_ARROW_CLASSES = [
  [0,   'rgba(0,200,140,0.85)'], [0.5, 'rgba(180,180,0,0.85)'],
  [1.0, 'rgba(220,140,0,0.85)'], [1.5, 'rgba(220,40,40,0.9)'],
];
function _currentColor(speed) {
  let c = CURRENT_ARROW_CLASSES[0][1];
  for (const [lo, color] of CURRENT_ARROW_CLASSES) if (speed >= lo) c = color;
  return c;
}
const SLACK_KT = 0.05;  // below this, render as a pause symbol
function _currentStyle(feature) {
  const speedMs = feature.get('speed_ms') || 0;
  const speed = speedMs / KT_MS;  // the arrow classes are in knots (rp-core.js KT_MS)
  const dirDeg = feature.get('dir_deg') || 0;
  const color = _currentColor(speed);

  if (speed < SLACK_KT) {
    const key = 'slack|' + color;
    if (_currentStyleCache.has(key)) return _currentStyleCache.get(key);
    const pauseSvg = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="4" y="3" width="2.5" height="10" fill="' + color + '"/>' +
      '<rect x="9.5" y="3" width="2.5" height="10" fill="' + color + '"/></svg>';
    const style = new ol.style.Style({
      image: new ol.style.Icon({
        src: 'data:image/svg+xml;utf8,' + encodeURIComponent(pauseSvg),
        anchor: [0.5, 0.5],
        scale: 0.7,
      }),
      zIndex: 8,
    });
    _currentStyleCache.set(key, style);
    return style;
  }

  // Quantize to reduce unique styles: direction to 5°, speed to color bucket
  const dirQ = Math.round(dirDeg / 5) * 5;
  const key = color + '|' + dirQ;
  if (_currentStyleCache.has(key)) return _currentStyleCache.get(key);
  const dirRad = dirQ * Math.PI / 180;
  const scale = Math.max(0.4, Math.min(0.8, speed * 0.7 + 0.27));
  const svg = '<svg width="16" height="32" viewBox="0 0 16 32" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="6" y="12" width="4" height="20" fill="' + color + '"/>' +
    '<path d="M8,0 L1,14 L8,10 L15,14 Z" fill="' + color + '"/></svg>';
  const style = new ol.style.Style({
    image: new ol.style.Icon({
      src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
      anchor: [0.5, 0.5],
      rotation: dirRad,
      scale: scale,
    }),
    zIndex: 8,
  });
  _currentStyleCache.set(key, style);
  return style;
}

const currentLayer = new ol.layer.Vector({
  source: currentSource,
  declutter: false,
  style: _currentStyle,
  zIndex: 8
});

function loadCurrentOverlay() {
  if (!currentLayer.getVisible()) return;
  _syncPointSource(currentSource);
}

// ─────────── Sea state arrows: the waves against the current ───────────
// A glyph per point (point tiles 'seas'): drawn along the way the waves
// travel, coloured by the sea-state index. Where the current runs against
// the waves (they steepen) two heads meet in the middle, larger the more
// the current steepens them; with the waves, a double chevron; with
// little current along them, a single thin arrow.
// One source for the 'seas' point tiles, shared by this layer and the wave
// arrows below (each draws its own glyph from the same points), so a tile
// is fetched once with both layers on.
const seasSource = _pointTileSource('seas', ['seasArrowsToggle', 'waveArrowsToggle'], p => {
  const f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([p.lon, p.lat])) });
  f.set('idx', p.idx);
  f.set('to_deg', p.to_deg);
  f.set('rel', p.rel);
  f.set('steepen', p.steepen);
  f.set('swh_m', p.swh_m);
  f.set('mwp_s', p.mwp_s);
  f.set('wind_ms', p.wind_ms);
  f.set('wind_to_deg', p.wind_to_deg);
  f.set('cur_ms', p.cur_ms);
  f.set('cur_to_deg', p.cur_to_deg);
  return f;
});
// The glyph, drawn pointing up (the waves travel north); the map rotates it
// to their direction. Also drawn in the legend.
function _seasGlyphSvg(rel, colour, outline = SEA_GLYPH_OUTLINE) {
  // The paths twice: wider in the outline colour underneath, then in the band's colour.
  const paths = (colour, extra) => {
    const w = x => (x + extra).toFixed(1);
    return rel === 'opposing'
      // Heads meeting in the middle: →← along the axis.
      ? '<path d="M11 1 L11 8" stroke="' + colour + '" stroke-width="' + w(2.4) + '"/><path d="M6 6 L11 11 L16 6" fill="none" stroke="' + colour + '" stroke-width="' + w(2.6) + '" stroke-linejoin="round"/>'
        + '<path d="M11 21 L11 14" stroke="' + colour + '" stroke-width="' + w(2.4) + '"/><path d="M6 16 L11 11 L16 16" fill="none" stroke="' + colour + '" stroke-width="' + w(2.6) + '" stroke-linejoin="round"/>'
      : rel === 'following'
        // Running together: a shaft with a double chevron at its head.
        ? '<path d="M11 21 L11 4" stroke="' + colour + '" stroke-width="' + w(2) + '"/><path d="M6 8 L11 3 L16 8 M6 13 L11 8 L16 13" fill="none" stroke="' + colour + '" stroke-width="' + w(2) + '" stroke-linejoin="round"/>'
        // Little current along the waves: a single thin arrow.
        : '<path d="M11 21 L11 4" stroke="' + colour + '" stroke-width="' + w(1.5) + '"/><path d="M7 8 L11 3 L15 8" fill="none" stroke="' + colour + '" stroke-width="' + w(1.5) + '" stroke-linejoin="round"/>';
  };
  return '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">'
    + (outline ? paths(outline, 1.6) : '') + paths(colour, 0) + '</svg>';
}
// A/B test of the layer's look. A: the glyph above at every point. B: only
// a tide-rip mark (the short wavy lines nautical charts use for overfalls
// and tide rips) where the current against the waves steepens them by at
// least SEAS_RIP_MIN_STEEPEN, nothing elsewhere; no direction (the wave and
// current arrows carry that). 1.10 marked about 4 % of the points in a
// sample of 168 (brain, Coral Sea, 2026-10-04 18Z): a starting value.
// Only where the sea is choppy or rougher (SEAS_RIP_MIN_INDEX, the top of
// the "slight" band and the comfort cost's free limit, src/engine/seas.ts
// COMFORT_FREE_INDEX): small waves steepened are still a calm sea.
const SEAS_RIP_MIN_STEEPEN = 1.10;
const SEAS_RIP_MIN_INDEX = 75;
// The mark by how much the current steepens the waves (what this layer is
// about; the colour gives the sea state): the tide-rip lines from 10 %, a
// breaking wave from 25 %, a breaking wave with spray from 50 %. Opposing
// points sampled on 2026-10-04 had a median steepening of 1.06 and a 90th
// percentile of 1.25 (Coral Sea); the Gulf Stream reached 1.4–2.8.
const SEAS_BREAK_MIN_STEEPEN = 1.25;
const SEAS_SPRAY_MIN_STEEPEN = 1.50;
let SEAS_STYLE = 'A';
try { const v = localStorage.getItem('rp:seasStyle'); if (v === 'B' || v === 'C') SEAS_STYLE = v; } catch (_) { /* no storage: A */ }

// Style C: three arrows from each point, each pointing where it is going:
// wind (thin, a feather at the tail), waves (wavy), current (thick,
// solid), in the sea-state colour, outlined. Where two oppose each other
// the sea is rough, and the glyph shows which pair. Below these the arm
// is left out: wind SEAS_C_MIN_WIND_MS, waves SEAS_C_MIN_SWH_M, current
// SEA_REL (0.1 m/s, as the A arrows' "little current").
const SEAS_C_MIN_WIND_MS = 1;
const SEAS_C_MIN_SWH_M = 0.1;
const SEAS_C_MIN_CUR_MS = 0.1;
const SEAS_C_PX = 34;
// Two arms within this angle are spread apart so they do not lie on top of each other.
const SEAS_C_SPREAD_DEG = 20;
function _seasArm(kind, toDeg, colour, outline) {
  const c = SEAS_C_PX / 2, L = 14;
  const r = d => { const a = d * Math.PI / 180; return (x, y) => [c + x * Math.cos(a) - y * Math.sin(a), c + x * Math.sin(a) + y * Math.cos(a)]; };
  const R = r(toDeg);
  const pts = arr => arr.map(([x, y]) => R(x, y).map(v => v.toFixed(1)).join(',')).join(' ');
  const line = (arr, col, w) => '<polyline points="' + pts(arr) + '" fill="none" stroke="' + col + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>';
  let out = '';
  if (kind === 'current') {
    const shaft = [[0, 0], [0, -L + 5]], head = [[-4, -L + 6], [0, -L], [4, -L + 6]];
    if (outline) out += line(shaft, outline, 5.2);
    out += line(shaft, colour, 3.4);
    out += '<polygon points="' + pts(head) + '" fill="' + colour + '"' + (outline ? ' stroke="' + outline + '" stroke-width="1"' : '') + ' stroke-linejoin="round"/>';
  } else if (kind === 'waves') {
    const wave = [];
    for (let t = 0; t <= L - 2; t += 0.5) wave.push([1.8 * Math.sin(t / 2.2), -t]);
    const head = [[-3.5, -L + 5], [0, -L + 0.5], [3.5, -L + 5]];
    for (const [col, w] of outline ? [[outline, 3.8], [colour, 2]] : [[colour, 2]]) out += line(wave, col, w) + line(head, col, w);
  } else {
    const shaft = [[0, 0], [0, -L]], head = [[-3, -L + 4.5], [0, -L], [3, -L + 4.5]], feather = [[0, -1.5], [-3.5, 1.5]];
    for (const [col, w] of outline ? [[outline, 3.4], [colour, 1.8]] : [[colour, 1.8]]) out += line(shaft, col, w) + line(head, col, w) + line(feather, col, w);
  }
  return out;
}
// The three-arrow glyph; `arms`: [{kind, deg}] (absent arms left out).
function _seasThreeSvg(arms, colour, outline = SEA_GLYPH_OUTLINE) {
  const c = SEAS_C_PX / 2;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + SEAS_C_PX + '" height="' + SEAS_C_PX + '" viewBox="0 0 ' + SEAS_C_PX + ' ' + SEAS_C_PX + '">'
    + arms.map(a => _seasArm(a.kind, a.deg, colour, outline)).join('')
    + '<circle cx="' + c + '" cy="' + c + '" r="1.6" fill="' + (outline || colour) + '"/></svg>';
}
// Spread arms that point (nearly) the same way, in order wind, waves, current.
function _seasSpread(arms) {
  for (let i = 0; i < arms.length; i++) {
    for (let j = 0; j < i; j++) {
      let d = ((arms[i].deg - arms[j].deg + 540) % 360) - 180;
      if (Math.abs(d) < SEAS_C_SPREAD_DEG) arms[i].deg = arms[j].deg + (d >= 0 ? 1 : -1) * SEAS_C_SPREAD_DEG;
    }
  }
  return arms;
}
// Three short wavy lines, 22 × 22; outlined unless outline is null.
function _seasRipSvg(colour, outline = SEA_GLYPH_OUTLINE) {
  const lines = (c, w) => [5, 11, 17].map(y => '<path d="M3 ' + y + ' q2 -3 4 0 t4 0 t4 0 t4 0" fill="none" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round"/>').join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">'
    + (outline ? lines(outline, 3.6) : '') + lines(colour, 2) + '</svg>';
}
// A wave crest curling over, on a base line, 22 × 22; `spray`: two drops
// thrown off the crest (extreme). Outlined unless outline is null.
function _seasBreakSvg(colour, spray, outline = SEA_GLYPH_OUTLINE) {
  const d = 'M2 18 C5 18 7 15 9 11 C11 7 15 5 18 7 C20 8.5 19.5 11.5 17 11.5 C15.5 11.5 15 10 16 9';
  const strokes = (c, w) => '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M2 19.5 L20 19.5" fill="none" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round"/>';
  const drops = spray
    ? [[20.5, 4], [13, 3.5]].map(([x, y]) => '<circle cx="' + x + '" cy="' + y + '" r="1.6" fill="' + colour + '"' + (outline ? ' stroke="' + outline + '" stroke-width="0.8"' : '') + '/>').join('')
    : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">'
    + (outline ? strokes(outline, 3.6) : '') + strokes(colour, 2) + drops + '</svg>';
}
// The B mark's SVG for a steepening factor (1.10 or more).
function _seasMarkSvg(steep, colour, outline) {
  if (steep >= SEAS_SPRAY_MIN_STEEPEN) return _seasBreakSvg(colour, true, outline);
  if (steep >= SEAS_BREAK_MIN_STEEPEN) return _seasBreakSvg(colour, false, outline);
  return _seasRipSvg(colour, outline);
}
const _seasGlyphStyles = new Map();
function _seasGlyphStyle(f) {
  const colour = seaBandColour(f.get('idx'));
  if (!colour) return null;
  if (SEAS_STYLE === 'C') {
    const arms = [];
    const q = d => Math.round(d / 10) * 10;
    if (f.get('wind_to_deg') != null && f.get('wind_ms') >= SEAS_C_MIN_WIND_MS) arms.push({ kind: 'wind', deg: q(f.get('wind_to_deg')) });
    if (f.get('to_deg') != null && f.get('swh_m') >= SEAS_C_MIN_SWH_M) arms.push({ kind: 'waves', deg: q(f.get('to_deg')) });
    if (f.get('cur_to_deg') != null && f.get('cur_ms') >= SEAS_C_MIN_CUR_MS) arms.push({ kind: 'current', deg: q(f.get('cur_to_deg')) });
    if (!arms.length) return null;
    _seasSpread(arms);
    const keyC = 'C' + colour + arms.map(a => a.kind[0] + a.deg).join('');
    let sc = _seasGlyphStyles.get(keyC);
    if (!sc) {
      // The map turns with the view; the arms are drawn in true bearings, so the icon turns with it.
      sc = new ol.style.Style({ image: new ol.style.Icon({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(_seasThreeSvg(arms, colour)), rotateWithView: true }) });
      _seasGlyphStyles.set(keyC, sc);
    }
    return sc;
  }
  if (SEAS_STYLE === 'B') {
    const steep = f.get('steepen') || 1;
    if (f.get('rel') !== 'opposing' || steep < SEAS_RIP_MIN_STEEPEN || !(f.get('idx') >= SEAS_RIP_MIN_INDEX)) return null;
    // The mark carries the steepening; one size (it no longer grows with it as well).
    const kind = steep >= SEAS_SPRAY_MIN_STEEPEN ? 'spray' : steep >= SEAS_BREAK_MIN_STEEPEN ? 'break' : 'rip';
    const keyB = 'B' + kind + colour;
    let sb = _seasGlyphStyles.get(keyB);
    if (!sb) {
      sb = new ol.style.Style({ image: new ol.style.Icon({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(_seasMarkSvg(steep, colour)), scale: 1.15 }) });
      _seasGlyphStyles.set(keyB, sb);
    }
    return sb;
  }
  const rel = f.get('rel');
  const big = rel === 'opposing' ? Math.min(1.6, Math.max(1, f.get('steepen') || 1)) : 1;
  const rot = Math.round(f.get('to_deg') / 5) * 5;
  const key = colour + rel + rot + big.toFixed(1);
  let st = _seasGlyphStyles.get(key);
  if (!st) {
    const svg = _seasGlyphSvg(rel, colour);
    st = new ol.style.Style({ image: new ol.style.Icon({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), rotation: rot * Math.PI / 180, rotateWithView: true, scale: big }) });
    _seasGlyphStyles.set(key, st);
  }
  return st;
}
const seasArrowsLayer = new ol.layer.Vector({ source: seasSource, visible: false, style: _seasGlyphStyle, zIndex: 8 });
// The A/B selector (index.html seasStyleRow): redraw and relabel at once.
for (const r of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="seasStyle"]'))) {
  r.checked = r.value === SEAS_STYLE;
  r.addEventListener('change', () => {
    if (!r.checked) return;
    SEAS_STYLE = r.value;
    try { localStorage.setItem('rp:seasStyle', SEAS_STYLE); } catch (_) { /* not remembered */ }
    seasArrowsLayer.changed();
    updateLegends();
  });
}
function loadSeasArrows() {
  if (!seasArrowsLayer.getVisible()) return;
  _syncPointSource(seasSource);
}

// ─────────── Wave arrows ───────────
// An arrow per point (the shared 'seas' source above) along the way the waves
// travel, coloured on the wave-height heatmap's scale (/api/legends waves,
// the ramp's colour at the point's height, shifted slightly darker and
// outlined like the seas glyphs), longer the longer the wave period: long
// swell reads as a long arrow, short chop as a short one.
// The wave-height ramp's colour at a height (m), shifted like the seas glyphs; null until the legends are loaded.
function waveHeightColour(m) {
  const S = _LEGENDS && _LEGENDS.waves && _LEGENDS.waves.stops;
  if (!S || !S.length || !Number.isFinite(m)) return null;
  if (m <= S[0][0]) return _shade(S[0][1], SEA_GLYPH_SHADE);
  for (let i = 1; i < S.length; i++) {
    if (m <= S[i][0]) {
      const t = (m - S[i - 1][0]) / ((S[i][0] - S[i - 1][0]) || 1);
      const a = parseInt(S[i - 1][1].slice(1), 16), b = parseInt(S[i][1].slice(1), 16);
      const mix = sh => Math.round(((a >> sh) & 255) + t * (((b >> sh) & 255) - ((a >> sh) & 255)));
      return _shade('#' + ((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1), SEA_GLYPH_SHADE);
    }
  }
  return _shade(S[S.length - 1][1], SEA_GLYPH_SHADE);
}
// Arrow length (px) for a period: 4 s and below → 12 px, 16 s and above → 34 px; no period → 20 px.
const WAVE_ARROW_MIN_PX = 12, WAVE_ARROW_MAX_PX = 34, WAVE_ARROW_T0 = 4, WAVE_ARROW_T1 = 16;
function _waveArrowLength(mwp) {
  if (mwp == null || !Number.isFinite(mwp)) return 20;
  const t = Math.max(0, Math.min(1, (mwp - WAVE_ARROW_T0) / (WAVE_ARROW_T1 - WAVE_ARROW_T0)));
  return Math.round(WAVE_ARROW_MIN_PX + t * (WAVE_ARROW_MAX_PX - WAVE_ARROW_MIN_PX));
}
// The arrow, pointing up (the waves travel north), `len` px long; outlined unless outline is null.
function _waveArrowSvg(colour, len, outline = SEA_GLYPH_OUTLINE) {
  const h = len + 4;
  const top = 2, bot = h - 2;
  const path = (c, extra) => '<path d="M7 ' + bot + ' L7 ' + (top + 1) + '" stroke="' + c + '" stroke-width="' + (2 + extra) + '" stroke-linecap="round"/>'
    + '<path d="M3 ' + (top + 5) + ' L7 ' + top + ' L11 ' + (top + 5) + '" fill="none" stroke="' + c + '" stroke-width="' + (2 + extra) + '" stroke-linecap="round" stroke-linejoin="round"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="' + h + '" viewBox="0 0 14 ' + h + '">'
    + (outline ? path(outline, 1.6) : '') + path(colour, 0) + '</svg>';
}
const _waveArrowStyles = new Map();
function _waveArrowStyle(f) {
  // Heights to 0.1 m, lengths to 2 px and directions to 5° for the style cache.
  const colour = waveHeightColour(Math.round(f.get('swh_m') * 10) / 10);
  if (!colour) return null;
  const len = Math.round(_waveArrowLength(f.get('mwp_s')) / 2) * 2;
  const rot = Math.round(f.get('to_deg') / 5) * 5;
  const key = colour + len + ':' + rot;
  let st = _waveArrowStyles.get(key);
  if (!st) {
    st = new ol.style.Style({ image: new ol.style.Icon({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(_waveArrowSvg(colour, len)), rotation: rot * Math.PI / 180, rotateWithView: true }) });
    _waveArrowStyles.set(key, st);
  }
  return st;
}
const waveArrowsLayer = new ol.layer.Vector({ source: seasSource, visible: false, style: _waveArrowStyle, zIndex: 8 });
function loadWaveArrows() {
  if (!waveArrowsLayer.getVisible()) return;
  _syncPointSource(seasSource);
}

// Refresh currents when departure time changes
document.getElementById('departure').addEventListener('change', function() {
  loadCurrentOverlay();
});


// ─────────── Wind barb overlay ───────────
// Classic meteorological wind barb rendering: staff points toward the
// wind source (FROM direction); feathers on one side of the staff
// encode speed — a pennant = 50 kt, a long feather = 10 kt, a half
// feather = 5 kt. Below ~2.5 kt we draw an open circle (calm). Color
// codes speed on a cool→warm ramp so a glance tells wind strength
// without reading the feathers.
const windSource = _pointTileSource('barbs', 'windToggle', p => {
  const f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([p.lon, p.lat])) });
  f.set('speed_ms', p.speed_ms);
  f.set('dir_deg', p.dir_deg);
  return f;
});
const _windStyleCache = new Map();

// Barb colour classes, lower bound in knots. Shared with the legend.
const WIND_BARB_CLASSES = [
  [0,  '#90CAF9', 'very light'], [5,  '#4FC3F7', 'light'], [10, '#00897B', 'moderate'],
  [15, '#43A047', 'fresh'], [20, '#F9A825', 'strong'], [25, '#E64A19', 'near gale'],
  [30, '#C62828', 'gale+'],
];
function _windColor(kts) {
  let c = WIND_BARB_CLASSES[0][1];
  for (const [lo, color] of WIND_BARB_CLASSES) if (kts >= lo) c = color;
  return c;
}

function _windBarbSvg(speedKts, color) {
  // Canvas: 44 high × 28 wide. Plot point at (14, 38). Staff goes up
  // to (14, 4). Feathers stick out to the LEFT of the staff (WMO
  // northern-hemisphere convention).
  const W = 28, H = 44;
  const sx = 14;        // staff x
  const staffTopY = 4;  // staff tip
  const anchorY = 38;   // plot point (bottom)
  const parts = ['<svg width="', W, '" height="', H,
    '" viewBox="0 0 ', W, ' ', H, '" xmlns="http://www.w3.org/2000/svg">'];

  if (speedKts < 2.5) {
    // Calm: open circle at the plot point.
    parts.push('<circle cx="', sx, '" cy="', anchorY - 4,
      '" r="4" fill="none" stroke="', color, '" stroke-width="1.5"/>');
    parts.push('</svg>');
    return parts.join('');
  }

  // Round to nearest 5 kt.
  let remain = Math.round(speedKts / 5) * 5;
  // Staff.
  parts.push('<line x1="', sx, '" y1="', anchorY, '" x2="', sx,
    '" y2="', staffTopY, '" stroke="', color, '" stroke-width="1.8"/>');

  // Draw features from the tip of the staff inward toward the plot.
  let y = staffTopY;
  const FEATHER_STEP = 4;    // spacing between feathers along staff
  const FEATHER_LEN = 10;    // horizontal feather length
  const HALF_LEN = 5;

  // 50 kt pennants first (triangular flags).
  while (remain >= 50) {
    parts.push('<polygon points="',
      sx, ',', y, ' ',
      sx, ',', y + FEATHER_STEP, ' ',
      sx - FEATHER_LEN, ',', y + FEATHER_STEP / 2,
      '" fill="', color, '"/>');
    y += FEATHER_STEP + 1;
    remain -= 50;
  }
  // 10 kt full feathers. Feather slants BACK toward the plot point
  // (WMO convention — "drawn obliquely toward lower pressure").
  while (remain >= 10) {
    parts.push('<line x1="', sx, '" y1="', y,
      '" x2="', sx - FEATHER_LEN, '" y2="', y + 3,
      '" stroke="', color, '" stroke-width="1.8"/>');
    y += FEATHER_STEP;
    remain -= 10;
  }
  // 5 kt half feather. Convention: a lone half feather sits one step
  // in from the tip, not at it. We only get here with remain in {0, 5}.
  if (remain >= 5) {
    if (y === staffTopY) y += FEATHER_STEP;
    parts.push('<line x1="', sx, '" y1="', y,
      '" x2="', sx - HALF_LEN, '" y2="', y + 1.5,
      '" stroke="', color, '" stroke-width="1.8"/>');
  }

  parts.push('</svg>');
  return parts.join('');
}

function _windStyle(feature) {
  const speedMs = feature.get('speed_ms') || 0;
  const kts = speedMs / KT_MS;
  // From-direction: meteorological convention. Staff points at the
  // source, so rotation = dirDeg (with north = 0 matching our SVG's
  // up-pointing staff).
  const dirDeg = feature.get('dir_deg') || 0;
  const color = _windColor(kts);

  // Quantize to reduce unique styles: speed to nearest 5 kt, direction
  // to 5°. One Icon per (speed, dir, color) bucket.
  const speedQ = Math.round(kts / 5) * 5;
  const dirQ = Math.round(dirDeg / 5) * 5;
  const key = speedQ + '|' + dirQ + '|' + color;
  if (_windStyleCache.has(key)) return _windStyleCache.get(key);
  const svg = _windBarbSvg(speedQ, color);
  const style = new ol.style.Style({
    image: new ol.style.Icon({
      src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
      anchor: [0.5, 38 / 44],   // plot point is near the bottom of the SVG
      rotation: dirQ * Math.PI / 180,
      scale: 1,
    }),
    zIndex: 7,
  });
  _windStyleCache.set(key, style);
  return style;
}

const windLayer = new ol.layer.Vector({
  source: windSource,
  declutter: false,
  style: _windStyle,
  zIndex: 7,
  visible: false,
});

function loadWindOverlay() {
  if (!windLayer.getVisible()) return;
  _syncPointSource(windSource);
}

document.getElementById('departure').addEventListener('change', () => reloadOverlays({ currents: false, streamlines: true }));


// ─────────── Heatmap engine (JSON grid → canvas → ImageStatic) ───────────
// The plugin serves the grid as JSON (`GET /api/field`): lons/lats
// ascending, `fields` row-major from the south, `land` per cell. We
// draw a translucent picture (bilinear, alpha 0.55, land masked): a
// viewport-sized canvas, bilinear interpolation between grid points,
// the legend's SI colour stops, alpha 0.55, land masked, and hand it to
// OpenLayers as an EPSG:4326 ImageStatic exactly where the PNG used to go.
// The colour stops of a legend (`GET /api/legends`, SI), or null until
// they are loaded: the page keeps no copy of the ramps.
function _legendStops(key) {
  const L = _LEGENDS && _LEGENDS[key] ? _LEGENDS[key] : null;
  return (L && Array.isArray(L.stops) && L.stops.length >= 2) ? L.stops : null;
}
// CSS colour of a value on a legend ramp (the heatmap LUT); transparent until the legends are loaded.
function _stopsColor(stops, v) {
  if (!stops) return 'rgba(0,0,0,0)';
  const { v0, v1, lut } = _rampLut(stops);
  const i = Math.max(0, Math.min(255, Math.round((v - v0) / ((v1 - v0) || 1) * 255)));
  return 'rgb(' + lut[i * 3] + ',' + lut[i * 3 + 1] + ',' + lut[i * 3 + 2] + ')';
}
function _cssToRgb(c) {
  c = String(c).trim();
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
  m = c.match(/^#([0-9a-f]{6})/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = c.match(/^rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2]]; }
  return [128, 128, 128];
}
// 256-entry RGB lookup over [v0, v1] from ascending [value, colour] stops.
const _lutCache = new Map();
function _rampLut(stops) {
  const key = JSON.stringify(stops);
  if (_lutCache.has(key)) return _lutCache.get(key);
  const v0 = stops[0][0], v1 = stops[stops.length - 1][0];
  const rgb = stops.map(s => _cssToRgb(s[1]));
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = v0 + (v1 - v0) * i / 255;
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const a = stops[k][0], b = stops[k + 1][0];
    const f = b > a ? Math.max(0, Math.min(1, (v - a) / (b - a))) : 0;
    lut[i * 3] = rgb[k][0] + f * (rgb[k + 1][0] - rgb[k][0]);
    lut[i * 3 + 1] = rgb[k][1] + f * (rgb[k + 1][1] - rgb[k][1]);
    lut[i * 3 + 2] = rgb[k][2] + f * (rgb[k + 1][2] - rgb[k][2]);
  }
  const out = { v0, v1, lut };
  _lutCache.set(key, out);
  return out;
}
// Bilinear sampler over one named grid, null-aware: corners without
// data drop out and the remaining weights renormalise, so a coast cell
// keeps colour up to the land edge instead of fading a whole cell early.
function _gridSampler(grid, rows) {
  const lons = grid.lons, lats = grid.lats, res = grid.res;
  const nx = lons.length, ny = lats.length;
  if (!rows || !nx || !ny) return () => null;
  const lon0 = lons[0], lat0 = lats[0];
  return function (lon, lat) {
    // Offset east of the grid's first column in [0, 360): a grid may span
    // more than 180° (views across the date line), so wrap from its west
    // edge, allowing half a cell west of it.
    let dx = ((lon - lon0) % 360 + 360) % 360;
    if (dx > 360 - res / 2) dx -= 360;
    let fx = dx / res, fy = (lat - lat0) / res;
    if (fx < -0.5 || fx > nx - 0.5 || fy < -0.5 || fy > ny - 0.5) return null;
    fx = Math.max(0, Math.min(nx - 1, fx)); fy = Math.max(0, Math.min(ny - 1, fy));
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1);
    const tx = fx - i0, ty = fy - j0;
    const r0 = rows[j0], r1 = rows[j1];
    const v00 = r0 ? r0[i0] : null, v10 = r0 ? r0[i1] : null, v01 = r1 ? r1[i0] : null, v11 = r1 ? r1[i1] : null;
    let sum = 0, wsum = 0;
    if (v00 != null) { const w = (1 - tx) * (1 - ty); sum += v00 * w; wsum += w; }
    if (v10 != null) { const w = tx * (1 - ty); sum += v10 * w; wsum += w; }
    if (v01 != null) { const w = (1 - tx) * ty; sum += v01 * w; wsum += w; }
    if (v11 != null) { const w = tx * ty; sum += v11 * w; wsum += w; }
    return wsum > 0.25 ? sum / wsum : null;
  };
}
// Draw a grid into a data URL. spec: { field, legend, alpha, maskLand,
// alphaField (multiplies alpha, e.g. sea-state `signal`) }; the legend's
// `fade_below` (precip) ramps alpha 0→1 across [0, fade_below].
// Canvas size for a heatmap of the current view (also the land-mask size).
function _heatmapCanvasSize() {
  const size = map.getSize() || [800, 600];
  return [Math.max(128, Math.min(1024, Math.round(size[0]))), Math.max(128, Math.min(1024, Math.round(size[1])))];
}
// Land mask at canvas resolution from the plugin's coastline, so a drawn
// layer stops exactly at the shore instead of at the data grid's land
// flags. Bytes, 1 = land, row 0 north, same pixel mapping as the canvas.
// Keyed by box and size; the browser also caches the response.
const _landMaskCache = new Map();
function fetchLandMask(bbox, W, H) {
  const key = bbox.join(',') + '|' + W + 'x' + H;
  if (_landMaskCache.has(key)) return _landMaskCache.get(key);
  const url = API + '/land-mask?bbox=' + bbox.join(',') + '&w=' + W + '&h=' + H;
  const p = authFetch(url, {}, 'land-mask-' + key)
    .then(r => r.ok ? r.arrayBuffer() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(buf => {
      const bytes = new Uint8Array(buf);
      if (bytes.length !== W * H) throw new Error('land mask size ' + bytes.length + ' != ' + (W * H));
      return { W, H, bytes };
    })
    .catch(err => { _landMaskCache.delete(key); throw err; });
  _landMaskCache.set(key, p);
  while (_landMaskCache.size > 16) _landMaskCache.delete(_landMaskCache.keys().next().value);
  return p;
}
// Streamline land test against a mask fetched for field `f`'s box.
// Returns true / false, or null when there is no mask (caller falls back).
function _maskIsLand(f, mask, lon, lat) {
  if (!mask || !f || !f.bbox) return null;
  const [w, s, e, n] = f.bbox;
  const dx = ((lon - w) % 360 + 360) % 360;
  const x = Math.floor(dx / (e - w) * mask.W), y = Math.floor((n - lat) / (n - s) * mask.H);
  if (x < 0 || x >= mask.W || y < 0 || y >= mask.H) return null;
  return mask.bytes[y * mask.W + x] === 1;
}
// Fetch the land mask for a streamline field and store it on the owner.
function _attachLandMask(owner, f) {
  owner.landMask = null;
  if (!f || !f.bbox) return;
  const [W, H] = _heatmapCanvasSize();
  fetchLandMask(f.bbox, W, H).then(m => { if (owner.vectorField === f) owner.landMask = m; })
    .catch(err => console.log('land mask unavailable for flow lines: ' + err.message));
}
// Grid resolution for a viewport: enough cells for a smooth picture,
// within the plugin's 40k-cell cap (it coarsens further itself).
function _fieldRes(bbox) {
  // Floor 0.002° (~200 m) so close-zoom views can show fine current data
  // (NECOFS ~0.01°) right up to the coast; the 40k-cell cap still applies.
  return Math.min(2, Math.max(0.002, +((bbox[2] - bbox[0]) / 160).toFixed(4)));
}
// Fetch a field grid for the current viewport + overlay time. The URL
// is identical for the heatmap and the streamlines of the same layer,
// so the second request is a browser-cache hit.
function fetchField(layer, channel) {
  const bbox = _viewBBox();
  const ext3857 = map.getView().calculateExtent(map.getSize());
  const res = _fieldRes(bbox);
  const url = API + '/field?layer=' + layer + '&bbox=' + _bboxParam(bbox) + '&time=' + encodeURIComponent(_overlayTimeIso()) + '&res=' + res;
  return authFetch(url, {}, channel).then(r => r.ok ? r.json() : _apiError(r).then(e => Promise.reject(e)))
    .then(g => { if (g && typeof g === 'object') g._ext3857 = ext3857; return g; });
}
// Tide-height stops as drawn (auto-scaled), for the legend.
const _autoScaleStops = {};
// ─────────── Overlay tiles ───────────
// Colour layers are drawn tile by tile from GET /api/tile/{layer}/{z}/{x}/{y}
// (fixed web-map tiles at whole hours, which the plugin saves on disk and
// answers without its data worker). Each tile is its grid painted through
// the legend ramp and clipped by its own coastline tile (256 × 256, rows
// in Web Mercator like the map). OpenLayers loads the visible tiles and
// drops queued ones that scroll away. Overlay times are rounded to the
// hour: the colour changes once an hour as the time moves.
const OVERLAY_TILE_PX = 256;
function _overlayHourIso() {
  const t = new Date(_overlayTimeIso()).getTime();
  return new Date(Math.round(t / 3600e3) * 3600e3).toISOString();
}
function _tileUrl(layer, z, x, y, hourIso) {
  return API + '/tile/' + layer + '/' + z + '/' + x + '/' + y + (hourIso ? '?time=' + encodeURIComponent(hourIso) : '');
}
// Tile fetch: the same auth breaker as authFetch but not its rate
// limiter — OpenLayers already caps concurrent tile loads, and saved
// tiles answer in milliseconds.
async function _tileFetch(url) {
  if (AuthGate.tripped) throw new Error('auth-gate-tripped');
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) { AuthGate.trip(401); throw new Error('auth 401'); }
  if (!r.ok) throw await _apiError(r);
  return r;
}
// A tile's JSON body; an empty or unparsable body (a damaged saved tile)
// is named as such rather than by the parser's message.
async function _tileJson(r) {
  const text = await r.text();
  if (!text) throw new Error('empty tile from the server (a damaged saved tile; it is rebuilt on the next request)');
  try { return JSON.parse(text); } catch (err) { throw new Error('unreadable tile from the server (a damaged saved tile; it is rebuilt on the next request)', { cause: err }); }
}
// Small in-page caches so a redraw (tide rescale, hour back and forth)
// does not refetch.
function _lruGet(m, key, make, max) {
  if (m.has(key)) { const v = m.get(key); m.delete(key); m.set(key, v); return v; }
  const v = make().catch(err => { m.delete(key); throw err; });
  m.set(key, v);
  while (m.size > max) m.delete(m.keys().next().value);
  return v;
}
const _tileGridCache = new Map();
const _landTileCache = new Map();
function _tileGrid(layer, z, x, y, hourIso) {
  const url = _tileUrl(layer, z, x, y, hourIso);
  return _lruGet(_tileGridCache, url, () => _tileFetch(url).then(_tileJson), 600);
}
function _landTile(z, x, y) {
  return _lruGet(_landTileCache, z + '/' + x + '/' + y, () => _tileFetch(_tileUrl('land', z, x, y)).then(r => r.arrayBuffer()).then(buf => {
    const bytes = new Uint8Array(buf);
    if (bytes.length !== OVERLAY_TILE_PX * OVERLAY_TILE_PX) throw new Error('land tile size ' + bytes.length);
    return bytes;
  }), 600);
}
// Paint one tile: RGBA bytes, pixel (x, y) at the tile's Web Mercator
// extent `ext`. `mask` is the tile's coastline (same pixel grid) or null.
// `gx0`/`gy0`: the tile's first pixel in the world, so the no-data hatch
// runs on across tile edges.
function _paintTile(grid, spec, mask, ext, gx0, gy0) {
  const N = OVERLAY_TILE_PX;
  const data = new Uint8ClampedArray(N * N * 4);
  const stops = spec.stops || _legendStops(spec.legend);
  if (!stops) return data; // legends not loaded: nothing to paint with (the loader waits for them)
  const { v0, v1, lut } = _rampLut(stops);
  const legend = _LEGENDS ? _LEGENDS[spec.legend] : null;
  const fadeBelow = legend && legend.fade_below ? legend.fade_below : 0;
  const sample = _gridSampler(grid, grid.fields[spec.field]);
  const sampleLand = spec.maskLand && !mask ? _gridSampler(grid, grid.land) : null;
  const sampleAlpha = spec.alphaField ? _gridSampler(grid, grid.fields[spec.alphaField]) : null;
  const baseA = spec.alpha == null ? 0.55 : spec.alpha;
  const span = (v1 - v0) || 1;
  const R = 6378137;
  const [ex0, ey0, ex1, ey1] = ext;
  // Pixels the "no data" hatch marks, drawn after the coast is softened so it stays sharp.
  const hatched = [];
  for (let y = 0; y < N; y++) {
    const my = ey1 - (y + 0.5) / N * (ey1 - ey0);
    const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180 / Math.PI;
    for (let x = 0; x < N; x++) {
      if (spec.maskLand && mask && mask[y * N + x]) continue;
      const lon = (ex0 + (x + 0.5) / N * (ex1 - ex0)) / R * 180 / Math.PI;
      const v = sample(lon, lat);
      if (v == null) {
        // Water (per the coastline) the source model has no value for:
        // channels narrower than its grid. Hatch it so a gap never reads as
        // zero. Needs the coastline tile to know it is water.
        if (spec.hatchNoData && mask && ((gx0 + x + gy0 + y) % 7) < 1) hatched.push((y * N + x) * 4);
        continue;
      }
      if (sampleLand) { const l = sampleLand(lon, lat); if (l != null && l > 0.5) continue; }
      let a = baseA;
      if (sampleAlpha) { const sg = sampleAlpha(lon, lat); a *= sg == null ? 0 : Math.max(0, Math.min(1, sg)); }
      if (fadeBelow) a *= Math.max(0, Math.min(1, v / fadeBelow));
      if (a <= 0.002) continue;
      const idx = Math.max(0, Math.min(255, Math.round((v - v0) / span * 255)));
      const o = (y * N + x) * 4;
      data[o] = lut[idx * 3]; data[o + 1] = lut[idx * 3 + 1]; data[o + 2] = lut[idx * 3 + 2]; data[o + 3] = Math.round(a * 255);
    }
  }
  if (spec.maskLand) _featherAlpha(data);
  for (const o of hatched) { data[o] = 96; data[o + 1] = 96; data[o + 2] = 96; data[o + 3] = 150; }
  return data;
}
// The coast softened, as the plugin's PNG tiles (src/plugin/pngtiles.ts featherAlpha): with land left transparent,
// the whole alpha blurred (Gaussian, σ = 1 px, radius 4 px, edges repeated); a pixel that had no colour takes the
// alpha-weighted colour of the pixels the blur brings in, not black.
const _FEATHER_KERNEL = (() => {
  const k = Array.from({ length: 9 }, (_v, i) => Math.exp(-((i - 4) ** 2) / 2));
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map(v => v / sum);
})();
function _featherBlur(src) {
  const n = OVERLAY_TILE_PX;
  const pass = (s, horizontal) => {
    const out = new Float32Array(s.length);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = -4; k <= 4; k++) {
          const ii = horizontal ? Math.min(n - 1, Math.max(0, i + k)) : i;
          const jj = horizontal ? j : Math.min(n - 1, Math.max(0, j + k));
          acc += s[jj * n + ii] * _FEATHER_KERNEL[k + 4];
        }
        out[j * n + i] = acc;
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}
function _featherAlpha(rgba) {
  const n = OVERLAY_TILE_PX * OVERLAY_TILE_PX;
  const alpha = new Float32Array(n);
  for (let p = 0; p < n; p++) alpha[p] = rgba[p * 4 + 3];
  const a2 = _featherBlur(alpha);
  const fill = [];
  let needFill = false;
  for (let p = 0; p < n; p++) if (alpha[p] === 0 && a2[p] >= 0.5) { needFill = true; break; }
  if (needFill)
    for (let c = 0; c < 3; c++) {
      const pre = new Float32Array(n);
      for (let p = 0; p < n; p++) pre[p] = rgba[p * 4 + c] * alpha[p];
      fill.push(_featherBlur(pre));
    }
  for (let p = 0; p < n; p++) {
    const a = Math.floor(a2[p] + 1e-6);
    if (alpha[p] === 0 && a > 0) for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(fill[c][p] / Math.max(a2[p], 1e-6));
    rgba[p * 4 + 3] = a;
  }
}
// Symmetric auto-scale (tide height) across tiles: the scale grows to the
// largest |value| over water in the tiles loaded for this hour; when it
// grows, the layer redraws from the in-page cache.
function _noteTileScale(layer, spec, grid) {
  if (!spec.autoScaleSym) return;
  const base = _legendStops(spec.legend);
  if (!base) return;
  const rows = grid.fields[spec.field] || [];
  let m = 0;
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j], lr = grid.land && grid.land[j];
    for (let i = 0; i < r.length; i++) {
      const v = r[i];
      if (v == null || (lr && lr[i])) continue;
      const a = Math.abs(v);
      if (a > m) m = a;
    }
  }
  const S = Math.max(spec.minScale || 0.5, Math.ceil(m * 4) / 4);
  if (spec._scale != null && S <= spec._scale) return;
  const first = spec._scale == null;
  spec._scale = S;
  const baseMax = Math.max(...base.map(s => Math.abs(s[0]))) || 1;
  spec.stops = base.map(([v, c]) => [+(v * S / baseMax).toFixed(4), c]);
  _autoScaleStops[spec.legend] = spec.stops;
  updateLegends();
  if (!first) {
    clearTimeout(spec._redraw);
    spec._redraw = setTimeout(() => { if (layer.getSource()) layer.setSource(_colourTileSource(layer, spec, spec._hour)); }, 250);
  }
}
// OpenLayers 9.1's canvas tile layer draws only image tiles (a DataTile
// source needs its WebGL layer), so each tile is painted into a canvas and
// handed to the image tile. The tile "URL" is just its key: layer, hour and
// the wrapped z/x/y.
function _colourTileSource(layer, spec, hourIso) {
  const grid = ol.tilegrid.createXYZ({ tileSize: OVERLAY_TILE_PX, maxZoom: 18 });
  const src = new ol.source.TileImage({
    tileGrid: grid,
    wrapX: true,
    interpolate: true,
    transition: 0,
    attributions: spec.attributions,
    tileUrlFunction: c => spec.tileLayer + '|' + hourIso + '|' + c[0] + '|' + c[1] + '|' + c[2],
    tileLoadFunction: (tile, key) => {
      const [, , zs, xs, ys] = key.split('|');
      const z = +zs, x = +xs, y = +ys;
      const ext = grid.getTileCoordExtent([z, x, y]);
      Promise.all([
        _tileGrid(spec.tileLayer, z, x, y, hourIso),
        spec.maskLand ? _landTile(z, x, y).catch(err => { console.log('coastline tile unavailable, using grid land flags: ' + err.message); return null; }) : null,
      ]).then(([g, mask]) => {
        _noteTileScale(layer, spec, g);
        _noteOverlay(spec.toggleId, null);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = OVERLAY_TILE_PX;
        canvas.getContext('2d').putImageData(new ImageData(_paintTile(g, spec, mask, ext, x * OVERLAY_TILE_PX, y * OVERLAY_TILE_PX), OVERLAY_TILE_PX, OVERLAY_TILE_PX), 0, 0);
        tile.setImage(canvas);
      }).catch(err => {
        _overlayFailed(spec.tileLayer + ' tile', [spec.toggleId], err);
        tile.setState(3);   // TileState.ERROR
      });
    },
  });
  src._hour = hourIso;
  return src;
}
// Loader for a colour layer: (re)creates its tile source when the layer
// is shown without one or the overlay hour changed; panning and zooming
// need nothing (OpenLayers loads the tiles).
function _heatmapLoader(layer, toggleId, fieldLayer, spec) {
  spec.toggleId = toggleId;
  spec.tileLayer = fieldLayer;
  return function load() {
    // The ramps come from GET /api/legends; paint only once they are here.
    if (!_LEGENDS) { _loadLegends().then(() => { if (_LEGENDS) load(); }); return; }
    const hour = _overlayHourIso();
    const cur = layer.getSource();
    if (cur && cur._hour === hour) return;
    if (spec.autoScaleSym) { spec._scale = null; spec.stops = null; }
    spec._hour = hour;
    layer.setSource(_colourTileSource(layer, spec, hour));
  };
}

// A colour tile layer and its debounced loader (300 ms after the last
// view change; nothing when the layer is off). `zIndex` orders the
// layers; the per-layer notes are at each layer below.
function _heatmapLayer(zIndex, toggleId, fieldLayer, spec) {
  const layer = new ol.layer.Tile({ preload: 0, source: null, opacity: 1.0, zIndex, visible: false });
  const doLoad = _heatmapLoader(layer, toggleId, fieldLayer, spec);
  let debounce = null;
  const load = () => {
    if (!layer.getVisible()) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(doLoad, 300);
  };
  return { layer, load };
}

// ─────────── Wind-speed heatmap ───────────
// Same ramp as the barbs (0–50 kt, 8 stops), alpha 0.55, not land
// masked (wind is a real field over land).
const { layer: windHeatmapLayer, load: loadWindHeatmap } = _heatmapLayer(6, 'windCombinedToggle', 'wind', { field: 'speed_ms', legend: 'wind', maskLand: false });

// ─────────── Current-speed heatmap ───────────
// Land masked so the coasts stay sharp.
const { layer: currentHeatmapLayer, load: loadCurrentHeatmap } = _heatmapLayer(6, 'currentHeatmapToggle', 'current', { field: 'speed_ms', legend: 'current', maskLand: true, hatchNoData: true, attributions: CURRENT_ATTRIBUTION });

// ─────────── Sea-state / roughness heatmap ───────────
// Combined wind + swell + current index, painted blue→red (RdYlBu_r,
// 0–150). Alpha is 0.55 × the grid's `signal` (0..1 fade from calm),
// 0 over land.
const { layer: roughnessLayer, load: loadRoughness } = _heatmapLayer(6, 'roughnessToggle', 'sea_state', { field: 'index', legend: 'sea_state', maskLand: true, alphaField: 'signal', attributions: CURRENT_ATTRIBUTION });

// ─────────── Wave height heatmap (0–6 m, 7 stops, land masked) ───────────
const { layer: waveHeatmapLayer, load: loadWaveHeatmap } = _heatmapLayer(6, 'wavesCombinedToggle', 'waves', { field: 'swh', legend: 'waves', maskLand: true });

// ─────────── Precipitation rate heatmap ────
// Alpha fades to 0 below 0.5 mm/h (linear ramp across [0, 0.5 mm/h])
// so the broad zero-precip background does not wash out the basemap;
// land masked.
const { layer: precipHeatmapLayer, load: loadPrecipHeatmap } = _heatmapLayer(6, 'precipToggle', 'precip', { field: 'rate', legend: 'precip', maskLand: true });

// ─────────── 2-m air temperature heatmap ─────────────
// Constant alpha, no land mask: air temp is meaningful everywhere and a
// sailor at anchor still cares about the shore-side temp.
const { layer: temperatureLayer, load: loadTemperature } = _heatmapLayer(5, 'temperatureToggle', 'temperature', { field: 't2m', legend: 'temperature', maskLand: false });

// ─────────── Sea-surface (skin) temperature heatmap ──
// Land masked: over land `skt` is the land-surface temperature, not SST.
const { layer: sstLayer, load: loadSst } = _heatmapLayer(5, 'sstToggle', 'sst', { field: 'skt', legend: 'sst', maskLand: true });

// ─────────── Tide height heatmap (Copernicus Marine, −3..+3 m around mean sea level) ──
// Land masked at the true coastline; the plugin extends the 1/12° field
// up to 2 cells towards the coast for display. Hourly: reloads with the
// overlay time like the other layers.
const { layer: tideLayer, load: loadTide } = _heatmapLayer(5, 'tideToggle', 'tide', { field: 'tide_m', legend: 'tide', maskLand: true, hatchNoData: true, autoScaleSym: true, minScale: 0.5, attributions: TIDE_ATTRIBUTION });

// ─────────── MSL pressure synoptic chart (vector GeoJSON) ─────────
// Plugin returns isobars + hPa labels along each contour + H/L glyphs
// (labels are shown in the user's pressure unit, see _isobarLabel)
// at smoothed-field circulation centres. Rendered with an OL VectorLayer
// styled per `kind` property: isobar (gray; bold black on multiples of 20
// hPa), label (hPa value with white halo), high (blue "H"), low (red "L").
// Labels are text styles; redraw them when the units change.
window.addEventListener('rp:units', () => pressureLayer.changed());
function _isobarLabel(hpa) {
  const u = unitDesc('pressure');
  if (u.missing) return UNIT_MISSING;
  const t = u.fn(hpa * 100).toFixed(u.p);
  return t === '-0' ? '0' : t;
}
const pressureSource = new ol.source.Vector({});
const pressureLayer = new ol.layer.Vector({
  source: pressureSource,
  zIndex: 8,
  visible: false,
  style: function(feature) {
    const p = feature.getProperties();
    if (p.kind === 'isobar') {
      const stroke = p.bold
        ? new ol.style.Stroke({ color: '#000', width: 1.6 })
        : new ol.style.Stroke({ color: '#555', width: 1.0,
                                lineDash: [4, 3] });
      return new ol.style.Style({ stroke });
    }
    if (p.kind === 'label') {
      return new ol.style.Style({
        text: new ol.style.Text({
          text: _isobarLabel(p.hpa),
          font: 'bold 11px sans-serif',
          fill: new ol.style.Fill({ color: '#000' }),
          stroke: new ol.style.Stroke({ color: '#fff', width: 3 }),
        }),
      });
    }
    if (p.kind === 'high' || p.kind === 'low') {
      const isHigh = p.kind === 'high';
      const color = isHigh ? '#1565C0' : '#C62828';
      return [
        new ol.style.Style({
          text: new ol.style.Text({
            text: isHigh ? 'H' : 'L',
            font: 'bold 22px sans-serif',
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 4 }),
          }),
        }),
        new ol.style.Style({
          text: new ol.style.Text({
            text: _isobarLabel(p.hpa),
            offsetY: 16,
            font: 'bold 11px sans-serif',
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 3 }),
          }),
        }),
      ];
    }
    return null;
  },
});

let _pressureDebounce = null;
function loadPressure() {
  if (!pressureLayer.getVisible()) return;
  if (_pressureDebounce) clearTimeout(_pressureDebounce);
  _pressureDebounce = setTimeout(_doLoadPressure, 400);
}
function _doLoadPressure() {
  const bbox = _viewBBox();
  const timeStr = _overlayTimeIso();
  const url = API + '/pressure?bbox=' + _bboxParam(bbox) +
              '&time=' + encodeURIComponent(timeStr) + '&interval=4';
  authFetch(url, {}, 'pressure')
    .then(r => {
      if (r.status === 304) return null;
      if (!r.ok) return _apiError(r).then(e => Promise.reject(e));
      return r.json();
    })
    .then(fc => {
      if (fc === null) return;   // 304 — preserve current features.
      pressureSource.clear();
      _noteOverlay('pressureToggle', null);
      if (!fc || !fc.features) return;
      const features = (new ol.format.GeoJSON()).readFeatures(fc, {
        dataProjection: 'EPSG:4326',
        featureProjection: map.getView().getProjection(),
      });
      pressureSource.addFeatures(features);
    })
    .catch(err => _overlayFailed('Pressure overlay', ['pressureToggle'], err));
}

// ─────────── Streamlines (animated canvas overlay) ───────────
// One animated particle layer per vector field (waves, wind): fetches the
// field (`/api/field?layer=…`) for the current viewport, spawns particles
// where the magnitude is finite and the cell is water, advects them in the
// direction the field moves TO (the fields give the direction FROM), and
// fades a trail. The colour is the field's legend ramp, so the layer
// reinforces the matching heatmap. `spec`: { layer, channel, label,
// magKey, dirKey, legend, stepDeg(mag) → degrees per frame }.
function _streamlines(spec) {
  return {
    spec,
    canvas: null,
    ctx: null,
    enabled: false,
    particles: [],
    vectorField: null,
    rafId: null,
    fetching: false,
    _onMoveEnd: null,

    _init() {
      if (this.canvas) return;
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText =
        'position:absolute;top:0;left:0;pointer-events:none;z-index:5;display:none;';
      document.getElementById('map').appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this._resize();
      window.addEventListener('resize', () => this._resize());
      map.on('change:size', () => this._resize());
    },

    _resize() {
      const size = map.getSize();
      if (!size) return;
      this.canvas.width = size[0];
      this.canvas.height = size[1];
    },

    setEnabled(on) {
      this._init();
      this.enabled = on;
      this.canvas.style.display = on ? '' : 'none';
      if (on) {
        this._fetchField();
        if (!this.rafId) this._loop();
        this._onMoveEnd = () => this._fetchField();
        map.on('moveend', this._onMoveEnd);
      } else {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        this.particles = [];
        this.vectorField = null;
        if (this._onMoveEnd) { map.un('moveend', this._onMoveEnd); this._onMoveEnd = null; }
        if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    },

    _fetchField() {
      if (!this.enabled || this.fetching || AuthGate.tripped) return;
      this.fetching = true;
      fetchField(this.spec.layer, this.spec.channel).then(d => {
        this.vectorField = d;
        _attachLandMask(this, d);
        // Respawn the whole particle population: old particles are at
        // positions now out of the field's bounds.
        const N = 1500;
        this.particles = new Array(N);
        for (let i = 0; i < N; i++) this.particles[i] = this._spawn();
      }).catch(err => { if (err.name !== 'AbortError' && !err.waiting && !forecastWaiting()) console.log(this.spec.label + ':', err.message); })
        .finally(() => { this.fetching = false; });
    },

    _spawn() {
      const f = this.vectorField;
      if (!f || !f.bbox) return null;
      const [w, s, e, n] = f.bbox;
      for (let i = 0; i < 20; i++) {
        const lon = w + Math.random() * (e - w);
        const lat = s + Math.random() * (n - s);
        const sample = this._sample(lon, lat);
        if (sample) {
          return { lon, lat, age: 0, maxAge: 60 + Math.random() * 60 };
        }
      }
      return null;  // couldn't find a live cell
    },

    // { mag, dirFrom } at a position, or null over land / outside the field / without data.
    _sample(lon, lat) {
      const f = this.vectorField;
      if (!f || !f.res || !f.fields || !f.fields[this.spec.magKey]) return null;
      // Offset east of the field's first column in [0, 360) (fields can span > 180°).
      let dx = ((lon - f.lons[0]) % 360 + 360) % 360;
      if (dx > 360 - f.res / 2) dx -= 360;
      const j = Math.round(dx / f.res);
      const i = Math.round((lat - f.lats[0]) / f.res);
      if (i < 0 || i >= f.lats.length || j < 0 || j >= f.lons.length) return null;
      // Land cells are skipped so particles don't drift over the shore.
      const ml = _maskIsLand(f, this.landMask, lon, lat);
      if (ml === true) return null;
      if (ml === null && f.land && f.land[i] && f.land[i][j]) return null;
      const mag = f.fields[this.spec.magKey][i][j];
      const dirFrom = f.fields[this.spec.dirKey][i][j];
      if (mag == null || dirFrom == null) return null;
      return { mag, dirFrom };
    },

    _loop() {
      if (!this.enabled) { this.rafId = null; return; }
      const ctx = this.ctx;
      // Fade the previous frame to leave trails.
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';

      for (let k = 0; k < this.particles.length; k++) {
        let p = this.particles[k];
        if (!p) { this.particles[k] = this._spawn(); continue; }
        const sample = this._sample(p.lon, p.lat);
        if (!sample) { this.particles[k] = this._spawn(); continue; }
        // Meteorological direction FROM; velocity TO is +180°.
        const dirTo = (sample.dirFrom + 180) % 360;
        const rad = dirTo * Math.PI / 180;
        const speed = this.spec.stepDeg(sample.mag);   // deg per frame
        const coslat = Math.max(0.1, Math.cos(p.lat * Math.PI / 180));
        p.lat += Math.cos(rad) * speed;
        p.lon += Math.sin(rad) * speed / coslat;
        p.age++;
        if (p.age > p.maxAge) { this.particles[k] = this._spawn(); continue; }
        const pix = map.getPixelFromCoordinate(ol.proj.fromLonLat([p.lon, p.lat]));
        if (!pix) continue;
        ctx.fillStyle = this._color(sample.mag);
        ctx.fillRect(pix[0], pix[1], 2, 2);
      }
      this.rafId = requestAnimationFrame(() => this._loop());
    },

    // The field's legend ramp (GET /api/legends).
    _color(mag) {
      return _stopsColor(_legendStops(this.spec.legend), mag);
    },
  };
}
// Waves: direction mwd (FROM), coloured by significant wave height.
const waveStreamlines = _streamlines({
  layer: 'waves', channel: 'wave-vec', label: 'wave field error', magKey: 'swh', dirKey: 'mwd', legend: 'waves',
  stepDeg: swh => 0.0008 + 0.00025 * swh,
});
// Wind: direction dir_from, coloured by speed; the step is tuned so 20 kt is a quick drift.
const windStreamlines = _streamlines({
  layer: 'wind', channel: 'wind-vec', label: 'wind field error', magKey: 'speed_ms', dirKey: 'dir_from', legend: 'wind',
  stepDeg: v => 0.001 + 0.00012 * v,
});

// --- Seas along the route ---
// One arrow per leg, at its middle, pointing the way the waves travel,
// coloured by the leg's encounter index (the sea-state index weighted for
// the waves' angle to the course): the sea as the boat meets it.
// The seas glyphs are on the sea-state heatmap's colour scale: each band in
// the colour the heatmap's legend gives it (the stop nearest the band's
// middle, /api/legends sea_state), shifted slightly darker and outlined so a
// glyph stays visible over the heatmap. Null until the legends are loaded.
const SEA_GLYPH_SHADE = 0.15;
function _shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = sh => Math.round(((n >> sh) & 255) * (1 - f)).toString(16).padStart(2, '0');
  return '#' + c(16) + c(8) + c(0);
}
let _seaBandList = null;   // [{ lo, hi, name, colour }]
function _seaBands() {
  const L = _LEGENDS && _LEGENDS.sea_state;
  if (!L || !L.bands || !L.stops) return null;
  if (!_seaBandList) {
    _seaBandList = L.bands.map(([lo, name], i) => {
      const hi = i + 1 < L.bands.length ? L.bands[i + 1][0] : Infinity;
      const mid = (lo + (Number.isFinite(hi) ? hi : L.stops[L.stops.length - 1][0])) / 2;
      let best = L.stops[0][1], bd = Infinity;
      for (const [v, c] of L.stops) { const d = Math.abs(v - mid); if (d < bd) { bd = d; best = c; } }
      return { lo, hi, name, colour: _shade(best, SEA_GLYPH_SHADE) };
    });
  }
  return _seaBandList;
}
/** The sea-state band of an index: { name, colour }, or null (no index, legends not loaded). */
export function seaBand(idx) {
  const B = _seaBands();
  if (!B || idx == null || !Number.isFinite(idx)) return null;
  return B.find(b => idx < b.hi) || B[B.length - 1];
}
export function seaBandColour(idx) { const b = seaBand(idx); return b ? b.colour : null; }
/** Outline drawn under every seas glyph. */
const SEA_GLYPH_OUTLINE = '#0f172a';
const _seasArrowStyles = new Map();
function _seasArrowStyle(colour, travelDeg) {
  const rot = Math.round(travelDeg / 5) * 5;
  const key = colour + rot;
  let st = _seasArrowStyles.get(key);
  if (!st) {
    // A wave arrow: shaft and head, drawn pointing up (north), rotated to the travel direction.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">'
      + '<path d="M11 2 L17 10 L13 10 L13 20 L9 20 L9 10 L5 10 Z" fill="' + colour + '" stroke="' + SEA_GLYPH_OUTLINE + '" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    st = new ol.style.Style({ image: new ol.style.Icon({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), rotation: rot * Math.PI / 180, rotateWithView: true }) });
    _seasArrowStyles.set(key, st);
  }
  return st;
}
const seasRouteSource = new ol.source.Vector();
export const seasRouteLayer = new ol.layer.Vector({
  source: seasRouteSource,
  visible: true,
  style: f => { const c = seaBandColour(f.get('idx')); return c ? _seasArrowStyle(c, f.get('travelDeg')) : null; },
});
function _rebuildSeasArrows() {
  seasRouteSource.clear();
  const pts = routeSource.getFeatures()
    .filter(f => f.getGeometry() && f.getGeometry().getType() === 'Point' && f.get('time'))
    .sort((a, b) => Date.parse(a.get('time')) - Date.parse(b.get('time')));
  for (let i = 0; i + 1 < pts.length; i++) {
    const n = pts[i + 1].getProperties();   // a waypoint's values are those of the leg into it
    if (n.mwd_deg == null || n.encounter_index == null) continue;
    const a = ol.proj.toLonLat(pts[i].getGeometry().getCoordinates());
    const b = ol.proj.toLonLat(pts[i + 1].getGeometry().getCoordinates());
    let dLon = b[0] - a[0];
    if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
    seasRouteSource.addFeature(new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([a[0] + dLon / 2, (a[1] + b[1]) / 2])),
      idx: n.encounter_index,
      travelDeg: (n.mwd_deg + 180) % 360,
    }));
  }
  updateLegends();
}
let _seasTimer = null;
routeSource.on('change', () => { clearTimeout(_seasTimer); _seasTimer = setTimeout(_rebuildSeasArrows, 150); });

// --- Signal K notes ---
// Notes from the Signal K Resources API (hazards, warnings, remarks; e.g.
// signalk-passage-briefing's area warnings) as markers, for weighing a
// route against them. Loaded for the map view while the layer is on (Layers
// → Base, on by default); a click shows the note (rp-plan.js).
const notesSource = new ol.source.Vector();
const NOTE_STYLE = new ol.style.Style({
  image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: '#f9a825' }), stroke: new ol.style.Stroke({ color: '#5d4037', width: 1.5 }) }),
  text: new ol.style.Text({ text: '!', font: 'bold 11px sans-serif', fill: new ol.style.Fill({ color: '#3e2723' }) }),
  zIndex: 2,
});
// A note marked "avoid this area": red marker, and its circle (the router treats it as land).
const NOTE_AVOID_STYLE = new ol.style.Style({
  image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: '#e53935' }), stroke: new ol.style.Stroke({ color: '#7f0000', width: 1.5 }) }),
  text: new ol.style.Text({ text: '!', font: 'bold 11px sans-serif', fill: new ol.style.Fill({ color: '#fff' }) }),
  zIndex: 2,
});
const AVOID_RING_STYLE = new ol.style.Style({
  fill: new ol.style.Fill({ color: 'rgba(229,57,53,0.10)' }),
  stroke: new ol.style.Stroke({ color: '#e53935', width: 2, lineDash: [8, 5] }),
  zIndex: 1,
});
export const notesLayer = new ol.layer.Vector({
  source: notesSource,
  visible: true,
  style: f => (f.get('kind') === 'avoid' ? AVOID_RING_STYLE : f.get('avoidM') > 0 ? NOTE_AVOID_STYLE : NOTE_STYLE),
});
/** The circle of a note's avoid area, as a map polygon (true radius on the sphere). */
export function avoidRing(lonLat, radiusM) {
  return ol.geom.Polygon.circular(lonLat, radiusM, 96).transform('EPSG:4326', 'EPSG:3857');
}
let _notesSeq = 0;
export function loadNotes() {
  if (!notesLayer.getVisible()) return;
  const seq = ++_notesSeq;
  const [w, s0, e, n] = ol.proj.transformExtent(map.getView().calculateExtent(map.getSize()), 'EPSG:3857', 'EPSG:4326');
  // A view of a normal width in the main world: the notes in it; else (the
  // whole world, or a view across 180°) all notes, filtered by the map.
  const q = e - w < 360 && w >= -180 && e <= 180
    ? '?bbox=' + encodeURIComponent('[' + [w, Math.max(-90, s0), e, Math.min(90, n)].map(v => v.toFixed(4)).join(',') + ']')
    : '';
  authFetch('/signalk/v2/api/resources/notes' + q, { cache: 'no-store' }, 'notes')
    // A failed request is not an empty collection: keep the notes shown.
    .then(r => { if (!r.ok) throw new Error('notes: ' + r.status); return r.json(); })
    .then(col => {
      if (seq !== _notesSeq) return;
      notesSource.clear();
      for (const [id, note] of Object.entries(col || {})) {
        const pos = note && note.position;
        const lat = pos && (pos.latitude ?? pos[1]);
        const lon = pos && (pos.longitude ?? pos[0]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;   // a note on a region only has no point to show
        const avoidM = note.properties && note.properties.avoid && Number.isFinite(note.properties.avoid.radius_m) ? note.properties.avoid.radius_m : 0;
        notesSource.addFeature(new ol.Feature({
          geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
          kind: 'note',
          noteId: id,
          // Signal K notes carry a `title`; some older writers used `name`.
          title: note.title || note.name || 'Note',
          description: note.description || '',
          url: typeof note.url === 'string' ? note.url : '',
          timestamp: note.timestamp || '',
          source: note.$source || '',
          avoidM,
        }));
        if (avoidM > 0) notesSource.addFeature(new ol.Feature({ geometry: avoidRing([lon, lat], avoidM), kind: 'avoid', noteId: id }));
      }
    })
    .catch(err => { if (err.name !== 'AbortError' && err.message !== 'auth-gate-tripped') console.log(err.message); });
}

// --- Map ---
const _DEFAULT_LONLAT = [-71.7, 41.25];
let _SAVED_VIEW = null;
try {
  const v = JSON.parse(localStorage.getItem('rp:view') || 'null');
  if (v && isFinite(v.lon) && isFinite(v.lat) && isFinite(v.zoom)
      && Math.abs(v.lon) <= 180 && Math.abs(v.lat) <= 85) _SAVED_VIEW = v;
} catch (_) {}

export const map = new ol.Map({
  target: 'map',
  layers: [osmLayer, seamarkLayer, windHeatmapLayer, currentHeatmapLayer, roughnessLayer, waveHeatmapLayer, precipHeatmapLayer, temperatureLayer, sstLayer, tideLayer, pressureLayer, currentLayer, seasArrowsLayer, waveArrowsLayer, windLayer, frontLayer, skeletonLayer, pastRouteLayer, trackLayer, routeLayer, proposedRouteLayer, vesselMarkerLayer, notesLayer, seasRouteLayer, ringLayer, markerLayer, condMarkerLayer, meteoMarkerLayer],
  view: new ol.View({
    // Last view this browser had (saved on every move), else Block
    // Island Sound at zoom 11, until the first Signal K position fix
    // (navigation.position) pans to the vessel.
    center: ol.proj.fromLonLat(_SAVED_VIEW ? [_SAVED_VIEW.lon, _SAVED_VIEW.lat] : _DEFAULT_LONLAT),
    zoom: _SAVED_VIEW ? _SAVED_VIEW.zoom : 11
  })
});

// Keep the side panel clear of the map's attribution line: its height
// changes with the window width and the visible layers, so measure it.
(function () {
  const setAttribH = () => {
    const el = document.querySelector('.ol-attribution');
    const h = el ? Math.ceil(el.getBoundingClientRect().height) + 8 : 0;
    document.documentElement.style.setProperty('--attrib-h', h + 'px');
  };
  const el = document.querySelector('.ol-attribution');
  if (el && typeof ResizeObserver === 'function') new ResizeObserver(setAttribH).observe(el);
  window.addEventListener('resize', setAttribH);
  setAttribH();
})();

// Every load opens on the boat: routes are planned from where it is, and
// the view saved last time can be anywhere (on a first visit, Block
// Island Sound). The first Signal K fix centres the map on it, keeping
// the saved zoom, unless the map has moved since the load (the user, or
// a route fitted into view) before the fix came. The page never asks
// the browser for its location: the vessel's position comes from Signal K.
//
// The view is saved on every move, so the zoom carries over and the
// start view stands in while Signal K has no position. OL fires moveend
// after the first render too; that one is not a move, and saving it would
// keep the default view on a first visit. A zoom is a move: the zoom
// buttons keep the centre (PR #70 review).
let _autoCentreOnVessel = true;   // until the first Signal K fix, or the map moves
const _startCenter = map.getView().getCenter();
const _startZoom = map.getView().getZoom();
map.on('moveend', function() {
  const v = map.getView();
  const c = v.getCenter();
  if (_autoCentreOnVessel) {
    if (c[0] === _startCenter[0] && c[1] === _startCenter[1] && v.getZoom() === _startZoom) return;
    _autoCentreOnVessel = false;
  }
  const [lon, lat] = ol.proj.toLonLat(c);
  try { localStorage.setItem('rp:view', JSON.stringify({ lon, lat, zoom: v.getZoom() })); } catch (_) {}
});
// The first Signal K fix of the load opens the map on the boat (rp-plan.js).
// Not while the view is animating: something else (a route being fitted)
// is moving the map already.
export function centreOnVesselOnce(coord) {
  if (!_autoCentreOnVessel) return;
  _autoCentreOnVessel = false;
  const v = map.getView();
  if (v.getAnimating()) return;
  v.animate({ center: coord, duration: 400 });
}

// Every overlay keyed by the view and the overlay time (each loader
// debounces itself and does nothing when its layer is off). `currents`:
// the current arrows too (they do not follow the departure change);
// `streamlines`: refetch the wave / wind streamline fields (they attach
// their own moveend listener in setEnabled, so the view change skips them).
export function reloadOverlays({ currents = true, streamlines = false } = {}) {
  if (currents) loadCurrentOverlay();
  loadSeasArrows();
  loadWaveArrows();
  loadWindOverlay();
  loadWindHeatmap();
  loadCurrentHeatmap();
  loadRoughness();
  loadWaveHeatmap();
  loadPrecipHeatmap();
  loadTemperature();
  loadSst();
  loadTide();
  loadPressure();
  if (streamlines) {
    if (waveStreamlines.enabled) waveStreamlines._fetchField();
    if (windStreamlines.enabled) windStreamlines._fetchField();
  }
}
// Reload overlays when map view changes.
map.on('moveend', function() {
  if (AuthGate.tripped) return;
  reloadOverlays({ currents: true, streamlines: false });
});

// ─────────── Legends ───────────
// One row per active water/weather overlay, drawn from the same
// colour stops the heatmaps use (`GET /api/legends`, SI values) plus the
// barb/arrow class tables. Values shown in display units.
let _LEGENDS = null, _legendsReq = null;
// Resolves when the legends are loaded (or the request failed); the
// heatmaps wait for it, there is no fallback copy of the ramps.
// The seas glyphs wait for the legends' colours: draw them once they are in.
function _seasColoursReady() {
  seasArrowsLayer.changed();
  seasRouteLayer.changed();
  waveArrowsLayer.changed();
  window.dispatchEvent(new Event('rp:seacolours'));
}
function _loadLegends() {
  if (_LEGENDS) return Promise.resolve();
  if (_legendsReq) return _legendsReq;
  _legendsReq = authFetch(API + '/legends', {}, null)
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d) { _LEGENDS = d; _seaBandList = null; updateLegends(); _seasColoursReady(); } })
    .catch(() => {})
    .finally(() => { _legendsReq = null; });
  return _legendsReq;
}
_loadLegends();

function _legendUnit(quantity) {
  if (quantity === 'speed') { const d = unitDesc('speed'); d.p = 0; return d; }
  if (quantity === 'wave_height') { const d = unitDesc('wave_height'); d.p = Math.min(d.p, 1); return d; }
  if (quantity === 'temperature') { const d = unitDesc('temperature'); d.p = 0; return d; }
  // Precip stops are a water-depth rate in m/s, as is the precip unit.
  if (quantity === 'precip_depth_rate') return unitDesc('precip');
  // Sea-level heights (tide) follow the user's depth unit.
  if (quantity === 'sea_level') { const d = unitDesc('depth'); d.p = Math.min(d.p, 1); return d; }
  return { fn: v => v, u: '', p: 0 };
}
function _legendVal(v, u) {
  if (u.missing) return UNIT_MISSING;
  const x = u.fn(v);
  const s = x.toFixed(u.p);
  return s === '-0' ? '0' : s;
}
function _gradientRow(L) {
  const u = _legendUnit(L.quantity);
  const v0 = L.stops[0][0], v1 = L.stops[L.stops.length - 1][0], span = (v1 - v0) || 1;
  const pct = v => ((v - v0) / span * 100).toFixed(1);
  const grad = 'linear-gradient(to right, ' + L.stops.map(([v, c]) => c + ' ' + pct(v) + '%').join(', ') + ')';
  // At most ~6 tick labels: first, last, and evenly chosen stops between.
  const n = L.stops.length, every = Math.max(1, Math.ceil((n - 2) / 4));
  const ticks = L.stops.map(([v], i) => ({ v, i })).filter(t => t.i === 0 || t.i === n - 1 || ((t.i % every) === 0));
  const tickHtml = ticks.map(t => '<span class="' + (t.i === 0 ? 'first' : t.i === n - 1 ? 'last' : '') + '" style="left:' + pct(t.v) + '%;">' + _legendVal(t.v, u) + (t.i === n - 1 ? '+' : '') + '</span>').join('');
  return '<div class="lg-row"><div class="lg-title">' + L.title + ' <span>(' + u.u + ')</span></div>'
    + '<div class="lg-bar" style="background:' + grad + ';"></div><div class="lg-ticks">' + tickHtml + '</div></div>';
}
function _bandsRow(L) {
  const cells = L.bands.map(([lo, name], i) => {
    const hi = i + 1 < L.bands.length ? L.bands[i + 1][0] : L.stops[L.stops.length - 1][0];
    const mid = (lo + hi) / 2;
    let best = L.stops[0][1], bd = Infinity;
    for (const [v, c] of L.stops) { const d = Math.abs(v - mid); if (d < bd) { bd = d; best = c; } }
    return '<div><i style="background:' + best + ';"></i>' + name + '</div>';
  }).join('');
  return '<div class="lg-row"><div class="lg-title">' + L.title + '</div><div class="lg-classes">' + cells + '</div></div>';
}
// Class bounds are in knots (the symbols are knot-based); shown in the
// preset's speed unit.
function _classesRow(title, classes, glyph) {
  const u = unitDesc('speed'); u.p = 1;
  const cv = kt => { if (u.missing) return UNIT_MISSING; const t = u.fn(kt * KT_MS).toFixed(u.p); return t.replace(/\.0$/, ''); };
  const cells = classes.map(([lo, color], i) => {
    const hi = i + 1 < classes.length ? classes[i + 1][0] : null;
    const label = hi == null ? '≥' + cv(lo) : (i === 0 ? '&lt;' + cv(hi) : cv(lo) + '–' + cv(hi));
    const g = glyph ? '<span class="lg-glyph">' + glyph(lo, color) + '</span>' : '';
    return '<div>' + g + '<i style="background:' + color + ';"></i>' + label + '</div>';
  }).join('');
  return '<div class="lg-row"><div class="lg-title">' + title + ' <span>(' + u.u + ')</span></div><div class="lg-classes">' + cells + '</div></div>';
}
function _on(id) { const el = /** @type {HTMLInputElement} */ (document.getElementById(id)); return !!(el && el.checked); }
function _noteRow(id) {
  const m = _overlayNotes[id];
  return m ? '<div class="lg-note" style="color:var(--danger);">unavailable: ' + m + '</div>' : '';
}
// The sea-state bands in the colours the seas glyphs are drawn in (seaBand).
// `minIdx`: only the bands from that index up (style B draws nothing calmer than choppy).
function _seaBandsRow(title, minIdx = -Infinity) {
  const cells = (_seaBands() || []).filter(b => b.hi > minIdx).map(b => '<div><i style="background:' + b.colour + ';border-color:' + SEA_GLYPH_OUTLINE + ';"></i>' + b.name + '</div>').join('');
  return '<div class="lg-row"><div class="lg-title">' + title + '</div><div class="lg-classes">' + cells + '</div></div>';
}
// The layer's key: three cells, each glyph drawn as on the map (in the
// "rough" colour, outlined) with what it means under it.
function _seasGlyphKey() {
  const colour = seaBandColour(125) || '#cc5636';
  const cell = (svg, label) => '<div><span class="lg-sym">' + svg + '</span>' + label + '</div>';
  if (SEAS_STYLE === 'C') {
    const one = kind => _seasThreeSvg([{ kind, deg: 45 }], colour);
    return '<div class="lg-cells">' + cell(one('wind'), 'wind') + cell(one('waves'), 'waves') + cell(one('current'), 'current') + '</div>'
      + '<div class="lg-note">Each arrow points where it is going. Where two point against each other the sea is rough: wind against current, waves against current, or wind against waves.</div>';
  }
  if (SEAS_STYLE === 'B') {
    const p = x => Math.round((x - 1) * 100);
    return '<div class="lg-cells">'
      + cell(_seasMarkSvg(SEAS_RIP_MIN_STEEPEN, colour), p(SEAS_RIP_MIN_STEEPEN) + '–' + p(SEAS_BREAK_MIN_STEEPEN) + ' % steeper')
      + cell(_seasMarkSvg(SEAS_BREAK_MIN_STEEPEN, colour), p(SEAS_BREAK_MIN_STEEPEN) + '–' + p(SEAS_SPRAY_MIN_STEEPEN) + ' % steeper')
      + cell(_seasMarkSvg(SEAS_SPRAY_MIN_STEEPEN, colour), p(SEAS_SPRAY_MIN_STEEPEN) + ' % or more')
      + '</div><div class="lg-note">Waves steepened by a current running against them; only where the sea is choppy or rougher.</div>';
  }
  return '<div class="lg-cells">'
    + cell(_seasGlyphSvg('opposing', colour), 'current against the waves')
    + cell(_seasGlyphSvg('following', colour), 'current with the waves')
    + cell(_seasGlyphSvg('none', colour), 'little current')
    + '</div><div class="lg-note">Each arrow points the way the waves travel; larger where the current steepens them.</div>';
}
function updateLegends() {
  const box = document.getElementById('legendBox');
  if (!box) return;
  if (_LEGENDS == null) _loadLegends();
  const rows = [];
  const G = _LEGENDS || {};
  // Barb glyph per class: the class's lower bound drawn as the map draws
  // it (calm circle, half feather, full feathers) in the class colour.
  if (_on('windToggle')) rows.push(_classesRow('Wind barbs', WIND_BARB_CLASSES, (lo, c) => _windBarbSvg(lo, c)) + _noteRow('windToggle'));
  if (_on('windCombinedToggle') && G.wind) rows.push(_gradientRow(G.wind) + _noteRow('windCombinedToggle'));
  if (_on('currentToggle')) rows.push(_classesRow('Tidal current', CURRENT_ARROW_CLASSES) + _noteRow('currentToggle'));
  if (_on('currentHeatmapToggle') && G.current) rows.push(_gradientRow(G.current) + '<div class="lg-note"><span style="display:inline-block;width:14px;height:9px;vertical-align:middle;margin-right:4px;border:1px solid #bbb;background:repeating-linear-gradient(135deg,rgba(96,96,96,.6) 0 1px,transparent 1px 5px);"></span>no model data: water narrower than the model grid (about ' + _fmt(9000, 'distance') + ')</div>' + _noteRow('currentHeatmapToggle'));
  if (_on('wavesCombinedToggle') && G.waves) rows.push(_gradientRow(G.waves) + _noteRow('wavesCombinedToggle'));
  if (_on('roughnessToggle') && G.sea_state) rows.push(_bandsRow(G.sea_state) + _noteRow('roughnessToggle'));
  if (_on('waveArrowsToggle') && G.waves) {
    // Arrows of 5, 10 and 15 s, drawn as the map draws them (unrotated).
    const key = [5, 10, 15].map(t => '<span style="display:inline-block;vertical-align:bottom;margin-right:2px;">'
      + _waveArrowSvg('currentColor', _waveArrowLength(t), null) + '</span>' + _fmt(t, 'wave_period')).join(' ');
    rows.push(_gradientRow(Object.assign({}, G.waves, { title: 'Wave arrows: height', stops: G.waves.stops.map(([v, c]) => [v, _shade(c, SEA_GLYPH_SHADE)]) }))
      + '<div class="lg-note">points the way the waves travel · length by mean period: ' + key + '</div>' + _noteRow('waveArrowsToggle'));
  }
  // What the current does to the waves; the colour is the sea state there (its own legend row says the bands).
  if (_on('seasArrowsToggle') && G.sea_state) {
    // The colour is the sea state: said in one line when that layer's own legend is shown, else with its bands.
    const colour = _on('roughnessToggle')
      ? '<div class="lg-note">Colour: the sea state there (as the Sea state layer).</div>'
      : '<div class="lg-note">Colour: the sea state there:</div>' + _seaBandsRow('', SEAS_STYLE === 'B' ? SEAS_RIP_MIN_INDEX : -Infinity).replace('<div class="lg-title"></div>', '');
    rows.push('<div class="lg-row"><div class="lg-title">Current against the waves</div>' + _seasGlyphKey() + colour + '</div>' + _noteRow('seasArrowsToggle'));
  }
  if (_on('seasRouteToggle') && G.sea_state && seasRouteSource.getFeatures().length) rows.push(_seaBandsRow('Seas along the route, as the boat meets them') + '<div class="lg-note">sea-state index × 1.3 in head seas, × 0.8 following · arrow points the way the waves travel</div>');
  if (_on('precipToggle') && G.precip) rows.push(_gradientRow(G.precip) + _noteRow('precipToggle'));
  if (_on('temperatureToggle') && G.temperature) rows.push(_gradientRow(G.temperature) + _noteRow('temperatureToggle'));
  if (_on('sstToggle') && G.sst) rows.push(_gradientRow(G.sst) + _noteRow('sstToggle'));
  if (_on('tideToggle') && G.tide) {
    // The map stretches the tide scale to the tiles loaded (rp-layers _noteTileScale); show the stops actually drawn.
    const scaled = _autoScaleStops.tide ? Object.assign({}, G.tide, { stops: _autoScaleStops.tide }) : G.tide;
    rows.push(_gradientRow(scaled) + '<div class="lg-note">scaled to the largest tide in the tiles loaded · relative to mean sea level, not chart datum · Copernicus Marine</div>' + '<div class="lg-note"><span style="display:inline-block;width:14px;height:9px;vertical-align:middle;margin-right:4px;border:1px solid #bbb;background:repeating-linear-gradient(135deg,rgba(96,96,96,.6) 0 1px,transparent 1px 5px);"></span>no model data: water narrower than the model grid (about ' + _fmt(9000, 'distance') + ')</div>' + _noteRow('tideToggle'));
  }
  if (_on('pressureToggle')) rows.push('<div class="lg-row"><div class="lg-title">Pressure <span>(' + unitDesc('pressure').u + ')</span></div><div class="lg-note">isobars every ' + fmtPressure(400) + ' · bold every ' + fmtPressure(2000) + ' · <b style="color:#1565C0">H</b> / <b style="color:#C62828">L</b> centres</div>' + _noteRow('pressureToggle') + '</div>');
  box.innerHTML = rows.join('');
}
// Any layer toggle change (user click, or the saved-state restore that
// dispatches bubbling change events) refreshes the box.
const _layersSec = document.getElementById('layersSection');
if (_layersSec) _layersSec.addEventListener('change', updateLegends);
// The page may have loaded already: rp-core.js holds module start-up for the user's choices.
if (document.readyState === 'complete') updateLegends();
else window.addEventListener('load', updateLegends);

// The auth gate stops the map from loading more data; repaint once so the frozen state shows.
AuthGate.onStop(() => map.render());
window.addEventListener('rp:units', updateLegends);

let _notesTimer = null;
map.on('moveend', () => { clearTimeout(_notesTimer); _notesTimer = setTimeout(loadNotes, 300); });

// ─────────── Layer toggles ───────────
// One row per checkbox in the Layers tab: the layer it shows, how to
// load it when switched on, how to drop its data when switched off, and
// the flow lines that follow it. Each checkbox's state is kept in
// localStorage and restored here (the restore fires `change`, so the
// legends box and the exclusive heatmap group follow).
const LAYER_TOGGLES = [
  ['osmToggle', osmLayer],
  ['seamarkToggle', seamarkLayer],
  ['vesselToggle', vesselMarkerLayer],
  ['notesToggle', notesLayer, loadNotes, () => notesSource.clear()],
  ['seasRouteToggle', seasRouteLayer],
  ['frontToggle', frontLayer],
  // The point sources are refreshed, not cleared, when turned off: clear()
  // keeps the loaded-extent index, so turning a layer back on at the same
  // hour and zoom would load nothing (_syncPointSource).
  ['windToggle', windLayer, loadWindOverlay, () => windSource.refresh()],
  ['windCombinedToggle', windHeatmapLayer, loadWindHeatmap, () => windHeatmapLayer.setSource(null), windStreamlines],
  ['precipToggle', precipHeatmapLayer, loadPrecipHeatmap, () => precipHeatmapLayer.setSource(null)],
  ['temperatureToggle', temperatureLayer, loadTemperature, () => temperatureLayer.setSource(null)],
  ['sstToggle', sstLayer, loadSst, () => sstLayer.setSource(null)],
  ['pressureToggle', pressureLayer, loadPressure, () => pressureSource.clear()],
  ['currentToggle', currentLayer, loadCurrentOverlay, () => currentSource.refresh()],
  // The two share one source: refreshed only when both are off.
  ['seasArrowsToggle', seasArrowsLayer, loadSeasArrows, () => { if (!waveArrowsLayer.getVisible()) seasSource.refresh(); }],
  ['waveArrowsToggle', waveArrowsLayer, loadWaveArrows, () => { if (!seasArrowsLayer.getVisible()) seasSource.refresh(); }],
  ['currentHeatmapToggle', currentHeatmapLayer, loadCurrentHeatmap, () => currentHeatmapLayer.setSource(null)],
  ['wavesCombinedToggle', waveHeatmapLayer, loadWaveHeatmap, () => waveHeatmapLayer.setSource(null), waveStreamlines],
  ['roughnessToggle', roughnessLayer, loadRoughness, () => roughnessLayer.setSource(null)],
  ['tideToggle', tideLayer, loadTide, () => tideLayer.setSource(null)],
];
for (const [id, layer, load, clear, streamlines, persist = true] of LAYER_TOGGLES) {
  const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
  if (!el) continue;
  const KEY = 'layer:' + id;
  el.addEventListener('change', () => {
    layer.setVisible(el.checked);
    if (el.checked) { if (load) load(); } else if (clear) clear();
    if (streamlines) streamlines.setEnabled(el.checked);
    if (persist) { try { localStorage.setItem(KEY, el.checked ? 'true' : 'false'); } catch (_) {} }
  });
  if (!persist) continue;
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_) {}
  if (saved !== 'true' && saved !== 'false') continue;
  const want = saved === 'true';
  if (el.checked !== want) {
    el.checked = want;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
// The first forecast is ready (rp-core.js): every visible layer afresh,
// since their tiles failed or waited meanwhile. Colour layers get a new
// source, point layers forget the tiles they tried, the legend notes go.
window.addEventListener('rp:forecast-ready', () => {
  for (const k of Object.keys(_overlayNotes)) delete _overlayNotes[k];
  for (const [id, layer, , clear] of LAYER_TOGGLES) {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    // Notes come from Signal K, not the forecast: they stay.
    if (id !== 'notesToggle' && el && el.checked && layer && layer.getVisible() && clear) clear();
  }
  for (const src of [currentSource, windSource, seasSource]) src.refresh();
  reloadOverlays({ currents: true, streamlines: true });
  updateLegends();
});
// The Decision lines switch beside Find Route is the same switch as the one
// in Layers → Base: either drives the other, and the saved state is one.
{
  const main = /** @type {HTMLInputElement} */ (document.getElementById('frontToggle'));
  const twin = /** @type {HTMLInputElement} */ (document.getElementById('frontToggleRoute'));
  if (main && twin) {
    twin.checked = main.checked;
    twin.addEventListener('change', () => {
      if (main.checked === twin.checked) return;
      main.checked = twin.checked;
      main.dispatchEvent(new Event('change', { bubbles: true }));
    });
    main.addEventListener('change', () => { twin.checked = main.checked; });
  }
}
