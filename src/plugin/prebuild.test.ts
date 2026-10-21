/**
 * The view the prebuild follows (prebuild.ts ViewTracker): from whole bursts of tile requests, never their tail;
 * views shallower than the build leave the last one; a tile asked for many layers counts once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewTracker } from './prebuild';
import { tileAt, tileBBox } from './tiles';

const RADIUS_M = 250_000;
const M_PER_DEG = 111_320;

/** The tiles of a w × h screen at zoom z whose top-left tile holds (lon, lat). */
function screen(z: number, lon: number, lat: number, w: number, h: number): { x: number; y: number }[] {
  const t = tileAt(lon, lat, z);
  const out: { x: number; y: number }[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push({ x: (t.x + i) % 2 ** z, y: t.y + j });
  return out;
}

/** The middle of tiles (their centres' mean), as the tracker takes it before rounding. */
function middle(z: number, tiles: { x: number; y: number }[]): { lat: number; lon: number } {
  let sx = 0;
  let sy = 0;
  let lat = 0;
  for (const { x, y } of tiles) {
    const b = tileBBox(z, x, y);
    const lon = (((b.west + b.east) / 2) * Math.PI) / 180;
    sx += Math.cos(lon);
    sy += Math.sin(lon);
    lat += (b.north + b.south) / 2;
  }
  return { lat: lat / tiles.length, lon: (Math.atan2(sy, sx) * 180) / Math.PI };
}

/** Within the tracker's rounding step at zoom z (a quarter of the build's radius there). */
function near(z: number, got: { lat: number; lon: number }, want: { lat: number; lon: number }): boolean {
  const step = (z <= 8 ? RADIUS_M : RADIUS_M / 2 ** (z - 8)) / 4 / M_PER_DEG;
  return Math.abs(got.lat - want.lat) <= step && Math.abs(((got.lon - want.lon + 540) % 360) - 180) <= step;
}

test('view: a burst trickling in is taken whole once it ends, never its last tiles; none while it arrives', () => {
  const v = new ViewTracker(() => RADIUS_M);
  const z = 10;
  const tiles = screen(z, -71.0, 42.0, 6, 4);
  // One tile a second (a slow server), 24 s in all: the old 5 s window held only the last five, the bottom-right corner.
  let t = 1_000_000;
  for (const { x, y } of tiles) {
    v.note(z, x, y, t);
    assert.equal(v.view(t), null, 'no view while the burst is still arriving');
    t += 1000;
  }
  assert.equal(v.view(t + 1000), null, 'not yet: the gap is not over');
  const got = v.view(t + 6000)!;
  assert.ok(got, 'the burst ended: a view');
  assert.equal(got.z, z);
  const want = middle(z, tiles);
  assert.ok(near(z, got, want), `the middle of the whole screen ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  const corner = middle(z, tiles.slice(-5));
  assert.ok(!near(z, got, corner), 'not the tail of the burst');
});

test('view: zoomed out past the shallowest zoom built, the last view stays (the whole-Atlantic view of 2026-10-13)', () => {
  const v = new ViewTracker(() => RADIUS_M);
  let t = 0;
  for (const { x, y } of screen(13, -70.7, 41.75, 5, 3)) v.note(13, x, y, (t += 200));
  const capeCod = v.view((t += 6000))!;
  assert.ok(capeCod && capeCod.z === 13);
  // The 24 tiles of the zoom 4 view, from 79°W to 34°E, trickling in; the last one 4/9/4 (northwest Russia).
  for (let y = 4; y <= 7; y++) for (let x = 4; x <= 9; x++) v.note(4, x, y, (t += 1200));
  assert.deepEqual(v.view((t += 6000)), capeCod, 'the zoom 4 view does not move it');
  // On its own, a zoom 4 burst is no view at all.
  const fresh = new ViewTracker(() => RADIUS_M);
  for (let x = 4; x <= 9; x++) fresh.note(4, x, 4, (t += 100));
  assert.equal(fresh.view(t + 6000), null);
});

test('view: a tile asked for many layers counts once; shallower tiles of a zooming burst are left out', () => {
  const z = 9;
  const tiles = screen(z, -74.5, 41.0, 4, 3);
  const once = new ViewTracker(() => RADIUS_M);
  const many = new ViewTracker(() => RADIUS_M);
  let t = 0;
  for (const { x, y } of tiles) once.note(z, x, y, (t += 10));
  for (const { x, y } of tiles) many.note(z, x, y, (t += 10));
  const first = tiles[0];
  for (let k = 0; k < 10; k++) many.note(z, first.x, first.y, (t += 10)); // ten more layers of the corner tile
  // The previous, shallower zoom's tiles of the same burst (the map zooming in) do not pull the middle.
  for (const { x, y } of screen(z - 1, -80, 30, 2, 2)) many.note(z - 1, x, y, (t += 10));
  assert.deepEqual(many.view((t += 6000)), once.view(t));
});

test('view: across the date line the middle is at the date line, not the far side of the world', () => {
  const v = new ViewTracker(() => RADIUS_M);
  const z = 8;
  const n = 2 ** z;
  const y = tileAt(180, -17, z).y;
  let t = 0;
  for (const x of [n - 2, n - 1, 0, 1]) v.note(z, x, y, (t += 10));
  const got = v.view(t + 6000)!;
  assert.ok(Math.abs(Math.abs(got.lon) - 180) < 1, `lon ${got.lon}`);
});

test('view: a map asking for the same tiles again and again (other hours, a refresh) does not hold the view back', () => {
  // PR #39 review: ended by any request, a map asking at least every 5 s never let the view be taken.
  const v = new ViewTracker(() => RADIUS_M);
  const z = 9;
  const tiles = screen(z, -71.0, 41.5, 4, 3);
  let t = 0;
  for (const { x, y } of tiles) v.note(z, x, y, (t += 100));
  // Then the same tiles every second for a minute, as a map stepping through the hours asks for them.
  let got = null;
  for (let k = 0; k < 60 && !got; k++) {
    const { x, y } = tiles[k % tiles.length];
    v.note(z, x, y, (t += 1000));
    got = v.view(t);
  }
  assert.ok(got, 'taken while the requests go on');
  assert.ok(near(z, got, middle(z, tiles)), JSON.stringify(got));
});

test('walk: the forecast layers are built ahead at its steps only, the hourly sources every hour', async () => {
  const { TilePrebuilder } = await import('./prebuild');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-prebuild-'));
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 9, 14, 0);
  const steps = new Set([0, 3, 6, 9, 12].map(h => t0 + h * H)); // the forecast's steps, 3 h apart
  try {
    const pb = new TilePrebuilder(
      { enabled: true, radiusM: 50_000, windowS: null, maxZoom: 6, workers: 1, followView: true },
      {
        store: null as never,
        dataDir: dir,
        workerPath: '',
        execArgv: [],
        initMessage: () => ({ type: 'shutdown' }),
        replayMessages: () => [],
        dataStamp: () => ({ forecast: null, smoc: null, rtofs: null, tide: null }),
        vesselPosition: () => null,
        lastHourMs: () => t0 + 12 * H,
        atStep: (layer, h) => layer !== 'wind' || steps.has(h),
        layerAvailable: () => true,
        busy: () => false,
        log: () => undefined,
        error: () => undefined,
      }
    );
    const walk = (pb as unknown as { tiles: (...a: unknown[]) => Iterable<{ t: { layer: string; hourMs: number } }> }).tiles(
      [{ kind: 'boat', lat: 41, lon: -71 }],
      ['wind', 'current'],
      t0,
      Infinity
    );
    const hours = new Map<string, Set<number>>();
    for (const { t } of walk) {
      if (t.layer === 'land') continue;
      if (!hours.has(t.layer)) hours.set(t.layer, new Set());
      hours.get(t.layer)!.add((t.hourMs - t0) / H);
    }
    assert.deepEqual(
      [...hours.get('wind')!].sort((a, b) => a - b),
      [0, 3, 6, 9, 12],
      'wind at the forecast steps'
    );
    assert.equal(hours.get('current')!.size, 13, 'currents every hour from 0 to 12');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasStep: the forecast at its steps, currents at an RTOFS or SMOC step or every hour with harmonics, tides every hour', async () => {
  const { hasStep } = await import('./prebuild');
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 9, 14, 0);
  const at = (h: number): number => t0 + h * H;
  const base = { forecast: [0, 3, 6].map(at), rtofs: [] as number[], smocStepMs: null as number | null, harmonic: false };
  assert.deepEqual(
    [0, 1, 2, 3].map(h => hasStep('wx', at(h), base)),
    [true, false, false, true],
    'forecast every 3 h'
  );
  assert.equal(hasStep('wx', at(0), { ...base, forecast: null }), false, 'no forecast: none');
  // SMOC at 3 h: its steps are the multiples of 3 h from 00Z.
  const smoc = { ...base, smocStepMs: 3 * H };
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(h => hasStep('cur', at(h), smoc)),
    [true, false, false, true, false]
  );
  // RTOFS alone, hourly to some time: its own steps.
  const rtofs = { ...base, rtofs: [1, 2].map(at) };
  assert.deepEqual(
    [0, 1, 2, 3].map(h => hasStep('cur', at(h), rtofs)),
    [false, true, true, false]
  );
  // Tidal harmonics: a value every hour.
  assert.ok([0, 1, 2].every(h => hasStep('cur', at(h), { ...smoc, harmonic: true })));
  // Tide height and the coastline: every hour.
  assert.ok([0, 1, 2].every(h => hasStep('tide', at(h), base) && hasStep('land', at(h), base)));
});

test('walk: a view builds the tiles the map showed, at its zoom; the boat its pyramid', async () => {
  const { TilePrebuilder, coveringTiles } = await import('./prebuild');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-prebuild-'));
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 9, 14, 0);
  try {
    const pb = new TilePrebuilder(
      { enabled: true, radiusM: 50_000, windowS: null, maxZoom: 9, workers: 1, followView: true },
      {
        store: null as never,
        dataDir: dir,
        workerPath: '',
        execArgv: [],
        initMessage: () => ({ type: 'shutdown' }),
        replayMessages: () => [],
        dataStamp: () => ({ forecast: null, smoc: null, rtofs: null, tide: null }),
        vesselPosition: () => null,
        lastHourMs: () => t0 + 3 * H,
        atStep: () => true,
        layerAvailable: () => true,
        busy: () => false,
        log: () => undefined,
        error: () => undefined,
      }
    );
    const shown = screen(11, -71.6, 41.2, 3, 2);
    const walk = (
      pb as unknown as { tiles: (...a: unknown[]) => Iterable<{ t: { layer: string; z: number; x: number; y: number } }> }
    ).tiles(
      [
        { kind: 'view', lat: 41.19, lon: -71.58, z: 11, tiles: shown },
        { kind: 'boat', lat: 40.65, lon: -73.98 },
      ],
      ['wind', 'msl'],
      t0,
      Infinity
    );
    const view = new Set<string>();
    const boat = new Set<string>();
    let msl = 0;
    let inView = true;
    for (const { t } of walk) {
      if (t.layer === 'land' && t.z === 6) inView = false; // the boat's pyramid starts at zoom 6
      if (t.layer === 'msl') msl++;
      else (inView ? view : boat).add(`${t.layer}/${t.z}/${t.x}/${t.y}`);
    }
    const want = new Set(shown.flatMap(({ x, y }) => [`land/11/${x}/${y}`, `wind/11/${x}/${y}`]));
    assert.deepEqual([...view].sort(), [...want].sort(), 'the view: its own tiles at zoom 11, land and wind, nothing else');
    assert.ok([...boat].some(k => k.startsWith('wind/6/')) && [...boat].some(k => k.startsWith('wind/9/')), 'the boat: zoom 6 to 9');
    assert.ok(msl > 0 && coveringTiles(11, shown, 5).length >= 1, 'isobars over the view at their own zoom');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
