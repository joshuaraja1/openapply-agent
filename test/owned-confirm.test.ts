import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { confirmOwnedSubmission, type OwnedConfirmationAttestation } from "../src/application/owned-confirm.js";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { applicationPackageSchema } from "../src/application/runner.js";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import type { DiscoveredJob } from "../src/types.js";

const job: DiscoveredJob = { id: "greenhouse:example:123456", provider: "greenhouse",
  company: "Example Co", title: "Software Engineer", descriptionText: "Build software",
  applicationUrl: "https://jobs.example.com/apply/123456", sourceUrl: "https://jobs.example.com/job/123456",
  location: null, department: null, employmentType: null, workplaceType: null, compensation: null,
  sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: "2026-11-24T00:00:00Z",
  discoveredAt: "2026-11-24T00:00:00Z", isNew: true, isFresh: true,
  freshnessBasis: "first-seen", matchedKeywords: [] };
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [] });
const pdfSha256 = "b".repeat(64);
const pkg = applicationPackageSchema.parse({ version: 1, browserRuntime: "owned", job, candidate,
  source: { provider: "greenhouse", company: "Example Co", boardToken: "example", enabled: true,
    allowedApplicationHosts: ["jobs.example.com"] }, handoff: createApplicationHandoff(job, false),
  resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
  resumePdfPath: "/private/resume.pdf", expectedConfirmation: "Thank you for applying" });
const verify = async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
  pdfSha256, path: pkg.resumePdfPath, pages: 1, verifiedAt: new Date().toISOString() });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openapply-owned-confirm-"));
  const profile = join(root, "profile");
  await mkdir(profile, { mode: 0o700 });
  const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
  await workflow.create(job.id, job.applicationUrl);
  for (const stage of ["validated", "matched", "tailored"] as const) await workflow.advance(job.id, stage);
  await workflow.advance(job.id, "rendered", { artifactPath: pkg.resumePdfPath, artifactSha256: pdfSha256,
    sourceFingerprint: pkg.resumeSource.fingerprint });
  await workflow.advance(job.id, "applying");
  await workflow.advance(job.id, "submit-claimed", { browserPageUrl: job.applicationUrl,
    ownedProfileDirectory: profile });
  await workflow.advance(job.id, "submission-uncertain", { blocker: "Submission outcome is unknown" });
  const attestation: OwnedConfirmationAttestation = { version: 1, jobId: job.id,
    officialUrl: job.applicationUrl, preSubmitUrl: job.applicationUrl,
    confirmationUrl: "https://jobs.example.com/confirmation/123456", browserProfileDirectory: profile,
    artifactSha256: pdfSha256, expectedConfirmation: pkg.expectedConfirmation!, attestCorrectJob: true };
  return { root, profile, workflow, attestation };
}

describe("owned-browser uncertain submission confirmation", () => {
  it("fails closed for wrong job, URL, profile, artifact, missing profile, and missing tab", async () => {
    const { root, profile, workflow, attestation } = await setup();
    let launches = 0;
    const launch = async () => { launches += 1; return { context: { pages: () => [] }, close: async () => {} }; };
    try {
      for (const change of [{ jobId: "another-job" }, { officialUrl: "https://jobs.example.com/apply/999999" },
        { preSubmitUrl: "https://jobs.example.com/apply/999999" },
        { browserProfileDirectory: join(root, "other-profile") }, { artifactSha256: "c".repeat(64) }]) {
        await expect(confirmOwnedSubmission(pkg, workflow, { ...attestation, ...change }, profile,
          launch as never, verify)).rejects.toThrow();
      }
      expect(launches).toBe(0);
      await expect(confirmOwnedSubmission(pkg, workflow, attestation, join(root, "missing"),
        launch as never, verify)).rejects.toThrow();
      await expect(confirmOwnedSubmission(pkg, workflow, attestation, profile,
        launch as never, verify)).rejects.toThrow("tab is missing");
      expect((await workflow.current(job.id))?.stage).toBe("submission-uncertain");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "requires a live same-job employer receipt in a controlled Chromium page", async () => {
      const { root, profile, workflow, attestation } = await setup();
      const context = await chromium.launchPersistentContext(profile, { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) => route.fulfill({ contentType: "text/html",
          body: '<h1>Thank you for applying</h1><p>Example Co Software Engineer</p>' }));
        const page = await context.newPage();
        await page.goto(attestation.confirmationUrl);
        const launch = async () => ({ context, close: async () => {} });
        await confirmOwnedSubmission(pkg, workflow, attestation, profile, launch, verify);
        expect((await workflow.current(job.id))?.stage).toBe("submitted");
      } finally { await context.close(); await rm(root, { recursive: true, force: true }); }
    }, 30_000);

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "rejects a visible generic receipt without the exact company and role", async () => {
      const { root, profile, workflow, attestation } = await setup();
      const context = await chromium.launchPersistentContext(profile, { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) => route.fulfill({ contentType: "text/html",
          body: '<h1>Thank you for applying</h1><p>Another Co Software Engineer</p>' }));
        const page = await context.newPage();
        await page.goto(attestation.confirmationUrl);
        await expect(confirmOwnedSubmission(pkg, workflow, attestation, profile,
          async () => ({ context, close: async () => {} }), verify)).rejects.toThrow("exact requisition, company, and role");
        expect((await workflow.current(job.id))?.stage).toBe("submission-uncertain");
      } finally { await context.close(); await rm(root, { recursive: true, force: true }); }
    }, 30_000);

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "rejects a matching job page without visible confirmation", async () => {
      const { root, profile, workflow, attestation } = await setup();
      const context = await chromium.launchPersistentContext(profile, { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) => route.fulfill({ contentType: "text/html",
          body: '<h1>Application in progress</h1><p>Example Co Software Engineer requisition 123456</p>' }));
        const page = await context.newPage();
        await page.goto(attestation.confirmationUrl);
        await expect(confirmOwnedSubmission(pkg, workflow, attestation, profile,
          async () => ({ context, close: async () => {} }), verify)).rejects.toThrow("not visibly present");
        expect((await workflow.current(job.id))?.stage).toBe("submission-uncertain");
      } finally { await context.close(); await rm(root, { recursive: true, force: true }); }
    }, 30_000);
});
