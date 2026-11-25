import type { JobSource } from "../config.js";
import type { SourceFailure } from "../sources/batch.js";
import type { DiscoveredJob, DiscoveryState } from "../types.js";

export interface QueuedJob {
  job: DiscoveredJob;
  source?: JobSource | undefined;
  sourceVerification: "verified" | "unavailable";
}

/** Preserve pending jobs on a source outage, but never pass them to the runner. */
export function retainUnavailableJobs(previous: QueuedJob[], failures: SourceFailure[]): QueuedJob[] {
  const unavailable = new Set(failures.map(({ source }) => `${source.provider}:${source.company}`));
  return previous.filter(({ job }) => unavailable.has(`${job.provider}:${job.company}`))
    .map((entry) => ({ ...entry, sourceVerification: "unavailable" }));
}

export function runnableJobs(queue: QueuedJob[]): DiscoveredJob[] {
  return queue.filter((entry) => entry.sourceVerification === "verified").map((entry) => entry.job);
}

/** Reported means queued, not submitted. Dropped entries may be rediscovered later. */
export function reconcileReportedQueue(
  state: DiscoveryState, previouslyQueued: ReadonlySet<string>, nextQueued: ReadonlySet<string>,
): void {
  for (const id of previouslyQueued) {
    if (!nextQueued.has(id) && state.jobs[id]) delete state.jobs[id].reportedAt;
  }
}
