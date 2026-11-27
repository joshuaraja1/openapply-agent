import { describe, expect, it, vi } from "vitest";
import { handleCandidateOnboardingHttp } from "../src/hosted/candidate-onboarding-http.js";

const appOrigin = "https://staging.openapplyagent.xyz";
const token = `a.${"b".repeat(8)}.c`;
const validBody = { version: 1, submissionId: "22222222-2222-4222-8222-222222222222",
  careerStage: "student", targetRoles: ["Software engineer"], locations: ["Chicago"],
  schoolOrEmployer: "Example University", graduationOrExperience: "May 2027",
  workAuthorization: "United States", sponsorshipRequiredNowOrFuture: false,
  masterResume: { name: "Resume.pdf", base64: Buffer.from("%PDF-1.7\nexample").toString("base64") },
  reviewConfirmed: true, storageConsent: true, automationConsent: true };

function deps() {
  const put = vi.fn(async () => {});
  const markers = new Map<string, { status: string; subjectId: string; digest: string }>();
  return { appOrigin, verifySubject: vi.fn(async () => "sub-1"),
    loadEntitlements: vi.fn(async (): Promise<readonly unknown[]> => [{ kind: "free-grant", subjectId: "sub-1",
      grantId: "beta-1", approvedBy: "beta-admin", startsAt: "2020-01-01T00:00:00Z",
      endsAt: "2099-01-01T00:00:00Z", revokedAt: null }]),
    candidateIdForSubject: () => "11111111-1111-4111-8111-111111111111",
    vault: { put, read: vi.fn(async () => Buffer.alloc(0)) },
    markers: {
      isDeleted: vi.fn(async () => false),
      get: vi.fn(async (_candidate: string, id: string) => markers.get(id) ?? null),
      createPending: vi.fn(async (_candidate: string, id: string, subject: string, digest: string) => {
        markers.set(id, { status: "pending", subjectId: subject, digest });
      }),
      markVerified: vi.fn(async (_candidate: string, id: string, subject: string) => {
        markers.set(id, { ...markers.get(id)!, status: "verified", subjectId: subject });
      }),
    } };
}

function request(body: unknown, overrides: { origin?: string; authorization?: string } = {}) {
  return new Request(`${appOrigin}/api/candidates/onboarding`, { method: "POST",
    headers: { origin: overrides.origin ?? appOrigin,
      authorization: overrides.authorization ?? `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
}

describe("hosted candidate onboarding HTTP", () => {
  it("requires same origin and verified Cognito identity before accessing storage", async () => {
    const test = deps();
    expect((await handleCandidateOnboardingHttp(request(validBody, { origin: "https://evil.example" }), test)).status).toBe(403);
    expect((await handleCandidateOnboardingHttp(request(validBody, { authorization: "" }), test)).status).toBe(401);
    expect(test.vault.put).not.toHaveBeenCalled();
    expect(test.verifySubject).not.toHaveBeenCalled();
  });

  it("rejects unreviewed facts and never echoes private data", async () => {
    const test = deps();
    const response = await handleCandidateOnboardingHttp(request({ ...validBody, reviewConfirmed: false }), test);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("Example University");
    expect(test.vault.put).not.toHaveBeenCalled();
  });

  it("saves only a verified profile under the authenticated subject", async () => {
    const test = deps();
    const response = await handleCandidateOnboardingHttp(request(validBody), test);
    expect(response.status).toBe(201);
    expect(test.vault.put).toHaveBeenCalledTimes(2);
    expect(test.markers.markVerified).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts a current paid semester entitlement", async () => {
    const test = deps();
    test.loadEntitlements.mockResolvedValueOnce([{ kind: "semester", subjectId: "sub-1",
      checkoutSessionId: "cs_test_123", paymentIntentId: "pi_123",
      startsAt: "2020-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z",
      revokedAt: null }]);
    const response = await handleCandidateOnboardingHttp(request(validBody), test);
    expect(response.status).toBe(201);
    expect(test.markers.markVerified).toHaveBeenCalledOnce();
  });

  it("returns inactive plan status from trusted entitlements", async () => {
    const test = deps();
    test.loadEntitlements.mockResolvedValueOnce([]);
    const response = await handleCandidateOnboardingHttp(new Request(`${appOrigin}/api/candidates/plan`, {
      method: "POST", headers: { origin: appOrigin, authorization: `Bearer ${token}` }, body: "{}",
    }), test);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "inactive" });
    expect(test.loadEntitlements).toHaveBeenCalledWith("sub-1");
  });

  it("blocks unpaid, expired, and unreadable entitlements before uploading", async () => {
    const test = deps();
    test.loadEntitlements.mockResolvedValueOnce([]);
    const unpaid = await handleCandidateOnboardingHttp(request(validBody), test);
    expect(unpaid.status).toBe(403);
    test.loadEntitlements.mockResolvedValueOnce([{ kind: "free-grant", subjectId: "sub-1",
      grantId: "expired", approvedBy: "beta-admin", startsAt: "2020-01-01T00:00:00Z",
      endsAt: "2021-01-01T00:00:00Z", revokedAt: null }]);
    const expired = await handleCandidateOnboardingHttp(request(validBody), test);
    expect(expired.status).toBe(403);
    test.loadEntitlements.mockRejectedValueOnce(new Error("Dynamo unavailable"));
    const unavailable = await handleCandidateOnboardingHttp(request(validBody), test);
    expect(unavailable.status).toBe(503);
    expect(test.vault.put).not.toHaveBeenCalled();
    expect(test.markers.createPending).not.toHaveBeenCalled();
  });
});
