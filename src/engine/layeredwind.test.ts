import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_CELLS, HANDOFF_MS, LayeredWind, type BaseWind, type RegionalWind } from './layeredwind';

const T0 = Date.UTC(2026, 9, 3, 0);
/** A uniform wind source: `speed` m/s from `dir`°. */
function uniform(speed: number, dir: number): BaseWind {
  return {
    at: () => [speed, dir],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(speed), dir: new Float64Array(lons.length).fill(dir) }),
    hasWaves: true,
    wavesAt: () => ({ swh: 1.5, mwp: 7, mp2: 7, mwd: 200 }),
    validRange: [new Date(T0), new Date(T0 + 240 * 3600_000)],
  };
}
/** A regional grid over 0..10°E, 40..50°N at 0.1°, 48 h from T0, uniform wind. */
function regional(speed: number, dir: number, dLon = 0.1, name = 'arome'): RegionalWind {
  const grid = { lat0: 40, lon0: 0, dLat: dLon, dLon, nLat: Math.round(10 / dLon) + 1, nLon: Math.round(10 / dLon) + 1 };
  const w = uniform(speed, dir);
  return {
    name,
    wind: { ...w, covers: (lon, lat) => lon >= 0 && lon <= 10 && lat >= 40 && lat <= 50 },
    grid,
    firstMs: T0,
    lastMs: T0 + 48 * 3600_000,
  };
}

test('layered wind: regional inside its grid and hours, the base outside, blended at the border and near its end', () => {
  const lw = new LayeredWind(uniform(5, 270), [regional(10, 270)]);
  const t = new Date(T0 + 6 * 3600_000);
  assert.deepEqual(
    lw.at(5, 45, t).map(x => +x.toFixed(6)),
    [10, 270],
    'well inside: regional'
  );
  assert.deepEqual(
    lw.at(20, 45, t).map(x => +x.toFixed(6)),
    [5, 270],
    'outside: base'
  );
  // Half way through the edge ramp: half and half.
  const x = (EDGE_CELLS / 2) * 0.1;
  assert.ok(Math.abs(lw.at(x, 45, t)[0] - 7.5) < 1e-9);
  // After the regional forecast's last step: base. Half way through the handoff: half and half.
  assert.deepEqual(
    lw.at(5, 45, new Date(T0 + 50 * 3600_000)).map(x2 => +x2.toFixed(6)),
    [5, 270]
  );
  assert.ok(Math.abs(lw.at(5, 45, new Date(T0 + 48 * 3600_000 - HANDOFF_MS / 2))[0] - 7.5) < 1e-9);
  // Waves and the time range are the base's.
  assert.equal(lw.wavesAt(5, 45, t)?.swh, 1.5);
  assert.equal(lw.validRange[1].getTime(), T0 + 240 * 3600_000);
});

test('layered wind: vectors are blended, not directions (north and south make calm, not east or west)', () => {
  const lw = new LayeredWind(uniform(5, 0), [regional(5, 180)]);
  const x = (EDGE_CELLS / 2) * 0.1;
  const [s] = lw.at(x, 45, new Date(T0 + 3600_000));
  assert.ok(s < 1e-9, `half north, half south: ${s}`);
});

test('layered wind: the finest grid is applied last; shares count who answered', () => {
  const lw = new LayeredWind(uniform(5, 270), [regional(12, 270, 0.025, 'fine'), regional(8, 270, 0.1, 'coarse')]);
  const t = new Date(T0 + 3600_000);
  assert.ok(Math.abs(lw.at(5, 45, t)[0] - 12) < 1e-9, 'fine wins where both cover');
  lw.resetShares();
  lw.atMany(Float64Array.of(5, 5, 20, 20), Float64Array.of(45, 45, 45, 45), t);
  const sh = Object.fromEntries(lw.shares().map(s => [s.name, s.share]));
  assert.equal(sh.fine, 0.5);
  assert.equal(sh.coarse, 0);
});

test('layered wind: a grid that goes all the way round has no border at its seam', () => {
  // A global 0.25° grid starting at 0°E (as GFS from signalk-grib-downloader): 1440 columns, the last at 359.75°.
  const w = uniform(10, 270);
  const grid = { lat0: -90, lon0: 0, dLat: 0.25, dLon: 0.25, nLat: 721, nLon: 1440 };
  const global: RegionalWind = {
    name: 'gfs-0p25',
    wind: { ...w, covers: () => true },
    grid: { ...grid, wrapLon: true },
    firstMs: T0,
    lastMs: T0 + 48 * 3600_000,
  };
  const t = new Date(T0 + 6 * 3600_000);
  const lw = new LayeredWind(uniform(5, 270), [global]);
  for (const lon of [-0.1, 0, 0.1, 359.9, 180]) assert.equal(+lw.at(lon, 45, t)[0].toFixed(6), 10, `lon ${lon}: the global source`);
  // The same grid without the flag (as before) fell back to the base at 0°: the seam was a border.
  const asBefore = new LayeredWind(uniform(5, 270), [{ ...global, grid }]);
  assert.equal(+asBefore.at(-0.1, 45, t)[0].toFixed(6), 5);
  // Near the poles the latitude border still applies.
  assert.ok(lw.at(10, 89.9, t)[0] < 10);
});

test('layered wind: the source of each sample, the finest regional one where it weighs more than half, else the base', () => {
  const lw = new LayeredWind(uniform(5, 270), [regional(12, 270, 0.025, 'fine'), regional(8, 270, 0.1, 'coarse')]);
  const t = T0 + 6 * 3600_000;
  // Well inside, outside, on the grids' border (weight 0), 0.02° in (fine 0.16, coarse 0.04), after the end.
  const lons = Float64Array.of(5, 20, 0, 0.02, 5);
  const lats = Float64Array.of(45, 45, 45, 45, 45);
  const times = Float64Array.of(t, t, t, t, T0 + 49 * 3600_000);
  const r = lw.atManyAtWithSource(lons, lats, times);
  assert.deepEqual(r.source, ['fine', null, null, null, null]);
  const plain = lw.atManyAt(lons, lats, times);
  assert.deepEqual([...r.speed], [...plain.speed], 'the same wind as atManyAt');
  assert.deepEqual([...r.dir], [...plain.dir]);
});
