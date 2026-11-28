import { describe, expect, it } from "vitest";
import { handleQueuedApplication, type CloudRunPorts } from "../src/cloud/queued-run.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const receiptId = "8c231a91-c73b-4e2d-b085-5d5ebf302311";
const job = { provider: "synthetic", employerId: "fixture", requisitionId: "109" };
const wrongJob = { ...job, requisitionId: "110" };
const body = encodeCloudRunEnvelope({ version: 1, candidateId, runId, kind: "apply",
  scheduledAt: "2026-11-26T20:00:00Z" }).body;
const paid = { kind: "free-grant", subjectId: candidateId, grantId: "stress-grant",
  approvedBy: "synthetic-test", startsAt: "2020-01-01T00:00:00Z",
  endsAt: "2099-01-01T00:00:00Z", revokedAt: null };

type Fault = "before_intent" | "after_intent" | "after_click" | "after_receipt_store"
  | "after_confirmation";

/** The journal and receipt bytes persist across two independent handler calls.
 * Only the browser object is reconstructed on redelivery. */
function harness(fault: Fault, receiptJob = job) {
  let firstAttempt = true;
  let status: "not_started" | "needs_reconciliation" | "confirmed" = "not_started";
  let clicks = 0;
  let profileRestores = 0;
  let confirmations = 0;
  let acknowledgments = 0;
  let storedReceipt: Uint8Array | undefined;
  const ports: CloudRunPorts = {
    billing: { async loadEntitlements() { return [paid]; } },
    authorization: { async ownsRun() { return true; },
      async hasCurrentConsent() { return true; } },
    dispatch: { async readStatus() { return "launched"; } },
    journal: {
      async acquireLease() { return runId; },
      async renewLease() { return true; },
      async releaseLease() {},
      async readSubmission() { return status === "not_started" ? { status }
        : { status, receiptArtifactId: receiptId }; },
      async beginSubmission() {
        if (status !== "not_started") return null;
        status = "needs_reconciliation";
        return receiptId;
      },
      async markUncertain() { status = "needs_reconciliation"; },
      async confirmAfterVerification() {
        if (!storedReceipt || status !== "needs_reconciliation") return false;
        status = "confirmed";
        confirmations++;
        return true;
      },
    },
    runRecords: { async loadIdentity() { return { subjectId: candidateId,
      consentVersion: 1, job }; }, async loadProfileArtifactId() { return runId; } },
    vault: {
      async restoreToPrivateTemp() { profileRestores++;
        return { path: "/private/synthetic-profile", async cleanup() {} }; },
      async put(_candidateId, _runId, _leaseToken, _artifactId, bytes) {
        storedReceipt = bytes;
        if (firstAttempt && fault === "after_receipt_store") {
          throw new Error("process stopped after encrypted receipt write");
        }
      },
    },
    application: { async prepare() {
      if (firstAttempt && fault === "before_intent") {
        throw new Error("process stopped while preparing form");
      }
      return { async submitOnce(beforeClick: () => Promise<boolean>) {
        if (!await beforeClick()) return null;
        clicks++;
        if (firstAttempt && fault === "after_click") {
          throw new Error("process stopped after employer Submit");
        }
        return { evidence: new TextEncoder().encode("Exact synthetic receipt 109"),
          job: receiptJob };
      }, async close() {} };
    } },
    syntheticProbe: { checkpoint(stage) {
      if (firstAttempt && ((fault === "after_intent" && stage === "after_intent")
        || (fault === "after_confirmation" && stage === "after_confirmation"))) {
        throw new Error(`process stopped ${stage}`);
      }
    } },
    receiptVerifier: { async verify(receipt, expected) {
      return receipt.job.requisitionId === expected.requisitionId;
    } },
    queue: { async acknowledge() { acknowledgments++; } },
  };
  return { ports, nextAttempt() { firstAttempt = false; },
    get status() { return status; }, get clicks() { return clicks; },
    get profileRestores() { return profileRestores; },
    get confirmations() { return confirmations; },
    get acknowledgments() { return acknowledgments; } };
}

describe("cloud queued-run crash/redelivery stress", () => {
  it("fences a second final click across 1,000 injected boundary failures", async () => {
    const faults: Fault[] = ["before_intent", "after_intent", "after_click",
      "after_receipt_store", "after_confirmation"];
    for (let index = 0; index < 1_000; index++) {
      const fault = faults[index % faults.length]!;
      const h = harness(fault);
      const message = { body, receiptHandle: `receipt-${index}` };
      if (fault === "after_click") {
        expect(await handleQueuedApplication(message, h.ports)).toBe("needs_reconciliation");
      } else {
        await expect(handleQueuedApplication(message, h.ports)).rejects.toThrow();
      }
      const firstClicks = h.clicks;
      h.nextAttempt();
      const redelivery = await handleQueuedApplication(message, h.ports);
      if (fault === "before_intent") {
        expect(redelivery).toBe("confirmed");
        expect(h.clicks).toBe(1);
        expect(h.confirmations).toBe(1);
      } else if (fault === "after_confirmation") {
        expect(redelivery).toBe("already_confirmed");
        expect(h.clicks).toBe(firstClicks);
        expect(h.confirmations).toBe(1);
      } else {
        expect(redelivery).toBe("needs_reconciliation");
        expect(h.clicks).toBe(firstClicks);
        expect(h.confirmations).toBe(0);
      }
      expect(h.clicks).toBeLessThanOrEqual(1);
      expect(h.profileRestores).toBe(fault === "before_intent" ? 2 : 1);
      expect(h.acknowledgments).toBe(fault === "before_intent" || fault === "after_confirmation" ? 1 : 0);
    }
  });

  it("never confirms a receipt for another exact posting", async () => {
    const h = harness("before_intent", wrongJob);
    h.nextAttempt();
    const outcome = await handleQueuedApplication({ body, receiptHandle: "wrong-job" }, h.ports);
    expect(outcome).toBe("needs_reconciliation");
    expect(h.status).toBe("needs_reconciliation");
    expect(h.confirmations).toBe(0);
    expect(h.acknowledgments).toBe(0);
    expect(h.clicks).toBe(1);
  });
});
