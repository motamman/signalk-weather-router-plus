import { test } from 'node:test';
import assert from 'node:assert/strict';
test('forecast-derived layers report no data outside a cropped (non-global) store', async () => {
  const { ForecastStore } = await import('../data/forecast');
  const mk = (v: number) => ({ lat0: 40, lon0: -70, dLat: 1, dLon: 1, nLat: 3, nLon: 3, values: new Float32Array(9).fill(v) });
  const steps = [0, 3].map(h => ({
    validMs: Date.UTC(2026, 8, 27) + h * 3600_000,
    stepHours: h,
    fields: new Map([
      ['10u', mk(5)],
      ['10v', mk(0)],
      ['msl', mk(101000)],
    ]),
  }));
  const store = new ForecastStore(steps, {
    cycleTime: new Date(Date.UTC(2026, 8, 27)),
    bbox: { west: -70, south: 40, east: -68, north: 42 },
    steps: [0, 3],
    params: ['10u', '10v', 'msl'],
    loadedAt: new Date(),
  });
  const { fieldGrid, windPoints, sampleConditions } = await import('./overlays');
  const src = { forecast: store, currents: null, land: null };
  const t = new Date(Date.UTC(2026, 8, 27, 1));
  const g = fieldGrid(src, 'wind', { west: -72, south: 39, east: -66, north: 43 }, t, 1);
  const col = (lon: number) => g.lons.indexOf(lon);
  const row = (lat: number) => g.lats.indexOf(lat);
  const speed = Object.values(g.fields)[0];
  assert.ok(speed[row(41)][col(-69)] !== null, 'inside has data');
  assert.equal(speed[row(41)][col(-66)], null, 'east of region');
  assert.equal(speed[row(39)][col(-69)], null, 'south of region');
  assert.equal(speed[row(43)][col(-72)], null, 'corner');
  const pts = windPoints(src, { west: -72, south: 39, east: -66, north: 43 }, t, 1);
  assert.ok(pts.length > 0 && pts.every(p => p.lon >= -70 && p.lon <= -68 && p.lat >= 40 && p.lat <= 42));
  assert.equal(sampleConditions(src, -60, 41, t).wind_ms, null);
  assert.ok(sampleConditions(src, -69, 41, t).wind_ms !== null);
});

test('precip layer keeps small m/s rates (1 mm/h ≈ 2.78e-7 m/s) instead of rounding them to 0', async () => {
  const { ForecastStore } = await import('../data/forecast');
  const { fieldGrid } = await import('./overlays');
  const mk = (v: number) => ({ lat0: 40, lon0: -70, dLat: 1, dLon: 1, nLat: 3, nLon: 3, values: new Float32Array(9).fill(v) });
  const rate = 1 / 3600 / 1000; // 1 mm/h in m/s
  const steps = [0, 3].map(h => ({
    validMs: Date.UTC(2026, 8, 27) + h * 3600_000,
    stepHours: h,
    fields: new Map([
      ['10u', mk(1)],
      ['10v', mk(0)],
      ['tprate', mk(rate)],
    ]),
  }));
  const store = new ForecastStore(steps, {
    cycleTime: new Date(Date.UTC(2026, 8, 27)),
    bbox: { west: -70, south: 40, east: -68, north: 42 },
    steps: [0, 3],
    params: ['10u', '10v', 'tprate'],
    loadedAt: new Date(),
  });
  const g = fieldGrid(
    { forecast: store, currents: null, land: null },
    'precip',
    { west: -70, south: 40, east: -68, north: 42 },
    new Date(Date.UTC(2026, 8, 27, 1)),
    1
  );
  const v = g.fields.rate[1][1]!;
  assert.ok(Math.abs(v - Math.fround(rate)) / rate < 1e-4, `got ${v}`);
});

test('landMaskImage: one byte per pixel, row 0 north, pixel centres match the page canvas', async () => {
  const { landMaskImage } = await import('./overlays');
  // Land where lon < -70 (a straight north-south coast).
  const land = {
    forBBox: () => ({ isLand: (lon: number) => lon < -70 }),
    isLandAt: (lon: number) => lon < -70,
  };
  const src = { forecast: null, currents: null, land };
  const img = landMaskImage(src, { west: -72, south: 40, east: -68, north: 42 }, 8, 4);
  assert.equal(img.length, 32);
  // Pixel width 0.5°: centres at -71.75, -71.25, -70.75, -70.25 (land), -69.75... (water).
  for (let y = 0; y < 4; y++) assert.deepEqual(Array.from(img.slice(y * 8, y * 8 + 8)), [1, 1, 1, 1, 0, 0, 0, 0]);
  assert.throws(
    () => landMaskImage({ forecast: null, currents: null, land: null }, { west: 0, south: 0, east: 1, north: 1 }, 4, 4),
    /coastline/
  );
});

test('conditions: no current source with data here is reported as no value, not 0 kn (the Narrows)', async () => {
  const { sampleConditions } = await import('./overlays');
  const { CurrentStack } = await import('../currents/stack');
  const src = (u: number, v: number) =>
    ({
      name: 'fake',
      priority: 1,
      resolutionM: 9000,
      bbox: { west: -180, south: -90, east: 180, north: 90 },
      contains: () => true,
      at: () => [u, v] as [number, number],
      atMany: (lons: Float64Array) => ({ u: new Float64Array(lons.length).fill(u), v: new Float64Array(lons.length).fill(v) }),
    }) as never;
  const t = new Date(Date.UTC(2026, 8, 30, 12));
  const none = sampleConditions({ forecast: null, currents: new CurrentStack([src(0, 0)]), land: null }, -74.03, 40.59, t);
  assert.equal(none.current_ms, null);
  assert.equal(none.current_dir_deg, null);
  const some = sampleConditions({ forecast: null, currents: new CurrentStack([src(0.3, 0.4)]), land: null }, -74.03, 40.59, t);
  assert.equal(some.current_ms, 0.5);
  assert.equal(some.current_dir_deg, 37);
});

test('conditions rows: gust, cloud cover, interval depth and fluxes appear only when the run holds them', async () => {
  const { ForecastStore } = await import('../data/forecast');
  const mk = (v: number) => ({ lat0: 40, lon0: -70, dLat: 1, dLon: 1, nLat: 3, nLon: 3, values: new Float32Array(9).fill(v) });
  const base = ['10u', '10v', 'msl'] as const;
  // A run with the extra and energy fields: interval values only from step 3 on.
  const steps = [0, 3].map(h => ({
    validMs: Date.UTC(2026, 8, 27) + h * 3600_000,
    stepHours: h,
    fields: new Map<string, ReturnType<typeof mk>>([
      ['10u', mk(1)],
      ['10v', mk(0)],
      ['msl', mk(101000)],
      ['tcc', mk(0.75)],
      ...(h === 0
        ? []
        : ([
            ['10fg', mk(9)],
            ['tp', mk(0.004)],
            ['ssrd', mk(333)],
            ['mucape', mk(1200)],
          ] as [string, ReturnType<typeof mk>][])),
    ]),
    ...(h === 0
      ? {}
      : {
          intervals: new Map([
            ['tp', 3],
            ['ssrd', 3],
          ]),
        }),
  }));
  const store = new ForecastStore(
    steps,
    {
      cycleTime: new Date(Date.UTC(2026, 8, 27)),
      bbox: { west: -70, south: 40, east: -68, north: 42 },
      steps: [0, 3],
      params: [...base, '10fg', 'tcc', 'tp', 'ssrd', 'mucape'],
      loadedAt: new Date(),
    },
    { requireWind: false }
  );
  const { sampleConditions } = await import('./overlays');
  const src = { forecast: store, currents: null, land: null };
  const t3 = new Date(Date.UTC(2026, 8, 27, 3));
  const r = sampleConditions(src, -69, 41, t3);
  assert.equal(r.gust_ms, 9);
  assert.equal(r.cloud_cover, 0.75);
  assert.equal(r.precip_m, 0.004);
  assert.equal(r.interval_h, 3);
  assert.equal(r.ssrd_wm2, 333);
  assert.equal(r.mucape_jkg, 1200);
  assert.equal(r.snowfall_m, null);
  assert.equal(r.strd_wm2, null);
  // Mid-interval: the containing interval's values, unblended.
  const mid = sampleConditions(src, -69, 41, new Date(Date.UTC(2026, 8, 27, 1, 30)));
  assert.equal(mid.precip_m, 0.004);
  assert.equal(mid.interval_h, 3);
  // Step 0: no gust and no interval values.
  const r0 = sampleConditions(src, -69, 41, new Date(Date.UTC(2026, 8, 27)));
  assert.equal(r0.gust_ms, null);
  assert.equal(r0.precip_m, null);
  assert.equal(r0.interval_h, null);
  assert.equal(r0.cloud_cover, 0.75, 'tcc is instant: it is in every step, unlike the interval fields');
  // A run without the fields: the columns stay null, the rest keeps coming.
  const bare = new ForecastStore(
    [0, 3].map(h => ({
      validMs: Date.UTC(2026, 8, 27) + h * 3600_000,
      stepHours: h,
      fields: new Map([
        ['10u', mk(1)],
        ['10v', mk(0)],
        ['msl', mk(101000)],
      ]),
    })),
    {
      cycleTime: new Date(Date.UTC(2026, 8, 27)),
      bbox: { west: -70, south: 40, east: -68, north: 42 },
      steps: [0, 3],
      params: [...base],
      loadedAt: new Date(),
    },
    { requireWind: false }
  );
  const b = sampleConditions({ forecast: bare, currents: null, land: null }, -69, 41, t3);
  assert.equal(b.wind_ms, 1);
  assert.equal(b.gust_ms, null);
  assert.equal(b.precip_m, null);
  assert.equal(b.ssrd_wm2, null);
});
