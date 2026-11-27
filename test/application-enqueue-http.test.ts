import { describe, expect, it, vi } from "vitest";
import { handleApplicationEnqueueHttp } from "../src/hosted/application-enqueue-http.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const url = "https://openapply.example/api/applications/enqueue";
const grant = { kind: "free-grant", subjectId: "sub-a", grantId: "grant-a",
  approvedBy: "admin", startsAt: "2026-01-01T00:00:00Z",
  endsAt: "2027-01-01T00:00:00Z", revokedAt: null };

function harness(subjectId = "sub-a") {
  const send = vi.fn(async () => {});
  const ports = {
    runRecords: { loadIdentity: vi.fn(async () => ({ subjectId: "sub-a",
      consentVersion: 1, job: { provider: "Greenhouse", employerId: "acme",
        requisitionId: "42" } })) },
    authorization: { ownsRun: vi.fn(async () => true),
      hasCurrentConsent: vi.fn(async () => true) },
    billing: { loadEntitlements: vi.fn(async () => [grant] as unknown[]) },
    queue: { send },
  };
  return { send, ports, deps: { appOrigin: "https://openapply.example",
    verifySubject: vi.fn(async () => subjectId), ports } };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body), headers: {
    origin: "https://openapply.example", authorization: "Bearer a.b.c",
    "content-type": "application/json", ...headers,
  } });
}

describe("authenticated application enqueue HTTP", () => {
  it("accepts only a verified subject with run ownership, consent and access", async () => {
    const h = harness();
    const result = await handleApplicationEnqueueHttp(request({ candidateId, runId }), h.deps);
    expect(result.status).toBe(202);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.ports.billing.loadEntitlements).toHaveBeenCalledWith("sub-a");
  });

  it("does not use a spoofed subject or an unauthenticated request", async () => {
    const h = harness("sub-b");
    expect((await handleApplicationEnqueueHttp(request({ candidateId, runId,
      subjectId: "sub-a" }), h.deps)).status).toBe(400);
    expect((await handleApplicationEnqueueHttp(request({ candidateId, runId }), h.deps))
      .status).toBe(403);
    expect((await handleApplicationEnqueueHttp(request({ candidateId, runId },
      { authorization: "" }), h.deps)).status).toBe(401);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("returns a retryable error when the durable billing read fails", async () => {
    const h = harness();
    h.ports.billing.loadEntitlements.mockRejectedValue(new Error("DynamoDB unavailable"));
    expect((await handleApplicationEnqueueHttp(request({ candidateId, runId }), h.deps))
      .status).toBe(503);
    expect(h.send).not.toHaveBeenCalled();
  });
});
