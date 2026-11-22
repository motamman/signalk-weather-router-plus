/**
 * Explicit full garbage collection after large short-lived forecast
 * memory is dropped: the streaming decoder's one-step block and decode
 * buffers at the end of an update, and a route's corridor store when the
 * route ends; and in the route worker, relayed SMOC / RTOFS shared
 * memory it let go (worker/currents.ts: V8 does not count a
 * SharedArrayBuffer from another thread toward this one's memory). An idle
 * isolate (the route worker between jobs) can go hours without a major
 * GC, so that memory would otherwise stay resident until some later
 * collection. (The decoded forecast itself is on disk, never resident;
 * see data/decoded.ts.)
 *
 * `gc` is obtained without a command-line flag: --expose_gc set at run
 * time installs `gc` in contexts created afterwards, so a fresh vm
 * context hands it back. If that is unavailable nothing happens (the old
 * store is then freed whenever V8 next collects on its own).
 */

import * as v8 from 'node:v8';
import * as vm from 'node:vm';

let gcFn: (() => void) | null | undefined;

function getGc(): (() => void) | null {
  if (gcFn !== undefined) return gcFn;
  try {
    const g = (globalThis as { gc?: () => void }).gc;
    if (typeof g === 'function') {
      gcFn = g;
    } else {
      v8.setFlagsFromString('--expose_gc');
      const f = vm.runInNewContext('gc') as unknown;
      gcFn = typeof f === 'function' ? (f as () => void) : null;
    }
  } catch {
    gcFn = null;
  }
  return gcFn;
}

/** Run a full GC now; returns the time taken in ms, or null when GC is not available. */
export function releaseMemory(): number | null {
  const gc = getGc();
  if (!gc) return null;
  const t = Date.now();
  gc();
  return Date.now() - t;
}
