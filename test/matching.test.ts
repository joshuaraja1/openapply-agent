import { describe, expect, it } from "vitest";
import { candidateProfileSchema, searchPreferencesSchema } from "../src/candidate/schema.js";
import { parseSalaryTarget, scoreJob } from "../src/matching/score.js";
import type { DiscoveredJob } from "../src/types.js";

const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Example Candidate", location: "Dallas, TX", email: "candidate@example.com", phone: "+1 555 555 0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { languages: ["TypeScript", "Python"], frontend: ["React"] },
  education: [], experience: [{ employer: "Example", title: "Engineer", employmentType: "Intern",
    start: "2025", end: "2025", claims: [{ id: "experience-1", claim: "Built TypeScript and Python services with React",
      skills: ["TypeScript", "Python", "React"],
      evidence: [{ source: "user-confirmed", uri: "private:work-history" }],
      status: "user-confirmed", allowedUses: ["matching", "resume"] }] }],
  projects: [], quarantinedClaims: [],
});
const preferences = searchPreferencesSchema.parse({
  version: 1,
  targetRoles: ["software engineer", "product engineer"],
  workArrangements: { preferred: ["remote"], accepted: ["hybrid", "on-site"] },
  compensation: { preferredBaseFloor: 100_000, targetRangePosition: 0.7 },
  applicationPolicy: { dailyTarget: 10, dailyHardCap: 25, requireFinalApproval: true },
});
const job: DiscoveredJob = {
  id: "ashby:example:1", provider: "ashby", company: "Example", title: "Product Engineer",
  location: "Remote - US", department: "Engineering", employmentType: "Full time", workplaceType: "Remote",
  compensation: "$120,000-$150,000", descriptionText: "Early career TypeScript, React, and Python",
  applicationUrl: "https://example.com/apply", sourceUrl: "https://example.com/job",
  sourcePublishedAt: "2026-01-01T00:00:00Z", sourceUpdatedAt: null,
  firstSeenAt: "2026-01-01T00:00:00Z", discoveredAt: "2026-01-01T01:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "source-published", matchedKeywords: [],
};

describe("evidence-backed matching", () => {
  it("ranks a matching early-career role", () => {
    const result = scoreJob(job, candidate, preferences);
    expect(result.eligible).toBe(true);
    expect(result.matchedSkills).toEqual(["Python", "React", "TypeScript"]);
    expect(result.score).toBeGreaterThan(70);
  });

  it("rejects excluded seniority", () => {
    expect(scoreJob({ ...job, title: "Senior Product Engineer" }, candidate, preferences).eligible).toBe(false);
  });

  it("rejects a title match with no supported skill overlap", () => {
    const result = scoreJob({ ...job, descriptionText: "Early career C++ firmware development" },
      candidate, preferences);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("No job skill matches an approved candidate claim");
  });

  it("does not count unverified, quarantined, or resume-only skills", () => {
    const unsupported = candidateProfileSchema.parse({ ...candidate,
      skills: { languages: ["Rust"] },
      experience: [{ ...candidate.experience[0], claims: [{
        id: "unconfirmed", claim: "Used Rust", skills: ["Rust"],
        evidence: [{ source: "user", uri: "private:pending" }],
        status: "needs-confirmation", allowedUses: ["matching"] }] }],
      quarantinedClaims: [{ id: "quarantined", claim: "Used Rust", skills: ["Rust"],
        evidence: [{ source: "user", uri: "private:pending" }], status: "do-not-use",
        allowedUses: ["matching"] }],
    });
    expect(scoreJob({ ...job, descriptionText: "Rust" }, unsupported, preferences).eligible).toBe(false);
  });

  it("matches verified skills containing punctuation without matching partial words", () => {
    const withCpp = candidateProfileSchema.parse({ ...candidate,
      experience: [{ ...candidate.experience[0], claims: [{ ...candidate.experience[0]!.claims[0]!,
        skills: ["C++"] }] }],
    });
    expect(scoreJob({ ...job, descriptionText: "Build C++ services" }, withCpp, preferences).eligible).toBe(true);
    expect(scoreJob({ ...job, descriptionText: "Build C services" }, withCpp, preferences).eligible).toBe(false);
  });

  it("targets the configured point in a salary range", () => {
    expect(parseSalaryTarget("$100,000-$140,000", 0.75)).toBe(130_000);
  });

  it("pauses on mandatory citizenship, degree, clearance, and experience without approved proof", () => {
    for (const requirement of ["US citizenship required", "U.S. citizenship required", "Bachelor's degree required",
      "Active Secret clearance required", "Must have 2+ years of software engineering experience"]) {
      const result = scoreJob({ ...job, descriptionText: `TypeScript. ${requirement}.` },
        candidate, preferences);
      expect(result.eligible, requirement).toBe(false);
      expect(result.reviewFlags).toContain("Review mandatory qualifications before applying");
    }
  });

  it("accepts an explicit year claim but does not use unapproved claims", () => {
    const yearClaim = { ...candidate.experience[0]!.claims[0]!,
      claim: "3 years of software engineering experience with TypeScript" };
    const posting = { ...job,
      descriptionText: "TypeScript. Must have 2+ years of software engineering experience with TypeScript." };
    const documented = candidateProfileSchema.parse({ ...candidate,
      experience: [{ ...candidate.experience[0], claims: [yearClaim] }] });
    expect(scoreJob(posting, documented, preferences).eligible).toBe(true);
    const unapproved = candidateProfileSchema.parse({ ...documented,
      experience: [{ ...candidate.experience[0], claims: [{ ...yearClaim, status: "needs-confirmation" }] }] });
    expect(scoreJob(posting, unapproved, preferences).eligible).toBe(false);
  });

  it("does not classify a preferred or explicitly non-required qualification as mandatory", () => {
    const result = scoreJob({ ...job,
      descriptionText: "TypeScript. US citizenship not required. Bachelor's degree preferred." },
      candidate, preferences);
    expect(result.eligible).toBe(true);
  });

  it("checks bullets under a requirements heading and leaves preferred bullets alone", () => {
    const posting = { ...job, descriptionText: ["TypeScript", "Minimum qualifications:",
      "- 2 years of software engineering experience", "Preferred qualifications:",
      "- Active Secret clearance"].join("\n") };
    const result = scoreJob(posting, candidate, preferences);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("2 years of software engineering experience needs an approved matching claim");
    expect(result.reasons).not.toContain("Security clearance requirement needs an approved matching claim");
  });
});
