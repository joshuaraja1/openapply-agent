import { describe, expect, it, vi } from "vitest";
import { DailyQuota } from "../src/application/daily-quota.js";
import { runApplicationQueue } from "../src/application/queue-runner.js";
import { RetryLedger } from "../src/application/retry-ledger.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const jobs = ["one", "two", "three"].map((id) => ({ id }) as DiscoveredJob);

describe("daily application queue", () => {
  it("reserves before execution and enforces a durable hard cap", async () => {
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const execute = vi.fn(async (job: DiscoveredJob) => { if (job.id === "one") throw new Error("portal changed"); });
    const first = await runApplicationQueue(jobs, quota, retries, () => "2026-11-24", 2, execute);
    expect(first.map((outcome) => outcome.status)).toEqual(["failed", "processed", "cap-reached"]);
    expect(execute).toHaveBeenCalledTimes(2);
    const repeated = await runApplicationQueue(jobs, quota, retries, () => "2026-11-24", 2, execute);
    expect(repeated.map((outcome) => outcome.status)).toEqual(["duplicate", "duplicate", "cap-reached"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh quota on the next date", async () => {
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    expect(await quota.reserve("2026-11-24", "one", 1)).toBe("reserved");
    expect(await quota.reserve("2026-11-25", "one", 1)).toBe("reserved");
  });

  it("allows only one reservation when two jobs race for the final slot", async () => {
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const results = await Promise.all([
      quota.reserve("2026-11-24", "one", 1), quota.reserve("2026-11-24", "two", 1),
    ]);
    expect(results.sort()).toEqual(["full", "reserved"]);
  });

  it("quarantines repeated failures and refreshes the date for each reservation", async () => {
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore(), 1);
    const dates = ["2026-11-24", "2026-11-25"];
    const first = await runApplicationQueue(jobs.slice(0, 2), quota, retries,
      () => dates.shift()!, 1, async (job) => { if (job.id === "one") throw new Error("closed"); });
    expect(first.map((entry) => entry.status)).toEqual(["failed", "processed"]);
    const second = await runApplicationQueue(jobs.slice(0, 2), quota, retries,
      () => "2026-11-26", 1, async () => {});
    expect(second.map((entry) => entry.status)).toEqual(["quarantined", "processed"]);
  });
});
