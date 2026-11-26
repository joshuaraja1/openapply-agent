import { describe, expect, it } from "vitest";
import { confirmManualSubmission } from "../src/application/manual-confirm.js";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { applicationPackageSchema } from "../src/application/runner.js";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const job: DiscoveredJob = { id: "test:manual:1", provider: "greenhouse", company: "Example Co",
  title: "Engineer", descriptionText: "Build Python services", applicationUrl: "https://jobs.example.com/apply",
  sourceUrl: "https://jobs.example.com/job", location: null, department: null, employmentType: null,
  workplaceType: null, compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null,
  firstSeenAt: "2026-11-24T00:00:00Z", discoveredAt: "2026-11-24T00:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [] };
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [] });

describe("manual submission reconciliation", () => {
  it("records submission only after verified PDF and employer confirmation in saved tab", async () => {
    const pkg = applicationPackageSchema.parse({ version: 1, job, candidate,
      source: { provider: "greenhouse", company: "Example Co", boardToken: "example", enabled: true,
        allowedApplicationHosts: ["jobs.example.com"] },
      handoff: createApplicationHandoff(job, true),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/private/resume.pdf", expectedConfirmation: "Thank you for applying",
      browserEndpoint: "http://127.0.0.1:3333/mcp" });
    expect(applicationPackageSchema.safeParse({ ...pkg, expectedConfirmation: "   " }).success).toBe(false);
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
    await workflow.create(job.id, job.applicationUrl);
    await workflow.advance(job.id, "validated");
    await workflow.advance(job.id, "matched");
    await workflow.advance(job.id, "tailored");
    await workflow.advance(job.id, "rendered", { artifactPath: pkg.resumePdfPath,
      artifactSha256: "b".repeat(64), sourceFingerprint: pkg.resumeSource.fingerprint });
    await workflow.advance(job.id, "applying");
    await workflow.advance(job.id, "waiting-human", { blocker: "CAPTCHA requires human action", browserPageId: 7,
      browserGroupId: "AAAAAAAAAAAAAAAA", browserEndpoint: pkg.browserEndpoint! });
    const verify = async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
      pdfSha256: "b".repeat(64), path: pkg.resumePdfPath, pages: 1, verifiedAt: new Date().toISOString() });
    const unconfirmed = { inspectHandoff: async () => ({ url: "https://jobs.example.com/other",
      title: "Apply", controls: [], visibleText: '- paragraph "Thank you for applying"' }) };
    const attestation = { version: 1 as const, jobId: job.id, browserPageId: 7,
      confirmationUrl: "https://jobs.example.com/other", expectedConfirmation: "Thank you for applying",
      attestCorrectJob: true as const };
    await expect(confirmManualSubmission(pkg, workflow, unconfirmed as never,
      { ...attestation, expectedConfirmation: "   " }, verify)).rejects.toThrow();
    await expect(confirmManualSubmission(pkg, workflow, unconfirmed as never, attestation, verify))
      .rejects.toThrow("not visible");
    expect((await workflow.current(job.id))?.stage).toBe("waiting-human");
    const confirmed = { inspectHandoff: async () => ({ url: "https://jobs.example.com/confirmation",
      title: "Confirmation", controls: [], visibleText: '- heading "Thank you for applying"' }) };
    await expect(confirmManualSubmission(pkg, workflow, confirmed as never, attestation, verify))
      .rejects.toThrow("changed after attestation");
    await confirmManualSubmission(pkg, workflow, confirmed as never,
      { ...attestation, confirmationUrl: "https://jobs.example.com/confirmation" }, verify);
    expect((await workflow.current(job.id))?.stage).toBe("submitted");
  });
});
