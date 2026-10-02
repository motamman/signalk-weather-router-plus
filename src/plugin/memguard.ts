/**
 * Resource guard: refuse work the device cannot hold with the user's
 * headroom to spare, instead of letting the system swap or kill Signal K.
 *
 * The decoded forecast lives on disk (decoded.ts), not in memory. What
 * needs memory is:
 *  - a forecast update: the streaming decoder's one-step block plus its
 *    decode buffers (streamingDecodeBytes, ≈67 MB with the extra fields),
 *    held only while the update runs;
 *  - a route: its corridor store (the route area × the engine's fields ×
 *    every step), held only while the route runs;
 * and what needs disk is the decoded run itself (one Float32 global grid,
 * 1440 × 721 cells, per field per step: 1.14 GB for 72 h with the extra
 * fields), written next to the run in use before that one is pruned.
 * Each check compares the need against what is available *now*: after
 * the work, `headroom` bytes of memory must remain, and at least
 * DISK_RESERVE_BYTES of disk.
 *
 * Available memory is Linux MemAvailable (what the kernel can hand out
 * without swapping), bounded by a cgroup memory limit when the plugin
 * runs in a container. On macOS os.freemem() counts only completely free
 * pages (often tens of MB on a busy Mac), so there the figure is free +
 * inactive + speculative + purgeable pages from vm_stat, the memory the
 * kernel reclaims without swapping. Elsewhere os.freemem().
 *
 * The global water grid (about 65 MB, route worker only) is resident from
 * start-up, so it is already excluded from the available figure when a
 * forecast update or a route runs. Rebuilding it (only when no grid matches the configured
 * coastline) needs WATER_GRID_BUILD_BYTES more while it runs;
 * checkWaterGridBuildMemory guards that the same way.
 */

import { execFileSync } from 'node:child_process';
import { HOUR_S } from '../geo/units';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { availableSteps, ATM_PARAMS, WAVE_PARAMS, MAIN_MAX_STEP } from '../data/ecmwf';
import { streamingDecodeBytes } from '../data/loader';

/** Bytes of one global field for one step (Float32, 0.25°). */
export const FIELD_STEP_BYTES = 1440 * 721 * 4;
export const EXTRA_FIELD_COUNT = 7;

/** Bytes of a decoded run (on disk) for a horizon and field set: steps × fields × one global grid. */
export function forecastBytes(horizonS: number, extraFields: boolean): number {
  // The longest schedule (a 00z/12z cycle), so the estimate never falls short.
  const steps = availableSteps({ maxStep: MAIN_MAX_STEP }, horizonS / HOUR_S).length;
  return steps * fieldsPerStep(extraFields) * FIELD_STEP_BYTES;
}

function readNumber(file: string): number | null {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t === 'max' || t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Memory the system can give this process now, bytes, and where the figure came from. */
export function availableMemory(): { bytes: number; source: string } {
  let bytes = os.freemem();
  let source = 'os.freemem';
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) {
      bytes = Number(m[1]) * 1024;
      source = 'MemAvailable';
    }
  } catch {
    /* not Linux */
  }
  if (process.platform === 'darwin' && source === 'os.freemem') {
    const mac = darwinAvailable();
    if (mac !== null) {
      bytes = mac;
      source = 'vm_stat free+inactive+speculative+purgeable';
    }
  }
  // cgroup v2, then v1: a container limit can be far below the host's free memory.
  const limit = readNumber('/sys/fs/cgroup/memory.max') ?? readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const used = readNumber('/sys/fs/cgroup/memory.current') ?? readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (limit !== null && used !== null && limit < 2 ** 60) {
    const cg = Math.max(0, limit - used);
    if (cg < bytes) {
      bytes = cg;
      source = 'cgroup limit';
    }
  }
  return { bytes, source };
}

/** macOS reclaimable memory from vm_stat, bytes, or null when unavailable. */
export function parseVmStat(text: string): number | null {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) return null;
  const pages = (name: string): number => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * Number(page[1]);
}

function darwinAvailable(): number | null {
  try {
    return parseVmStat(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }));
  } catch {
    return null;
  }
}

export interface MemoryCheck {
  ok: boolean;
  needBytes: number;
  availableBytes: number;
  headroomBytes: number;
  source: string;
  /** Human explanation with a suggestion when not ok. */
  message: string;
}

// Sizes and times as unit tokens: the web app writes them in its user's units.
const mb = (b: number): string => `{dataSize:${Math.round(b)}}`;
const hrs = (h: number): string => `{time:${Math.round(h * HOUR_S)}}`;

/** Parameters per step for a field set. */
export function fieldsPerStep(extraFields: boolean): number {
  return ATM_PARAMS.length + WAVE_PARAMS.length + (extraFields ? EXTRA_FIELD_COUNT : 0);
}

/** Disk left free after writing a decoded run (a policy, not a measurement). */
export const DISK_RESERVE_BYTES = 1e9;

/** Free disk space for this process below `dir`, bytes, or null when unknown. */
export function availableDisk(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * Can a forecast update run: memory for one decode step with `headroom`
 * to spare, and disk for the whole decoded run with DISK_RESERVE_BYTES to
 * spare? `available` / `disk` default to live readings (tests pass their own).
 */
export function checkDecodeResources(
  horizonS: number,
  extraFields: boolean,
  headroomBytes: number,
  dir: string | null,
  available: { bytes: number; source: string } = availableMemory(),
  disk: number | null = dir ? availableDisk(dir) : null
): MemoryCheck {
  const need = streamingDecodeBytes(fieldsPerStep(extraFields));
  const horizonHours = horizonS / HOUR_S;
  const runBytes = forecastBytes(horizonS, extraFields);
  const memOk = need + headroomBytes <= available.bytes;
  const diskOk = disk === null || runBytes + DISK_RESERVE_BYTES <= disk;
  const diskText = disk === null ? 'free disk space unknown' : `${mb(disk)} disk free`;
  let message = `update needs ${mb(need)} of memory for one decode step (${hrs(horizonHours)}${extraFields ? ', extra fields' : ''}) and ${mb(runBytes)} of disk for the decoded run; ${mb(available.bytes)} memory available, ${mb(headroomBytes)} headroom kept; ${diskText}`;
  if (!memOk) {
    message = `not enough memory: ${message}. Free memory or lower the memory headroom setting (Settings tab).`;
  } else if (!diskOk) {
    const fits = (h: number, x: boolean): boolean => forecastBytes(h * HOUR_S, x) + DISK_RESERVE_BYTES <= disk!;
    const options: string[] = [];
    if (extraFields && fits(horizonHours, false)) options.push('turn off the extra fields');
    for (const h of [120, 96, 72, 48, 24, 12]) {
      if (h >= horizonHours) continue;
      if (fits(h, extraFields)) {
        options.push(`shorten the forecast horizon to ${hrs(h)}`);
        break;
      }
      if (extraFields && fits(h, false)) {
        options.push(`shorten the horizon to ${hrs(h)} with the extra fields off`);
        break;
      }
    }
    options.push(`free disk space (${mb(DISK_RESERVE_BYTES)} must stay free)`);
    message = `not enough disk space: ${message}. To fit: ${options.join(', or ')}.`;
  }
  return { ok: memOk && diskOk, needBytes: need, availableBytes: available.bytes, headroomBytes, source: available.source, message };
}

/** Can a route's corridor store of `needBytes` be read, leaving `headroomBytes` free? */
export function checkRouteForecastMemory(
  needBytes: number,
  headroomBytes: number,
  available: { bytes: number; source: string } = availableMemory()
): MemoryCheck {
  const ok = needBytes + headroomBytes <= available.bytes;
  const message = ok
    ? `route forecast area needs ${mb(needBytes)}; ${mb(available.bytes)} available, ${mb(headroomBytes)} headroom kept`
    : `not enough memory for the route's forecast area: it needs ${mb(needBytes)}, ${mb(available.bytes)} available with ${mb(headroomBytes)} to keep free. Shorten the route (fewer waypoints far apart), shorten the forecast horizon, or lower the memory headroom setting.`;
  return { ok, needBytes, availableBytes: available.bytes, headroomBytes, source: available.source, message };
}

/**
 * Peak extra memory of a water grid rebuild (the three global bit planes,
 * one 10° tile with halo, its distance field, decoded polygons), bytes.
 * Measured on the full GSHHG L1: 419 MB peak RSS for the standalone build
 * process including Node itself (about 60 MB).
 */
export const WATER_GRID_BUILD_BYTES = 400e6;

/** Can a water grid rebuild run now, leaving `headroomBytes` free? */
export function checkWaterGridBuildMemory(
  headroomBytes: number,
  available: { bytes: number; source: string } = availableMemory()
): MemoryCheck {
  const need = WATER_GRID_BUILD_BYTES;
  const ok = need + headroomBytes <= available.bytes;
  const message = ok
    ? `water grid rebuild needs about ${mb(need)}; ${mb(available.bytes)} available, ${mb(headroomBytes)} headroom kept`
    : `not enough memory to rebuild the water grid: it needs about ${mb(need)}, ${mb(available.bytes)} available with ${mb(headroomBytes)} to keep free. Routes use the shipped grid meanwhile; free memory or lower the memory headroom setting and restart the plugin.`;
  return { ok, needBytes: need, availableBytes: available.bytes, headroomBytes, source: available.source, message };
}
