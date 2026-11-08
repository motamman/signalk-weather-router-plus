/**
 * The Signal K Admin panel's units (public/remoteEntry.js), run as the panel defines them, given the webapp's own
 * rp-units.js with its requests stubbed (as condtabs.test.ts runs the page's helpers): each quantity's unit is read,
 * turned into a unit and written by rp-units.js; a duration in a format with no single unit to type a number in, or a
 * unit that cannot be read, is null, and a data size without a unit is "—".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Unit = { unit: string; fn: (v: number) => number; precision: number } | null;
type Units = { distance: Unit; time: Unit; dataSize: Unit };

const source = fs.readFileSync(path.join(__dirname, '../../public/remoteEntry.js'), 'utf8');
const du = (formula: string, inverseFormula: string, symbol: string) => ({ formula, inverseFormula, symbol, displayFormat: '0.0' });

/** The panel's unit loading and data-size text, with rp-units.js answering `answers` (null: it does not load). */
async function panel(answers: { path: Record<string, unknown>; preset: Record<string, unknown> } | null) {
  const real = (await import(path.join(__dirname, '../../public/rp-units.js'))) as Record<string, unknown>;
  const from = source.indexOf("  // The user's units for the panel's quantities");
  const to = source.indexOf('  // A number typed in display units');
  const s0 = source.indexOf('    function size(');
  const s1 = source.indexOf('\n', s0);
  assert.ok(from > 0 && to > from && s0 > 0 && s1 > s0, 'the slices of remoteEntry.js are found');
  const warned: string[] = [];
  const context = {
    console: { warn: (m: string) => warned.push(m) },
    Promise,
    units: { dataSize: null } as { dataSize: Unit },
    MISSING: '—',
    stub: () =>
      answers
        ? Promise.resolve({
            ...real,
            fetchDisplayUnits: async (cat: string) => answers.path[cat] ?? null,
            fetchPresetUnits: async () => answers.preset,
          })
        : Promise.reject(new Error('no module')),
  };
  const api = runInNewContext(
    `${source.slice(from, to)}\n${source.slice(s0, s1)}\nloadUnitsModule = stub;\n({ loadUnits, size })`,
    context
  ) as {
    loadUnits: () => Promise<Units>;
    size: (n: number) => string;
  };
  return { ...api, units: context.units, warned };
}

test("the panel's units come from rp-units.js: distance and time from their paths, data size from the preset", async () => {
  const p = await panel({
    path: { distance: du('value / 1852', 'value * 1852', 'nm'), time: du('value / 3600', 'value * 3600', 'h') },
    preset: { dataSize: du('value / 1000000', 'value * 1000000', 'MB') },
  });
  const u = await p.loadUnits();
  assert.deepEqual([u.distance?.unit, u.time?.unit, u.dataSize?.unit, u.dataSize?.fn(20e9)], ['nm', 'h', 'MB', 20000]);
  p.units.dataSize = u.dataSize;
  assert.equal(p.size(1_234_567_890), '1234.6 MB');
});

test('a duration format has no unit to type in, and without rp-units.js every unit is null and a size is —', async () => {
  const p = await panel({ path: { time: { formula: 'formatDurationCompact(value)' } }, preset: { dataSize: null } });
  const u = await p.loadUnits();
  assert.deepEqual([u.distance, u.time, u.dataSize], [null, null, null]);
  assert.equal(p.size(20e9), '—');
  const failed = await panel(null);
  const none = await failed.loadUnits();
  assert.deepEqual([none.distance, none.time, none.dataSize], [null, null, null]);
  assert.deepEqual(failed.warned, ['[units] no module']);
});
