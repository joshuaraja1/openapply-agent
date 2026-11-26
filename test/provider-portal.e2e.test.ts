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
import type { Provider, DiscoveredJob } from "../src/types.js";

type Scenario = "success" | "unknown-required" | "wrong-requisition"
  | "conditional-required" | "validation-error" | "identity-drift";

const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com",
    phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});

function portal(provider: Provider, scenario: Scenario): string {
  const nameLabel = scenario === "identity-drift" ? "Candidate name"
    : provider === "ashby" || provider === "lever" ? "Your name" : "Full name";
  const emailLabel = provider === "workday" ? "Primary Email" : "Email";
  const revealQuestion = scenario === "conditional-required"
    ? "document.getElementById('conditional').hidden=false" : "";
  const continueAction = scenario === "validation-error"
    ? "document.getElementById('validation').hidden=false"
    : `document.getElementById('first').hidden=true;
        document.getElementById('second').hidden=false;${scenario === "wrong-requisition"
          ? "history.pushState({}, '', '/apply/654321')" : ""}`;
  const phone = provider === "smartrecruiters"
    ? '<label>Mobile Phone<input name="phone" required></label>' : "";
  const unknown = scenario === "unknown-required"
    ? '<label>Unanswered legal question<input required name="legal"></label>' : "";
  return `<!doctype html><title>Example Co application</title>
    <h1>Example Co Software Engineer</h1>
    <section id="first"><label>${nameLabel}<input name="name" required></label>
      <label>${emailLabel}<input type="email" name="email" required oninput="${revealQuestion}"></label>
      ${scenario === "conditional-required"
        ? '<label id="conditional" hidden>Security clearance<input name="clearance" required></label>' : ""}
      ${phone}
      <label>Resume<input type="file" name="resume" required></label>
      <button type="button" onclick="${continueAction}">Continue</button></section>
    <p id="validation" hidden>Employer validation rejected this step</p>
    <section id="second" hidden>
      <label>Are you legally authorized to work in the United States?
        <select required><option value="">Select</option><option>Yes</option><option>No</option></select></label>
      ${unknown}
      <button type="submit" onclick="document.getElementById('done').hidden=false;this.hidden=true">
        Submit application</button></section>
    <p id="done" hidden>Thank you for applying to Example Co as Software Engineer</p>`;
}

async function run(provider: Provider, scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "openapply-provider-e2e-"));
  const resumePath = join(root, "verified-resume.pdf");
  const resumeBytes = Buffer.from("%PDF-1.4\nsynthetic fixture\n%%EOF\n");
  await writeFile(resumePath, resumeBytes);
  const pdfSha256 = createHash("sha256").update(resumeBytes).digest("hex");
  const job: DiscoveredJob = {
    id: `${provider}:example:123456`, provider, company: "Example Co", title: "Software Engineer",
    descriptionText: "Build software", location: "Remote", department: null,
    employmentType: null, workplaceType: "Remote", compensation: null,
    applicationUrl: "https://jobs.example.com/apply/123456",
    sourceUrl: "https://jobs.example.com/job/123456", sourcePublishedAt: null,
    sourceUpdatedAt: null, firstSeenAt: "2026-11-24T00:00:00Z",
    discoveredAt: "2026-11-24T00:00:00Z", isNew: true, isFresh: true,
    freshnessBasis: "first-seen", matchedKeywords: [],
  };
  const source = { provider, boardToken: "example", boardName: "example", site: "example",
    companyIdentifier: "example", host: "jobs.example.com", tenant: "example", company: job.company,
    enabled: true, allowedApplicationHosts: ["jobs.example.com"] };
  const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
    handoff: createApplicationHandoff(job, false), browserRuntime: "owned",
    resumeSource: { latex: "synthetic fixture", fingerprint: "f".repeat(64),
      renderToken: "a".repeat(64), claimIds: ["fixture-claim"] },
    resumePdfPath: resumePath, expectedConfirmation: "Thank you for applying" });
  const context = await chromium.launchPersistentContext(join(root, "profile"), { headless: true });
  try {
    await context.route("https://jobs.example.com/**", (route) => route.fulfill({
      contentType: "text/html", body: portal(provider, scenario),
    }));
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
    const result = await runApplicationPackage(pkg, workflow, join(root, "profile"), {
      validateOfficial: async () => true,
      verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256, path: resumePath, pages: 1, verifiedAt: new Date().toISOString() }),
      browserFactory: async (hosts, artifacts) => ({
        browser: new AgentBrowser(context, hosts, artifacts), close: async () => {},
      }),
    });
    const page = context.pages().at(-1)!;
    return { checkpoint: result.checkpoint,
      nameValue: await page.locator('input[name="name"]').inputValue(),
      emailValue: await page.locator('input[name="email"]').inputValue(),
      phoneValue: await page.locator('input[name="phone"]').count()
        ? await page.locator('input[name="phone"]').inputValue() : null,
      authorizationValue: await page.locator("select").inputValue(),
      fileName: await page.locator('input[type="file"]').evaluate((input) =>
        (input as HTMLInputElement).files?.[0]?.name),
      validationVisible: await page.locator("#validation").isVisible(),
      confirmationVisible: await page.locator("#done").isVisible() };
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("controlled provider portal", () => {
  for (const provider of ["greenhouse", "ashby", "lever", "smartrecruiters", "workday"] as const) {
    it(`${provider} submits a two-step job-bound form with the verified résumé`, async () => {
      const result = await run(provider, "success");
      expect(result.checkpoint.stage).toBe("submitted");
      expect(result.checkpoint.confirmation).toContain("Thank you for applying");
      expect(result.nameValue).toBe("Test Candidate");
      expect(result.emailValue).toBe("test@example.com");
      if (provider === "smartrecruiters") expect(result.phoneValue).toBe("555-0100");
      expect(result.authorizationValue).toBe("Yes");
      expect(result.fileName).toBe("verified-resume.pdf");
      expect(result.confirmationVisible).toBe(true);
    }, 30_000);

    it(`${provider} pauses on an unknown required question after Continue`, async () => {
      const result = await run(provider, "unknown-required");
      expect(result.checkpoint.stage).toBe("waiting-human");
      expect(result.checkpoint.blocker).toContain("Unanswered legal question");
      expect(result.fileName).toBe("verified-resume.pdf");
      expect(result.confirmationVisible).toBe(false);
    }, 30_000);

    it(`${provider} rejects a switch to another requisition before Submit`, async () => {
      const result = await run(provider, "wrong-requisition");
      expect(result.checkpoint.stage).toBe("waiting-human");
      expect(result.checkpoint.blocker).toContain("original requisition");
      expect(result.confirmationVisible).toBe(false);
    }, 30_000);
  }

  for (const provider of ["greenhouse", "ashby"] as const) {
    it(`${provider} pauses when filling reveals a new required question`, async () => {
      const result = await run(provider, "conditional-required");
      expect(result.checkpoint.stage).toBe("waiting-human");
      expect(result.checkpoint.blocker).toContain("New required field appeared after filling: Security clearance");
      expect(result.fileName).toBeUndefined();
      expect(result.confirmationVisible).toBe(false);
    }, 30_000);

    it(`${provider} pauses when Continue leaves a validation error on the same step`, async () => {
      const result = await run(provider, "validation-error");
      expect(result.checkpoint.stage).toBe("waiting-human");
      expect(result.checkpoint.blocker).toContain("Continue did not advance");
      expect(result.fileName).toBe("verified-resume.pdf");
      expect(result.validationVisible).toBe(true);
      expect(result.confirmationVisible).toBe(false);
    }, 30_000);

    it(`${provider} pauses on an unrecognized required identity label`, async () => {
      const result = await run(provider, "identity-drift");
      expect(result.checkpoint.stage).toBe("waiting-human");
      expect(result.checkpoint.blocker).toContain("Required field needs an answer: Candidate name");
      expect(result.fileName).toBeUndefined();
      expect(result.confirmationVisible).toBe(false);
    }, 30_000);
  }
});
