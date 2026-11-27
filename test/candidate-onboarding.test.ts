import { describe, expect, it } from "vitest";
import { saveCandidateOnboarding, type OnboardingDeps } from "../src/hosted/candidate-onboarding.js";

const candidateId = "11111111-1111-4111-8111-111111111111";
const submissionId = "22222222-2222-4222-8222-222222222222";
const document = { name: "Resume.pdf", base64: Buffer.from("%PDF-1.7\nexample").toString("base64") };
const input = { version: 1, submissionId, careerStage: "new-graduate", targetRoles: ["Software engineer"],
  locations: ["Chicago"], schoolOrEmployer: "Example University", graduationOrExperience: "May 2026",
  workAuthorization: "United States", sponsorshipRequiredNowOrFuture: false,
  masterResume: document, reviewConfirmed: true, storageConsent: true, automationConsent: true };

function fixture() {
  const objects = new Map<string, Buffer>();
  const markers = new Map<string, { status: string; subjectId: string; digest: string }>();
  let deleted = false;
  const deps: OnboardingDeps = {
    candidateIdForSubject: () => candidateId,
    vault: {
      async put(_candidate, artifactId, data) {
        if (objects.has(artifactId)) throw new Error("Object exists");
        objects.set(artifactId, Buffer.from(data));
      },
      async read(_candidate, artifactId) {
        const value = objects.get(artifactId);
        if (!value) throw new Error("Object missing");
        return Buffer.from(value);
      },
    },
    markers: {
      async isDeleted() { return deleted; },
      async get(_candidate, artifactId) { return markers.get(artifactId) ?? null; },
      async createPending(_candidate, artifactId, subjectId, digest) {
        if (deleted || markers.has(artifactId)) throw new Error("Marker exists or deleted");
        markers.set(artifactId, { status: "pending", subjectId, digest });
      },
      async markVerified(_candidate, artifactId, subjectId) {
        if (deleted || markers.get(artifactId)?.status !== "pending"
          || markers.get(artifactId)?.subjectId !== subjectId) throw new Error("Cannot verify");
        markers.set(artifactId, { ...markers.get(artifactId)!, status: "verified", subjectId });
      },
    },
  };
  return { deps, objects, markers, setDeleted(value: boolean) { deleted = value; } };
}

describe("candidate onboarding", () => {
  it("stores only reviewed candidate facts and encrypted-vault document inputs before verification", async () => {
    const test = fixture();
    expect(await saveCandidateOnboarding("sub-1", input, test.deps)).toEqual({ candidateId, artifactId: submissionId });
    expect(test.markers.get(submissionId)).toMatchObject({ status: "verified", subjectId: "sub-1" });
    const profile = JSON.parse(test.objects.get(submissionId)!.toString());
    expect(profile.provenance).toBe("candidate-entered-and-reviewed");
    expect(profile.targetRoles).toEqual(["Software engineer"]);
    expect(profile.masterResume.artifactId).toMatch(/^[a-f0-9-]{36}$/);
    expect(test.objects.get(profile.masterResume.artifactId)!.toString()).toBe("%PDF-1.7\nexample");
    expect(await saveCandidateOnboarding("sub-1", input, test.deps)).toEqual({ candidateId, artifactId: submissionId });
    expect(test.objects.size).toBe(2);
  });

  it("rejects unconsented or malformed uploads without creating a marker", async () => {
    const test = fixture();
    await expect(saveCandidateOnboarding("sub-1", { ...input, automationConsent: false }, test.deps)).rejects.toThrow();
    await expect(saveCandidateOnboarding("sub-1", { ...input, masterResume: { ...document,
      base64: Buffer.from("not a pdf").toString("base64") } }, test.deps)).rejects.toThrow();
    expect(test.markers.get(submissionId)?.status).not.toBe("verified");
  });

  it("does not verify a profile after deletion starts", async () => {
    const test = fixture();
    test.setDeleted(true);
    await expect(saveCandidateOnboarding("sub-1", input, test.deps)).rejects.toThrow("unavailable");
    expect(test.objects.size).toBe(0);
  });

  it("does not let a different subject reuse a submission ID", async () => {
    const test = fixture();
    await saveCandidateOnboarding("sub-1", input, test.deps);
    await expect(saveCandidateOnboarding("sub-2", input, test.deps)).rejects.toThrow("unavailable");
  });
});
