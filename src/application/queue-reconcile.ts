import { z } from "zod";
import type { SourceFailure } from "../sources/batch.js";
import type { DiscoveredJob, DiscoveryState } from "../types.js";
import { jobSchema } from "./runner.js";

export const queuedJobSchema = z.object({
  job: jobSchema,
  // Legacy queues have no verification proof; require a fresh discovery pass.
  sourceVerification: z.enum(["verified", "unavailable"]).default("unavailable"),
});
export const rankedQueueSchema = z.object({ queue: z.array(queuedJobSchema) });

export interface QueuedJob {
  job: DiscoveredJob;
  sourceVerification: "verified" | "unavailable";
}

/** Preserve pending jobs on a source outage, but never pass them to the runner. */
export function retainUnavailableJobs(previous: QueuedJob[], failures: SourceFailure[]): QueuedJob[] {
  const unavailable = new Set(failures.map(({ source }) => `${source.provider}:${source.company}`));
  return previous.filter(({ job }) => unavailable.has(`${job.provider}:${job.company}`))
    .map(({ job }) => ({ job, sourceVerification: "unavailable" }));
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
