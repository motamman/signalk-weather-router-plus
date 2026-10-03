import * as fs from 'node:fs';
import * as path from 'node:path';
import { PolarDiagram } from '../vessel/polar';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activePolarId,
  adaptManagedPolar,
  loadManagedPolar,
  managedDiagram,
  selectManagedPolar,
  type PolarProviderApp,
} from './managedpolar';

const table = () => ({
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'TBD',
  units: { twa: 'rad', tws: 'm/s', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: { twa: [0, Math.PI / 4, Math.PI / 2, Math.PI], tws: [5, 10] },
  values: {
    boatSpeedMatrix: [
      [0, 2, 4, 3],
      [0, 4, 6, 5],
    ],
  },
});

test('canonical SI matrix transposes without changing speeds; routing interpolation and no-go math stay intact', () => {
  const doc = table();
  const snapshot = adaptManagedPolar(doc, 'boat', 0.8);
  assert.deepEqual(snapshot.twa, [0, 45, 90, 180]);
  assert.deepEqual(snapshot.tws, [5, 10]);
  assert.deepEqual(snapshot.speeds, [0, 0, 2, 4, 4, 6, 3, 5]);
  assert.deepEqual(doc, table());
  const polar = managedDiagram(snapshot);
  assert.equal(polar.boatSpeed(67.5, 7.5), 4);
  assert.equal(polar.boatSpeed(-67.5, 7.5), 4);
  assert.equal(polar.boatSpeed(30, 7.5), 0);
  assert.equal(polar.scaled(snapshot.performanceFactor).boatSpeed(67.5, 7.5), 3.2);
  assert.equal(polar.scaled(0).boatSpeed(90, 7.5), 0);
  doc.values.boatSpeedMatrix[0][1] = 100;
  assert.equal(polar.boatSpeed(45, 5), 2);
});

test('provider nodes, resource ids and missing performance factor', async () => {
  assert.equal(activePolarId({ value: { href: '/resources/polars/TBD boat' } }), 'TBD boat');
  for (const href of ['/resources/routes/x', 'https://example.com/resources/polars/x', '/resources/polars/a/b'])
    assert.throws(() => activePolarId({ href }), /activePolar/);
  const calls: string[][] = [];
  const app: PolarProviderApp = {
    getSelfPath: path => (path === 'polars.activePolar' ? { value: { href: '/resources/polars/tbd' } } : undefined),
    resourcesApi: {
      getResource: async (type, id) => {
        calls.push([type, id]);
        return table();
      },
    },
  };
  assert.equal((await loadManagedPolar(app)).performanceFactor, 1);
  assert.deepEqual(calls, [['polars', 'tbd']]);
  await assert.rejects(loadManagedPolar({}), /Resources API/);
  await assert.rejects(loadManagedPolar({ ...app, getSelfPath: () => ({ value: null }) }), /No active polar/);
  await assert.rejects(
    loadManagedPolar({
      ...app,
      resourcesApi: {
        getResource: async () => {
          throw new Error('provider stopped');
        },
      },
    }),
    /provider stopped/
  );
});

test('fresh reads pick up same-id table edits and factor changes; previous snapshots remain unchanged', async () => {
  let speed = 2;
  let factor = 0.8;
  const app: PolarProviderApp = {
    getSelfPath: path => ({ value: path === 'polars.activePolar' ? { href: '/resources/polars/tbd' } : factor }),
    resourcesApi: {
      getResource: async () => {
        const doc = table();
        doc.values.boatSpeedMatrix[0][1] = speed;
        return doc;
      },
    },
  };
  const first = await loadManagedPolar(app);
  speed = 3;
  factor = 0.5;
  const second = await loadManagedPolar(app);
  assert.equal(first.speeds[2], 2);
  assert.equal(first.performanceFactor, 0.8);
  assert.equal(second.speeds[2], 3);
  assert.equal(second.performanceFactor, 0.5);
});

test('selection changes during asynchronous fetch reject a stale polar', async () => {
  let id = 'first';
  const app: PolarProviderApp = {
    getSelfPath: path => (path === 'polars.activePolar' ? { href: `/resources/polars/${id}` } : 1),
    resourcesApi: {
      getResource: async () => {
        id = 'second';
        return table();
      },
    },
  };
  await assert.rejects(loadManagedPolar(app), /changed while loading/);
});

test('reject malformed tables and unsupported semantics before routing', () => {
  const bad: unknown[] = [
    null,
    { ...table(), units: { twa: 'deg', tws: 'kn', boatSpeed: 'kn' } },
    { ...table(), symmetry: { portStarboardSymmetric: false } },
    { ...table(), axes: { twa: [0, Math.PI + 0.01], tws: [5] } },
    { ...table(), axes: { twa: [0, 1], tws: [5, 5] } },
    { ...table(), values: { boatSpeedMatrix: [[1, 2]] } },
    {
      ...table(),
      values: {
        boatSpeedMatrix: [
          [0, null, 4, 3],
          [0, 4, 6, 5],
        ],
      },
    },
    {
      ...table(),
      values: {
        boatSpeedMatrix: [
          [0, NaN, 4, 3],
          [0, 4, 6, 5],
        ],
      },
    },
  ];
  for (const doc of bad) assert.throws(() => adaptManagedPolar(doc, 'tbd', 1));
  for (const factor of [-1, 1.1, NaN, '0.8']) assert.throws(() => adaptManagedPolar(table(), 'tbd', factor), /performanceFactor/);
});

test('automatic route selection detects managed polars, falls back, and respects internal overrides', async () => {
  let available = true;
  let loads = 0;
  const app: PolarProviderApp = {
    getSelfPath: key => (key === 'polars.activePolar' && available ? { value: { href: '/resources/polars/tbd' } } : undefined),
    resourcesApi: {
      getResource: async () => {
        loads++;
        return table();
      },
    },
  };
  assert.equal((await selectManagedPolar(app, 'auto'))?.label, 'TBD');
  assert.equal((await selectManagedPolar(app, 'files', 'auto'))?.label, 'TBD');
  assert.equal(await selectManagedPolar(app, 'auto', 'default'), undefined);
  assert.equal(await selectManagedPolar(app, 'signalk', 'internal.csv'), undefined);
  assert.equal(await selectManagedPolar(app, 'files'), undefined);
  assert.equal(loads, 2);
  available = false;
  assert.equal(await selectManagedPolar(app, 'auto'), undefined);
  assert.equal(await selectManagedPolar(app, 'signalk'), undefined);
  await assert.rejects(selectManagedPolar(app, 'auto', 'signalk-active'), /No active polar/);
});

const rad = (degrees: number): number => (degrees * Math.PI) / 180;
const close = (actual: number, expected: number, tolerance = 1e-10): void =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('ORC targets are restored per wind speed with linear interpolation and downwind extrapolation', () => {
  const doc = {
    ...table(),
    axes: { twa: [rad(60), rad(90), rad(120)], tws: [5, 10] },
    values: {
      boatSpeedMatrix: [
        [3, 4, 4.5],
        [5, 6, 6.5],
      ],
    },
    derived: {
      rows: [
        { tws: 10, beat: { twa: rad(45), tbs: 4 }, run: { twa: rad(160), tbs: 6 } },
        { tws: 5, beat: { twa: rad(40), tbs: 2 }, run: { twa: rad(150), tbs: 4 } },
      ],
    },
  };
  const before = structuredClone(doc);
  const adapted = adaptManagedPolar(doc, 'orc', 0.8);
  const polar = managedDiagram(adapted);
  assert.deepEqual(doc, before);
  close(polar.noGoFloor(5), 40);
  close(polar.noGoFloor(10), 45);
  close(polar.noGoFloor(7.5), 42.5);
  assert.equal(polar.boatSpeed(39.99, 5), 0);
  assert.equal(polar.boatSpeed(44.99, 10), 0);
  close(polar.boatSpeed(40, 5), 2);
  close(polar.boatSpeed(45, 10), 4);
  close(polar.boatSpeed(50, 5), 2.5);
  close(polar.boatSpeed(150, 5), 4);
  close(polar.boatSpeed(160, 10), 6);
  close(polar.boatSpeed(180, 5), 3.5);
  close(polar.boatSpeed(180, 10), 5.75);
  close(polar.scaled(0.8).boatSpeed(180, 10), 4.6);
  // Resampling agrees with each row's straight-line polar throughout the sailable range.
  const expected = [
    new PolarDiagram([40, 60, 90, 120, 150], [5], [2, 3, 4, 4.5, 4]),
    new PolarDiagram([45, 60, 90, 120, 160], [10], [4, 5, 6, 6.5, 6]),
  ];
  for (let a = 0; a <= 180; a += 0.5)
    for (let k = 0; k < 2; k++) close(polar.boatSpeed(a, doc.axes.tws[k]), expected[k].boatSpeed(a, doc.axes.tws[k]));
});

test('text-imported .pol target rows agree with direct loading, including between wind columns', () => {
  // Output of Polar Management 1.2.0's actual matrixText importer at 4f3e4270.
  // This fixture has beat and run target rows plus ordinary shared table rows.
  const dir = path.join(__dirname, 'fixtures');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'managed-targets.json'), 'utf8'));
  assert.equal(doc.derived.rows[0].beat.twa, rad(40));
  assert.equal(doc.derived.rows[0].run.twa, rad(180));
  const managed = managedDiagram(adaptManagedPolar(doc, 'text-import', 1));
  const direct = PolarDiagram.load(path.join(dir, 'managed-targets.pol'));
  for (const wind of [3.1, 4, 5, 6]) {
    close(managed.noGoFloor(wind), direct.noGoFloor(wind), 1e-4);
    for (let angle = 0; angle <= 180; angle += 0.5) close(managed.boatSpeed(angle, wind), direct.boatSpeed(angle, wind), 2e-5);
  }
});

test('absent or empty derived targets leave matrix values and axes unchanged', () => {
  const doc = table();
  const plain = adaptManagedPolar(doc, 'unchanged', 0.8);
  for (const derived of [undefined, {}, { rows: [] }, { rows: [{ tws: 5, maxSpeed: 4 }] }])
    assert.deepEqual(adaptManagedPolar({ ...doc, derived }, 'unchanged', 0.8), plain);
});

test('malformed derived targets are rejected rather than silently dropping sailing data', () => {
  for (const rows of [
    [{ tws: 999, beat: { twa: rad(40), tbs: 2 } }],
    [{ tws: 5, beat: { twa: 4, tbs: 2 } }],
    [{ tws: 5, beat: { twa: rad(40), tbs: -1 } }],
    [
      { tws: 5, beat: { twa: rad(40), tbs: 2 } },
      { tws: 5, run: { twa: rad(150), tbs: 3 } },
    ],
  ])
    assert.throws(() => adaptManagedPolar({ ...table(), derived: { rows } }, 'invalid', 1), /Invalid derived/);
});
