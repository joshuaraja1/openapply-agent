import { describe, expect, it } from "vitest";
import { candidateProfileSchema, searchPreferencesSchema } from "../src/candidate/schema.js";
import { isEligibleQueuedJob } from "../src/application/queue-eligibility.js";
import type { DiscoveredJob } from "../src/types.js";

const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Candidate", location: "Dallas, TX", email: "person@example.com",
    phone: "+1 555 555 0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { languages: ["TypeScript"] }, education: [], projects: [], quarantinedClaims: [],
  experience: [{ employer: "Example", title: "Engineer", employmentType: "Intern", start: "2025",
    end: "2025", claims: [{ id: "supported", claim: "Built TypeScript services",
      skills: ["TypeScript"], evidence: [{ source: "user-confirmed", uri: "private:history" }],
      status: "user-confirmed", allowedUses: ["matching"] }] }],
});
const preferences = searchPreferencesSchema.parse({ version: 1,
  targetRoles: ["software engineer"], workArrangements: { preferred: ["remote"], accepted: ["hybrid"] },
  compensation: { preferredBaseFloor: 100000 }, applicationPolicy: { dailyTarget: 10, dailyHardCap: 25 },
});
const job: DiscoveredJob = { id: "ashby:example:1", provider: "ashby", company: "Example",
  title: "Software Engineer", location: "Remote US", department: null, employmentType: null,
  workplaceType: "Remote", compensation: null, descriptionText: "Build TypeScript services",
  applicationUrl: "https://example.com/apply", sourceUrl: "https://example.com/job",
  sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: "2026-01-01T00:00:00Z",
  discoveredAt: "2026-01-01T00:00:00Z", isNew: true, isFresh: true,
  freshnessBasis: "first-seen", matchedKeywords: [],
};

describe("scheduled queue eligibility", () => {
  it("rechecks matching against the current approved profile", () => {
    expect(isEligibleQueuedJob(job, candidate, preferences)).toBe(true);
    expect(isEligibleQueuedJob({ ...job, descriptionText: "Build Rust services" },
      candidate, preferences)).toBe(false);
    expect(isEligibleQueuedJob({ ...job, title: "Senior Software Engineer" },
      candidate, preferences)).toBe(false);
  });
});
