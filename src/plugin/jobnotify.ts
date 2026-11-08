/**
 * The notification a finished route job sends (index.ts sends it: a Signal K notification), or none. A route of its own
 * says it is ready, or failed and why; a cancelled one says nothing (the user cancelled it). A departure window's
 * departure and an ensemble set's member say nothing either: the window sends one notification for itself when it
 * ends (windows.ts windowNotification), and a set is followed on its page (GET /api/ensemble-sets/{id}), not member
 * by member. SI in the text: the client converts to its user's units.
 */

import type { Job } from './jobs';
import type { RouteSummary } from './protocol';
import { siText } from './unittext';

/** How a job ended, as the route worker said it. */
export type JobEnd = { kind: 'done'; summary: RouteSummary } | { kind: 'error'; message: string; cancelled: boolean };

export function jobNotification(
  job: Pick<Job, 'windowId' | 'ensembleSetId'>,
  end: JobEnd
): { state: 'normal' | 'alert'; message: string } | null {
  if (job.windowId || job.ensembleSetId) return null;
  if (end.kind === 'done')
    return {
      state: 'normal',
      message: `route ready: ${Math.round(end.summary.total_distance_m)} m, ${Math.round(end.summary.total_time_s)} s`,
    };
  return end.cancelled ? null : { state: 'alert', message: `route failed: ${siText(end.message)}` };
}
