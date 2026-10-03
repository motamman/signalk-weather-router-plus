import { authFetch } from './rp-core.js';

// Raster chart descriptors advertised by the shared Signal K chart API.
// Kept separate so descriptor handling can be tested without a map/browser.
export function signalKCharts(catalog, origin) {
  const formats = new Set(['png', 'jpg', 'jpeg', 'webp']);
  const charts = [];
  for (const [id, entry] of Object.entries(catalog || {})) {
    const chart = entry && (entry.value || entry);
    if (!chart) continue;
    const type = String(chart.type || chart.serverType || 'tilelayer').toLowerCase();
    if (!['tilelayer', 'xyz', 'wms'].includes(type) ||
        !formats.has(String(chart.format || 'png').toLowerCase())) continue;
    const template = chart.url || chart.tilemapUrl;
    if (typeof template !== 'string') continue;
    if (type !== 'wms' && !['{z}', '{x}', '{y}'].every(t => template.includes(t))) continue;
    const layers = chart.layers || chart.chartLayers;
    if (type === 'wms' && (!Array.isArray(layers) || !layers.length || !layers.every(v => typeof v === 'string'))) continue;
    let url;
    try { url = new window.URL(template, origin); } catch (_) { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const number = (value, fallback) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;
    const minZoom = Math.max(0, Math.min(24, number(chart.minzoom ?? chart.minZoom, 0)));
    const maxZoom = Math.max(minZoom, Math.min(24, number(chart.maxzoom ?? chart.maxZoom, 18)));
    const bounds = Array.isArray(chart.bounds) ? chart.bounds.map(Number) : typeof chart.bounds === 'string' ? chart.bounds.split(',').map(Number) : null;
    const extent = bounds && bounds.length === 4 && bounds.every(Number.isFinite) &&
      bounds[0] < bounds[2] && bounds[1] < bounds[3] && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90 ? bounds : null;
    charts.push({ id, type, layers: layers || [], online: url.origin !== origin, name: String(chart.name || id), url: url.href.replace(/%7B/gi, '{').replace(/%7D/gi, '}'),
      minZoom, maxZoom, tileSize: number(chart.tileSize, 256) === 512 ? 512 : 256,
      bounds: extent, scale: number(chart.scale, 250000), opacity: Math.max(0, Math.min(1, number(chart.defaultOpacity, 1))) });
  }
  // Detailed charts draw above less detailed ones when 'All' is selected.
  return charts.sort((a, b) => b.scale - a.scale || a.name.localeCompare(b.name));
}

export const localChartLayer = new ol.layer.Group({ layers: [], zIndex: 1, visible: false });
let _localCharts = [];
let _localChartChoice = '';
let _localChartsEnabled = false;
try {
  _localChartChoice = localStorage.getItem('rp:localChartChoice') || '';
  _localChartsEnabled = localStorage.getItem('rp:localChartsEnabled') === 'true';
} catch (_) {}

function updateLocalCharts() {
  const toggle = document.getElementById('localChartsToggle');
  const picker = document.getElementById('localChartPicker');
  _localChartsEnabled = toggle.checked;
  _localChartChoice = picker.value;
  localChartLayer.setVisible(_localChartsEnabled);
  localChartLayer.getLayers().forEach(layer => layer.setVisible(_localChartChoice ? layer.get('chartId') === _localChartChoice : !layer.get('onlineChart')));
  try {
    localStorage.setItem('rp:localChartsEnabled', String(_localChartsEnabled));
    localStorage.setItem('rp:localChartChoice', _localChartChoice);
  } catch (_) {}
}

async function loadLocalCharts() {
  const toggle = document.getElementById('localChartsToggle');
  const picker = document.getElementById('localChartPicker');
  const note = document.getElementById('localChartsNote');
  const refresh = document.getElementById('localChartsRefresh');
  refresh.disabled = true;
  note.textContent = 'Loading Signal K charts…';
  try {
    let catalog;
    for (const version of [2, 1]) {
      const response = await authFetch('/signalk/v' + version + '/api/resources/charts', {}, 'signalk-chart-catalog');
      if (response.status === 404) continue;
      if (!response.ok) throw new Error('Chart catalog: HTTP ' + response.status);
      catalog = await response.json();
      break;
    }
    _localCharts = signalKCharts(catalog, window.location.origin);
    const layers = _localCharts.map(chart => {
      const source = chart.type === 'wms' ? new ol.source.TileWMS({ url: chart.url,
        params: { LAYERS: chart.layers.join(',') } }) :
        new ol.source.XYZ({ url: chart.url, minZoom: chart.minZoom, maxZoom: chart.maxZoom, tileSize: chart.tileSize, wrapX: false });
      const options = { source,
        visible: _localChartChoice ? chart.id === _localChartChoice : !chart.online, opacity: chart.opacity, minZoom: chart.minZoom - 0.000001 };
      if (chart.bounds) options.extent = ol.proj.transformExtent(chart.bounds, 'EPSG:4326', 'EPSG:3857');
      const layer = new ol.layer.Tile(options);
      layer.set('chartId', chart.id);
      layer.set('onlineChart', chart.online);
      return layer;
    });
    localChartLayer.getLayers().clear();
    layers.forEach(layer => localChartLayer.getLayers().push(layer));
    picker.replaceChildren();
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'Local charts together'; picker.appendChild(all);
    for (const chart of [..._localCharts].sort((a, b) => a.name.localeCompare(b.name))) {
      const option = document.createElement('option');
      option.value = chart.id; option.textContent = chart.name + (chart.online ? ' — online' : '') + (_localCharts.filter(c => c.name === chart.name).length > 1 ? ' (' + chart.id + ')' : ''); picker.appendChild(option);
    }
    if (!_localCharts.some(chart => chart.id === _localChartChoice)) _localChartChoice = '';
    picker.value = _localChartChoice;
    toggle.disabled = picker.disabled = !_localCharts.length;
    toggle.checked = _localChartsEnabled && !!_localCharts.length;
    localChartLayer.setVisible(toggle.checked);
    localChartLayer.getLayers().forEach(layer => layer.setVisible(_localChartChoice ? layer.get('chartId') === _localChartChoice : !layer.get('onlineChart')));
    note.textContent = _localCharts.length ? _localCharts.length + ' chart(s) available from Signal K.' :
      'No compatible charts found. Enable charts in your chart provider, then refresh.';
  } catch (err) {
    note.textContent = 'Signal K charts unavailable: ' + err.message;
  } finally { refresh.disabled = false; }
}

// Modules wire DOM handlers directly; no globals or inline HTML handlers.
export function initializeSignalKCharts() {
  document.getElementById('localChartsToggle').addEventListener('change', updateLocalCharts);
  document.getElementById('localChartPicker').addEventListener('change', updateLocalCharts);
  document.getElementById('localChartsRefresh').addEventListener('click', loadLocalCharts);
  return loadLocalCharts();
}
