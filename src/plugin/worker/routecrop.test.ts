// A route's forecast crop written as a decoded run for the chart mesh process (routecrop.ts): read back the way the
// mesh process reads it (meshlegtask.ts: openDecodedRun, then a window of its area with one cell of margin), every
// sample is the crop's own; the job's crop goes with removeCropRun, every crop in a worker's folder with clearCropRuns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ForecastStore, type FieldGrid, type ForecastStep } from '../../data/forecast';
import { openDecodedRun } from '../../data/decoded';
import { clearCropRuns, removeCropRun, ROUTE_CROP_DIR, writeCropRun } from './routecrop';

/** A crop over the antimeridian (175°E to 175°W), as cropField builds one: plain arrays, its own lat0/lon0. */
function cropField(seed: number, landCell: boolean): FieldGrid {
  const nLat = 21;
  const nLon = 41;
  const values = new Float32Array(nLat * nLon);
  for (let i = 0; i < values.length; i++) values[i] = Math.sin(seed + i * 0.37) * 10 + seed;
  if (landCell) values[8 * nLon + 12] = NaN; // 18°S 178°E, inside the area read below
  return { lat0: -20, lon0: 175, dLat: 0.25, dLon: 0.25, nLat, nLon, values };
}

function cropStore(): ForecastStore {
  const t0 = Date.UTC(2026, 10, 7, 0);
  const step = (h: number, withMp2: boolean): ForecastStep => {
    const fields = new Map<string, FieldGrid>([
      ['10u', cropField(h + 1, false)],
      ['10v', cropField(h + 2, false)],
      ['swh', cropField(h + 3, true)],
      ['mwp', cropField(h + 4, true)],
      ['mwd', cropField(h + 5, true)],
    ]);
    if (withMp2) fields.set('mp2', cropField(h + 6, true));
    return { validMs: t0 + h * 3_600_000, stepHours: h, fields };
  };
  return new ForecastStore([step(0, false), step(3, true)], {
    cycleTime: new Date(t0),
    bbox: { west: 175.25, east: -175.25, south: -19.75, north: -15.25 },
    steps: [0, 3],
    params: ['10u', '10v', 'swh', 'mwp', 'mwd'],
    loadedAt: new Date(t0),
  });
}

test("a route's crop written as a run reads back, as the mesh process reads it, with every sample the crop's own", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecrop-'));
  // A route worker's folder, and another's beside it.
  const root = path.join(tmp, ROUTE_CROP_DIR, 'a');
  const other = path.join(tmp, ROUTE_CROP_DIR, 'b');
  try {
    const crop = cropStore();
    const run = writeCropRun(root, 'job-1', crop, 72);
    assert.equal(run.dir, path.join(root, 'job-1', '2026110700'));
    // The mesh process's read (meshlegtask.ts): the run opened from its folder, its area with one cell of margin.
    const opened = openDecodedRun(run.dir);
    assert.equal(opened.problem, null);
    const area = { west: 177, east: -177.5, south: -18, north: -16 };
    const read = await opened.run!.window({ bbox: area, params: ['10u', '10v', 'swh', 'mwp', 'mwd', 'mp2'], marginCells: 1 });
    // Inside the area, either side of 180°, at a step, between steps and over the land cell (NaN waves).
    const times = [0, 1.5, 3].map(h => new Date(Date.UTC(2026, 10, 7, 0) + h * 3_600_000));
    let n = 0;
    for (let lat = -18; lat <= -16; lat += 0.13)
      for (const lon of [177, 178.4, 179.9, 180, -179.95, -178.6, -177.5])
        for (const t of times) {
          assert.deepEqual(read.at(lon, lat, t), crop.at(lon, lat, t), `wind at ${lon}, ${lat}, ${t.toISOString()}`);
          assert.deepEqual(read.wavesAt(lon, lat, t), crop.wavesAt(lon, lat, t), `waves at ${lon}, ${lat}, ${t.toISOString()}`);
          n++;
        }
    assert.ok(n > 200, `${n} samples`);
    assert.equal(crop.wavesAt(178, -18, times[0]), null, 'the area holds the land cell');
    // A second crop of the same job replaces the first; removeCropRun takes the job's crop.
    const again = writeCropRun(root, 'job-1', crop, 72);
    assert.equal(again.dir, run.dir);
    assert.deepEqual(fs.readdirSync(path.join(root, 'job-1')), ['2026110700']);
    removeCropRun(root, 'job-1');
    assert.equal(fs.existsSync(path.join(root, 'job-1')), false);
    removeCropRun(root, 'job-1');
    // What a stop left behind: every crop in the worker's folder goes at its start, another worker's stays.
    writeCropRun(root, 'job-2', crop, 72);
    writeCropRun(root, 'job-3', crop, 72);
    writeCropRun(other, 'job-4', crop, 72);
    clearCropRuns(root);
    assert.equal(fs.existsSync(root), false);
    assert.deepEqual(fs.readdirSync(other), ['job-4']);
    clearCropRuns(root);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a crop whose write fails leaves no folder of the job's behind", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecrop-'));
  try {
    const root = path.join(tmp, ROUTE_CROP_DIR, 'a');
    const crop = cropStore();
    // A field of another grid in the second step: the writer refuses it mid-run (decoded.ts writeStep).
    crop.steps[1].fields.set('swh', { ...cropField(9, false), nLat: 3, values: new Float32Array(3 * 41) });
    assert.throws(() => writeCropRun(root, 'job-1', crop, 72), /has a different grid/);
    assert.equal(fs.existsSync(path.join(root, 'job-1')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
