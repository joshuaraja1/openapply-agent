import type { JobSource } from "../config.js";
import type { SourceFailure } from "../sources/batch.js";
import type { DiscoveredJob, DiscoveryState } from "../types.js";

export interface QueuedJob {
  job: DiscoveredJob;
  source?: JobSource | undefined;
  sourceVerification: "verified" | "unavailable";
}

/** Preserve pending jobs on a source outage, but never pass them to the runner. */
export function retainUnavailableJobs(
  previous: QueuedJob[], failures: SourceFailure[], freshlyVerifiedIds: ReadonlySet<string> = new Set(),
): QueuedJob[] {
  const unavailable = new Set(failures.map(({ source }) => `${source.provider}:${source.company}`));
  return previous.filter(({ job }) => unavailable.has(`${job.provider}:${job.company}`)
    && !freshlyVerifiedIds.has(job.id))
    .map((entry) => ({ ...entry, sourceVerification: "unavailable" }));
}

export function runnableEntries<T extends QueuedJob>(queue: T[]): T[] {
  return queue.filter((entry) => entry.sourceVerification === "verified");
}

/** Reported means queued, not submitted. Dropped entries may be rediscovered later. */
export function reconcileReportedQueue(
  state: DiscoveryState, previouslyQueued: ReadonlySet<string>, nextQueued: ReadonlySet<string>,
): void {
  for (const id of previouslyQueued) {
    if (!nextQueued.has(id) && state.jobs[id]) delete state.jobs[id].reportedAt;
  }
}
