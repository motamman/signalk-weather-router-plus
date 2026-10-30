/**
 * Why a route cannot be made, as facts, and the one place that writes them
 * as the sentence the user sees.
 *
 * A throw site says what happened in data (the kind, where, when, the value
 * against its limit, when it eases); `refusalText` turns that into one
 * sentence in one voice, with positions, times and unit tokens (`{speed:…}`,
 * `{length:…}`: the web app writes them in its user's units) formatted the
 * same way everywhere. The counts and stage numbers that help debugging go
 * on the error as `detail` and into the job's progress log, not into the
 * sentence. Callers still decide by class or `code`, never by the text
 * (errors.ts).
 */

import { latLonText } from '../geo/geodesy';
import { HOUR_MS } from '../geo/units';
import type { WindSource } from './environment';
import { type EngineErrorCode, RouteError } from './errors';

/** A value the forecast gives against the limit the request set. */
export interface LimitFacts {
  seen: number;
  limit: number;
}

/** Where the boat is when the search stops: null = the start. */
export type RefusalPlace = { lon: number; lat: number } | null;

export type RouteRefusal =
  /** Every move from `at` is over the wind or wave limit. */
  | {
      kind: 'over_limit';
      at: RefusalPlace;
      atMs: number;
      wind: LimitFacts | null;
      waves: LimitFacts | null;
      /** When both come under the limits there (ms), null when not before `untilMs`. */
      easesMs: number | null;
      /** How far ahead the ease was looked for: the forecast's end, or the search's own horizon. */
      untilMs: number;
      /** true: `untilMs` comes from the forecast's end; false: the forecast's end is not known and `untilMs` ends a fixed look ahead. */
      untilForecastEnd: boolean;
      /** true: `at` and `atMs` are a reading one step ahead of the front (where a refused move would arrive), not a place reached. */
      ahead?: boolean;
    }
  /** Every heading from `at` crosses land. */
  | { kind: 'coast'; at: RefusalPlace; atMs: number }
  /** Every heading from `at` is dead upwind for the polar, and the boat does not motor there. */
  | { kind: 'dead_upwind'; at: RefusalPlace; atMs: number }
  /** The boat makes no way from `at`: no boat speed, or a current stronger than the boat. */
  | { kind: 'stopped'; at: RefusalPlace; atMs: number }
  /**
   * The moves from `at` were stopped for more than one reason, `reasons` in the order the counts give them; `at` is
   * 'front' when no single place is known (several candidates), `atMs` then the front's latest time.
   */
  | { kind: 'mixed'; at: RefusalPlace | 'front'; atMs: number; reasons: ('land' | 'no_go' | 'stopped' | 'limit')[] };

const REASON_TEXT = {
  land: 'land',
  no_go: 'the wind dead ahead for this polar',
  stopped: 'no boat speed or a current stronger than the boat',
  limit: 'the wind/wave limit',
};

/** An absolute time as the messages write it. */
export function fmtUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function whereText(at: RefusalPlace, atMs: number): string {
  return at ? `at ${latLonText(at.lat, at.lon)}, reached ${fmtUtc(atMs)}` : 'at the start';
}

function advice(at: RefusalPlace, eases: boolean): string {
  if (at) return 'Raise the limit, or change the departure so the boat is elsewhere then.';
  return eases ? 'Raise the limit or depart after that.' : 'Raise the limit or choose another departure.';
}

/** The sentence the user sees. */
export function refusalText(r: RouteRefusal): string {
  if (r.kind === 'mixed') {
    const lead =
      r.at === 'front'
        ? `From the search's front, reached ${fmtUtc(r.atMs)},`
        : r.at
          ? `From ${whereText(r.at, r.atMs).slice(3)},`
          : 'At the start';
    const why = r.reasons.length ? `: its moves were stopped by ${r.reasons.map(k => REASON_TEXT[k]).join(', ')}` : '';
    // Land alone: another departure changes nothing; the way out is a point in open water.
    const what =
      r.reasons.length === 1 && r.reasons[0] === 'land'
        ? 'Add a waypoint in open water round the land, or move a point that is close to the shore into open water.'
        : 'Add a waypoint or choose another departure.';
    return `${lead} the search could not make progress${why}. ${what}`;
  }
  const where =
    r.kind === 'over_limit' && r.ahead && r.at
      ? `at ${latLonText(r.at.lat, r.at.lon)}, one step ahead of the front, about ${fmtUtc(r.atMs)}`
      : whereText(r.at, r.atMs);
  switch (r.kind) {
    case 'over_limit': {
      const parts: string[] = [];
      if (r.wind) parts.push(`wind {speed:${r.wind.seen}} against your {speed:${r.wind.limit}} limit`);
      if (r.waves) parts.push(`waves {length:${r.waves.seen}} against your {length:${r.waves.limit}} limit`);
      if (!parts.length) return `Forecast ${where}: the wind or waves are over your limits on every heading. ${advice(r.at, false)}`;
      const they = parts.length > 1 ? 'They' : 'It';
      const limits = parts.length > 1 ? 'the limits' : 'the limit';
      const ease =
        r.easesMs !== null
          ? `${they} come${parts.length > 1 ? '' : 's'} under ${limits} about ${fmtUtc(r.easesMs)}.`
          : r.untilForecastEnd && r.atMs > r.untilMs
            ? `This is past the forecast's end, ${fmtUtc(r.untilMs)}: the search went beyond the forecast, on its last step held.`
            : // No hour with every limit met (limitsEaseAt): one value can ease while another stays over or rises.
              `Conditions there do not meet all your limits again before ${fmtUtc(r.untilMs)}, ${r.untilForecastEnd ? 'as far as the forecast goes' : 'as far ahead as was checked'}.`;
      return `Forecast ${where}: ${parts.join(' and ')}. ${ease} ${advice(r.at, r.easesMs !== null)}`;
    }
    case 'coast':
      return `Every heading ${where} crosses land: the search found no way past the coast there. ${
        r.at ? 'Add a waypoint in open water round it.' : 'Move the start into open water.'
      }`;
    case 'dead_upwind':
      return `${r.at ? `From ${where.slice(3)},` : 'At the start'} the wind is dead ahead for this polar and the boat does not motor, so it cannot make way. Allow motoring (Min sail speed) or choose another departure.`;
    case 'stopped':
      return `${r.at ? `From ${where.slice(3)},` : 'At the start'} the boat makes no way: no boat speed in this wind, or a current stronger than the boat. Allow motoring or choose another departure.`;
  }
}

/**
 * A route refused for a reason the user can act on; `detail` is what the search tried, for the log; `suffix` follows
 * the sentence (what else the user should know: a forecast that ended, a front that stalled).
 */
export class RouteRefused extends RouteError {
  constructor(
    readonly refusal: RouteRefusal,
    readonly detail: string,
    code: EngineErrorCode = 'route',
    suffix = ''
  ) {
    super(refusalText(refusal) + suffix, code);
  }
}

/** The wind and waves at a point and time against the limits, each null when under its limit or not limited. */
export function limitsAt(
  wind: WindSource,
  lon: number,
  lat: number,
  timeMs: number,
  maxWindMs: number | undefined,
  maxSwhM: number | undefined
): { wind: LimitFacts | null; waves: LimitFacts | null } {
  const t = new Date(timeMs);
  const [ws] = wind.at(lon, lat, t);
  const swh = maxSwhM !== undefined && wind.hasWaves ? (wind.wavesAt(lon, lat, t)?.swh ?? NaN) : NaN;
  return {
    wind: maxWindMs !== undefined && ws > maxWindMs ? { seen: round(ws, 1), limit: round(maxWindMs, 2) } : null,
    waves: maxSwhM !== undefined && swh > maxSwhM ? { seen: round(swh, 1), limit: round(maxSwhM, 2) } : null,
  };
}

/** The first whole hour from `fromMs` to `untilMs` when the point is under both limits, or null. */
export function limitsEaseAt(
  wind: WindSource,
  lon: number,
  lat: number,
  fromMs: number,
  untilMs: number,
  maxWindMs: number | undefined,
  maxSwhM: number | undefined
): number | null {
  for (let t = Math.ceil(fromMs / HOUR_MS) * HOUR_MS; t <= untilMs; t += HOUR_MS) {
    // Eased only on a reading under every limit set: a missing wind or wave value (NaN) is no sign that it eased. The
    // wave limit, as in the search (legsim.ts), only where the forecast has waves.
    const at = new Date(t);
    const windOk = maxWindMs === undefined || wind.at(lon, lat, at)[0] <= maxWindMs;
    const wavesOk = maxSwhM === undefined || !wind.hasWaves || (wind.wavesAt(lon, lat, at)?.swh ?? NaN) <= maxSwhM;
    if (windOk && wavesOk) return t;
  }
  return null;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
