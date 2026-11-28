import { describe, expect, it, vi } from "vitest";
import { handleQueuedApplication, type CloudRunPorts } from "../src/cloud/queued-run.js";
import { HostedSubmissionBlocked } from "../src/cloud/hosted-submission-blocked.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const job = { provider: "greenhouse", employerId: "acme", requisitionId: "109" };
const body = encodeCloudRunEnvelope({ version: 1, candidateId, runId,
  kind: "apply", scheduledAt: "2026-11-26T20:00:00Z" }).body;
const paid = { kind: "free-grant", subjectId: candidateId, grantId: "grant-test",
  approvedBy: "admin-test", startsAt: "2020-01-01T00:00:00Z",
  endsAt: "2099-01-01T00:00:00Z", revokedAt: null };

function fixture() {
  const events: string[] = [];
  let consent = true;
  let paidAccess = true;
  const browserState = new TextEncoder().encode(JSON.stringify({ cookies: [], origins: [] }));
  const blocked = new HostedSubmissionBlocked({ blockerCodes: ["unknown-required-field"],
    formUrl: "https://boards.greenhouse.io/acme/jobs/109", browserState,
    resumeSha256: "a".repeat(64), job });
  const ports: CloudRunPorts = {
    dispatch: { async readStatus() { return "launched"; } },
    billing: { async loadEntitlements() { return paidAccess ? [paid] : []; } },
    authorization: { async ownsRun() { return true; },
      async hasCurrentConsent() { return consent; } },
    journal: { async acquireLease() { events.push("lease"); return "lease-token"; },
      async renewLease() { events.push("renew"); return true; },
      async releaseLease() { events.push("release"); },
      async readSubmission() { return { status: "not_started" }; },
      async beginSubmission() { events.push("intent"); return null; },
      async markUncertain() { events.push("uncertain"); },
      async confirmAfterVerification() { events.push("confirm"); return false; } },
    runRecords: { async loadIdentity() { return { subjectId: candidateId,
      consentVersion: 1, job }; }, async loadProfileArtifactId() { return runId; } },
    vault: { async restoreToPrivateTemp() { return { path: "/private/profile",
      async cleanup() { events.push("cleanup"); } }; },
      async put() { events.push("receipt"); } },
    application: { async prepare() { events.push("prepare"); throw blocked; } },
    handoff: { async save(_token, state) { events.push("saved");
      expect(state.job).toEqual(job);
      expect(state.browserState).toEqual({ cookies: [], origins: [] });
      expect(state.blockerCodes).toEqual(["unknown-required-field"]);
    } },
    receiptVerifier: { async verify() { events.push("verify"); return false; } },
    queue: { async acknowledge() { events.push("ack-confirmed"); },
      async acknowledgeHandoff() { events.push("ack-handoff"); } },
  };
  return { ports, events, browserState,
    revokeConsent() { consent = false; },
    revokePayment() { paidAccess = false; } };
}

describe("cloud pre-submit handoff", () => {
  it("acknowledges a redelivered terminal handoff without opening the browser", async () => {
    const h = fixture();
    h.ports.dispatch = { async readStatus() { return "needs_human"; } };
    expect(await handleQueuedApplication({ body, receiptHandle: "sqs-receipt" }, h.ports))
      .toBe("needs_human");
    expect(h.events).toEqual(["ack-handoff"]);
    expect(h.browserState.every(byte => byte !== 0)).toBe(true);
  });
  it("rechecks a handoff that becomes terminal while this task acquires its lease", async () => {
    const h = fixture();
    let reads = 0;
    h.ports.dispatch = { async readStatus() {
      reads++;
      return reads === 1 ? "launched" : "needs_human";
    } };
    expect(await handleQueuedApplication({ body, receiptHandle: "sqs-receipt" }, h.ports))
      .toBe("needs_human");
    expect(h.events).toEqual(["lease", "release", "ack-handoff"]);
    expect(reads).toBe(2);
  });
  it("saves encrypted handoff before terminal queue acknowledgment, with no submit intent", async () => {
    const h = fixture();
    expect(await handleQueuedApplication({ body, receiptHandle: "sqs-receipt" }, h.ports))
      .toBe("needs_human");
    expect(h.events.indexOf("saved")).toBeLessThan(h.events.indexOf("ack-handoff"));
    expect(h.events).not.toContain("intent");
    expect(h.events).not.toContain("receipt");
    expect(h.browserState.every(byte => byte === 0)).toBe(true);
  });

  it("does not checkpoint or acknowledge if consent changes during preparation", async () => {
    const h = fixture();
    h.ports.application.prepare = async () => { h.revokeConsent();
      throw new HostedSubmissionBlocked({ blockerCodes: ["unknown-required-field"],
        formUrl: "https://boards.greenhouse.io/acme/jobs/109",
        browserState: h.browserState, resumeSha256: "a".repeat(64), job }); };
    expect(await handleQueuedApplication({ body, receiptHandle: "sqs-receipt" }, h.ports))
      .toBe("retry");
    expect(h.events).not.toContain("saved");
    expect(h.events).not.toContain("ack-handoff");
    expect(h.browserState.every(byte => byte === 0)).toBe(true);
  });

  it("does not checkpoint when payment expires during preparation", async () => {
    const h = fixture();
    h.ports.application.prepare = async () => { h.revokePayment();
      throw new HostedSubmissionBlocked({ blockerCodes: ["unknown-required-field"],
        formUrl: "https://boards.greenhouse.io/acme/jobs/109",
        browserState: h.browserState, resumeSha256: "a".repeat(64), job }); };
    expect(await handleQueuedApplication({ body, receiptHandle: "sqs-receipt" }, h.ports))
      .toBe("retry");
    expect(h.events).not.toContain("saved");
    expect(h.events).not.toContain("ack-handoff");
    expect(h.browserState.every(byte => byte === 0)).toBe(true);
  });

  it("fails closed when no durable handoff store is wired", async () => {
    const h = fixture();
    delete h.ports.handoff;
    expect(await handleQueuedApplication({ body, receiptHandle: "sqs-receipt" }, h.ports))
      .toBe("retry");
    expect(h.events).not.toContain("ack-handoff");
    expect(h.events).not.toContain("intent");
    expect(h.browserState.every(byte => byte === 0)).toBe(true);
  });

  it("keeps the task unacknowledged when durable storage fails", async () => {
    const h = fixture();
    h.ports.handoff!.save = vi.fn().mockRejectedValue(new Error("broker failed"));
    await expect(handleQueuedApplication({ body, receiptHandle: "sqs-receipt" }, h.ports))
      .rejects.toThrow("broker failed");
    expect(h.events).not.toContain("ack-handoff");
    expect(h.browserState.every(byte => byte === 0)).toBe(true);
  });
});
