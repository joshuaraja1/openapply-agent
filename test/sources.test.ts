import { describe, expect, it } from "vitest";
import { parseAshbyJobs } from "../src/sources/ashby.js";
import { parseGreenhouseJobs } from "../src/sources/greenhouse.js";
import { parseWorkdayJobs } from "../src/sources/workday.js";

describe("ATS adapters", () => {
  it("normalizes Greenhouse jobs", () => {
    const [job] = parseGreenhouseJobs({ jobs: [{
      id: 42,
      title: " Software Engineer ",
      absolute_url: "https://example.com/jobs/42",
      content: "<p>Build &amp; test APIs</p>",
      location: { name: "Remote - US" },
      updated_at: "2026-01-02T03:04:05Z",
    }] }, { boardToken: "example", company: "Example" });
    expect(job).toMatchObject({
      id: "greenhouse:example:42",
      title: "Software Engineer",
      descriptionText: "Build & test APIs",
    });
  });

  it("normalizes Ashby jobs and compensation", () => {
    const [job] = parseAshbyJobs({ jobs: [{
      id: "abc",
      title: "Product Engineer",
      jobUrl: "https://jobs.ashbyhq.com/example/abc",
      applyUrl: "https://jobs.ashbyhq.com/example/abc/application",
      descriptionPlain: "React and Node.js",
      compensation: { compensationTierSummary: "$120,000-$150,000" },
      publishedAt: "2026-01-02T03:04:05Z",
    }] }, { boardName: "example", company: "Example" });
    expect(job?.applicationUrl).toContain("/application");
    expect(job?.compensation).toBe("$120,000-$150,000");
  });

  it("converts relative Workday dates", () => {
    const [job] = parseWorkdayJobs({ jobPostings: [{
      title: "Data Engineer",
      externalPath: "/job/Example_R-123",
      locationsText: "Dallas, TX",
      postedOn: "Posted Yesterday",
    }] }, {
      host: "example.wd1.myworkdayjobs.com",
      tenant: "example",
      site: "Careers",
      company: "Example",
    }, new Date("2026-01-10T12:00:00Z"));
    expect(job?.sourcePublishedAt).toBe("2026-01-09T12:00:00.000Z");
  });
});
