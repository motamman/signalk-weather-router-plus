/**
 * The synthetic CMEMS SMOC store the SMOC tests run against (smoc.test.ts,
 * and the mesh leg task's currents test): a tiny Zarr v2 layout served by
 * a fetch mock, with the real product's three layouts. Not a test file by
 * content; named .test.ts so it stays out of the build.
 */
import { HOUR_S } from '../geo/units';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SmocSettings } from './smoc';

// ───────────── synthetic Zarr v2 store (uncompressed chunks) ─────────────
//
// Global 1° grid (80°S..90°N × 180°W..179°E), 200 hourly steps from
// 2026-09-20T00Z, the SMOC variable layout (time, elevation, latitude,
// longitude). Three layouts like the real product: `time` (1 h × 64 × 128
// cells, partial edge chunks), `geo` (48 h × 16 × 8) and `ds4` (2° grid).
// Land (fill value) on 40..45°N × 10..20°E; the rows south of 65°S are
// fill in `time` and absent chunks (HTTP 403) in `geo`.

export const FILL = 9.969209968386869e36;
export const T0 = Date.UTC(2026, 8, 20, 0);
export const NT = 200;
export const H = 3600_000;
export const HOURS_1950 = (T0 - Date.UTC(1950, 0, 1)) / H;

export function uTrue(lat: number, lon: number, ti: number): number {
  return 0.5 * Math.sin((2 * Math.PI * lon) / 360) + 0.01 * lat + 0.001 * ti;
}
export function vTrue(lat: number, lon: number, ti: number): number {
  return 0.3 * Math.cos((2 * Math.PI * lon) / 360) - 0.005 * lat - 0.002 * ti;
}
export function isLand(lat: number, lon: number): boolean {
  return (lat >= 40 && lat <= 45 && lon >= 10 && lon <= 20) || lat < -64.5;
}

interface MockLayout {
  d: number;
  chunks: [number, number, number, number];
}
export const LAYOUTS: Record<string, MockLayout> = {
  time: { d: 1, chunks: [1, 1, 64, 128] },
  geo: { d: 1, chunks: [48, 1, 16, 8] },
  ds4: { d: 2, chunks: [1, 1, 86, 180] },
};

export function f4(vals: ArrayLike<number>): Uint8Array {
  return new Uint8Array(new Float32Array(Array.from(vals)).buffer);
}

export function layoutMeta(name: string): { nLat: number; nLon: number; zmeta: unknown } {
  const L = LAYOUTS[name];
  const nLat = Math.round(170 / L.d) + 1;
  const nLon = Math.round(360 / L.d);
  const comp = null;
  const arr = (shape: number[], chunks: number[], fill: unknown) => ({
    chunks,
    compressor: comp,
    dtype: '<f4',
    fill_value: fill,
    filters: null,
    order: 'C',
    shape,
    zarr_format: 2,
  });
  const md: Record<string, unknown> = {
    '.zattrs': { credit: 'E.U. Copernicus Marine Service Information (CMEMS)' },
    'latitude/.zarray': arr([nLat], [nLat], 'NaN'),
    'latitude/.zattrs': { _ARRAY_DIMENSIONS: ['latitude'] },
    'longitude/.zarray': arr([nLon], [nLon], 'NaN'),
    'longitude/.zattrs': { _ARRAY_DIMENSIONS: ['longitude'] },
    'time/.zarray': arr([NT], [64], 'NaN'),
    'time/.zattrs': { _ARRAY_DIMENSIONS: ['time'], calendar: 'gregorian', units: 'hours since 1950-01-01' },
    'elevation/.zarray': arr([1], [1], 'NaN'),
    'elevation/.zattrs': { _ARRAY_DIMENSIONS: ['elevation'] },
  };
  for (const v of ['utotal', 'vtotal', 'uo', 'vo']) {
    md[`${v}/.zarray`] = arr([NT, 1, nLat, nLon], L.chunks, FILL);
    md[`${v}/.zattrs`] = { _ARRAY_DIMENSIONS: ['time', 'elevation', 'latitude', 'longitude'], units: 'm s-1' };
  }
  return { nLat, nLon, zmeta: { metadata: md, zarr_consolidated_format: 1 } };
}

export interface Mock {
  fetch: typeof fetch;
  counts: Map<string, number>;
  total: () => number;
  stacUpdating: boolean;
  stacUpdated: string;
}

export function makeMock(): Mock {
  const counts = new Map<string, number>();
  const mock: Mock = {
    counts,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    stacUpdating: false,
    stacUpdated: '2026-09-28T10:42:54Z',
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      counts.set(url, (counts.get(url) ?? 0) + 1);
      const headers = { 'last-modified': 'Mon, 28 Sep 2026 08:16:14 GMT', etag: '"abc"' };
      if (url.endsWith('dataset.stac.json')) {
        return new Response(
          JSON.stringify({
            properties: {
              admp_updated_data: mock.stacUpdated,
              admp_updating_start_date: mock.stacUpdating ? '2026-09-28T08:00:00Z' : null,
            },
          }),
          { status: 200 }
        );
      }
      const m = /\/(time|geo|ds4)\.zarr\/(.+)$/.exec(url);
      if (!m) return new Response('no', { status: 404 });
      const layout = m[1];
      const key = m[2];
      const L = LAYOUTS[layout];
      const { nLat, nLon, zmeta } = layoutMeta(layout);
      if (key === '.zmetadata') return new Response(JSON.stringify(zmeta), { status: 200, headers });
      if (key === 'latitude/0') return new Response(f4(Array.from({ length: nLat }, (_, i) => -80 + i * L.d)), { status: 200 });
      if (key === 'longitude/0') return new Response(f4(Array.from({ length: nLon }, (_, i) => -180 + i * L.d)), { status: 200 });
      const tm = /^time\/(\d+)$/.exec(key);
      if (tm) {
        const c = +tm[1];
        return new Response(f4(Array.from({ length: 64 }, (_, i) => (c * 64 + i < NT ? HOURS_1950 + c * 64 + i : NaN))), { status: 200 });
      }
      const dm = /^(utotal|vtotal)\/(\d+)\.0\.(\d+)\.(\d+)$/.exec(key);
      if (!dm) return new Response('no', { status: 404 });
      const [ct, , cr, cc] = L.chunks;
      const [tc, rc, ccI] = [+dm[2], +dm[3], +dm[4]];
      if (layout === 'geo' && rc === 0) return new Response('denied', { status: 403 });
      const out = new Float32Array(ct * cr * cc).fill(FILL);
      for (let t = 0; t < ct; t++) {
        const ti = tc * ct + t;
        if (ti >= NT) continue;
        for (let r = 0; r < cr; r++) {
          const gr = rc * cr + r;
          if (gr >= nLat) continue;
          const lat = -80 + gr * L.d;
          for (let c = 0; c < cc; c++) {
            const gc = ccI * cc + c;
            if (gc >= nLon) continue;
            const lon = -180 + gc * L.d;
            if (isLand(lat, lon)) continue;
            out[(t * cr + r) * cc + c] = dm[1] === 'utotal' ? uTrue(lat, lon, ti) : vTrue(lat, lon, ti);
          }
        }
      }
      return new Response(new Uint8Array(out.buffer), { status: 200 });
    }) as typeof fetch,
  };
  return mock;
}

export const URLS = {
  time: 'https://mock/time.zarr',
  geo: 'https://mock/geo.zarr',
  ds4: 'https://mock/ds4.zarr',
  stac: 'https://mock/dataset.stac.json',
};
export const SETTINGS: SmocSettings = { stepS: 3 * HOUR_S, horizonS: 24 * HOUR_S, halfWidthDeg: 10, budgetBytes: 64 * 1024 * 1024 };

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-smoc-'));
}
