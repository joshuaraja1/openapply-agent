import { describe, expect, it, vi } from "vitest";
import { DailyQuota } from "../src/application/daily-quota.js";
import { canonicalPostingUrl, PostingClaimLedger, type PostingClaim } from "../src/application/posting-claims.js";
import { runApplicationQueue } from "../src/application/queue-runner.js";
import { RetryLedger } from "../src/application/retry-ledger.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

describe("durable official posting claims", () => {
  const url = "https://jobs.example.com/apply/123456?gh_jid=123456&source=board&utm_source=feed";

  it("normalizes referral parameters but preserves requisition identity", () => {
    expect(canonicalPostingUrl(url)).toBe("https://jobs.example.com/apply/123456?gh_jid=123456");
    expect(canonicalPostingUrl("https://jobs.example.com/apply/123456?gh_jid=654321"))
      .not.toBe(canonicalPostingUrl(url));
    expect(() => canonicalPostingUrl("http://jobs.example.com/apply/123456")).toThrow("HTTPS");
  });

  it("claims once across board IDs, restarts, and competing workers", async () => {
    const store = new MemoryApplicationStateStore<PostingClaim>();
    const first = new PostingClaimLedger(store);
    expect(await first.claim("board-a", url)).toBe("claimed");
    const restarted = new PostingClaimLedger(store);
    expect(await restarted.claim("board-a", url)).toBe("claimed");
    expect(await restarted.claim("board-b", "https://jobs.example.com/apply/123456?gh_jid=123456"))
      .toBe("duplicate");
    const racing = await Promise.all([
      first.claim("board-c", "https://jobs.example.com/apply/987654"),
      restarted.claim("board-d", "https://jobs.example.com/apply/987654"),
    ]);
    expect(racing.sort()).toEqual(["claimed", "duplicate"]);
  });

  it("releases only a newly created unchanged claim before any attempt", async () => {
    const claims = new PostingClaimLedger(new MemoryApplicationStateStore<PostingClaim>());
    const created = await claims.claimWithReceipt("board-a", url);
    expect(created.status).toBe("claimed");
    expect(created.createdVersion).toEqual(expect.any(Number));
    expect(await claims.claimWithReceipt("board-a", url)).toEqual({ status: "claimed" });
    expect(await claims.releaseNewClaim("board-b", url, created.createdVersion!)).toBe(false);
    expect(await claims.releaseNewClaim("board-a", url, created.createdVersion! + 1)).toBe(false);
    expect(await claims.releaseNewClaim("board-a", url, created.createdVersion!)).toBe(true);
    expect(await claims.claim("board-b", url)).toBe("claimed");
    // A stale release receipt cannot remove the replacement claim.
    expect(await claims.releaseNewClaim("board-a", url, created.createdVersion!)).toBe(false);
    expect(await claims.claim("board-c", url)).toBe("duplicate");
  });

  it("skips a cross-source duplicate before consuming the daily quota", async () => {
    const claims = new PostingClaimLedger(new MemoryApplicationStateStore<PostingClaim>());
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const jobs = ["first", "duplicate", "other"].map((id, index) => ({ id,
      applicationUrl: index < 2 ? url : "https://jobs.example.com/apply/987654" }) as DiscoveredJob);
    const execute = vi.fn(async () => {});
    const outcomes = await runApplicationQueue(jobs, quota, retries, () => "2026-11-24", 2,
      execute, async (job) => await claims.claim(job.id, job.applicationUrl) === "claimed");
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["processed", "duplicate", "processed"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not claim a posting when the daily cap prevents an attempt", async () => {
    const claims = new PostingClaimLedger(new MemoryApplicationStateStore<PostingClaim>());
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const first = { id: "first", applicationUrl: url } as DiscoveredJob;
    const capped = { id: "board-a", applicationUrl: "https://jobs.example.com/apply/987654" } as DiscoveredJob;
    const samePostingTomorrow = { ...capped, id: "board-b" };
    const execute = vi.fn(async () => {});
    const claim = async (job: DiscoveredJob) => await claims.claim(job.id, job.applicationUrl) === "claimed";

    expect((await runApplicationQueue([first, capped], quota, retries,
      () => "2026-11-24", 1, execute, claim)).map((result) => result.status))
      .toEqual(["processed", "cap-reached"]);
    expect((await runApplicationQueue([samePostingTomorrow], quota, retries,
      () => "2026-11-25", 1, execute, claim)).map((result) => result.status))
      .toEqual(["processed"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
