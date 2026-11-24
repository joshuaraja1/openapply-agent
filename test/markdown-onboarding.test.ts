import { describe, expect, it } from "vitest";
import { compileCandidateMarkdown, compileSearchMarkdown } from "../src/candidate/markdown.js";

const identity = { version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  education: [],
};
const claim = { id: "result-1", claim: "Built Python services for three teams", skills: ["Python"],
  metrics: [], evidence: [{ source: "work history", uri: "/private/work-history.md" }],
  status: "user-confirmed", allowedUses: ["resume", "matching"] };
const history = { version: 1, skills: { languages: ["Python"] },
  experience: [{ employer: "Example Employer", title: "Engineer", employmentType: "Full-time",
    start: "2024", end: "2026", claims: [claim] }], projects: [], quarantinedClaims: [] };
const preferences = { version: 1, targetRoles: ["Software Engineer"],
  workArrangements: { preferred: ["Remote"], accepted: ["Remote", "Hybrid"] },
  compensation: { preferredBaseFloor: 100000, targetRangePosition: 0.7 },
  applicationPolicy: { dailyTarget: 10, dailyHardCap: 25, requireFinalApproval: true } };
const fenced = (tag: string, value: unknown) => `# Private source\n\n\u0060\u0060\u0060${tag}\n${JSON.stringify(value, null, 2)}\n\u0060\u0060\u0060\n`;

describe("Markdown onboarding compiler", () => {
  it("compiles only explicit structured facts and preferences", () => {
    const candidate = compileCandidateMarkdown(fenced("openapply-identity-json", identity),
      fenced("openapply-history-json", history));
    expect(candidate.experience[0]?.claims[0]?.claim).toBe(claim.claim);
    expect(candidate.authorization.sponsorshipRequiredNowOrFuture).toBe(false);
    expect(compileSearchMarkdown(fenced("openapply-search-json", preferences)).applicationPolicy.dailyTarget).toBe(10);
  });

  it("rejects placeholders, unsupported claims, and duplicate data blocks", () => {
    expect(() => compileCandidateMarkdown(fenced("openapply-identity-json", { ...identity,
      identity: { ...identity.identity, fullName: "{{NAME}}" } }),
    fenced("openapply-history-json", history))).toThrow("placeholder");
    const unapproved = { ...history, experience: [{ ...history.experience[0],
      claims: [{ ...claim, status: "needs-confirmation" }] }] };
    expect(() => compileCandidateMarkdown(fenced("openapply-identity-json", identity),
      fenced("openapply-history-json", unapproved))).toThrow("approved");
    const twice = fenced("openapply-search-json", preferences).repeat(2);
    expect(() => compileSearchMarkdown(twice)).toThrow("exactly one");
    const quarantinedDuplicate = { ...history, quarantinedClaims: [{ ...claim,
      status: "do-not-use", allowedUses: [] }] };
    expect(() => compileCandidateMarkdown(fenced("openapply-identity-json", identity),
      fenced("openapply-history-json", quarantinedDuplicate))).toThrow("unique");
  });
});
