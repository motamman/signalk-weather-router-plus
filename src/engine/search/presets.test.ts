import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beamFor } from './presets';

test('search presets: normal keeps the settings, wide and finer are fixed beams', () => {
  const settings = { stages: 22, subsectors: 31, headings: 29, headingIncrementDeg: 2 };
  assert.deepEqual(beamFor('normal', settings), settings);
  assert.deepEqual(beamFor('wide', settings), { stages: 40, subsectors: 100, headings: 60, headingIncrementDeg: 1 });
  assert.deepEqual(beamFor('finer', settings), { stages: 40, subsectors: 150, headings: 120, headingIncrementDeg: 0.5 });
  assert.notEqual(beamFor('normal', settings), settings, 'a copy, not the settings object');
});
