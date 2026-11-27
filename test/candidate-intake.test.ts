import { describe, expect, it } from "vitest";
import { compileCandidateMarkdown } from "../src/candidate/markdown.js";
import { exportCandidateMarkdown, fingerprintExtractedClaim, intakeQuestions, reviewExtractedClaim }
  from "../src/candidate/intake.js";

const pending = { id: "win-1", claim: "Improved an internal service", skills: ["TypeScript"], metrics: [],
  evidence: [{ source: "master résumé", uri: "/private/resume.pdf" }],
  status: "needs-confirmation" as const, allowedUses: [] };
const context = { candidateId: "candidate-1", sourceFingerprint: "a".repeat(64) };
const review = { claimId: pending.id, exactClaim: pending.claim,
  expectedFingerprint: fingerprintExtractedClaim(pending, context), decision: "approve" as const,
  allowedUses: ["resume" as const] };

describe("hosted candidate intake", () => {
  it("asks stage-specific questions and treats transcripts as optional", () => {
    expect(intakeQuestions("student").map(({ id }) => id)).toContain("expected-graduation");
    expect(intakeQuestions("new-graduate").map(({ id }) => id)).toContain("graduation");
    expect(intakeQuestions("workforce").map(({ id }) => id)).not.toContain("transcript");
    expect(intakeQuestions("student").find(({ id }) => id === "transcript")?.required).toBe(false);
    expect(intakeQuestions("workforce").find(({ id }) => id === "master-resume")?.required).toBe(true);
  });

  it("requires an exact explicit review before promoting an extracted fact", () => {
    expect(() => reviewExtractedClaim(pending, context, { ...review,
      exactClaim: "Improved a public service" }))
      .toThrow("changed");
    expect(() => reviewExtractedClaim(pending, context, { ...review, allowedUses: [] }))
      .toThrow("allowed use");
    expect(reviewExtractedClaim(pending, context, review)).toMatchObject({
        status: "user-confirmed", allowedUses: ["resume"], evidence: pending.evidence,
      });
    expect(reviewExtractedClaim(pending, context, { ...review, decision: "reject",
      allowedUses: [] })).toMatchObject({ status: "do-not-use", allowedUses: [] });
  });

  it("rejects a stale approval when numbers, evidence, uses, source, or tenant change", () => {
    const changed = [
      { ...pending, metrics: [{ label: "time saved", value: 30, unit: "%" }] },
      { ...pending, evidence: [{ source: "master résumé", uri: "/private/changed.pdf" }] },
      { ...pending, skills: ["Python"] },
      { ...pending, allowedUses: ["application" as const] },
    ];
    for (const draft of changed) {
      expect(() => reviewExtractedClaim(draft, context, review)).toThrow("changed");
    }
    expect(() => reviewExtractedClaim(pending, { ...context,
      sourceFingerprint: "b".repeat(64) }, review)).toThrow("changed");
    expect(() => reviewExtractedClaim(pending, { ...context,
      candidateId: "candidate-2" }, review)).toThrow("changed");
  });

  it("does not promote unresolved placeholders in claims, metrics, skills, or evidence", () => {
    const bad = [
      { ...pending, claim: "Improved {{SERVICE}}" },
      { ...pending, metrics: [{ label: "users", value: "{{COUNT}}" }] },
      { ...pending, skills: ["{{SKILL}}"] },
      { ...pending, evidence: [{ source: "master résumé", uri: "{{SOURCE}}" }] },
    ];
    for (const draft of bad) {
      expect(() => reviewExtractedClaim(draft, context, { ...review,
        exactClaim: draft.claim, expectedFingerprint: fingerprintExtractedClaim(draft, context) }))
        .toThrow("placeholders");
    }
  });

  it("exports private Markdown views that round-trip through the existing compiler", () => {
    const approved = reviewExtractedClaim(pending, context, review);
    const candidate = { version: 1 as const, identity: { fullName: "Test Candidate", location: "Dallas, TX",
      email: "test@example.com", phone: "555-0100" },
    authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
    education: [], skills: { languages: ["TypeScript"] },
    experience: [{ employer: "Example", title: "Engineer", employmentType: "Intern",
      start: "2025", end: "2026", claims: [approved] }], projects: [], quarantinedClaims: [] };
    const exported = exportCandidateMarkdown(candidate);
    expect(exported.profile).toContain("Do not commit");
    expect(compileCandidateMarkdown(exported.profile, exported.history)).toEqual(candidate);
  });
});
