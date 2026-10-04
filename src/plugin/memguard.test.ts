import { test } from 'node:test';
import { HOUR_S } from '../geo/units';
import assert from 'node:assert/strict';
import {
  checkDecodeResources,
  checkRouteForecastMemory,
  forecastBytes,
  FIELD_STEP_BYTES,
  availableMemory,
  DISK_RESERVE_BYTES,
} from './memguard';
import { streamingDecodeBytes } from '../data/loader';

test('forecastBytes (a decoded run on disk) is steps × fields × one global grid', () => {
  assert.equal(FIELD_STEP_BYTES, 4_152_960);
  assert.equal(forecastBytes(72 * HOUR_S, false), 25 * 6 * FIELD_STEP_BYTES); // 622,944,000
  assert.equal(forecastBytes(72 * HOUR_S, true), 25 * 13 * FIELD_STEP_BYTES); // 1,349,712,000
  assert.equal(forecastBytes(72 * HOUR_S, true, true), 25 * 19 * FIELD_STEP_BYTES); // 1,972,656,000
  assert.equal(forecastBytes(72 * HOUR_S, false, true), 25 * 12 * FIELD_STEP_BYTES);
});

test('update check: memory for one decode step, disk for the decoded run', () => {
  const GB = 1e9;
  // One step with the extra fields: 13 global Float32 fields + decode buffers (12 B/cell) + wave fill temporaries (8 B/cell).
  assert.equal(streamingDecodeBytes(13), 1440 * 721 * (13 * 4 + 12 + 8));
  const ok = checkDecodeResources(72 * HOUR_S, true, false, GB, null, { bytes: 2 * GB, source: 'test' }, 10 * GB);
  assert.equal(ok.ok, true);
  assert.equal(ok.needBytes, streamingDecodeBytes(13));
  // Memory: one step fits where the old whole store (1.14 GB + 1 GB headroom) did not.
  assert.equal(
    checkDecodeResources(72 * HOUR_S, true, false, GB, null, { bytes: GB + streamingDecodeBytes(13), source: 'test' }, 10 * GB).ok,
    true
  );
  const noMem = checkDecodeResources(
    72 * HOUR_S,
    true,
    false,
    GB,
    null,
    { bytes: GB + streamingDecodeBytes(13) - 1, source: 'test' },
    10 * GB
  );
  assert.equal(noMem.ok, false);
  assert.match(noMem.message, /not enough memory/);
  // Disk: 1.35 GB run + 1 GB reserve.
  const run = forecastBytes(72 * HOUR_S, true);
  assert.equal(
    checkDecodeResources(72 * HOUR_S, true, false, GB, null, { bytes: 5 * GB, source: 'test' }, run + DISK_RESERVE_BYTES).ok,
    true
  );
  const noDisk = checkDecodeResources(72 * HOUR_S, true, false, GB, null, { bytes: 5 * GB, source: 'test' }, run + DISK_RESERVE_BYTES - 1);
  assert.equal(noDisk.ok, false);
  assert.match(noDisk.message, /not enough disk space/);
  assert.match(noDisk.message, /turn off the extra fields/);
  // Unknown free disk space does not block.
  assert.equal(checkDecodeResources(72 * HOUR_S, true, false, GB, null, { bytes: 5 * GB, source: 'test' }, null).ok, true);
  // The energy fields count for memory (one step plus the previous accumulated
  // fields the step difference holds) and disk, and their setting is suggested
  // off when the run would not fit.
  const needEnergy = streamingDecodeBytes(19) + 5 * FIELD_STEP_BYTES;
  const runEnergy = forecastBytes(72 * HOUR_S, true, true);
  const okEnergy = checkDecodeResources(
    72 * HOUR_S,
    true,
    true,
    GB,
    null,
    { bytes: 5 * GB, source: 'test' },
    runEnergy + DISK_RESERVE_BYTES
  );
  assert.equal(okEnergy.ok, true);
  assert.equal(okEnergy.needBytes, needEnergy);
  const noDiskEnergy = checkDecodeResources(
    72 * HOUR_S,
    true,
    true,
    GB,
    null,
    { bytes: 5 * GB, source: 'test' },
    runEnergy + DISK_RESERVE_BYTES - 1
  );
  assert.equal(noDiskEnergy.ok, false);
  assert.match(noDiskEnergy.message, /turn off the solar and radiation fields/);
});

test('route check: the corridor store must fit with the headroom', () => {
  assert.equal(checkRouteForecastMemory(100e6, 1e9, { bytes: 1.1e9, source: 'test' }).ok, true);
  const no = checkRouteForecastMemory(100e6, 1e9, { bytes: 1.1e9 - 1, source: 'test' });
  assert.equal(no.ok, false);
  assert.match(no.message, /route's forecast area/);
});

test('availableMemory returns a positive figure and its source', () => {
  const a = availableMemory();
  assert.ok(a.bytes > 0);
  assert.ok(a.source.length > 0);
});

test('parseVmStat sums free, inactive, speculative and purgeable pages', async () => {
  const { parseVmStat } = await import('./memguard');
  const text =
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                3785.\nPages active:                            188296.\nPages inactive:                          187679.\nPages speculative:                          245.\nPages throttled:                              0.\nPages wired down:                        203849.\nPages purgeable:                              2.\n';
  assert.equal(parseVmStat(text), (3785 + 187679 + 245 + 2) * 16384);
  assert.equal(parseVmStat('nonsense'), null);
});

test('water grid rebuild memory check', async () => {
  const { checkWaterGridBuildMemory, WATER_GRID_BUILD_BYTES } = await import('./memguard');
  const ok = checkWaterGridBuildMemory(1e9, { bytes: WATER_GRID_BUILD_BYTES + 1e9, source: 'test' });
  assert.equal(ok.ok, true);
  const no = checkWaterGridBuildMemory(1e9, { bytes: WATER_GRID_BUILD_BYTES + 1e9 - 1, source: 'test' });
  assert.equal(no.ok, false);
  assert.match(no.message, /not enough memory to rebuild the water grid/);
});
