import { describe, expect, it, vi } from "vitest";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { candidateIdForSubject } from "../src/cloud/hosted-run-creator.js";
import { createReviewedApplicationRetry } from "../src/cloud/reviewed-application-retry.js";
import { handleReviewedRetryHttp } from "../src/hosted/reviewed-retry-http.js";

const issuer = "https://cognito.example.com/pool";
const subjectId = "job-seeker-1";
const candidateId = candidateIdForSubject(issuer, subjectId);
const blockedRunId = "00000000-0000-4000-8000-000000000001";
const newRunId = "00000000-0000-4000-8000-000000000002";
const oldProfile = "00000000-0000-4000-8000-000000000003";
const reviewedProfile = "00000000-0000-4000-8000-000000000004";
const leadId = "00000000-0000-4000-8000-000000000005";
const job = { provider: "greenhouse", employerId: "example", requisitionId: "123" };
const now = new Date("2026-11-28T05:00:00.000Z");
const input = { blockedRunId, newRunId, reviewedProfileArtifactId: reviewedProfile,
  acknowledgement: "I reviewed and updated my application facts" };

function fixture() {
  const lead = { leadId, job, jobKey: officialJobKey(job),
    canonicalUrl: "https://boards.greenhouse.io/example/jobs/123",
    expiresAt: Math.floor(now.getTime() / 1000) + 900 };
  return {
    loadBlockedRun: vi.fn(async () => ({ subjectId, leadId,
      profileArtifactId: oldProfile, job })),
    readNeedsHumanPointer: vi.fn(async () => ({ artifactId: blockedRunId,
      sha256: "a".repeat(64) })),
    readSubmission: vi.fn(async () => ({ status: "not_started" })),
    hasCurrentConsent: vi.fn(async () => true),
    hasActiveTask: vi.fn(async () => false),
    verifyLiveLead: vi.fn(async () => lead),
    billing: { loadEntitlements: vi.fn(async () => [{ kind: "free-grant", subjectId,
      grantId: "beta", approvedBy: "admin", startsAt: "2026-11-25T00:00:00.000Z",
      endsAt: "2026-12-01T00:00:00.000Z", revokedAt: null }]) },
    loadProfile: vi.fn(async () => ({ candidateId, artifactId: reviewedProfile,
      subjectId, applicationProfileReady: true as const })),
    profileObjectExists: vi.fn(async () => true),
    createOrGet: vi.fn(async () => "created" as const),
  };
}

describe("reviewed job seeker retry", () => {
  it("creates a new exact-job run with a different approved profile", async () => {
    const ports = fixture();
    const result = await createReviewedApplicationRetry(issuer, subjectId, input, ports, now);
    expect(result.record).toMatchObject({ candidateId, runId: newRunId,
      profileArtifactId: reviewedProfile, job });
    expect(ports.createOrGet).toHaveBeenCalledOnce();
  });
  it("fails closed on unreviewed data, intent, withdrawn consent, active task or changed posting", async () => {
    const scenarios: Array<(ports: ReturnType<typeof fixture>) => void> = [
      ports => { ports.readNeedsHumanPointer.mockResolvedValue(undefined as never); },
      ports => { ports.readSubmission.mockResolvedValue({ status: "confirmed" }); },
      ports => { ports.hasCurrentConsent.mockResolvedValue(false); },
      ports => { ports.hasActiveTask.mockResolvedValue(true); },
      ports => { ports.verifyLiveLead.mockResolvedValue({ ...awaitlessLead(),
        job: { ...job, requisitionId: "other" } }); },
      ports => { ports.billing.loadEntitlements.mockResolvedValue([] as never); },
    ];
    for (const change of scenarios) {
      const ports = fixture(); change(ports);
      await expect(createReviewedApplicationRetry(issuer, subjectId, input, ports, now))
        .rejects.toThrow();
      expect(ports.createOrGet).not.toHaveBeenCalled();
    }
    const ports = fixture();
    await expect(createReviewedApplicationRetry(issuer, subjectId,
      { ...input, reviewedProfileArtifactId: oldProfile }, ports, now)).rejects.toThrow();
  });
  it("requires a signed-in, same-origin explicit review action", async () => {
    const url = "https://app.example.com/api/applications/reviewed-retry";
    const body = JSON.stringify(input);
    const request = (origin: string, bearer = "Bearer a.b.c") => new Request(url, {
      method: "POST", headers: { origin, authorization: bearer,
        "content-type": "application/json" }, body });
    const deps = { appOrigin: "https://app.example.com", issuer,
      verifySubject: vi.fn(async () => subjectId), ports: fixture(), now };
    expect((await handleReviewedRetryHttp(request("https://evil.example"), deps)).status).toBe(403);
    expect((await handleReviewedRetryHttp(request(deps.appOrigin, "Bearer wrong"), deps)).status).toBe(401);
    expect(deps.ports.createOrGet).not.toHaveBeenCalled();
    const result = await handleReviewedRetryHttp(request(deps.appOrigin), deps);
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ candidateId, runId: newRunId });
    expect(deps.ports.createOrGet).toHaveBeenCalledOnce();
  });
});

function awaitlessLead() {
  return { leadId, job, jobKey: officialJobKey(job),
    canonicalUrl: "https://boards.greenhouse.io/example/jobs/123",
    expiresAt: Math.floor(now.getTime() / 1000) + 900 };
}
