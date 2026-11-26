import { describe, expect, it } from "vitest";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import { recordConsent, recordObservation, summarizeBetaEvidence,
  type BetaEvidence } from "../src/application/beta-evidence.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";

const consent = { kind: "consent", participantId: "candidate-1", recordedAt: "2026-11-26T12:00:00.000Z",
  approvedProviders: ["greenhouse"], dailyCap: 2, automaticSubmission: true,
  monitoringAccepted: true, browserSessionApproved: true, candidateAcknowledged: true,
  retentionDays: 30 };
const input = { kind: "observation", participantId: "candidate-1", runId: "run-1",
  jobId: "gh:123", provider: "greenhouse", os: "macos", recordedAt: "2026-11-26T12:01:00.000Z",
  outcome: "submitted", failureCategory: "none", retryCount: 0, crashCount: 0,
  stageLatencyMs: { application: 2450, recovery: 0 } };
const checkpoint: ApplicationCheckpoint = { jobId: "gh:123", officialUrl: "https://jobs.example/apply/123",
  stage: "submitted", confirmation: "Application received for gh:123, jane@example.com",
  updatedAt: "2026-11-26T12:01:00.000Z" };
const { confirmation: _confirmation, ...withoutConfirmation } = checkpoint;

describe("private beta evidence", () => {
  it("requires active opt-in and an exact confirmed checkpoint; summary omits private values", async () => {
    const store = new MemoryApplicationStateStore<BetaEvidence>();
    await expect(recordObservation(store, input, checkpoint)).rejects.toThrow("consent");
    await recordConsent(store, consent);
    const saved = await recordObservation(store, input, checkpoint);
    expect(saved.officialUrlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(saved)).not.toContain("jane@example.com");
    expect(JSON.stringify(saved)).not.toContain("jobs.example");
    const summary = JSON.stringify(summarizeBetaEvidence([saved]));
    expect(summary).toContain('"confirmed":1');
    expect(summary).not.toContain("gh:123");
    expect(summary).not.toContain("candidate-1");
    await expect(recordObservation(store, input, checkpoint)).rejects.toThrow("already exists");
    await expect(recordObservation(store, { ...input, runId: "run-2" },
      { ...checkpoint, jobId: "gh:other" })).rejects.toThrow("exact application");
    await expect(recordObservation(store, { ...input, runId: "run-3" },
      withoutConfirmation)).rejects.toThrow("confirmed job-bound");
    await expect(recordObservation(store, { ...input, runId: "run-4", provider: "lever" },
      checkpoint)).rejects.toThrow("consent");
  });

  it("records handoff and crash counts and refuses withdrawn consent", async () => {
    const store = new MemoryApplicationStateStore<BetaEvidence>();
    await recordConsent(store, consent);
    const handoff = await recordObservation(store, { ...input, outcome: "waiting-human",
      failureCategory: "human-question", crashCount: 1 },
    { ...withoutConfirmation, stage: "waiting-human" });
    expect(summarizeBetaEvidence([handoff]).providerCounts.greenhouse)
      .toEqual({ total: 1, confirmed: 0, handoffs: 1, uncertain: 0, crashes: 1,
        retries: 0, failures: { "human-question": 1 },
        latencyMs: { application: { samples: 1, median: 2450, p95: 2450 },
          recovery: { samples: 1, median: 0, p95: 0 } } });
    await recordConsent(store, { ...consent, withdrawnAt: "2026-11-26T12:02:00.000Z" });
    await expect(recordObservation(store, { ...input, runId: "run-2" }, checkpoint))
      .rejects.toThrow("consent");
    await expect(recordConsent(store, consent)).rejects.toThrow("immutable");
  });
});
