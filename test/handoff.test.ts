import { describe, expect, it } from "vitest";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { createTailoringBrief } from "../src/resume/tailoring.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import type { DiscoveredJob } from "../src/types.js";

const job: DiscoveredJob = {
  id: "ashby:example:1", provider: "ashby", company: "Example", title: "Product Engineer",
  location: "Remote - US", department: "Engineering", employmentType: "Full time", workplaceType: "Remote",
  compensation: null, descriptionText: "Build React and TypeScript applications. GPA required.",
  applicationUrl: "https://jobs.ashbyhq.com/example/1/application", sourceUrl: "https://example.com/job",
  sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: "2026-01-01T00:00:00Z",
  discoveredAt: "2026-01-01T00:00:00Z", isNew: true, isFresh: true,
  freshnessBasis: "first-seen", matchedKeywords: [],
};

describe("guarded application preparation", () => {
  it("restricts navigation and stops before submission by default", () => {
    const handoff = createApplicationHandoff(job);
    expect(handoff.allowedDomains).toEqual(["jobs.ashbyhq.com"]);
    expect(handoff.stopConditions).toContain("final-submit");
  });

  it("uses only verified resume claims", () => {
    const claim = (status: string, allowedUses: string[]) => ({
      id: status, claim: `${status} claim`, skills: ["React"], metrics: [],
      evidence: [{ source: "test", uri: "private://source" }], status, allowedUses,
    });
    const candidate = candidateProfileSchema.parse({
      version: 1,
      identity: { fullName: "Example", location: "Dallas, TX", email: "candidate@example.com", phone: "+1 555 555 0100" },
      authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
      skills: { frontend: ["React"], languages: ["TypeScript"] }, education: [], projects: [], quarantinedClaims: [],
      experience: [{ employer: "Example", title: "Engineer", employmentType: "Intern", start: "2025", end: "2025",
        claims: [claim("verified", ["resume"]), claim("needs-confirmation", ["resume"])], }],
    });
    const brief = createTailoringBrief(job, candidate);
    expect(brief.experienceClaims).toEqual(["Engineer at Example: verified claim"]);
    expect(brief.hardRequirementGaps).toContain("Academic scores require explicit source data");
  });
});
