import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const code = fs
  .readFileSync(path.join(__dirname, '../../public/rp-charts.js'), 'utf8')
  .split('export const localChartLayer =')[0]
  .replace(/^import .*;$/gm, '')
  .replace('export function', 'function');
const context = vm.createContext({ URL, window: { URL } });
vm.runInContext(code, context);
const parse = (catalog: unknown): Array<Record<string, unknown>> =>
  JSON.parse(JSON.stringify(context.signalKCharts(catalog, 'http://boat:3000')));

test('discovers local raster charts across providers and API descriptor versions', () => {
  const charts = parse({
    simple: {
      name: 'Lake Michigan (South)',
      type: 'tilelayer',
      format: 'png',
      url: '/signalk/v1/api/resources/charts/Lake Michigan (South)/{z}/{x}/{y}',
      bounds: [-89, 41, -84, 44],
      minzoom: '0',
      maxzoom: '17',
    },
    other: {
      value: {
        name: 'Harbor',
        type: 'tilelayer',
        format: 'jpg',
        tilemapUrl: '/plugins/another-provider/tiles/{z}/{x}/{y}',
        scale: 10000,
        tileSize: 512,
      },
    },
    external: { type: 'tilelayer', format: 'png', url: 'https://internet.test/{z}/{x}/{y}' },
    vector: { type: 'tilelayer', format: 'pbf', url: '/charts/{z}/{x}/{y}' },
    wms: { type: 'WMS', format: 'png', url: '/wms' },
    invalid: { type: 'tilelayer', format: 'png', url: 'javascript:alert(1)' },
  });
  assert.equal(charts.length, 3);
  const lake = charts.find(c => c.id === 'simple')!;
  assert.equal(lake.name, 'Lake Michigan (South)');
  assert.match(String(lake.url), /Lake%20Michigan%20\(South\)\/\{z\}\/\{x\}\/\{y\}/);
  assert.equal(lake.maxZoom, 17);
  assert.deepEqual(lake.bounds, [-89, 41, -84, 44]);
  assert.equal(charts.find(c => c.id === 'other')!.tileSize, 512);
  assert.equal(charts.find(c => c.id === 'external')!.online, true);
});

test('malformed catalogs and metadata do not prevent chart discovery', () => {
  assert.deepEqual(parse(null), []);
  const charts = parse({
    bad: null,
    good: { type: 'tilelayer', format: 'webp', tilemapUrl: '/tiles/{z}/{x}/{y}', bounds: 'bad', minzoom: -5, maxzoom: 'invalid' },
  });
  assert.equal(charts.length, 1);
  assert.equal(charts[0].minZoom, 0);
  assert.equal(charts[0].maxZoom, 18);
  assert.equal(charts[0].bounds, null);
});

test('Freeboard-compatible XYZ and legacy serverType descriptors retain zoom and opacity', () => {
  const charts = parse({
    xyz: { type: 'XYZ', format: 'png', url: '/provider/{z}/{x}/{y}', minZoom: 3, maxZoom: 12, defaultOpacity: 0.75 },
    legacy: { serverType: 'tilelayer', format: 'jpeg', tilemapUrl: '/tiles/{z}/{x}/{y}' },
  });
  const xyz = charts.find(c => c.id === 'xyz')!;
  assert.equal(xyz.minZoom, 3);
  assert.equal(xyz.maxZoom, 12);
  assert.equal(xyz.opacity, 0.75);
  assert.equal(charts.length, 2);
});

test('Canadian WMS charts use exactly the provider URL and layer list', () => {
  const charts = parse({
    canada: {
      name: 'Canadian Nautical Charts',
      type: 'WMS',
      format: 'png',
      url: 'https://charts.example.test/WMSServer',
      layers: ['0', '1', '3'],
      bounds: [-141, 41, -52, 84],
    },
  });
  assert.equal(charts.length, 1);
  assert.equal(charts[0].type, 'wms');
  assert.equal(charts[0].url, 'https://charts.example.test/WMSServer');
  assert.deepEqual(charts[0].layers, ['0', '1', '3']);
  assert.equal(charts[0].online, true);
  assert.deepEqual(parse({ bad: { type: 'WMS', url: '/wms' } }), []);
});
