/**
 * Signal K Weather API provider backed by the decoded forecast: point
 * forecasts (one WeatherData per forecast step) and observations (one
 * WeatherData for the conditions now, interpolated between the two steps
 * around the current time). Daily summaries and warnings are not provided.
 *
 * Surface current (`water.surfaceCurrentSpeed`, m/s, and
 * `water.surfaceCurrentDirection`, rad, the direction the water flows
 * TOWARDS, the set, as Signal K's `environment.water.current.setTrue`)
 * from the loaded current sources (Copernicus SMOC, RTOFS, harmonics)
 * where they cover the point; the fields are left out elsewhere. Beyond a
 * source's time range its last step is held, as the overlays do.
 *
 * The main thread holds no forecast: the provider asks the data worker
 * (query 'weather_point'), which reads the few grid cells around the
 * position for every step from the decoded run on disk and runs
 * pointForecasts() on them.
 *
 * Every value is in the Signal K unit for its field: m/s, rad, Pa, K,
 * m, s, and relative humidity as a ratio. The extra fields (temperature,
 * dew point, humidity, water temperature, total cloud cover, wind gust)
 * appear only when the plugin is configured to fetch them, as do the
 * energy fields (total precipitation as `precipitationVolume`, the depth
 * of the interval ending at the forecast time; solar and infrared fluxes,
 * snowfall and convective instability only through the plugin's own API
 * and the conditions popup, which have no Signal K slot). The step-0
 * gust, whose time range is empty (ECMWF codes it 0 m/s everywhere), is
 * never published; from step 3 on every step carries the real maximum.
 *
 * Water level (when tides are enabled): `water.level` is the total water
 * level (tide + surge) in metres relative to local MEAN SEA LEVEL (not
 * chart datum) from the Copernicus Marine hourly sea level at the
 * position, and `water.levelTendency` its tendency at that time
 * (Signal K TendencyKind: increasing / decreasing, steady within
 * ±2 cm/h, from the central difference of the hourly series). The point
 * series is fetched on demand (the provider methods are async); when it
 * is unavailable the two fields are left out.
 */

import type { ForecastStore } from '../data/forecast';
import { HOUR_MS } from '../geo/units';
import type { QueryArgs, TideSeriesResult } from './protocol';
import { relativeHumidity } from './conditions';
import { sampleSeries, signalKTendency, slopeAt, type RegularSeries } from '../tides/tidecalc';

export interface SkPosition {
  latitude: number;
  longitude: number;
}

export interface WeatherReqParams {
  maxCount?: number;
  startDate?: string;
  custom?: Record<string, unknown>;
}

export interface WeatherData {
  description?: string;
  date: string;
  type: 'point' | 'daily' | 'observation';
  outside?: {
    pressure?: number;
    temperature?: number;
    dewPointTemperature?: number;
    /** Ratio 0..1. */
    relativeHumidity?: number;
    /** Total cloud cover, ratio 0..1 (ECMWF `tcc`). */
    cloudCover?: number;
    /** Depth in m accumulated over the interval ending at `date`. */
    precipitationVolume?: number;
  };
  water?: {
    temperature?: number;
    /** Total water level relative to local mean sea level, m. */
    level?: number;
    levelTendency?: 'steady' | 'decreasing' | 'increasing' | 'not available';
    waveSignificantHeight?: number;
    wavePeriod?: number;
    waveDirection?: number;
    /** m/s. */
    surfaceCurrentSpeed?: number;
    /** rad, the set (direction the water flows towards), true. */
    surfaceCurrentDirection?: number;
  };
  wind?: { speedTrue?: number; directionTrue?: number; /** m/s, 10 m wind gust (ECMWF `10fg`). */ gust?: number };
}

/** A current source as pointForecasts samples it (the data worker's CurrentStack). */
export interface CurrentsLike {
  contains(lon: number, lat: number): boolean;
  /** [u east, v north] in m/s. */
  at(lon: number, lat: number, time: Date): [number, number];
}

export interface WeatherProviderLike {
  name: string;
  methods: {
    pluginId?: string;
    getObservations: (position: SkPosition, options?: WeatherReqParams) => Promise<WeatherData[]>;
    getForecasts: (position: SkPosition, type: 'point' | 'daily', options?: WeatherReqParams) => Promise<WeatherData[]>;
    getWarnings: (position: SkPosition) => Promise<unknown[]>;
  };
}

/** Hourly water level at a point (m above local mean sea level, NaN = none), or null when tides are off. */
export interface TideSeriesLike {
  t0Ms: number;
  stepMs: number;
  waterLevel: ArrayLike<number>;
  run?: string | null;
  error: string | null;
}

export type TideSeriesFn = (lat: number, lon: number, fromMs: number, hours: number) => Promise<TideSeriesLike | null>;

/** Add water.level / water.levelTendency to point forecasts from an hourly water-level series. */
export function applyWaterLevel(items: WeatherData[], s: TideSeriesLike): number {
  const wl: RegularSeries = { t0Ms: s.t0Ms, stepMs: s.stepMs, values: s.waterLevel };
  let n = 0;
  for (const item of items) {
    const t = Date.parse(item.date);
    const level = sampleSeries(wl, t);
    if (level === null) continue;
    item.water = { ...(item.water ?? {}), level, levelTendency: signalKTendency(slopeAt(wl, t)) };
    n++;
  }
  return n;
}

/** Point forecasts at a position (the data worker runs pointForecasts on a window of the decoded run); `observation` asks for the conditions now instead. */
export type PointForecastFn = (position: SkPosition, options?: WeatherReqParams & { observation?: boolean }) => Promise<WeatherData[]>;

/** Observations are answered for the 5-minute slot, so the data worker's answer can be reused across a chartplotter's many points. */
export const OBSERVATION_SLOT_MS = 5 * 60_000;

/** The step start time a request asks for (options.startDate, else now). */
export function startMsOf(options?: WeatherReqParams): number | null {
  if (!options?.startDate) return null;
  const d = Date.parse(options.startDate);
  return Number.isNaN(d) ? null : d;
}

export function makeWeatherProvider(
  points: PointForecastFn,
  pluginId: string,
  tideSeries?: TideSeriesFn,
  log: (m: string) => void = () => undefined
): WeatherProviderLike {
  let lastTideError = '';
  const withWaterLevel = async (position: SkPosition, items: WeatherData[]): Promise<WeatherData[]> => {
    if (!tideSeries || items.length === 0) return items;
    const times = items.map(i => Date.parse(i.date));
    // One step either side for the tendency's central difference.
    const fromMs = Math.min(...times) - HOUR_MS;
    const hours = Math.ceil((Math.max(...times) - fromMs) / HOUR_MS) + 1;
    try {
      const s = await tideSeries(position.latitude, position.longitude, fromMs, Math.min(hours, 400));
      if (!s) return items;
      if (s.error) throw new Error(s.error);
      applyWaterLevel(items, s);
      lastTideError = '';
    } catch (err) {
      const m = (err as Error).message;
      if (m !== lastTideError)
        log(`Weather API: water level unavailable at ${position.latitude.toFixed(3)}, ${position.longitude.toFixed(3)}: ${m}`);
      lastTideError = m;
    }
    return items;
  };
  return {
    name: 'Weather Router Plus (ECMWF open data)',
    methods: {
      pluginId,
      // The conditions now: one entry, interpolated between the two forecast
      // steps around the current time (what a chartplotter's wind overlay
      // asks for at every point of its lattice).
      getObservations: async position => withWaterLevel(position, await points(position, { observation: true })),
      getForecasts: async (position, type, options) => {
        if (type !== 'point') return [];
        return withWaterLevel(position, await points(position, options));
      },
      getWarnings: async () => [],
    },
  };
}

/** Parameters pointForecasts reads. The energy parameters are skipped for runs decoded without them. */
export const POINT_FORECAST_PARAMS = [
  '10u',
  '10v',
  'msl',
  'swh',
  'mwp',
  'mwd',
  '2t',
  '2d',
  'skt',
  'tcc',
  '10fg',
  'tp',
  'ssrd',
  'sf',
  'strd',
  'str',
  'mucape',
] as const;

/**
 * Point forecasts from a store holding every step around the position
 * (the data worker passes a window of the decoded run, which samples
 * exactly like the whole global store).
 */
export function pointForecasts(
  store: ForecastStore,
  lon: number,
  lat: number,
  startMs: number | null,
  maxCount: number | null,
  opts: { currents?: CurrentsLike; observation?: boolean } = {}
): WeatherData[] {
  if (!store.covers(lon, lat)) {
    throw new Error(`position ${lat.toFixed(3)}, ${lon.toFixed(3)} is outside the forecast`);
  }
  const fromMs = startMs ?? Date.now();
  const cycle = store.meta.cycleTime.toISOString();
  if (opts.observation) {
    // The conditions at `fromMs`: the store interpolates between the two
    // steps around it (held at the first or last step outside the run).
    return [
      weatherItemAt(
        store,
        lon,
        lat,
        new Date(fromMs),
        'observation',
        `ECMWF IFS 0.25° open data, cycle ${cycle}, interpolated to the time`,
        opts.currents
      ),
    ];
  }
  const out: WeatherData[] = [];
  for (let i = 0; i < store.steps.length; i++) {
    const step = store.steps[i];
    if (step.validMs + 3 * HOUR_MS <= fromMs) continue; // step already fully in the past
    out.push(
      weatherItemAt(
        store,
        lon,
        lat,
        new Date(step.validMs),
        'point',
        `ECMWF IFS open data, cycle ${cycle}, valid ${new Date(step.validMs).toISOString()}`,
        opts.currents
      )
    );
    if (maxCount && out.length >= maxCount) break;
  }
  return out;
}

/** One WeatherData sampled from the store (and the currents, where they cover the point) at `t`. */
function weatherItemAt(
  store: ForecastStore,
  lon: number,
  lat: number,
  t: Date,
  type: WeatherData['type'],
  description: string,
  currents?: CurrentsLike
): WeatherData {
  const finiteOr = (v: number): number | undefined => (Number.isFinite(v) ? v : undefined);
  const [ws, wd] = store.at(lon, lat, t);
  const wave = store.wavesAt(lon, lat, t);
  const msl = store.mslAt(lon, lat, t);
  const wind: NonNullable<WeatherData['wind']> = { speedTrue: ws, directionTrue: (wd * Math.PI) / 180 };
  // hasAny, not has: the step-0 gust is dropped at the decode (empty range).
  const gust = store.hasAny('10fg') ? finiteOr(store.paramAt('10fg', lon, lat, t)) : undefined;
  if (gust !== undefined) wind.gust = gust;
  const item: WeatherData = {
    description,
    date: t.toISOString(),
    type,
    wind,
  };
  const outside: NonNullable<WeatherData['outside']> = {};
  const tcc = store.has('tcc') ? finiteOr(store.paramAt('tcc', lon, lat, t)) : undefined;
  if (tcc !== undefined) outside.cloudCover = tcc;
  // Total precipitation: the interval depth ending at the item's time.
  // Point forecasts sit on step valid times, where the interval is the
  // step's own (3 h to 144 h, 6 h past it); an observation's time falls
  // inside an interval that has not ended, so the field is left out there.
  if (type === 'point' && store.hasAny('tp')) {
    const iv = store.intervalAt('tp', lon, lat, t);
    if (iv && Number.isFinite(iv.value)) outside.precipitationVolume = iv.value;
  }
  if (Number.isFinite(msl)) outside.pressure = msl;
  const t2m = store.has('2t') ? finiteOr(store.paramAt('2t', lon, lat, t)) : undefined;
  const d2m = store.has('2d') ? finiteOr(store.paramAt('2d', lon, lat, t)) : undefined;
  if (t2m !== undefined) outside.temperature = t2m;
  if (d2m !== undefined) outside.dewPointTemperature = d2m;
  const rh = relativeHumidity(t2m ?? null, d2m ?? null);
  if (rh !== null) outside.relativeHumidity = rh;
  if (Object.keys(outside).length > 0) item.outside = outside;
  const water: NonNullable<WeatherData['water']> = {};
  const skt = store.has('skt') ? finiteOr(store.paramAt('skt', lon, lat, t)) : undefined;
  if (skt !== undefined) water.temperature = skt;
  if (wave && Number.isFinite(wave.swh)) {
    water.waveSignificantHeight = wave.swh;
    water.wavePeriod = wave.mwp;
    water.waveDirection = (wave.mwd * Math.PI) / 180;
  }
  if (currents && currents.contains(lon, lat)) {
    const [u, v] = currents.at(lon, lat, t);
    if (Number.isFinite(u) && Number.isFinite(v)) {
      water.surfaceCurrentSpeed = Math.hypot(u, v);
      // The set: direction the water flows towards, from north, clockwise.
      water.surfaceCurrentDirection = ((Math.atan2(u, v) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    }
  }
  if (Object.keys(water).length > 0) item.water = water;
  return item;
}

/**
 * Register the plugin as a Weather API provider (point forecasts read by
 * the data worker from the decoded run; water level from its tide point
 * series). True when registered. Extracted from index.ts (phase 2.3).
 */
export function registerWeatherProvider(
  app: { registerWeatherProvider?: (provider: unknown) => void },
  d: {
    pluginId: string;
    tidesEnabled: () => boolean;
    hasForecast: () => boolean;
    pointQuery: (kind: 'tide_series' | 'weather_point', args: QueryArgs['tide_series'] | QueryArgs['weather_point']) => Promise<unknown>;
    log: (m: string) => void;
    error: (m: string) => void;
  }
): boolean {
  if (typeof app.registerWeatherProvider !== 'function') {
    d.log('Weather API not available on this server; provider not registered');
    return false;
  }
  try {
    // Water level for point forecasts comes from the data worker's tide point series (on demand).
    const tideSeries = async (lat: number, lon: number, fromMs: number, hours: number): Promise<TideSeriesResult | null> => {
      if (!d.tidesEnabled()) return null;
      return (await d.pointQuery('tide_series', { lat, lon, fromMs, hours })) as TideSeriesResult;
    };
    // Point forecasts are read by the data worker from the decoded run (this thread holds no forecast).
    const points = async (
      position: { latitude: number; longitude: number },
      options?: { startDate?: string; maxCount?: number; observation?: boolean }
    ): Promise<WeatherData[]> => {
      if (!d.hasForecast()) throw new Error('no forecast loaded yet');
      if (options?.observation) {
        return (await d.pointQuery('weather_point', {
          lat: position.latitude,
          lon: position.longitude,
          // The current 5-minute slot, so the answer can be reused across a chartplotter's lattice.
          startMs: Math.floor(Date.now() / OBSERVATION_SLOT_MS) * OBSERVATION_SLOT_MS,
          maxCount: 1,
          observation: true,
        })) as WeatherData[];
      }
      return (await d.pointQuery('weather_point', {
        lat: position.latitude,
        lon: position.longitude,
        // No start given: from the start of this hour (not this millisecond), so the answer can be kept for the hour.
        startMs: startMsOf(options) ?? Math.floor(Date.now() / HOUR_MS) * HOUR_MS,
        maxCount: options?.maxCount ?? null,
      })) as WeatherData[];
    };
    app.registerWeatherProvider(makeWeatherProvider(points, d.pluginId, tideSeries, m => d.log(m)));
    d.log('registered as a Weather API provider');
    return true;
  } catch (err) {
    d.error(`Weather API registration failed: ${(err as Error).message}`);
    return false;
  }
}
