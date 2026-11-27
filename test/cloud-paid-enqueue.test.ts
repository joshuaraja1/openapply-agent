import { describe, expect, it, vi } from "vitest";
import { enqueueHostedApplication } from "../src/cloud/paid-enqueue.js";
import { decodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const now = new Date("2026-11-26T20:00:00Z");
const grant = { kind: "free-grant", subjectId: "sub-a", grantId: "grant-a",
  approvedBy: "admin", startsAt: "2026-01-01T00:00:00Z",
  endsAt: "2027-01-01T00:00:00Z", revokedAt: null };

function harness() {
  const send = vi.fn(async (_message: unknown) => {});
  const ports = {
    runRecords: { loadIdentity: vi.fn(async () => ({ subjectId: "sub-a", consentVersion: 1,
      job: { provider: "Greenhouse", employerId: "acme", requisitionId: "42" } })) },
    authorization: { ownsRun: vi.fn(async () => true),
      hasCurrentConsent: vi.fn(async () => true) },
    billing: { loadEntitlements: vi.fn(async () => [grant] as unknown[]) },
    queue: { send },
  };
  return { ports, send };
}

describe("hosted application enqueue access", () => {
  it("sends only opaque IDs after checking ownership, consent and current access", async () => {
    const { ports, send } = harness();
    await enqueueHostedApplication("sub-a", candidateId, runId, ports, now);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0] as { body: string };
    expect(decodeCloudRunEnvelope(message.body)).toMatchObject({ candidateId, runId, kind: "apply" });
    expect(message.body).not.toContain("sub-a");
  });

  it("rejects a different authenticated subject before reading billing or sending", async () => {
    const { ports, send } = harness();
    await expect(enqueueHostedApplication("sub-b", candidateId, runId, ports, now))
      .rejects.toThrow("not bound");
    expect(ports.billing.loadEntitlements).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects expired access and a failed entitlement read", async () => {
    const { ports, send } = harness();
    ports.billing.loadEntitlements.mockResolvedValue([]);
    await expect(enqueueHostedApplication("sub-a", candidateId, runId, ports, now))
      .rejects.toThrow("Hosted access unavailable");
    ports.billing.loadEntitlements.mockRejectedValue(new Error("DynamoDB unavailable"));
    await expect(enqueueHostedApplication("sub-a", candidateId, runId, ports, now))
      .rejects.toThrow("DynamoDB unavailable");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a run after consent is revoked", async () => {
    const { ports, send } = harness();
    ports.authorization.hasCurrentConsent.mockResolvedValue(false);
    await expect(enqueueHostedApplication("sub-a", candidateId, runId, ports, now))
      .rejects.toThrow("not authorized");
    expect(send).not.toHaveBeenCalled();
  });

  it("launches from the exact durable row without sending to shared SQS", async () => {
    const { ports, send } = harness();
    const order: string[] = [];
    const dispatch = {
      ensurePending: vi.fn(async (_candidateId: string, _runId: string,
        envelope: { body: string; groupId: string; deduplicationId: string }) => {
        order.push("durable");
        return { ...envelope, state: "pending_queue" as const };
      }),
      markQueued: vi.fn(async () => { order.push("queued"); }),
      markLaunched: vi.fn(async () => { order.push("launched"); }),
      markNeedsReconciliation: vi.fn(async () => {}),
    };
    const launch = vi.fn(async () => {
      expect(send).not.toHaveBeenCalled();
      expect(order).toEqual(["durable", "queued"]);
      return "started" as const;
    });
    await enqueueHostedApplication("sub-a", candidateId, runId,
      { ...ports, dispatch, launcher: { launch } }, now);
    expect(order).toEqual(["durable", "queued", "launched"]);
    expect(launch).toHaveBeenCalledWith(candidateId, runId);
    expect(send).not.toHaveBeenCalled();
  });
});
