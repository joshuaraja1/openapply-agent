import type { DiscoveredJob } from "../types.js";
import { DailyQuota } from "./daily-quota.js";
import { RetryLedger } from "./retry-ledger.js";

export interface QueueOutcome { jobId: string; status: "processed" | "duplicate" | "cap-reached" | "failed" | "quarantined" }

export async function runApplicationQueue(
  jobs: DiscoveredJob[], quota: DailyQuota, retries: RetryLedger, date: () => string, cap: number,
  execute: (job: DiscoveredJob) => Promise<void>,
): Promise<QueueOutcome[]> {
  const outcomes: QueueOutcome[] = [];
  for (const job of jobs) {
    if (await retries.exhausted(job.id)) {
      outcomes.push({ jobId: job.id, status: "quarantined" });
      continue;
    }
    const reservation = await quota.reserve(date(), job.id, cap);
    if (reservation === "full") {
      outcomes.push({ jobId: job.id, status: "cap-reached" });
      break;
    }
    if (reservation === "duplicate") {
      outcomes.push({ jobId: job.id, status: "duplicate" });
      continue;
    }
    try {
      await execute(job);
      outcomes.push({ jobId: job.id, status: "processed" });
    } catch {
      await retries.fail(job.id);
      outcomes.push({ jobId: job.id, status: "failed" });
    }
  }
  return outcomes;
}
