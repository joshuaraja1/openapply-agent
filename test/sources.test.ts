import { describe, expect, it } from "vitest";
import { parseAshbyJobs } from "../src/sources/ashby.js";
import { parseGreenhouseJobs } from "../src/sources/greenhouse.js";
import { parseJsonLdJobs } from "../src/sources/jsonld.js";
import { parseLeverJobs } from "../src/sources/lever.js";
import { parseSmartRecruitersJobs } from "../src/sources/smartrecruiters.js";
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

  it("keeps relative Workday ages without inventing an exact posting time", () => {
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
    expect(job?.sourcePublishedAt).toBeNull();
    expect(job?.sourceAgeLowerBoundDays).toBe(1);
  });

  it("normalizes Lever jobs", () => {
    const [job] = parseLeverJobs([{
      id: "lever-1",
      text: " Junior Software Engineer ",
      hostedUrl: "https://jobs.lever.co/example/lever-1",
      createdAt: 1767323045000,
      workplaceType: "hybrid",
      descriptionPlain: "Build reliable services.",
      categories: { location: "Dallas, TX", team: "Engineering", commitment: "Full-time" },
    }], { site: "example", company: "Example" });
    expect(job).toMatchObject({
      id: "lever:example:lever-1",
      title: "Junior Software Engineer",
      applicationUrl: "https://jobs.lever.co/example/lever-1/apply",
      location: "Dallas, TX",
    });
    expect(job?.sourcePublishedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("normalizes SmartRecruiters jobs", () => {
    const [job] = parseSmartRecruitersJobs({ content: [{
      id: "smart-1",
      name: "Data Engineer",
      releasedDate: "2026-01-02T03:04:05Z",
      postingUrl: "https://jobs.smartrecruiters.com/Example/smart-1",
      applyUrl: "https://jobs.smartrecruiters.com/Example/smart-1/apply",
      location: { city: "Dallas", region: "TX", country: "US", hybrid: true },
      department: { label: "Data" },
      typeOfEmployment: { label: "Full-time" },
      jobAd: { sections: { companyDescription: { text: "<p>Build pipelines</p>" } } },
    }] }, { companyIdentifier: "Example", company: "Example" });
    expect(job).toMatchObject({
      id: "smartrecruiters:Example:smart-1",
      descriptionText: "Build pipelines",
      workplaceType: "Hybrid",
      location: "Dallas, TX, US",
    });
  });

  it("extracts schema.org JobPosting JSON-LD", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      identifier: { value: "jsonld-1" },
      title: "AI Engineer",
      description: "<p>Build RAG systems</p>",
      datePosted: "2026-01-02",
      employmentType: "FULL_TIME",
      jobLocationType: "TELECOMMUTE",
      hiringOrganization: { name: "Example AI" },
      jobLocation: { address: { addressLocality: "Dallas", addressRegion: "TX", addressCountry: "US" } },
      baseSalary: { currency: "USD", value: { minValue: 100000, maxValue: 140000, unitText: "YEAR" } },
      url: "https://example.com/careers/jsonld-1",
    })}</script>`;
    const [job] = parseJsonLdJobs(html, { sourceUrl: "https://example.com/careers", company: "Fallback" });
    expect(job).toMatchObject({
      id: "jsonld:jsonld-1",
      company: "Example AI",
      title: "AI Engineer",
      descriptionText: "Build RAG systems",
      compensation: "USD 100000-140000 YEAR",
    });
  });
});
