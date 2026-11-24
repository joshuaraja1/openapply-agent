import { describe, expect, it, vi } from "vitest";
import { DailyQuota } from "../src/application/daily-quota.js";
import { runApplicationQueue } from "../src/application/queue-runner.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const jobs = ["one", "two", "three"].map((id) => ({ id }) as DiscoveredJob);

describe("daily application queue", () => {
  it("reserves before execution and enforces a durable hard cap", async () => {
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const execute = vi.fn(async (job: DiscoveredJob) => { if (job.id === "one") throw new Error("portal changed"); });
    const first = await runApplicationQueue(jobs, quota, "2026-11-24", 2, execute);
    expect(first.map((outcome) => outcome.status)).toEqual(["failed", "processed", "cap-reached"]);
    expect(execute).toHaveBeenCalledTimes(2);
    const repeated = await runApplicationQueue(jobs, quota, "2026-11-24", 2, execute);
    expect(repeated.map((outcome) => outcome.status)).toEqual(["duplicate", "duplicate", "cap-reached"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh quota on the next date", async () => {
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    expect(await quota.reserve("2026-11-24", "one", 1)).toBe("reserved");
    expect(await quota.reserve("2026-11-25", "one", 1)).toBe("reserved");
  });
});
