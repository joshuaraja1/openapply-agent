import { describe, expect, it, vi } from "vitest";
import { officialSourceForLead, verifyOfficialBrowserLeads } from "../src/browser/verify-official.js";
import type { BrowserLead } from "../src/browser/schema.js";
import type { NormalizedJob } from "../src/types.js";

const link = "https://job-boards.greenhouse.io/example/jobs/1234";
const lead: BrowserLead = { platform: "generic", title: "Software Engineer", url: link,
  sourceSearchUrl: "https://job-boards.greenhouse.io/example", observedAt: "2026-01-01T00:00:00Z" };
const live: NormalizedJob = { id: "greenhouse:example:1234", provider: "greenhouse",
  company: "example", title: "Software Engineer", location: "Remote", department: null,
  employmentType: null, workplaceType: "Remote", compensation: null,
  descriptionText: "Build TypeScript services", applicationUrl: link,
  sourceUrl: "https://boards-api.greenhouse.io/v1/boards/example/jobs/1234",
  sourcePublishedAt: null, sourceUpdatedAt: null };

describe("official browser lead verification", () => {
  it("recognizes exact HTTPS ATS posting URLs only", () => {
    expect(officialSourceForLead(link)?.postingId).toBe("1234");
    expect(officialSourceForLead("https://jobs.ashbyhq.com/acme/abc-123")?.source.provider)
      .toBe("ashby");
    expect(officialSourceForLead("https://jobs.eu.lever.co/acme/abc-123")?.source.provider)
      .toBe("lever");
    expect(officialSourceForLead("https://jobs.smartrecruiters.com/Acme/744000138717897-software-engineer")?.postingId)
      .toBe("744000138717897");
    for (const url of ["http://job-boards.greenhouse.io/example/jobs/1234",
      "https://job-boards.greenhouse.io.evil.test/example/jobs/1234",
      "https://job-boards.greenhouse.io/example/jobs/1234/other",
      "https://jobs.ashbyhq.com/acme", "https://www.linkedin.com/jobs/view/1234/",
      "https://jobs.smartrecruiters.com.evil.test/Acme/744000138717897",
      "https://jobs.smartrecruiters.com/Acme/744000138717897/other"]) {
      expect(officialSourceForLead(url)).toBeNull();
    }
  });

  it("promotes a SmartRecruiters slug only when its posting ID is live", async () => {
    const url = "https://jobs.smartrecruiters.com/Acme/744000138717897-software-engineer";
    const boardLead = { ...lead, url };
    const official = { ...live, id: "smartrecruiters:Acme:744000138717897" as const,
      provider: "smartrecruiters" as const, company: "Acme", sourceUrl: url,
      applicationUrl: `${url}/apply` };
    expect(await verifyOfficialBrowserLeads([boardLead], new Date(), async () => []))
      .toHaveLength(0);
    const verified = await verifyOfficialBrowserLeads([boardLead], new Date(), async () => [official]);
    expect(verified).toHaveLength(1);
    expect(verified[0]?.source.provider).toBe("smartrecruiters");
    expect(verified[0]?.source.allowedApplicationHosts).toContain("jobs.smartrecruiters.com");
  });

  it("accepts provider-owned application paths bound to the exact posting", async () => {
    for (const [url, applicationUrl, provider, company, id] of [
      ["https://jobs.ashbyhq.com/acme/abc-123",
        "https://jobs.ashbyhq.com/acme/abc-123/application", "ashby", "acme", "abc-123"],
      ["https://jobs.lever.co/acme/abc-123",
        "https://jobs.lever.co/acme/abc-123/apply", "lever", "acme", "abc-123"],
      ["https://jobs.eu.lever.co/acme/abc-123",
        "https://jobs.eu.lever.co/acme/abc-123/apply", "lever", "acme", "abc-123"],
    ]) {
      const result = await verifyOfficialBrowserLeads([{ ...lead, url: url! }], new Date(),
        async () => [{ ...live, id: `${provider}:${company}:${id}`,
          provider: provider as NormalizedJob["provider"], company: company!,
          applicationUrl: applicationUrl! }]);
      expect(result, url).toHaveLength(1);
    }
    expect(await verifyOfficialBrowserLeads([
      { ...lead, url: "https://jobs.eu.lever.co/acme/abc-123" }], new Date(),
    async () => [{ ...live, id: "lever:acme:abc-123", provider: "lever", company: "acme",
      applicationUrl: "https://jobs.lever.co/acme/abc-123/apply" }])).toHaveLength(0);
  });

  it("requires a matching live posting and deduplicates repeated leads", async () => {
    const fetcher = vi.fn(async () => [live]);
    const verified = await verifyOfficialBrowserLeads([lead, lead,
      { ...lead, url: "https://job-boards.greenhouse.io/example/jobs/5678" }],
    new Date("2026-01-01T01:00:00Z"), fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(verified).toHaveLength(1);
    expect(verified[0]?.job.id).toBe(live.id);
    expect(verified[0]?.source.allowedApplicationHosts).toContain("job-boards.greenhouse.io");
  });

  it("deduplicates the same official posting found through different board searches", async () => {
    const variants: BrowserLead[] = [
      { ...lead, sourceSearchUrl: "https://www.linkedin.com/jobs/search/" },
      { ...lead, sourceSearchUrl: "https://jobright.ai/jobs/recommend",
        url: "https://boards.greenhouse.io/example/jobs/1234?utm_source=jobright" },
      { ...lead, sourceSearchUrl: "https://app.joinhandshake.com/stu/jobs" },
    ];
    const fetcher = vi.fn(async () => [live]);
    const verified = await verifyOfficialBrowserLeads(variants, new Date(), fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(verified).toHaveLength(1);
    expect(verified[0]?.job.id).toBe("greenhouse:example:1234");
  });

  it("rejects unsafe application destinations even when a matching ID appears in a provider result", async () => {
    for (const applicationUrl of ["http://jobs.example.com/apply",
      "https://127.0.0.1/apply", "https://localhost/apply",
      "https://127.0.0.1.nip.io/apply", "https://evil.example.com/apply",
      "https://jobs.example.com:8443/apply", "https://user:pass@jobs.example.com/apply",
      "https://job-boards.greenhouse.io/example/jobs/5678",
      "https://job-boards.greenhouse.io/another/jobs/1234"]) {
      expect(await verifyOfficialBrowserLeads([lead], new Date(), async () =>
        [{ ...live, applicationUrl }])).toHaveLength(0);
    }
    expect(await verifyOfficialBrowserLeads([lead], new Date(), async () =>
      [{ ...live, provider: "ashby" }])).toHaveLength(0);
    expect(await verifyOfficialBrowserLeads([lead], new Date(), async () =>
      [{ ...live, applicationUrl: `${link}?utm_source=board` }])).toHaveLength(1);
  });

  it("does not promote stale, incomplete, or failed provider results", async () => {
    expect(await verifyOfficialBrowserLeads([lead], new Date(), async () => []))
      .toHaveLength(0);
    expect(await verifyOfficialBrowserLeads([lead], new Date(), async () => [{ ...live,
      descriptionText: "" }])).toHaveLength(0);
    expect(await verifyOfficialBrowserLeads([lead], new Date(), async () => {
      throw new Error("provider unavailable");
    })).toHaveLength(0);
  });
});
