import { describe, expect, it } from "vitest";
import { hasUnboundReceiptUrl, isOriginalRequisition } from "../src/application/requisition.js";
import type { DiscoveredJob } from "../src/types.js";

const job = { id: "greenhouse:example:123456", title: "Software Engineer",
  company: "Example Co", applicationUrl: "https://jobs.example.com/apply/123456" } as DiscoveredJob;
const page = (url: string, visibleText?: string) => ({ url, title: "Apply", controls: [],
  ...(visibleText ? { visibleText } : {}) });

describe("requisition binding", () => {
  it("accepts the original job and its own steps but rejects another same-host job", () => {
    expect(isOriginalRequisition(page(job.applicationUrl), job)).toBe(true);
    expect(isOriginalRequisition(page(`${job.applicationUrl}/step-2`), job)).toBe(true);
    expect(isOriginalRequisition(page("https://jobs.example.com/apply/654321/step-2",
      "Example Co Software Engineer application"), job)).toBe(false);
  });

  it("rejects changed generic URLs even when unrelated page text mentions the role", () => {
    const generic = { ...job, id: "test:runner:1", applicationUrl: "https://jobs.example.com/apply" };
    expect(isOriginalRequisition(page(generic.applicationUrl), generic)).toBe(true);
    expect(isOriginalRequisition(page("https://jobs.example.com/apply/step-2"), generic)).toBe(false);
    expect(isOriginalRequisition(page("https://jobs.example.com/apply/step-2",
      "Apply to Data Engineer at Example Co. Related jobs: Software Engineer"), generic)).toBe(false);
    expect(isOriginalRequisition(page("https://jobs.example.com:8443/apply/step-2"), generic)).toBe(false);
  });

  it("requires the original job path in a receipt until a provider can prove another format", () => {
    expect(hasUnboundReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/apply/654321/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl("test:runner:1", "https://jobs.example.com/apply",
      "https://other.example/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl("greenhouse:example:ABC12345",
      "https://jobs.example.com/apply/ABC12345",
      "https://jobs.example.com/apply/XYZ67890/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/apply/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com:8443/apply/123456/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/job/654321/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl("test:runner:1", "https://jobs.example.com/apply",
      "https://jobs.example.com/job/654321/thank-you")).toBe(true);
    expect(hasUnboundReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/apply/123456/thank-you")).toBe(false);
    expect(isOriginalRequisition(page("https://jobs.example.com/apply/123456/step%ZZ"), job)).toBe(false);
  });
});
