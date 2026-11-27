import { describe, expect, it, vi } from "vitest";
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { SqsApplicationQueueReceiver, runOneApplicationQueueTick }
  from "../src/cloud/aws-queue-consumer.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";
import type { CloudRunPorts } from "../src/cloud/queued-run.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const receiptId = "8c231a91-c73b-4e2d-b085-5d5ebf302311";
const job = { provider: "synthetic", employerId: "fixture", requisitionId: "109" };
const body = encodeCloudRunEnvelope({ version: 1, candidateId, runId, kind: "apply",
  scheduledAt: "2026-11-26T20:00:00Z" }).body;
const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/openapply-staging-application.fifo";

function harness(messages: string[]) {
  const deleted: string[] = [];
  const received: ReceiveMessageCommand[] = [];
  const sqs = { send: vi.fn(async (command: ReceiveMessageCommand | DeleteMessageCommand) => {
    if (command instanceof ReceiveMessageCommand) {
      received.push(command);
      const next = messages.shift();
      return { Messages: next ? [{ Body: next, ReceiptHandle: "receipt-1" }] : [] };
    }
    if (command instanceof DeleteMessageCommand) {
      deleted.push(command.input.ReceiptHandle!);
      return {};
    }
    throw new Error("Unexpected SQS command");
  }) } as unknown as Pick<SQSClient, "send">;
  return { receiver: new SqsApplicationQueueReceiver(sqs, queueUrl), deleted, received };
}

function ports() {
  let status: "not_started" | "needs_reconciliation" | "confirmed" = "not_started";
  let clickCount = 0;
  let profileRestores = 0;
  const submitted = new TextEncoder().encode("Synthetic confirmation for requisition 109");
  const value: Omit<CloudRunPorts, "queue"> = {
    billing: { async loadEntitlements() { return [{ kind: "free-grant", subjectId: candidateId,
      grantId: "synthetic", approvedBy: "staging", startsAt: "2020-01-01T00:00:00Z",
      endsAt: "2099-01-01T00:00:00Z", revokedAt: null }]; } },
    authorization: { async ownsRun() { return true; }, async hasCurrentConsent() { return true; } },
    journal: {
      async acquireLease() { return runId; }, async renewLease() { return true; },
      async releaseLease() {},
      async readSubmission() { return status === "not_started" ? { status }
        : { status, receiptArtifactId: receiptId }; },
      async beginSubmission() { status = "needs_reconciliation"; return receiptId; },
      async markUncertain() { status = "needs_reconciliation"; },
      async confirmAfterVerification() { status = "confirmed"; return true; },
    },
    runRecords: { async loadIdentity() { return { subjectId: candidateId,
      consentVersion: 1, job }; }, async loadProfileArtifactId() { return runId; } },
    vault: { async restoreToPrivateTemp() { profileRestores++;
      return { path: "/private/synthetic-profile", async cleanup() {} }; },
    async put() {} },
    application: { async prepare() { return { async submitOnce() { clickCount++;
      return { evidence: submitted, job }; } }; } },
    receiptVerifier: { async verify(receipt, expected) {
      return receipt.job.requisitionId === expected.requisitionId;
    } },
  };
  return { value, get clickCount() { return clickCount; },
    get profileRestores() { return profileRestores; } };
}

describe("single-message SQS application task", () => {
  it("confirms, deletes only after confirmation, and never submits again on redelivery", async () => {
    const h = harness([body, body]);
    const p = ports();
    expect(await runOneApplicationQueueTick(h.receiver, p.value)).toBe("confirmed");
    expect(await runOneApplicationQueueTick(h.receiver, p.value)).toBe("already_confirmed");
    expect(h.deleted).toEqual(["receipt-1", "receipt-1"]);
    expect(p.clickCount).toBe(1);
    expect(p.profileRestores).toBe(1);
    expect(h.received.every(command => command.input.MaxNumberOfMessages === 1
      && command.input.VisibilityTimeout === 900)).toBe(true);
  });

  it("exits cleanly for an empty poll and never deletes an invalid message", async () => {
    const empty = harness([]);
    expect(await runOneApplicationQueueTick(empty.receiver, ports().value)).toBe("empty");
    const invalid = harness(["not-json"]);
    await expect(runOneApplicationQueueTick(invalid.receiver, ports().value)).rejects.toThrow();
    expect(invalid.deleted).toEqual([]);
  });

  it("rejects a queue URL outside the staging FIFO contract", () => {
    expect(() => new SqsApplicationQueueReceiver({ send: vi.fn() } as unknown as
      Pick<SQSClient, "send">, "https://example.com/queue")).toThrow("Invalid application queue URL");
  });
});
