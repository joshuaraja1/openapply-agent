import type { DiscoveryState } from "../types.js";

/** Reported means queued, not submitted. Dropped entries may be rediscovered later. */
export function reconcileReportedQueue(
  state: DiscoveryState, previouslyQueued: ReadonlySet<string>, nextQueued: ReadonlySet<string>,
): void {
  for (const id of previouslyQueued) {
    if (!nextQueued.has(id) && state.jobs[id]) delete state.jobs[id].reportedAt;
  }
}
