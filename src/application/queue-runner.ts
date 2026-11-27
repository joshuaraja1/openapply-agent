import type { DiscoveredJob } from "../types.js";
import { DailyQuota } from "./daily-quota.js";
import { RetryLedger } from "./retry-ledger.js";

export type QueueExecutionStatus = "submitted" | "waiting-human" | "submission-uncertain" | "blocked" | "skipped";
export interface QueueOutcome {
  jobId: string;
  status: "processed" | QueueExecutionStatus | "duplicate" | "cap-reached" | "failed" | "quarantined"
    | "provider-paused" | "resume-review";
  reason?: string;
}
export interface QueuePostingClaimResult {
  claimed: boolean;
  /** Present only for a claim created by this run; never release after browser activity. */
  releaseBeforeBrowser?: () => Promise<boolean>;
}

export async function runApplicationQueue(
  jobs: DiscoveredJob[], quota: DailyQuota, retries: RetryLedger, date: () => string, cap: number,
  execute: (job: DiscoveredJob, reservedDate: string) => Promise<void | QueueExecutionStatus
    | { status: "provider-paused" | "resume-review"; reason: string }>,
  claimPosting?: (job: DiscoveredJob) => Promise<boolean | QueuePostingClaimResult>,
  beforeDispatch?: (job: DiscoveredJob) => Promise<string | undefined>,
): Promise<QueueOutcome[]> {
  const outcomes: QueueOutcome[] = [];
  for (const job of jobs) {
    // Gate before quota or canonical claim so an existing queued job stays
    // available when its provider is later approved. A policy read error
    // fails closed without consuming an application slot.
    let pauseReason: string | undefined;
    try { pauseReason = await beforeDispatch?.(job); }
    catch { pauseReason = "Private queue provider policy is unavailable; scheduled application paused"; }
    if (pauseReason) {
      outcomes.push({ jobId: job.id, status: "provider-paused", reason: pauseReason });
      continue;
    }
    if (await retries.exhausted(job.id)) {
      outcomes.push({ jobId: job.id, status: "quarantined" });
      continue;
    }
    const runDate = date();
    // The CLI holds the workflow lease while running this queue. Check the cap
    // before recording a durable canonical posting claim: an unattempted role
    // must remain available if a different source ID finds it tomorrow.
    let releaseClaimBeforeBrowser: (() => Promise<boolean>) | undefined;
    if (claimPosting) {
      const availability = await quota.availability(runDate, job.id, cap);
      if (availability === "duplicate") {
        outcomes.push({ jobId: job.id, status: "duplicate" });
        continue;
      }
      if (availability === "full") {
        outcomes.push({ jobId: job.id, status: "cap-reached" });
        break;
      }
      const claimResult = await claimPosting(job);
      const claimed = typeof claimResult === "boolean" ? claimResult : claimResult.claimed;
      if (!claimed) {
        outcomes.push({ jobId: job.id, status: "duplicate" });
        continue;
      }
      if (typeof claimResult !== "boolean") releaseClaimBeforeBrowser = claimResult.releaseBeforeBrowser;
    }
    let reservation: Awaited<ReturnType<DailyQuota["reserve"]>>;
    try {
      reservation = await quota.reserve(runDate, job.id, cap);
    } catch (error) {
      // No browser work or quota reservation happened. A storage error must
      // not strand a claim this run created before the reservation attempt.
      await releaseClaimBeforeBrowser?.();
      throw error;
    }
    if (reservation === "full") {
      await releaseClaimBeforeBrowser?.();
      outcomes.push({ jobId: job.id, status: "cap-reached" });
      break;
    }
    if (reservation === "duplicate") {
      // A different runner may own this job's reservation and already be in
      // the browser. Retain the canonical claim to prevent another board ID
      // from entering while that attempt is in flight.
      outcomes.push({ jobId: job.id, status: "duplicate" });
      continue;
    }
    try {
      const status = await execute(job, runDate);
      if (typeof status === "object" && ["provider-paused", "resume-review"].includes(status.status)) {
        // This status is returned only by the pre-browser policy check. A
        // newly created canonical claim must not strand a rediscovered job ID.
        await quota.releaseBeforeBrowser(runDate, job.id);
        await releaseClaimBeforeBrowser?.();
      }
      outcomes.push(typeof status === "object"
        ? { jobId: job.id, ...status } : { jobId: job.id, status: status ?? "processed" });
    } catch {
      await retries.fail(job.id);
      outcomes.push({ jobId: job.id, status: "failed" });
    }
  }
  return outcomes;
}
