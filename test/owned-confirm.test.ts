import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { confirmOwnedSubmission, inspectOwnedReceipt } from "../src/application/owned-confirm.js";
import { applicationPackageSchema } from "../src/application/runner.js";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { submitApplication } from "../src/application/submit.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const job: DiscoveredJob = { id: "greenhouse:example:123456", provider: "greenhouse",
  company: "Example Co", title: "Software Engineer", descriptionText: "Build services",
  applicationUrl: "https://jobs.example.com/apply/123456",
  sourceUrl: "https://jobs.example.com/job/123456", location: null, department: null,
  employmentType: null, workplaceType: null, compensation: null,
  sourcePublishedAt: null, sourceUpdatedAt: null,
  firstSeenAt: "2026-11-24T00:00:00Z", discoveredAt: "2026-11-24T00:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [] };
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [] });

const receipt = (reference = "123456", company = "Example Co", role = "Software Engineer",
  confirmation = "Thank you for applying") =>
  `<h1>${confirmation}</h1><p>${company} - ${role}</p><p>Requisition ${reference}</p>`;

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("owned receipt recovery", () => {
  it("requires a fresh live job-bound receipt after close and reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-owned-receipt-"));
    const packagePath = join(root, "application.json");
    const resumePath = join(root, "resume.pdf");
    const bytes = Buffer.from("%PDF-1.4\nsynthetic fixture\n%%EOF\n");
    await writeFile(resumePath, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const pkg = applicationPackageSchema.parse({ version: 1, browserRuntime: "owned", job, candidate,
      source: { provider: "greenhouse", company: job.company, boardToken: "example", enabled: true,
        allowedApplicationHosts: ["jobs.example.com"] },
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "synthetic", fingerprint: "f".repeat(64),
        renderToken: "a".repeat(64), claimIds: ["claim"] },
      resumePdfPath: resumePath, expectedConfirmation: "Thank you for applying" });
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
    await workflow.create(job.id, job.applicationUrl);
    for (const stage of ["validated", "matched", "tailored"] as const) await workflow.advance(job.id, stage);
    await workflow.advance(job.id, "rendered", { artifactPath: resumePath,
      artifactSha256: digest, sourceFingerprint: pkg.resumeSource.fingerprint });
    await workflow.advance(job.id, "applying");
    let submitCalls = 0;
    await expect(submitApplication(workflow, { currentUrl: () => job.applicationUrl,
      submit: async () => { submitCalls += 1; throw new Error("after-click timeout"); } },
    job.id, "submit", pkg.expectedConfirmation!, pkg.handoff, undefined, undefined, packagePath))
      .rejects.toThrow("after-click timeout");
    expect(submitCalls).toBe(1);
    expect((await workflow.current(job.id))?.stage).toBe("submission-uncertain");
    const verify = async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
      pdfSha256: digest, path: resumePath, pages: 1, verifiedAt: new Date().toISOString() });
    const profile = join(root, "profile");
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, { headless: true });
      await context.route("https://jobs.example.com/**", (route) => route.fulfill({
        contentType: "text/html", body: receipt(),
      }));
      await context.newPage().then((page) => page.goto("https://jobs.example.com/apply/123456/receipt"));
      expect(await inspectOwnedReceipt(context, pkg)).toContain("/receipt");
      await context.close();
      context = await chromium.launchPersistentContext(profile, { headless: true });
      expect(context.pages().map((page) => page.url())).not.toContain("https://jobs.example.com/apply/123456/receipt");
      await expect(confirmOwnedSubmission(pkg, workflow, context, packagePath, true, verify))
        .rejects.toThrow("No job-bound employer receipt");
      expect((await workflow.current(job.id))?.stage).toBe("submission-uncertain");
      await context.route("https://jobs.example.com/**", (route) => route.fulfill({
        contentType: "text/html", body: receipt(),
      }));
      await context.newPage().then((page) => page.goto("https://jobs.example.com/apply/123456/receipt"));
      await expect(confirmOwnedSubmission(pkg, workflow, context, join(root, "wrong.json"), true, verify))
        .rejects.toThrow("No matching owned-browser");
      await expect(confirmOwnedSubmission(pkg, workflow, context, packagePath, false, verify))
        .rejects.toThrow("No matching owned-browser");
      expect(await confirmOwnedSubmission(pkg, workflow, context, packagePath, true, verify))
        .toContain("/receipt");
      expect((await workflow.current(job.id))?.stage).toBe("submitted");
      expect(submitCalls).toBe(1);
    } finally {
      await context?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects wrong host, job, generic text, and ambiguous tabs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-owned-receipt-negative-"));
    const context = await chromium.launchPersistentContext(join(root, "profile"), { headless: true });
    const pkg = applicationPackageSchema.parse({ version: 1, browserRuntime: "owned", job, candidate,
      source: { provider: "greenhouse", company: job.company, boardToken: "example", enabled: true,
        allowedApplicationHosts: ["jobs.example.com"] },
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "synthetic", fingerprint: "f".repeat(64),
        renderToken: "a".repeat(64), claimIds: ["claim"] },
      resumePdfPath: join(root, "resume.pdf"), expectedConfirmation: "Thank you for applying" });
    try {
      let html = receipt("654321");
      await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
      const page = await context.newPage();
      await page.goto("https://other.example.com/apply/123456/receipt");
      await expect(inspectOwnedReceipt(context, pkg)).rejects.toThrow("No job-bound employer receipt");
      await page.goto("https://jobs.example.com/apply/654321/receipt");
      await expect(inspectOwnedReceipt(context, pkg)).rejects.toThrow("No job-bound employer receipt");
      html = receipt("123456", "Other Co");
      await page.reload();
      await expect(inspectOwnedReceipt(context, pkg)).rejects.toThrow("No job-bound employer receipt");
      html = receipt("123456", "Example Co", "Senior Software Engineer");
      await page.reload();
      await expect(inspectOwnedReceipt(context, pkg)).rejects.toThrow("No job-bound employer receipt");
      html = '<h1>Thank you for applying</h1><p>Software Engineer</p><footer>Example Co</footer><p>123456</p>';
      await page.reload();
      await expect(inspectOwnedReceipt(context, pkg)).rejects.toThrow("No job-bound employer receipt");
      html = "<p>Thank you for applying</p><p>Example Co Software Engineer 123456</p>";
      await page.reload();
      await expect(inspectOwnedReceipt(context, pkg)).rejects.toThrow("No job-bound employer receipt");
      html = receipt();
      await page.reload();
      await page.goto(job.applicationUrl);
      await expect(inspectOwnedReceipt(context, pkg, job.applicationUrl))
        .rejects.toThrow("No job-bound employer receipt");
      await page.goto("https://jobs.example.com/apply/123456/receipt");
      await context.newPage().then((duplicate) => duplicate.goto("https://jobs.example.com/apply/123456/receipt"));
      await expect(inspectOwnedReceipt(context, pkg)).rejects.toThrow("More than one");
    } finally {
      await context.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
