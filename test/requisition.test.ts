import { describe, expect, it } from "vitest";
import { hasConflictingReceiptUrl, isOriginalRequisition } from "../src/application/requisition.js";
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

  it("rejects another requisition-shaped receipt URL but permits a generic thank-you path", () => {
    expect(hasConflictingReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/apply/654321/thank-you")).toBe(true);
    expect(hasConflictingReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/thank-you")).toBe(false);
    expect(hasConflictingReceiptUrl("test:runner:1", "https://jobs.example.com/apply",
      "https://other.example/thank-you")).toBe(true);
    expect(hasConflictingReceiptUrl("greenhouse:example:ABC12345",
      "https://jobs.example.com/apply/ABC12345",
      "https://jobs.example.com/apply/XYZ67890/thank-you")).toBe(true);
    expect(hasConflictingReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com/apply/thank-you")).toBe(false);
    expect(hasConflictingReceiptUrl(job.id, job.applicationUrl,
      "https://jobs.example.com:8443/apply/123456/thank-you")).toBe(true);
    expect(isOriginalRequisition(page("https://jobs.example.com/apply/123456/step%ZZ"), job)).toBe(false);
  });
});
