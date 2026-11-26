import { describe, expect, it } from "vitest";
import { candidateProfileSchema, searchPreferencesSchema } from "../src/candidate/schema.js";
import { scoreJob } from "../src/matching/score.js";
import type { DiscoveredJob } from "../src/types.js";

// Synthetic, held-out examples exercise the queue's automatic-eligibility boundary.
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { languages: ["TypeScript"] }, education: [], projects: [], quarantinedClaims: [],
  experience: [{ employer: "Example", title: "Engineer", employmentType: "Intern", start: "2025", end: "2025",
    claims: [{ id: "typescript", claim: "Built TypeScript services", skills: ["TypeScript"],
      evidence: [{ source: "user-confirmed", uri: "private:synthetic" }], status: "user-confirmed",
      allowedUses: ["matching"] }] }],
});
const preferences = searchPreferencesSchema.parse({ version: 1, targetRoles: ["software engineer"],
  workArrangements: { preferred: ["remote"], accepted: ["hybrid"] },
  compensation: { preferredBaseFloor: 100_000 }, applicationPolicy: { dailyTarget: 10, dailyHardCap: 25 },
});
const base: DiscoveredJob = { id: "ashby:test:1", provider: "ashby", company: "Example", title: "Software Engineer",
  location: "Remote - US", workplaceType: "Remote", department: null, employmentType: null,
  compensation: null, descriptionText: "Build TypeScript services", applicationUrl: "https://example.com/apply",
  sourceUrl: "https://example.com/job", sourcePublishedAt: null, sourceUpdatedAt: null,
  firstSeenAt: "2026-01-01T00:00:00Z", discoveredAt: "2026-01-01T00:00:00Z", isNew: true,
  isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [] };

describe("automatic match safety evaluation", () => {
  const falseAccepts = [
    ["unsupported required tool", "TypeScript. Must have Kubernetes experience."],
    ["compound tool requirement", "TypeScript. Must have TypeScript and Kubernetes."],
    ["unproven license", "TypeScript. Active Professional Engineer license required."],
    ["unproven certificate", "TypeScript. AWS certification required."],
    ["unproven degree", "TypeScript. Bachelor's degree required."],
    ["unproven years", "TypeScript. Must have 3 years of software engineering experience."],
    ["export eligibility", "TypeScript. Must be ITAR eligible."],
    ["ambiguous mandatory requirement", "TypeScript. Must satisfy client-specific eligibility rules."],
    ["optional clause cannot hide a required tool", "TypeScript. Bachelor's degree not required but Kubernetes required."],
    ["required skills section", "TypeScript\nRequired skills:\n- Kubernetes"],
  ] as const;
  it.each(falseAccepts)("holds %s for review", (_name, descriptionText) => {
    const result = scoreJob({ ...base, descriptionText }, candidate, preferences);
    expect(result.eligible).toBe(false);
    expect(result.reviewFlags).toContain("Review mandatory qualifications before applying");
  });

  it("holds an onsite role outside accepted arrangements", () => {
    const result = scoreJob({ ...base, location: "Austin, TX", workplaceType: "On-site" }, candidate, preferences);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/work arrangement|location/i);
  });

  it("holds a hybrid role in another city until relocation is confirmed", () => {
    const result = scoreJob({ ...base, location: "Austin, TX", workplaceType: "Hybrid" }, candidate, preferences);
    expect(result.eligible).toBe(false);
  });

  it("holds roles requiring sponsorship when the employer will not sponsor", () => {
    const sponsored = candidateProfileSchema.parse({ ...candidate,
      authorization: { countries: ["India"], sponsorshipRequiredNowOrFuture: true } });
    expect(scoreJob({ ...base, descriptionText: "TypeScript. Must be authorized to work in the US without sponsorship." },
      sponsored, preferences).eligible).toBe(false);
  });

  it("does not let one supported qualification hide another", () => {
    const educated = candidateProfileSchema.parse({ ...candidate,
      education: [{ id: "degree", claim: "Bachelor's degree in Computer Science", skills: [],
        evidence: [{ source: "user-confirmed", uri: "private:synthetic" }], status: "user-confirmed",
        allowedUses: ["matching"] }] });
    expect(scoreJob({ ...base, descriptionText: "TypeScript. Bachelor's degree and Kubernetes required." },
      educated, preferences).eligible).toBe(false);
  });

  it("keeps supported entry-level roles eligible", () => {
    for (const descriptionText of ["Entry-level TypeScript engineer",
      "Required qualifications:\n- TypeScript\nPreferred qualifications:\n- Kubernetes",
      "TypeScript. Must be authorized to work in the US without sponsorship."]) {
      expect(scoreJob({ ...base, descriptionText }, candidate, preferences).eligible, descriptionText).toBe(true);
    }
  });
});
