import { describe, expect, it, vi } from "vitest";
import { candidateIdForSubject, createTrustedApplicationRun } from "../src/cloud/hosted-run-creator.js";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { handleApplicationRunHttp } from "../src/hosted/application-run-http.js";

const runId = "00000000-0000-4000-8000-000000000001";
const leadId = "00000000-0000-4000-8000-000000000002";
const artifactId = "00000000-0000-4000-8000-000000000003";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
const subjectId = "cognito-sub-123";
const job = { provider: "greenhouse", employerId: "employer-1", requisitionId: "job-42" };
const body = { runId, leadId, profileArtifactId: artifactId,
  consent: { granted: true, scope: "apply-one-job", policyVersion: "v1" } };
const now = new Date("2026-11-26T12:00:00.000Z");

function fixture() {
  const candidateId = candidateIdForSubject(issuer, subjectId);
  const ports = {
    billing: { loadEntitlements: vi.fn(async () => [{ kind: "free-grant", subjectId,
      grantId: "beta", approvedBy: "admin", startsAt: "2026-11-25T00:00:00.000Z",
      endsAt: "2026-12-01T00:00:00.000Z", revokedAt: null }]) },
    loadLead: vi.fn(async () => ({ leadId, job, jobKey: officialJobKey(job),
      canonicalUrl: "https://jobs.example.com/job-42", expiresAt: 1795737600 })),
    loadProfile: vi.fn(async () => ({ candidateId, artifactId, subjectId })),
    profileObjectExists: vi.fn(async () => true),
    createOrGet: vi.fn(async () => "created" as const),
  };
  return ports;
}

describe("trusted hosted application run", () => {
  it("binds the run to the verified subject and trusted job and profile", async () => {
    const ports = fixture();
    const result = await createTrustedApplicationRun(issuer, subjectId, body, ports, now);
    expect(result.created).toBe(true);
    expect(result.record.candidateId).toBe(candidateIdForSubject(issuer, subjectId));
    expect(result.record.job).toEqual(job);
    expect(result.record.consentVersion).toBe(1);
    expect(ports.createOrGet).toHaveBeenCalledOnce();
  });

  it("rejects browser-provided identity and job claims", async () => {
    const ports = fixture();
    await expect(createTrustedApplicationRun(issuer, subjectId,
      { ...body, candidateId: runId }, ports, now)).rejects.toThrow();
    await expect(createTrustedApplicationRun(issuer, subjectId,
      { ...body, job }, ports, now)).rejects.toThrow();
    expect(ports.createOrGet).not.toHaveBeenCalled();
  });

  it("fails closed on unpaid, expired, missing artifact, and mismatched owner", async () => {
    const unpaid = fixture();
    unpaid.billing.loadEntitlements.mockResolvedValueOnce([] as never);
    await expect(createTrustedApplicationRun(issuer, subjectId, body, unpaid, now)).rejects.toThrow();
    expect(unpaid.createOrGet).not.toHaveBeenCalled();
    const missing = fixture();
    missing.profileObjectExists.mockResolvedValueOnce(false);
    await expect(createTrustedApplicationRun(issuer, subjectId, body, missing, now)).rejects.toThrow();
    const wrongOwner = fixture();
    wrongOwner.loadProfile.mockResolvedValueOnce({ candidateId: runId, artifactId, subjectId });
    await expect(createTrustedApplicationRun(issuer, subjectId, body, wrongOwner, now)).rejects.toThrow();
    const expired = fixture();
    expired.loadLead.mockResolvedValueOnce({ leadId, job, jobKey: officialJobKey(job),
      canonicalUrl: "https://jobs.example.com/job-42", expiresAt: 1 });
    await expect(createTrustedApplicationRun(issuer, subjectId, body, expired, now)).rejects.toThrow();
  });

  it("authenticates before loading inputs and requires explicit consent", async () => {
    const ports = fixture();
    const request = new Request("https://app.example.com/api/applications/runs", { method: "POST",
      headers: { origin: "https://app.example.com", authorization: "Bearer a.b.c",
        "content-type": "application/json" }, body: JSON.stringify(body) });
    const denied = await handleApplicationRunHttp(request, { appOrigin: "https://app.example.com",
      issuer, verifySubject: async () => { throw new Error("invalid"); }, ports });
    expect(denied.status).toBe(401);
    expect(ports.billing.loadEntitlements).not.toHaveBeenCalled();
    const noConsent = await handleApplicationRunHttp(new Request(request.url, { method: "POST",
      headers: request.headers, body: JSON.stringify({ ...body, consent: { ...body.consent,
        granted: false } }) }), { appOrigin: "https://app.example.com", issuer,
      verifySubject: async () => subjectId, ports });
    expect(noConsent.status).toBe(400);
  });
});
