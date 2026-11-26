import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyQuota } from "../src/application/daily-quota.js";
import { currentProviderPauseReason, providerPauseReason } from "../src/application/provider-gate.js";
import { PostingClaimLedger, type PostingClaim } from "../src/application/posting-claims.js";
import { queueRunnerConfigSchema } from "../src/application/queue-config.js";
import { runApplicationQueue } from "../src/application/queue-runner.js";
import { RetryLedger } from "../src/application/retry-ledger.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";
import type { DiscoveredJob } from "../src/types.js";

const root = join(tmpdir(), "openapply-provider-gate-fixture");
const config = { version: 1, queuePath: join(root, "queue.json"), candidatePath: join(root, "candidate.json"),
  preferencesPath: join(root, "preferences.json"), discoveryInputPath: join(root, "discovery.json"),
  discoveryStatePath: join(root, "discovery-state.json"), browserRuntime: "owned",
  overleafProjectUrl: "https://www.overleaf.com/project/000000000000000000000000",
  outputDirectory: join(root, "artifacts") };

describe("scheduled provider gate", () => {
  it("defaults legacy queue policy to deny and validates explicit providers", () => {
    const parsed = queueRunnerConfigSchema.parse(config);
    expect(parsed.queueProviderAllowlist).toEqual([]);
    expect(providerPauseReason("ashby", parsed.queueProviderAllowlist)).toContain("paused");
    expect(queueRunnerConfigSchema.parse({ ...config, queueProviderAllowlist: ["ashby"] })
      .queueProviderAllowlist).toEqual(["ashby"]);
    expect(queueRunnerConfigSchema.safeParse({ ...config, queueProviderAllowlist: ["unknown"] }).success)
      .toBe(false);
  });

  it("leaves a denied queued job unclaimed and unreserved until its provider is enabled", async () => {
    const job = { id: "ashby:example:123456", provider: "ashby" } as DiscoveredJob;
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const execute = vi.fn(async () => "submitted" as const);
    const claim = vi.fn(async () => true);
    const deny = async (queued: DiscoveredJob) => providerPauseReason(queued.provider, []);
    expect(await runApplicationQueue([job], quota, retries, () => "2026-11-26", 1,
      execute, claim, deny)).toEqual([{ jobId: job.id, status: "provider-paused",
      reason: expect.stringContaining("ashby") }]);
    expect(execute).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    const allow = async (queued: DiscoveredJob) => providerPauseReason(queued.provider, ["ashby"]);
    expect(await runApplicationQueue([job], quota, retries, () => "2026-11-26", 1,
      execute, claim, allow)).toEqual([{ jobId: job.id, status: "submitted" }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  });

  it("rechecks the private policy before dispatch and pauses after a mid-run edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-provider-policy-"));
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(directory);
      const path = join(directory, "queue-config.json");
      const initial = queueRunnerConfigSchema.parse({ ...config, queueProviderAllowlist: ["ashby"] });
      await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
      if (process.platform === "win32") await secureWindowsPrivatePath(path);
      expect(await currentProviderPauseReason(path, initial, "ashby")).toBeUndefined();
      await writeFile(path, JSON.stringify({ ...initial, queueProviderAllowlist: [] }), { mode: 0o600 });
      if (process.platform === "win32") await secureWindowsPrivatePath(path);
      expect(await currentProviderPauseReason(path, initial, "ashby"))
        .toContain("changed during this run");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, process.platform === "win32" ? 120_000 : 10_000);

  it("releases a new claim and quota after pre-browser revocation so a new board ID can retry", async () => {
    const url = "https://jobs.example.com/apply/123456?source=board";
    const job = { id: "ashby:example:123456", provider: "ashby", applicationUrl: url } as DiscoveredJob;
    const rediscovered = { ...job, id: "ashby:example:replacement",
      applicationUrl: "https://jobs.example.com/apply/123456" };
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const claims = new PostingClaimLedger(new MemoryApplicationStateStore<PostingClaim>());
    const browserAction = vi.fn();
    let revoked = false;
    const claim = async (queued: DiscoveredJob) => {
      const receipt = await claims.claimWithReceipt(queued.id, queued.applicationUrl);
      const createdVersion = receipt.createdVersion;
      revoked = true;
      return { claimed: receipt.status === "claimed",
        ...(createdVersion !== undefined ? { releaseBeforeBrowser: async () =>
          await claims.releaseNewClaim(queued.id, queued.applicationUrl, createdVersion) } : {}) };
    };
    const outcomes = await runApplicationQueue([job], quota, retries, () => "2026-11-26", 1,
      async () => {
        if (revoked) {
          return { status: "provider-paused" as const, reason: "Policy changed after claim" };
        }
        browserAction();
        return "submitted" as const;
      }, claim, async () => undefined);
    expect(outcomes).toEqual([{ jobId: job.id, status: "provider-paused",
      reason: "Policy changed after claim" }]);
    expect(browserAction).not.toHaveBeenCalled();
    expect(await quota.availability("2026-11-26", job.id, 1)).toBe("available");
    revoked = false;
    expect(await runApplicationQueue([rediscovered], quota, retries, () => "2026-11-26", 1,
      async () => { browserAction(); return "submitted" as const; }, claim, async () => undefined))
      .toEqual([{ jobId: rediscovered.id, status: "submitted" }]);
    expect(browserAction).toHaveBeenCalledOnce();
    expect(await claims.claim("ashby:example:third", rediscovered.applicationUrl)).toBe("duplicate");
  });
});
