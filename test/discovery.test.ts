import { describe, expect, it } from "vitest";
import { discoveryInputSchema } from "../src/config.js";
import { evaluateJob, freshnessPriority, markJobsReported, selectFreshnessTier } from "../src/discovery.js";
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

  it("classifies older postings as fallback when no recent posting exists", () => {
    const evaluated = evaluateJob(job, input, { jobs: {} }, new Date("2026-01-12T10:00:00Z"));
    expect(evaluated).not.toBeNull();
    expect(selectFreshnessTier([evaluated!], 24, 168, new Date("2026-01-12T10:00:00Z")).tier)
      .toBe("fallback");
  });

  it("keeps older active postings as backfill even when recent jobs exist", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const recent = evaluateJob({ ...job, id: "recent", sourcePublishedAt: "2026-01-15T08:00:00Z" },
      input, { jobs: {} }, now)!;
    const weekOld = evaluateJob({ ...job, id: "week", sourcePublishedAt: "2026-01-08T10:00:00Z" },
      input, { jobs: {} }, now)!;
    const twoWeeksOld = evaluateJob({ ...job, id: "two-weeks", sourcePublishedAt: "2026-01-01T10:00:00Z" },
      input, { jobs: {} }, now)!;
    const selected = selectFreshnessTier([twoWeeksOld, weekOld, recent], 48, null, now);
    expect(selected.tier).toBe("mixed");
    expect(selected.jobs.map((entry) => entry.id)).toEqual(["recent", "week", "two-weeks"]);
    expect(weekOld.isFresh).toBe(false);
    expect(selectFreshnessTier([twoWeeksOld, weekOld, recent], 48, 168, now).jobs.map((entry) => entry.id))
      .toEqual(["recent", "week"]);
  });

  it("does not claim an undated newly observed role was posted recently", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const undated = evaluateJob({ ...job, id: "undated", sourcePublishedAt: null },
      input, { jobs: {} }, now)!;
    const dated = evaluateJob({ ...job, id: "dated", sourcePublishedAt: "2026-01-15T09:00:00Z" },
      input, { jobs: {} }, now)!;
    expect(undated.isFresh).toBe(false);
    expect(undated.freshnessBasis).toBe("first-seen");
    expect(selectFreshnessTier([undated], 48, null, now).tier).toBe("observed");
    expect(freshnessPriority(dated, 48, now)).toBeLessThan(freshnessPriority(undated, 48, now));
    const future = evaluateJob({ ...job, id: "future", sourcePublishedAt: "2026-01-16T09:00:00Z" },
      input, { jobs: {} }, now)!;
    expect(future.isFresh).toBe(false);
    expect(freshnessPriority(future, 48, now)).toBe(2);
  });

  it("allows no age cutoff by default and a configured cutoff when requested", () => {
    expect(input.maximumFreshnessHours).toBeNull();
    expect(discoveryInputSchema.parse({ sources: input.sources,
      preferredFreshnessHours: 48, maximumFreshnessHours: 336 }).maximumFreshnessHours).toBe(336);
    expect(() => discoveryInputSchema.parse({ sources: input.sources,
      preferredFreshnessHours: 48, maximumFreshnessHours: 24 })).toThrow();
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
