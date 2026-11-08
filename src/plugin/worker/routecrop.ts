/**
 * A route's forecast crop as a decoded run on disk, for the chart mesh process.
 *
 * Before there is a decoded run (the first forecast is still being decoded, or its download failed and is retried),
 * the route worker decodes the route's area from the GRIB cache into memory (route.ts loadAreas). The mesh process
 * reads the forecast from a decoded run's files only (meshlegtask.ts), so a mesh leg had no forecast to read and was
 * refused. The crop is written as a run of its own: the same files and index as every decoded run
 * (decoded.ts DecodedRunWriter), its grid the crop's, so the mesh process reads exactly the values the worker holds.
 * It is removed with the route's areas. The crops are in the route worker's folder (WorkerState.cropRoot:
 * ROUTE_CROP_DIR in the plugin's data directory), and what a stop left in it is removed when the worker starts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cycleName, type DecodedRun, DecodedRunWriter, openDecodedRun } from '../../data/decoded';
import type { ForecastStore } from '../../data/forecast';

/** The route crops' folder below the plugin data directory. */
export const ROUTE_CROP_DIR = 'route-forecast';

/** Write route job `jobId`'s crop as a decoded run in the worker's folder `root` (replacing the job's earlier crop), and open it. */
export function writeCropRun(root: string, jobId: string, crop: ForecastStore, horizonHours: number): DecodedRun {
  removeCropRun(root, jobId);
  const writer = new DecodedRunWriter(path.join(root, jobId), cycleName(crop.meta.cycleTime));
  try {
    for (const step of crop.steps) writer.writeStep(step);
    writer.finish({
      cycleTimeMs: crop.meta.cycleTime.getTime(),
      request: { horizonHours, params: crop.meta.params },
      stepHours: crop.meta.steps,
      decodeMs: 0,
    });
  } catch (err) {
    // The job's folder goes too: a write that failed before the run was renamed into it leaves it empty, one that failed
    // after (finish's last fsync) a whole copy of the crop; neither is the route's yet (meshForecast keeps only a run
    // this returns).
    writer.abort();
    removeCropRun(root, jobId);
    throw err;
  }
  const { run, problem } = openDecodedRun(writer.finalDir);
  if (!run) {
    // Not the route's yet (meshForecast keeps only a run that opened): the crop written goes here, not at the worker's next start.
    removeCropRun(root, jobId);
    throw new Error(`the route's forecast crop written for the chart mesh is not usable (${problem})`);
  }
  return run;
}

/** Remove route job `jobId`'s crop from the worker's folder `root` (none: nothing to do). */
export function removeCropRun(root: string, jobId: string): void {
  fs.rmSync(path.join(root, jobId), { recursive: true, force: true });
}

/** Remove the worker's folder `root` with every crop in it: what a stop left behind (the worker's start). */
export function clearCropRuns(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
