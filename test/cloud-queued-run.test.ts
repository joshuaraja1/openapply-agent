import { describe, expect, it, vi } from "vitest";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";
import { handleQueuedApplication, receiptArtifactId, type CloudRunPorts, type VerifiedReceipt }
  from "../src/cloud/queued-run.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const job = { provider: "Greenhouse", employerId: "acme", requisitionId: "109" };
const evidence = new TextEncoder().encode("Employer confirmation for requisition 109");

function message(id = runId): { body: string; receiptHandle: string } {
  return {
    body: encodeCloudRunEnvelope({ version: 1, candidateId, runId: id,
      kind: "apply", scheduledAt: "2026-11-26T20:00:00Z" }).body,
    receiptHandle: "opaque-sqs-receipt",
  };
}

function harness() {
  const events: string[] = [];
  let status: "not_started" | "needs_reconciliation" | "confirmed" = "not_started";
  let busy = false;
  let leaseRenewalSucceeds = true;
  let intentWriteSucceeds = true;
  let confirmSucceeds = true;
  let storedArtifactId: string | undefined;
  let authorized = true;
  let clickResult: VerifiedReceipt | null = { evidence, job };
  let clickThrows = false;
  let failsBeforeClick = false;
  let prepareThrows = false;
  let ackThrows = false;
  let cleanupThrows = false;
  const ports: CloudRunPorts = {
    authorization: { async authorize() { events.push("authorize"); return authorized; } },
    journal: {
      async acquireLease() { events.push("lease"); return busy ? null : "lease-token"; },
      async renewLease() { events.push("renew"); return leaseRenewalSucceeds; },
      async releaseLease() { events.push("release"); },
      async submissionStatus() { events.push("status"); return status; },
      async beginSubmission() {
        events.push("intent");
        if (!intentWriteSucceeds) return false;
        if (status !== "not_started") return false;
        status = "needs_reconciliation";
        return true;
      },
      async markUncertain() { events.push("uncertain"); },
      async confirmAfterVerification() {
        events.push("confirmed");
        if (!confirmSucceeds) return false;
        status = "confirmed";
        return true;
      },
    },
    runRecords: {
      async load() { events.push("load"); return { profileArtifactId: runId, job }; },
    },
    vault: {
      async restoreToPrivateTemp() {
        events.push("restore");
        return { path: "/private/test-profile", async cleanup() {
          events.push("cleanup");
          if (cleanupThrows) throw new Error("private profile cleanup failed");
        } };
      },
      async put(_candidateId, artifactId) { storedArtifactId = artifactId; events.push("receipt-stored"); },
    },
    application: {
      async prepare() {
        events.push("prepare");
        if (prepareThrows) throw new Error("preflight failed");
        return { async submitOnce() {
          if (failsBeforeClick) throw new Error("browser closed before click");
          events.push("click");
          if (clickThrows) throw new Error("browser lost after click");
          return clickResult;
        } };
      },
    },
    receiptVerifier: { async verify() { events.push("verify"); return true; } },
    queue: { async acknowledge() {
      events.push("ack");
      if (ackThrows) throw new Error("SQS delete failed");
    } },
  };
  return {
    ports, events,
    setBusy(value: boolean) { busy = value; },
    setLeaseRenewalSucceeds(value: boolean) { leaseRenewalSucceeds = value; },
    setIntentWriteSucceeds(value: boolean) { intentWriteSucceeds = value; },
    setConfirmSucceeds(value: boolean) { confirmSucceeds = value; },
    setAuthorized(value: boolean) { authorized = value; },
    setClickThrows(value: boolean) { clickThrows = value; },
    setFailsBeforeClick(value: boolean) { failsBeforeClick = value; },
    setPrepareThrows(value: boolean) { prepareThrows = value; },
    setClickResult(value: VerifiedReceipt | null) { clickResult = value; },
    setAckThrows(value: boolean) { ackThrows = value; },
    setCleanupThrows(value: boolean) { cleanupThrows = value; },
    getStatus() { return status; },
    getStoredArtifactId() { return storedArtifactId; },
  };
}

describe("cloud queued application bridge", () => {
  it("persists intent before one click and confirms before acknowledging SQS", async () => {
    const h = harness();
    expect(await handleQueuedApplication(message(), h.ports)).toBe("confirmed");
    expect(h.events.indexOf("intent")).toBeLessThan(h.events.indexOf("click"));
    expect(h.events.indexOf("receipt-stored")).toBeLessThan(h.events.indexOf("confirmed"));
    expect(h.events.indexOf("confirmed")).toBeLessThan(h.events.indexOf("ack"));
    expect(h.events).toContain("cleanup");
    expect(h.getStatus()).toBe("confirmed");
  });

  it("acknowledges a duplicate delivery without preparing or clicking again", async () => {
    const h = harness();
    await handleQueuedApplication(message(), h.ports);
    h.events.length = 0;
    expect(await handleQueuedApplication(message("eb755d23-44d4-4224-973a-2cde18143273"), h.ports))
      .toBe("already_confirmed");
    expect(h.events).toContain("ack");
    expect(h.events).not.toContain("restore");
    expect(h.events).not.toContain("click");
  });

  it("does not load candidate state or ack while another worker holds the lease", async () => {
    const h = harness();
    h.setBusy(true);
    expect(await handleQueuedApplication(message(), h.ports)).toBe("lease_busy");
    expect(h.events).toEqual(["authorize", "lease"]);
  });

  it("never writes intent or clicks when the candidate lease was lost during preparation", async () => {
    const h = harness();
    h.setLeaseRenewalSucceeds(false);
    expect(await handleQueuedApplication(message(), h.ports)).toBe("retry");
    expect(h.events).toContain("cleanup");
    expect(h.events).not.toContain("intent");
    expect(h.events).not.toContain("click");
    expect(h.events).not.toContain("ack");
  });

  it("retries a rejected intent write when no durable intent exists", async () => {
    const h = harness();
    h.setIntentWriteSucceeds(false);
    expect(await handleQueuedApplication(message(), h.ports)).toBe("retry");
    expect(h.getStatus()).toBe("not_started");
    expect(h.events).not.toContain("click");
    expect(h.events).not.toContain("ack");
  });

  it("leaves the message unacknowledged when preflight crashes before intent", async () => {
    const h = harness();
    h.setPrepareThrows(true);
    await expect(handleQueuedApplication(message(), h.ports)).rejects.toThrow("preflight failed");
    expect(h.events).not.toContain("intent");
    expect(h.events).not.toContain("click");
    expect(h.events).not.toContain("ack");
    expect(h.events.slice(-2)).toEqual(["cleanup", "release"]);
  });

  it("holds a crash after intent for reconciliation and never clicks on redelivery", async () => {
    const h = harness();
    h.setClickThrows(true);
    expect(await handleQueuedApplication(message(), h.ports)).toBe("needs_reconciliation");
    expect(h.events).toContain("uncertain");
    expect(h.events).not.toContain("ack");
    h.events.length = 0;
    expect(await handleQueuedApplication(message(), h.ports)).toBe("needs_reconciliation");
    expect(h.events).not.toContain("prepare");
    expect(h.events).not.toContain("click");
    expect(h.events).not.toContain("ack");
  });

  it("also holds a crash between intent and the final click", async () => {
    const h = harness();
    h.setFailsBeforeClick(true);
    expect(await handleQueuedApplication(message(), h.ports)).toBe("needs_reconciliation");
    expect(h.events).toContain("intent");
    expect(h.events).not.toContain("click");
    h.events.length = 0;
    expect(await handleQueuedApplication(message(), h.ports)).toBe("needs_reconciliation");
    expect(h.events).not.toContain("click");
    expect(h.events).not.toContain("ack");
  });

  it("rejects mismatched exact-job evidence without acknowledging", async () => {
    const h = harness();
    h.setClickResult({ evidence, job: { ...job, requisitionId: "other" } });
    expect(await handleQueuedApplication(message(), h.ports)).toBe("needs_reconciliation");
    expect(h.events).not.toContain("verify");
    expect(h.events).not.toContain("receipt-stored");
    expect(h.events).not.toContain("ack");
  });

  it("recovers an SQS ack failure after confirmation without a second click", async () => {
    const h = harness();
    h.setAckThrows(true);
    await expect(handleQueuedApplication(message(), h.ports)).rejects.toThrow("SQS delete failed");
    expect(h.getStatus()).toBe("confirmed");
    h.setAckThrows(false);
    h.events.length = 0;
    expect(await handleQueuedApplication(message(), h.ports)).toBe("already_confirmed");
    expect(h.events).not.toContain("click");
  });

  it("does not acknowledge before private profile cleanup and lease release", async () => {
    const h = harness();
    expect(await handleQueuedApplication(message(), h.ports)).toBe("confirmed");
    expect(h.events.indexOf("cleanup")).toBeLessThan(h.events.indexOf("ack"));
    expect(h.events.indexOf("release")).toBeLessThan(h.events.indexOf("ack"));
    const bad = harness();
    bad.setCleanupThrows(true);
    await expect(handleQueuedApplication(message(), bad.ports)).rejects.toThrow("cleanup failed");
    expect(bad.events).not.toContain("ack");
  });

  it("retains a stable receipt pointer when confirmation loses the lease after a click", async () => {
    const h = harness();
    h.setConfirmSucceeds(false);
    expect(await handleQueuedApplication(message(), h.ports)).toBe("needs_reconciliation");
    expect(h.getStoredArtifactId()).toBe(receiptArtifactId(candidateId, job));
    expect(h.events).not.toContain("ack");
    h.events.length = 0;
    expect(await handleQueuedApplication(message(), h.ports)).toBe("needs_reconciliation");
    expect(h.events).not.toContain("click");
    expect(receiptArtifactId(candidateId, job)).toBe(h.getStoredArtifactId());
  });

  it("rejects discovery messages before acquiring a candidate lease", async () => {
    const h = harness();
    const discovery = encodeCloudRunEnvelope({ version: 1, candidateId, runId,
      kind: "discover", scheduledAt: "2026-11-26T20:00:00Z" });
    await expect(handleQueuedApplication({ body: discovery.body, receiptHandle: "sqs" }, h.ports))
      .rejects.toThrow("Discovery messages");
    expect(h.events).toEqual([]);
  });

  it("denies a run for another candidate before lease or vault access", async () => {
    const h = harness();
    h.setAuthorized(false);
    expect(await handleQueuedApplication(message(), h.ports)).toBe("unauthorized");
    expect(h.events).toEqual(["authorize"]);
  });

  it("never emits candidate data through console logging", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleQueuedApplication(message(), harness().ports);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
