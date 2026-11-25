import { describe, expect, it } from "vitest";
import { extractBrowserLeads } from "../src/browser/links.js";

describe("browser lead extraction", () => {
  const context = (platform: "linkedin" | "jobright" | "handshake" | "generic") => ({
    platform,
    sourceSearchUrl: "https://example.com/search",
    observedAt: "2026-01-02T03:04:05.000Z",
  });

  it("keeps only LinkedIn job-detail URLs and removes tracking", () => {
    const leads = extractBrowserLeads([
      "[Software Engineer](https://www.linkedin.com/jobs/view/123/?trackingId=abc)",
      "[Company](https://www.linkedin.com/company/example)",
    ].join("\n"), context("linkedin"));
    expect(leads).toEqual([expect.objectContaining({
      title: "Software Engineer",
      url: "https://www.linkedin.com/jobs/view/123/",
    })]);
  });

  it("deduplicates Jobright links", () => {
    const leads = extractBrowserLeads([
      "[AI Engineer](https://jobright.ai/jobs/info/abc?source=feed)",
      "https://jobright.ai/jobs/info/abc?source=other",
    ].join("\n"), context("jobright"));
    expect(leads).toHaveLength(1);
    expect(leads[0]?.title).toBe("AI Engineer");
  });

  it("accepts Handshake job URLs but not navigation", () => {
    const leads = extractBrowserLeads([
      "[Data Engineer](https://app.joinhandshake.com/stu/jobs/456)",
      "[Profile](https://app.joinhandshake.com/stu/profile)",
    ].join("\n"), context("handshake"));
    expect(leads.map((lead) => lead.url)).toEqual(["https://app.joinhandshake.com/stu/jobs/456"]);
  });

  it("keeps generic job paths on the configured origin and excludes private links", () => {
    const leads = extractBrowserLeads([
      "[Role](https://example.com/careers/engineering/123?jobId=123&access_token=secret)",
      "[Account](https://example.com/account/settings)",
      "[Other site](https://other.example/jobs/789)",
      "[Token](https://example.com/jobs/456?token=secret)",
      "[Userinfo](https://user:secret@example.com/jobs/789)",
      "[API key](https://example.com/jobs/999?api_key=secret)",
    ].join("\n"), { ...context("generic"), ownedGeneric: true });
    expect(leads.map((lead) => lead.url)).toEqual([
      "https://example.com/careers/engineering/123?jobId=123",
      "https://example.com/jobs/456",
      "https://example.com/jobs/999",
    ]);
  });

  it("keeps external employer links from existing BrowserOS generic searches", () => {
    const leads = extractBrowserLeads(
      "[Role](https://employer.example/careers/123?jobId=123&access_token=secret)", context("generic"));
    expect(leads.map((lead) => lead.url)).toEqual(["https://employer.example/careers/123?jobId=123"]);
  });
});
