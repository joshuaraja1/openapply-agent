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
});
