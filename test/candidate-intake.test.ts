import { describe, expect, it } from "vitest";
import { compileCandidateMarkdown } from "../src/candidate/markdown.js";
import { exportCandidateMarkdown, intakeQuestions, reviewExtractedClaim }
  from "../src/candidate/intake.js";

const pending = { id: "win-1", claim: "Improved an internal service", skills: ["TypeScript"], metrics: [],
  evidence: [{ source: "master résumé", uri: "/private/resume.pdf" }],
  status: "needs-confirmation" as const, allowedUses: [] };

describe("hosted candidate intake", () => {
  it("asks stage-specific questions and treats transcripts as optional", () => {
    expect(intakeQuestions("student").map(({ id }) => id)).toContain("expected-graduation");
    expect(intakeQuestions("new-graduate").map(({ id }) => id)).toContain("graduation");
    expect(intakeQuestions("workforce").map(({ id }) => id)).not.toContain("transcript");
    expect(intakeQuestions("student").find(({ id }) => id === "transcript")?.required).toBe(false);
    expect(intakeQuestions("workforce").find(({ id }) => id === "master-resume")?.required).toBe(true);
  });

  it("requires an exact explicit review before promoting an extracted fact", () => {
    expect(() => reviewExtractedClaim(pending, { claimId: pending.id,
      exactClaim: "Improved a public service", decision: "approve", allowedUses: ["resume"] }))
      .toThrow("changed");
    expect(() => reviewExtractedClaim(pending, { claimId: pending.id,
      exactClaim: pending.claim, decision: "approve", allowedUses: [] }))
      .toThrow("allowed use");
    expect(reviewExtractedClaim(pending, { claimId: pending.id, exactClaim: pending.claim,
      decision: "approve", allowedUses: ["resume"] })).toMatchObject({
        status: "user-confirmed", allowedUses: ["resume"], evidence: pending.evidence,
      });
    expect(reviewExtractedClaim(pending, { claimId: pending.id, exactClaim: pending.claim,
      decision: "reject" })).toMatchObject({ status: "do-not-use", allowedUses: [] });
  });

  it("exports private Markdown views that round-trip through the existing compiler", () => {
    const approved = reviewExtractedClaim(pending, { claimId: pending.id,
      exactClaim: pending.claim, decision: "approve", allowedUses: ["resume"] });
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
