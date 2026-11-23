import { describe, expect, it } from "vitest";
import { discoveryInputSchema } from "../src/config.js";
import { evaluateJob, markJobsReported, selectFreshnessTier } from "../src/discovery.js";
import type { DiscoveryState, NormalizedJob } from "../src/types.js";

const input = discoveryInputSchema.parse({
  sources: [{ provider: "greenhouse", company: "Example", boardToken: "example" }],
  includeKeywords: ["software"],
  excludeKeywords: ["staff"],
});
const job: NormalizedJob = {
  id: "greenhouse:example:1",
  provider: "greenhouse",
  company: "Example",
  title: "Software Engineer",
  location: "Remote - US",
  department: "Engineering",
  employmentType: "Full time",
  workplaceType: "Remote",
  compensation: "$100,000-$140,000",
  descriptionText: "TypeScript and React",
  applicationUrl: "https://example.com/apply",
  sourceUrl: "https://example.com/job",
  sourcePublishedAt: "2026-01-10T10:00:00Z",
  sourceUpdatedAt: null,
};

describe("job discovery policy", () => {
  it("tracks freshness and first-seen state", () => {
    const state: DiscoveryState = { jobs: {} };
    const result = evaluateJob(job, input, state, new Date("2026-01-11T10:00:00Z"));
    expect(result).toMatchObject({ isNew: true, isFresh: true, matchedKeywords: ["software"] });
  });

  it("uses the fallback tier only when the preferred tier is empty", () => {
    const evaluated = evaluateJob(job, input, { jobs: {} }, new Date("2026-01-12T10:00:00Z"));
    expect(evaluated).not.toBeNull();
    expect(selectFreshnessTier([evaluated!], 24, 168, new Date("2026-01-12T10:00:00Z")).tier)
      .toBe("fallback");
  });

  it("marks queued jobs so later runs can deduplicate them", () => {
    const state: DiscoveryState = {
      jobs: {
        [job.id]: {
          firstSeenAt: "2026-01-11T10:00:00.000Z",
          lastSeenAt: "2026-01-11T10:00:00.000Z",
        },
      },
    };
    markJobsReported(state, [job.id], new Date("2026-01-11T11:00:00Z"));
    expect(state.jobs[job.id]?.reportedAt).toBe("2026-01-11T11:00:00.000Z");
  });
});
