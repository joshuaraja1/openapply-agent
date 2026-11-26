import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { AgentBrowser } from "../src/browser/actions.js";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { applicationPackageSchema, runApplicationPackage } from "../src/application/runner.js";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const html = `<!doctype html><title>Example Co application</title>
<h1>Example Co Software Engineer</h1>
<section id="first"><label>Full name<input name="name" required></label>
<label>Email<input name="email" type="email" required></label>
<label>Resume<input name="resume" type="file" required></label>
<button type="button" onclick="document.getElementById('first').hidden=true;document.getElementById('second').hidden=false;history.pushState({},'', '/apply/123456/step-2')">Continue</button></section>
<section id="second" hidden><label>Required legal question<input name="legal" required></label>
<button type="submit" onclick="document.getElementById('done').hidden=false;this.hidden=true">Submit application</button></section>
<p id="done" hidden>Thank you for applying to Example Co as Software Engineer</p>`;

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("owned handoff restart", () => {
  it("restarts a two-step form with a fresh resume upload and job-bound answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-owned-handoff-"));
    const resumePath = join(root, "verified-resume.pdf");
    const bytes = Buffer.from("%PDF-1.4\nsynthetic fixture\n%%EOF\n");
    await writeFile(resumePath, bytes);
    const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
    const job: DiscoveredJob = { id: "greenhouse:example:123456", provider: "greenhouse",
      company: "Example Co", title: "Software Engineer", location: "Remote",
      department: null, employmentType: null, workplaceType: "Remote", compensation: null,
      descriptionText: "Build software", applicationUrl: "https://jobs.example.com/apply/123456",
      sourceUrl: "https://jobs.example.com/job/123456", sourcePublishedAt: null,
      sourceUpdatedAt: null, firstSeenAt: "2026-11-24T00:00:00Z",
      discoveredAt: "2026-11-24T00:00:00Z", isNew: true, isFresh: true,
      freshnessBasis: "first-seen", matchedKeywords: [] };
    const candidate = candidateProfileSchema.parse({ version: 1,
      identity: { fullName: "Test Candidate", location: "Dallas, TX",
        email: "test@example.com", phone: "555-0100" },
      authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
      skills: {}, education: [], experience: [], projects: [] });
    const pkg = applicationPackageSchema.parse({ version: 1, browserRuntime: "owned", job,
      source: { provider: "greenhouse", boardToken: "example", company: "Example Co",
        enabled: true, allowedApplicationHosts: ["jobs.example.com"] }, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "synthetic fixture", fingerprint: "f".repeat(64),
        renderToken: "a".repeat(64), claimIds: ["fixture-claim"] },
      resumePdfPath: resumePath, expectedConfirmation: "Thank you for applying" });
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
    const profile = join(root, "profile");
    const observedUploads: string[] = [];
    const verify = async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
      pdfSha256, path: resumePath, pages: 1, verifiedAt: new Date().toISOString() });
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, { headless: true });
      await context.route("https://jobs.example.com/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
      const first = await runApplicationPackage(pkg, workflow, profile, {
        validateOfficial: async () => true, verify,
        browserFactory: async (hosts, artifacts) => ({ browser: new AgentBrowser(context!, hosts, artifacts), close: async () => {} }),
      });
      expect(first.checkpoint.stage).toBe("waiting-human");
      expect(first.checkpoint.blocker).toContain("Required legal question");
      expect(first.checkpoint.resumeUploaded).toBe(true);
      const firstPage = context.pages().at(-1)!;
      observedUploads.push(await firstPage.locator('input[type="file"]').evaluate((input) =>
        (input as HTMLInputElement).files?.[0]?.name ?? ""));
      await context.close();
      context = await chromium.launchPersistentContext(profile, { headless: true });
      await context.route("https://jobs.example.com/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
      const second = await runApplicationPackage(pkg, workflow, profile, {
        resumedJobId: job.id, humanAnswerApproval: { jobId: job.id, browserPageId: 0,
          approveFinalSubmission: true, answers: new Map([["Required legal question", "Candidate answer"]]) },
        validateOfficial: async () => true, verify,
        browserFactory: async (hosts, artifacts) => ({ browser: new AgentBrowser(context!, hosts, artifacts), close: async () => {} }),
      });
      const secondPage = context.pages().at(-1)!;
      observedUploads.push(await secondPage.locator('input[type="file"]').evaluate((input) =>
        (input as HTMLInputElement).files?.[0]?.name ?? ""));
      expect(second.checkpoint.stage).toBe("submitted");
      expect(secondPage.url()).toContain("/apply/123456/step-2");
      expect(observedUploads).toEqual(["verified-resume.pdf", "verified-resume.pdf"]);
      expect(await secondPage.locator("#done").isVisible()).toBe(true);
    } finally {
      await context?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
