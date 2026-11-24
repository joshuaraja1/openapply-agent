import type { DiscoveredJob } from "../types.js";
import { DailyQuota } from "./daily-quota.js";

export interface QueueOutcome { jobId: string; status: "processed" | "duplicate" | "cap-reached" | "failed" }

export async function runApplicationQueue(
  jobs: DiscoveredJob[], quota: DailyQuota, date: string, cap: number,
  execute: (job: DiscoveredJob) => Promise<void>,
): Promise<QueueOutcome[]> {
  const outcomes: QueueOutcome[] = [];
  for (const job of jobs) {
    const reservation = await quota.reserve(date, job.id, cap);
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
      outcomes.push({ jobId: job.id, status: "failed" });
    }
  }
  return outcomes;
}
