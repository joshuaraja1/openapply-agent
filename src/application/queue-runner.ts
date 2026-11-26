import type { DiscoveredJob } from "../types.js";
import { DailyQuota } from "./daily-quota.js";
import { RetryLedger } from "./retry-ledger.js";

export type QueueExecutionStatus = "submitted" | "waiting-human" | "submission-uncertain" | "blocked" | "skipped";
export interface QueueOutcome {
  jobId: string;
  status: "processed" | QueueExecutionStatus | "duplicate" | "cap-reached" | "failed" | "quarantined";
}

export async function runApplicationQueue(
  jobs: DiscoveredJob[], quota: DailyQuota, retries: RetryLedger, date: () => string, cap: number,
  execute: (job: DiscoveredJob) => Promise<void | QueueExecutionStatus>,
  claimPosting?: (job: DiscoveredJob) => Promise<boolean>,
): Promise<QueueOutcome[]> {
  const outcomes: QueueOutcome[] = [];
  for (const job of jobs) {
    if (await retries.exhausted(job.id)) {
      outcomes.push({ jobId: job.id, status: "quarantined" });
      continue;
    }
    const runDate = date();
    // The CLI holds the workflow lease while running this queue. Check the cap
    // before recording a durable canonical posting claim: an unattempted role
    // must remain available if a different source ID finds it tomorrow.
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
      if (!await claimPosting(job)) {
        outcomes.push({ jobId: job.id, status: "duplicate" });
        continue;
      }
    }
    const reservation = await quota.reserve(runDate, job.id, cap);
    if (reservation === "full") {
      outcomes.push({ jobId: job.id, status: "cap-reached" });
      break;
    }
    if (reservation === "duplicate") {
      outcomes.push({ jobId: job.id, status: "duplicate" });
      continue;
    }
    try {
      const status = await execute(job);
      outcomes.push({ jobId: job.id, status: status ?? "processed" });
    } catch {
      await retries.fail(job.id);
      outcomes.push({ jobId: job.id, status: "failed" });
    }
  }
  return outcomes;
}
