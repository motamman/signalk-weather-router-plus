import { test } from 'node:test';
import { HOUR_S } from '../geo/units';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KTS_TO_MS } from '../geo/geodesy';
import { resolveConfig, routeVessel, type LegacyPluginConfig } from './config';
import {
  defaultSettings,
  mergeSettings,
  migrateLegacy,
  reloadsFor,
  SETTINGS_SPEC,
  settingsSchema,
  SettingsStore,
  SettingsValidationError,
} from './settings';
import { registerApi, type ApiDeps } from './api';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-settings-'));

// The plugin config this repository's owner actually has (pre-migration shape).
const LEGACY: LegacyPluginConfig & Record<string, unknown> = {
  landShapefiles: '/x/GSHHS_f_L1.shp',
  polarFile: '/x/catalina36.csv',
  vessel: {
    name: 'Catalina 36',
    draughtM: 1.0,
    airDraftM: 16.15,
    loaM: 10.97,
    beamM: 3.73,
    underKeelClearanceM: 2.0,
    overheadClearanceM: 1.0,
    motorSpeedKts: 6.0,
    maxSwhM: 3.0,
    tackPenaltySeconds: 30,
  } as LegacyPluginConfig['vessel'],
  forecast: {
    horizonHours: 48,
    refreshMinutes: 60,
    mirror: 'ecmwf',
    region: { west: -75, south: 36, east: -65, north: 45 },
    keepCycles: 2,
  } as LegacyPluginConfig['forecast'],
  routing: {
    stages: 20,
    subsectors: 30,
    headings: 30,
    headingIncrementDeg: 1,
    sailThresholdKts: 4.9,
    simStepM: 200,
    landRasterMaxCells: 25000000,
    keepJobs: 50,
  },
  publish: { toResources: true, routeNamePrefix: 'WRP', notifications: true },
  weatherProvider: { enabled: true },
};

test('defaults resolve to the same engine config the plugin config gave before', () => {
  const c = resolveConfig({ landShapefiles: '/a.shp, /b.shp' }, defaultSettings());
  assert.deepEqual(c.landShapefiles, ['/a.shp', '/b.shp']);
  assert.equal(c.forecast.horizonS, 72 * HOUR_S);
  assert.equal(c.forecast.refreshIntervalS, 3600);
  assert.equal(c.forecast.keepCycles, 2);
  assert.equal(c.forecast.extraFields, true);
  assert.equal(c.forecast.mirror, 'ecmwf');
  assert.equal(c.currents.rtofsRegion, 'west_atl');
  assert.equal(c.currents.rtofsHorizonS, 72 * HOUR_S);
  assert.equal(c.currents.rtofsStepS, 3 * HOUR_S);
  assert.ok(Math.abs(c.routing.sailThreshMs - 4.9 * KTS_TO_MS) < 1e-12);
  assert.ok(Math.abs(c.vessel.motorSpeedMs - 6 * KTS_TO_MS) < 1e-12);
  assert.equal(c.weatherProvider.enabled, true);
  assert.throws(() => resolveConfig({ forecast: { mirror: 'nope' as 'aws' } }, defaultSettings()), /mirror/);
});

test('migration converts the old plugin config to SI settings and ignores region keys', () => {
  const m = migrateLegacy(LEGACY);
  assert.ok(Math.abs(m.values.vessel.motorSpeed - 6 * 0.514444444) < 1e-6, 'kt → m/s');
  // Vessel keys the router never used (draught, clearances, tack penalty…) are not carried over, nor the
  // name (Signal K's vessels.self.name is used).
  assert.deepEqual(Object.keys(m.values.vessel).sort(), ['motorSpeed', 'polarPerformance']);
  assert.equal(m.values.forecast.horizon, 48 * 3600, 'h → s');
  assert.equal(m.values.forecast.refreshInterval, 3600, 'min → s');
  assert.ok(Math.abs(m.values.routing.sailThreshold - 4.9 * 0.514444444) < 1e-6, 'kt → m/s');
  assert.equal(m.values.routing.headingIncrement, 1);
  assert.equal(m.values.currents.rtofsRegion, 'west_atl', 'unset → default');
  assert.ok(!('region' in m.values.forecast) && !('regionFromVesselDeg' in m.values.forecast));
  assert.ok(m.migrated.includes('vessel.motorSpeed') && m.migrated.includes('forecast.horizon'));
  assert.deepEqual(m.skipped, []);
  // An invalid legacy value is skipped (default kept), the rest still migrate.
  const bad = migrateLegacy({ forecast: { horizonHours: 500 }, currents: { rtofsRegion: 'mars' }, vessel: { motorSpeedKts: 5 } });
  assert.equal(bad.values.forecast.horizon, 72 * 3600);
  assert.equal(bad.values.currents.rtofsRegion, 'west_atl');
  assert.ok(Math.abs(bad.values.vessel.motorSpeed - 5 * KTS_TO_MS) < 1e-12);
  assert.equal(bad.skipped.length, 2);
});

test('partial merge validates with the old ranges and enums, all-or-nothing', () => {
  const base = defaultSettings();
  const r = mergeSettings(base, { vessel: { motorSpeed: 2.1 }, routing: { stages: 40 } });
  assert.deepEqual(r.changed.sort(), ['routing.stages', 'vessel.motorSpeed']);
  assert.equal(r.values.vessel.motorSpeed, 2.1);
  assert.equal(r.values.vessel.polarPerformance, base.vessel.polarPerformance, 'untouched keys kept');
  assert.ok(Math.abs(base.vessel.motorSpeed - 6 * KTS_TO_MS) < 1e-12, 'base not mutated');
  // Same value → not reported as changed.
  assert.deepEqual(mergeSettings(r.values, { vessel: { motorSpeed: 2.1 } }).changed, []);
  try {
    mergeSettings(base, {
      vessel: { motorSpeed: 51, name: 5, draught: 1 },
      forecast: { horizon: 2 * 3600, refreshInterval: 601, keepCycles: 2.5 },
      currents: { rtofsRegion: 'mars', rtofsStep: 7 * 3600 },
      routing: { headingIncrement: 0.1, sailThreshold: -1 },
      publish: { toResources: 'yes' },
      nope: {},
    });
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof SettingsValidationError);
    const e = err.errors;
    assert.match(e['vessel.motorSpeed'], /\[\{speed:0.01\}, \{speed:50\}\]/, 'unit tokens, Signal K base units; the client converts');
    assert.match(e['vessel.name'], /unknown setting/, 'the name comes from Signal K');
    assert.match(e['vessel.draught'], /unknown setting/, 'removed settings are unknown');
    assert.match(e['forecast.horizon'], /\[\{time:10800\}, \{time:1296000\}\]/);
    assert.match(e['forecast.refreshInterval'], /multiple of \{time:60\}/);
    assert.match(e['forecast.keepCycles'], /whole number/);
    assert.match(e['currents.rtofsRegion'], /one of west_atl, west_conus/);
    assert.match(e['currents.rtofsStep'], /\[\{time:3600\}, \{time:21600\}\]/);
    assert.match(e['routing.headingIncrement'], /\[\{angle:0\.004363323129985824\}, \{angle:0\.17453292519943295\}\]/);
    assert.match(e['routing.sailThreshold'], /\[\{speed:0\}, /);
    assert.match(e['publish.toResources'], /true or false/);
    assert.match(e.nope, /unknown settings group/);
  }
  assert.throws(() => mergeSettings(base, []), SettingsValidationError);
  assert.throws(() => mergeSettings(base, { vessel: { motorSpeed: '2' } }), /must be a number/);
});

test('reload kinds per changed key', () => {
  assert.deepEqual([...reloadsFor(['forecast.horizon'])], ['forecast']);
  assert.deepEqual([...reloadsFor(['forecast.extraFields'])], ['forecast']);
  assert.deepEqual([...reloadsFor(['currents.rtofsRegion', 'currents.rtofsEnabled'])], ['currents']);
  assert.deepEqual([...reloadsFor(['vessel.motorSpeed', 'routing.stages', 'publish.toResources'])], ['next_job']);
  assert.deepEqual([...reloadsFor(['forecast.refreshInterval'])], ['refresh_timer']);
  assert.deepEqual([...reloadsFor(['routing.keepJobs'])], ['jobs']);
  // Every spec entry has a label, help and SI unit where dimensional.
  for (const s of SETTINGS_SPEC) {
    assert.ok(s.label && s.help, s.key);
    if (s.quantity && !['count'].includes(s.quantity)) assert.ok(s.unit, `${s.key} has a unit`);
  }
  assert.equal(settingsSchema().groups.length, 6);
});

test('SettingsStore: first load migrates and writes settings.json; later loads ignore the old keys', () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  const r = s.load(LEGACY);
  assert.equal(r.created, true);
  assert.ok(r.migrated.includes('vessel.motorSpeed'));
  assert.ok(!r.migrated.includes('vessel.name'));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(file.version, 1);
  assert.equal(file.migratedFrom, 'plugin-config');
  assert.ok(Math.abs(file.values.vessel.motorSpeed - 6 * KTS_TO_MS) < 1e-12);
  // Update persists; a second store reads the file, not the legacy config.
  const u = s.update({ vessel: { motorSpeed: 1.2 }, forecast: { horizon: 72 * 3600 } });
  assert.deepEqual(u.changed.sort(), ['forecast.horizon', 'vessel.motorSpeed']);
  const s2 = new SettingsStore(dir);
  const r2 = s2.load({ vessel: { motorSpeedKts: 9 } });
  assert.equal(r2.created, false);
  assert.equal(s2.values.vessel.motorSpeed, 1.2);
  assert.equal(s2.values.forecast.horizon, 72 * 3600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).migratedFrom, 'plugin-config');
  // Invalid update: nothing saved.
  assert.throws(() => s2.update({ vessel: { motorSpeed: 1.3, polarPerformance: -1 } }), SettingsValidationError);
  const s3 = new SettingsStore(dir);
  s3.load(undefined);
  assert.equal(s3.values.vessel.motorSpeed, 1.2);
});

test('SettingsStore: bad stored values fall back per key; unreadable file is kept aside', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ version: 1, values: { vessel: { motorSpeed: 99, polarPerformance: 0.9, draught: 1.8 }, forecast: { horizon: 'x' } } })
  );
  const s = new SettingsStore(dir);
  const r = s.load(LEGACY);
  assert.equal(r.created, false);
  assert.ok(Math.abs(s.values.vessel.motorSpeed - 6 * KTS_TO_MS) < 1e-12);
  assert.equal(s.values.vessel.polarPerformance, 0.9);
  assert.ok(!('draught' in s.values.vessel), 'a removed setting in an older settings.json is dropped');
  assert.equal(r.problems.length, 2);
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'settings.json'), '{not json');
  const s2 = new SettingsStore(dir2);
  const r2 = s2.load(LEGACY);
  assert.equal(r2.created, true);
  assert.ok(Math.abs(s2.values.vessel.motorSpeed - 6 * KTS_TO_MS) < 1e-12);
  assert.ok(fs.readdirSync(dir2).some(f => f.startsWith('settings.json.corrupt-')));
});

/** Minimal express-like router capturing handlers. */
function fakeRouter(): {
  router: unknown;
  call: (method: string, p: string, body?: unknown, query?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
} {
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const reg = (m: string) => (p: string | string[], h: (req: unknown, res: unknown) => unknown) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  const call = async (method: string, p: string, body?: unknown, query: Record<string, string> = {}) => {
    const h = routes.get(`${method} ${p}`);
    if (!h) throw new Error(`no route ${method} ${p}`);
    let status = 200;
    let out: unknown;
    const res = {
      status(c: number) {
        status = c;
        return res;
      },
      json(b: unknown) {
        out = b;
        return res;
      },
      setHeader() {
        return res;
      },
    };
    await h({ body, query, params: {} }, res);
    return { status, body: out };
  };
  return { router, call };
}

test('GET/PUT /api/settings: schema + values, partial update, 400 with per-key errors', async () => {
  const dir = tmp();
  const store = new SettingsStore(dir);
  store.load(undefined);
  const applied: string[][] = [];
  const { router, call } = fakeRouter();
  registerApi(
    router as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: dir,
      getSettings: () => ({ values: store.values, schema: settingsSchema() }),
      updateSettings: (partial: unknown) => {
        const { values, changed } = store.update(partial);
        applied.push(changed);
        const k = reloadsFor(changed);
        return {
          values,
          changed,
          reloaded: {
            forecast: k.has('forecast'),
            currents: k.has('currents'),
            tides: k.has('tides'),
            refresh_timer: k.has('refresh_timer'),
            jobs: k.has('jobs'),
          },
        };
      },
    } as unknown as ApiDeps
  );
  const g = await call('GET', '/api/settings');
  assert.equal(g.status, 200);
  const gb = g.body as { values: { vessel: { motorSpeed: number } }; schema: { settings: { key: string; unit?: string }[] } };
  assert.ok(Math.abs(gb.values.vessel.motorSpeed - 6 * KTS_TO_MS) < 1e-12);
  assert.equal(gb.schema.settings.find(s => s.key === 'vessel.motorSpeed')!.unit, 'm/s');
  const p = await call('PUT', '/api/settings', { forecast: { horizon: 96 * 3600 } });
  assert.equal(p.status, 200);
  const pb = p.body as { values: { forecast: { horizon: number } }; changed: string[]; reloaded: { forecast: boolean } };
  assert.equal(pb.values.forecast.horizon, 96 * 3600);
  assert.deepEqual(pb.changed, ['forecast.horizon']);
  assert.equal(pb.reloaded.forecast, true);
  const bad = await call('PUT', '/api/settings', { vessel: { motorSpeed: -1 } });
  assert.equal(bad.status, 400);
  assert.match((bad.body as { errors: Record<string, string> }).errors['vessel.motorSpeed'], /\[\{speed:0.01\}, \{speed:50\}\]/);
  assert.ok(Math.abs(store.values.vessel.motorSpeed - 6 * KTS_TO_MS) < 1e-12);
  assert.deepEqual(applied, [['forecast.horizon']]);
});

test('route endpoints answer JSON 503 when the plugin is not started', async () => {
  const { router, call } = fakeRouter();
  registerApi(
    router as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: tmp(),
      get jobs(): never {
        throw new Error('plugin not started');
      },
    } as unknown as ApiDeps
  );
  for (const [m, p] of [
    ['GET', '/api/routes'],
    ['POST', '/api/routes'],
    ['GET', '/api/routes/:id'],
    ['GET', '/api/routes/:id/result'],
    ['GET', '/api/routes/:id/skeleton'],
    ['GET', '/api/routes/:id/signalk'],
    ['GET', '/api/routes/:id/events'],
    ['POST', '/api/routes/:id/cancel'],
    ['POST', '/api/routes/:id/publish'],
    ['DELETE', '/api/routes/:id'],
  ]) {
    const r = await call(m, p, { start: { lat: 0, lon: 0 }, end: { lat: 1, lon: 1 } });
    assert.equal(r.status, 503, `${m} ${p}`);
    assert.deepEqual(r.body, { error: 'plugin not started' }, `${m} ${p}`);
  }
});

test('per-route vessel values override the settings; omitted ones come from the settings', () => {
  const m = migrateLegacy(LEGACY);
  const cfg = resolveConfig({ landShapefiles: '/a.shp' }, m.values);
  const plain = routeVessel(cfg, undefined);
  assert.ok(Math.abs(plain.motorSpeedMs - 6 * KTS_TO_MS) < 1e-12);
  const o = routeVessel(cfg, { motor_speed_ms: 2.5 });
  assert.equal(o.motorSpeedMs, 2.5);
  assert.equal(o.polarPerformance, 1, 'not overridden → setting, not the default');
  assert.ok(!('name' in o), "the vessel name is Signal K's, not a route value");
});

test('polar performance: ratio setting (default 1), per-route override, 0.3..1.2', () => {
  const d = defaultSettings();
  assert.equal(d.vessel.polarPerformance, 1);
  const m = migrateLegacy(LEGACY);
  const cfg = resolveConfig({ landShapefiles: '/a.shp' }, m.values);
  assert.equal(routeVessel(cfg, undefined).polarPerformance, 1);
  assert.equal(routeVessel(cfg, { polar_performance: 0.85 }).polarPerformance, 0.85);
  assert.throws(() => routeVessel(cfg, { polar_performance: 1.5 }), /polarPerformance/);
});

test('CMEMS SMOC settings: defaults in SI, 1 h or 3 h step only, changes reload currents', () => {
  const d = defaultSettings();
  assert.equal(d.currents.smocEnabled, true);
  assert.equal(d.currents.smocStep, 3 * 3600);
  assert.equal(d.currents.smocHorizon, 72 * 3600);
  assert.equal(d.currents.smocHalfWidth, 15);
  const c = resolveConfig({ landShapefiles: '/a.shp' }, d);
  assert.deepEqual(
    [c.currents.smocEnabled, c.currents.smocStepS, c.currents.smocHorizonS, c.currents.smocHalfWidthDeg],
    [true, 3 * HOUR_S, 72 * HOUR_S, 15]
  );
  const ok = mergeSettings(d, { currents: { smocStep: 3600, smocHalfWidth: 20, smocHorizon: 120 * 3600 } });
  assert.deepEqual(ok.changed.sort(), ['currents.smocHalfWidth', 'currents.smocHorizon', 'currents.smocStep']);
  assert.deepEqual([...reloadsFor(ok.changed)], ['currents']);
  try {
    mergeSettings(d, { currents: { smocStep: 7200, smocHalfWidth: 60, smocHorizon: 300 * 3600 } });
    assert.fail('should throw');
  } catch (err) {
    const e = (err as SettingsValidationError).errors;
    assert.match(e['currents.smocStep'], /one of \{time:3600\}, \{time:10800\}/);
    assert.match(e['currents.smocHalfWidth'], /\[\{angle:0\.03490658503988659\}, \{angle:0\.5235987755982988\}\]/);
    assert.match(e['currents.smocHorizon'], /\[\{time:21600\}, \{time:864000\}\]/);
  }
  const specs = settingsSchema().settings.filter(s => s.key.startsWith('currents.smoc'));
  assert.deepEqual(
    specs.map(s => s.key),
    ['currents.smocEnabled', 'currents.smocHorizon', 'currents.smocStep', 'currents.smocHalfWidth']
  );
  assert.deepEqual(SETTINGS_SPEC.find(s => s.key === 'currents.smocStep')!.oneOf, [3600, 10800]);
});

test('allow canals: routing setting, off by default, applies to the next route', () => {
  const spec = SETTINGS_SPEC.find(s => s.key === 'routing.allowCanals');
  assert.ok(spec);
  assert.equal(spec!.type, 'boolean');
  assert.equal(spec!.default, false);
  assert.equal(defaultSettings().routing.allowCanals, false);
  assert.equal(resolveConfig({ landShapefiles: '/x.shp' }, defaultSettings()).routing.allowCanals, false);
  const r = mergeSettings(defaultSettings(), { routing: { allowCanals: true } });
  assert.deepEqual(r.changed, ['routing.allowCanals']);
  assert.equal(resolveConfig({ landShapefiles: '/x.shp' }, r.values).routing.allowCanals, true);
  assert.deepEqual([...reloadsFor(['routing.allowCanals'])], ['next_job']);
});

test('settings: Tides group reloads tides only', () => {
  const d = defaultSettings();
  assert.deepEqual(d.tides, { enabled: true, halfWidth: 15, horizon: 24 * 3600 });
  const c = resolveConfig({}, d);
  assert.deepEqual(c.tides, { enabled: true, halfWidthDeg: 15, horizonS: 24 * HOUR_S });
  const r = mergeSettings(d, { tides: { enabled: false, halfWidth: 8, horizon: 48 * 3600 } });
  assert.deepEqual(r.changed.sort(), ['tides.enabled', 'tides.halfWidth', 'tides.horizon']);
  assert.deepEqual([...reloadsFor(r.changed)], ['tides']);
  assert.throws(() => mergeSettings(d, { tides: { halfWidth: 40 } }), /\[\{angle:0\.017453292519943295\}, \{angle:0\.5235987755982988\}\]/);
  assert.deepEqual(
    SETTINGS_SPEC.filter(s => s.group === 'tides').map(s => s.key),
    ['tides.enabled', 'tides.halfWidth', 'tides.horizon']
  );
});

test('polar source automatically detects by default and retains files/signalk compatibility', () => {
  assert.equal(resolveConfig({}, defaultSettings()).polarSource, 'auto');
  for (const polarSource of ['auto', 'files', 'signalk'] as const)
    assert.equal(resolveConfig({ polarSource }, defaultSettings()).polarSource, polarSource);
  assert.throws(() => resolveConfig({ polarSource: 'other' } as never, defaultSettings()), /polarSource/);
});

test('managed detection API keeps the internal library, automatic fallback and explicit overrides', async () => {
  const dir = tmp();
  const file = path.join(dir, 'internal.csv');
  fs.writeFileSync(file, 'twa/tws,10\n45,4\n90,6\n180,5\n');
  let available = true;
  const { router, call } = fakeRouter();
  registerApi(
    router as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: dir,
      polarLibrary: () => ({ polarFile: file, polarsDir: dir }),
      managedPolar: async () =>
        available ? { label: 'TBD', twa: [45, 90, 180], tws: [5, 10], speeds: [2, 4, 4, 6, 3, 5], performanceFactor: 0.5 } : null,
    } as unknown as ApiDeps
  );
  const list = await call('GET', '/api/polars');
  const entries = list.body as { path: string; activeSource?: string }[];
  assert.equal(entries[0].path, 'auto');
  assert.equal(entries[0].activeSource, 'signalk');
  assert.ok(entries.some(entry => entry.path === 'signalk-active'));
  assert.ok(entries.some(entry => entry.path === 'default'));
  const preview = await call('GET', '/api/polars/table');
  assert.equal(preview.status, 200);
  assert.deepEqual((preview.body as { speeds_ms: number[][] }).speeds_ms, [
    [1, 2],
    [2, 3],
    [1.5, 2.5],
  ]);
  assert.equal((preview.body as { source: string }).source, 'signalk');
  const override = await call('GET', '/api/polars/table', undefined, { path: 'default' });
  assert.equal((override.body as { source: string }).source, 'internal');
  available = false;
  const fallback = await call('GET', '/api/polars/table');
  assert.equal(fallback.status, 200);
  assert.equal((fallback.body as { source: string }).source, 'internal');
  const missing = await call('GET', '/api/polars/table', undefined, { path: 'signalk-active' });
  assert.equal(missing.status, 400);
  assert.match((missing.body as { error: string }).error, /No active Polar Management/);
  const unavailableList = await call('GET', '/api/polars');
  assert.equal((unavailableList.body as { activeSource: string }[])[0].activeSource, 'internal');
});
