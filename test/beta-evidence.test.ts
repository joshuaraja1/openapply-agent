import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { recordConsent, recordObservation, summarizeBetaEvidence, sweepBetaEvidence, withdrawConsent,
  type BetaEvidence } from "../src/application/beta-evidence.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";

const consent = { kind: "consent", participantId: "candidate-1",
  approvedProviders: ["greenhouse"], dailyCap: 2, automaticSubmission: true,
  monitoringAccepted: true, browserSessionApproved: true, candidateAcknowledged: true,
  retentionDays: 30 };
const input = { kind: "observation", participantId: "candidate-1", runId: "run-1",
  jobId: "greenhouse:example:123", provider: "greenhouse", os: "macos",
  outcome: "submitted", failureCategory: "none", retryCount: 0, crashCount: 0,
  stageLatencyMs: { application: 2450, recovery: 0 } };
const checkpoint: ApplicationCheckpoint = { jobId: "greenhouse:example:123", officialUrl: "https://boards.greenhouse.io/example/jobs/123",
  stage: "submitted", confirmation: "Application received for greenhouse:example:123, jane@example.com",
  createdAt: "2026-11-26T12:00:30.000Z", updatedAt: "2026-11-26T12:01:00.000Z" };
const { confirmation: _confirmation, ...withoutConfirmation } = checkpoint;
const observedAt = new Date("2026-11-26T12:01:01.000Z");

describe("private beta evidence", () => {
  it("requires active opt-in and an exact confirmed checkpoint; summary omits private values", async () => {
    const store = new MemoryApplicationStateStore<BetaEvidence>();
    await expect(recordObservation(store, input, checkpoint, observedAt)).rejects.toThrow("consent");
    await recordConsent(store, consent, new Date("2026-11-26T12:00:00.000Z"));
    const saved = await recordObservation(store, input, checkpoint, observedAt);
    expect(saved.officialUrlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(saved)).not.toContain("jane@example.com");
    expect(JSON.stringify(saved)).not.toContain("jobs.example");
    const summary = JSON.stringify(summarizeBetaEvidence([saved]));
    expect(summary).toContain('"confirmed":1');
    expect(summary).not.toContain("greenhouse:example:123");
    expect(summary).not.toContain("candidate-1");
    await expect(recordObservation(store, input, checkpoint, observedAt)).rejects.toThrow("already exists");
    await expect(recordObservation(store, { ...input, runId: "run-2" },
      { ...checkpoint, jobId: "greenhouse:example:other" }, observedAt)).rejects.toThrow("exact application");
    await expect(recordObservation(store, { ...input, runId: "run-3" },
      withoutConfirmation, observedAt)).rejects.toThrow("confirmed job-bound");
    await expect(recordObservation(store, { ...input, runId: "run-4", provider: "lever" },
      checkpoint, observedAt)).rejects.toThrow("consent");
    await expect(recordObservation(store, { ...input, runId: "run-5" },
      { ...checkpoint, officialUrl: "https://jobs.lever.co/example/123" }, observedAt))
      .rejects.toThrow("provider does not match");
    const { createdAt: _createdAt, ...legacyCheckpoint } = checkpoint;
    await expect(recordObservation(store, { ...input, runId: "run-6" }, legacyCheckpoint, observedAt))
      .rejects.toThrow("no trusted creation time");
    await expect(recordObservation(store, { ...input, runId: "run-7" },
      { ...checkpoint, createdAt: "2026-11-26T11:59:59.000Z" }, observedAt))
      .rejects.toThrow("before beta consent");
    await expect(recordConsent(store, { ...consent, recordedAt: "2000-01-01T00:00:00.000Z" }))
      .rejects.toThrow();
  });

  it("records handoff and crash counts and refuses withdrawn consent", async () => {
    const store = new MemoryApplicationStateStore<BetaEvidence>();
    await recordConsent(store, consent, new Date("2026-11-26T12:00:00.000Z"));
    const handoff = await recordObservation(store, { ...input, outcome: "waiting-human",
      failureCategory: "human-question", crashCount: 1 },
    { ...withoutConfirmation, stage: "waiting-human" }, observedAt);
    expect(summarizeBetaEvidence([handoff]).providerCounts.greenhouse)
      .toEqual({ total: 1, confirmed: 0, handoffs: 1, uncertain: 0, crashes: 1,
        retries: 0, failures: { "human-question": 1 },
        latencyMs: { application: { samples: 1, median: 2450, p95: 2450 },
          recovery: { samples: 1, median: 0, p95: 0 } } });
    await withdrawConsent(store, "candidate-1", new Date("2026-11-26T12:02:00.000Z"));
    await expect(recordObservation(store, { ...input, runId: "run-2" }, checkpoint, observedAt))
      .rejects.toThrow("consent");
    await expect(recordConsent(store, consent)).rejects.toThrow("already exists");
  });

  it("uses the local encrypted ledger to sweep expired and withdrawn observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-beta-evidence-"));
    try {
      const privateDir = join(root, "private");
      await ensurePrivateDirectory(privateDir);
      const store = new EncryptedApplicationStateStore<BetaEvidence>(join(privateDir, "beta.enc.json"), randomBytes(32));
      await recordConsent(store, { ...consent, retentionDays: 1 }, new Date("2026-11-26T12:00:00.000Z"));
      await recordObservation(store, input, checkpoint, observedAt);
      expect(await sweepBetaEvidence(store, new Date("2026-11-26T13:00:00.000Z"))).toBe(0);
      await expect(recordObservation(store, { ...input, runId: "run-2" }, checkpoint,
        new Date("2026-11-27T12:01:00.000Z"))).rejects.toThrow("consent");
      await withdrawConsent(store, "candidate-1", new Date("2026-11-26T14:00:00.000Z"));
      expect(await sweepBetaEvidence(store, new Date("2026-11-26T14:00:00.000Z"))).toBe(1);
      expect((await store.snapshotRecords()).filter((row) => row.state?.kind === "observation")).toHaveLength(0);
      expect(await sweepBetaEvidence(store, new Date("2026-11-27T12:00:00.000Z"))).toBe(0);
      expect((await store.snapshotRecords()).filter((row) => row.state !== undefined).map((row) => row.state))
        .toEqual([{ kind: "revocation", participantId: "candidate-1",
          withdrawnAt: "2026-11-26T14:00:00.000Z" }]);
      await expect(recordConsent(store, { ...consent, retentionDays: 1 },
        new Date("2026-11-28T12:00:00.000Z"))).rejects.toThrow("already exists");
      await recordConsent(store, { ...consent, participantId: "candidate-2", retentionDays: 1 },
        new Date("2026-11-28T12:00:00.000Z"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
