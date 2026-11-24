import { describe, expect, it, vi } from "vitest";
import type { JobSource } from "../src/config.js";
import { fetchSourceBatch } from "../src/sources/batch.js";
import type { NormalizedJob } from "../src/types.js";

const sources: JobSource[] = [
  { provider: "greenhouse", company: "Working", boardToken: "working", enabled: true, allowedApplicationHosts: [] },
  { provider: "ashby", company: "Broken", boardName: "broken", enabled: true, allowedApplicationHosts: [] },
  { provider: "lever", company: "Disabled", site: "disabled", region: "global", enabled: false,
    allowedApplicationHosts: [] },
];

const job: NormalizedJob = {
  id: "greenhouse:working:1",
  provider: "greenhouse",
  company: "Working",
  title: "Software Engineer",
  location: "Remote - US",
  department: "Engineering",
  employmentType: "Full time",
  workplaceType: "Remote",
  compensation: null,
  descriptionText: "Build software.",
  applicationUrl: "https://example.com/apply",
  sourceUrl: "https://example.com/job",
  sourcePublishedAt: null,
  sourceUpdatedAt: null,
};

describe("source batch fetching", () => {
  it("keeps successful jobs when another source fails and skips disabled sources", async () => {
    const fetcher = vi.fn(async (source: JobSource) => {
      if (source.company === "Broken") throw new Error("HTTP 503");
      return [job, { ...job, id: `${job.id}:2` }];
    });

    const result = await fetchSourceBatch(sources, 1, new Date("2026-01-01T00:00:00Z"), fetcher);

    expect(result.jobs).toEqual([job]);
    expect(result.failures).toEqual([expect.objectContaining({
      source: expect.objectContaining({ company: "Broken" }),
      message: "HTTP 503",
    })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
