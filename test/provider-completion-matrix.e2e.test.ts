import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { applicationPackageSchema, runApplicationPackage } from "../src/application/runner.js";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { AgentBrowser } from "../src/browser/actions.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", email: "test@example.com", phone: "555-0100",
    location: "Dallas, TX", linkedin: "https://linkedin.com/in/test",
    github: "https://github.com/test", portfolio: "https://example.com" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});

let pdfBytes: Buffer;
beforeAll(async () => {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  pdfBytes = Buffer.from(await document.save());
});

const nameLayouts = ["name", "full", "split", "given-family", "provider"] as const;
const contactLayouts = ["minimal", "phone", "profiles", "website"] as const;
const stepLayouts = ["authorization", "sponsorship", "both", "optional-reveal", "three-step"] as const;
type Provider = "greenhouse" | "ashby";
type NameLayout = typeof nameLayouts[number];
type ContactLayout = typeof contactLayouts[number];
type StepLayout = typeof stepLayouts[number];

function nameFields(provider: Provider, layout: NameLayout): string {
  const label = (name: string, id: string) => `<label>${name}<input name="${id}" required></label>`;
  if (layout === "split") return label("First name", "first") + label("Last name", "last");
  if (layout === "given-family") return label("Given name", "first") + label("Family name", "last");
  if (layout === "provider") return provider === "ashby"
    ? label("Your name", "name") : label("First name", "first") + label("Surname", "last");
  return label(layout === "name" ? "Name" : "Full name", "name");
}

function contactFields(provider: Provider, layout: ContactLayout): string {
  if (layout === "phone") return `<label>${provider === "ashby" ? "Your phone number" : "Phone"}<input name="phone" required></label>`;
  if (layout === "profiles") return provider === "ashby"
    ? '<label>Your LinkedIn profile<input name="linkedin" required></label><label>Your GitHub profile<input name="github" required></label>'
    : '<label>LinkedIn Profile URL<input name="linkedin" required></label><label>GitHub Profile URL<input name="github" required></label>';
  if (layout === "website") return `<label>${provider === "ashby" ? "Personal website URL" : "Website URL"}<input name="website" required></label>`;
  return "";
}

const authorization = '<label>Are you legally authorized to work in the United States?<select name="authorization" required><option value="">Select</option><option>Yes</option><option>No</option></select></label>';
const sponsorship = '<label>Will you now or in the future require visa sponsorship to work in the United States?<select name="sponsorship" required><option value="">Select</option><option>Yes</option><option>No</option></select></label>';

function portal(provider: Provider, name: NameLayout, contact: ContactLayout, step: StepLayout): string {
  const reveal = step === "optional-reveal" ? "document.getElementById('optional').hidden=false" : "";
  const second = step === "authorization" ? authorization
    : step === "sponsorship" ? sponsorship
      : step === "three-step" ? authorization : authorization + sponsorship;
  const optional = step === "optional-reveal"
    ? '<label id="optional" hidden>Optional introduction<input name="introduction"></label>' : "";
  const secondButton = step === "three-step"
    ? '<button type="button" onclick="document.getElementById(\'second\').hidden=true;document.getElementById(\'third\').hidden=false">Continue</button>'
    : '<button type="submit" onclick="window.submitClicks++;document.getElementById(\'done\').hidden=false;this.hidden=true">Submit application</button>';
  return `<!doctype html><title>Example Co application</title><h1>Example Co Software Engineer</h1>
    <section id="first">${nameFields(provider, name)}
      <label>Email<input type="email" name="email" required oninput="${reveal}"></label>
      ${contactFields(provider, contact)}${optional}
      <label>Resume<input type="file" name="resume" required></label>
      <button type="button" onclick="document.getElementById('first').hidden=true;document.getElementById('second').hidden=false">Continue</button>
    </section><section id="second" hidden>${second}${secondButton}</section>
    <section id="third" hidden>${sponsorship}
      <button type="submit" onclick="window.submitClicks++;document.getElementById('done').hidden=false;this.hidden=true">Submit application</button></section>
    <p id="done" hidden>Thank you for applying to Example Co as Software Engineer</p>
    <script>window.submitClicks=0</script>`;
}

async function run(provider: Provider, name: NameLayout, contact: ContactLayout,
  step: StepLayout, caseNumber: number) {
  const root = await mkdtemp(join(tmpdir(), "openapply-provider-complete-"));
  const resumePath = join(root, "fixture-resume.pdf");
  await writeFile(resumePath, pdfBytes);
  const pdfSha256 = createHash("sha256").update(pdfBytes).digest("hex");
  const reference = `${provider}-123456-${caseNumber}`;
  const job: DiscoveredJob = {
    id: `${provider}:example:${reference}`, provider, company: "Example Co", title: "Software Engineer",
    descriptionText: "Build software", location: "Remote", department: null,
    employmentType: null, workplaceType: "Remote", compensation: null,
    applicationUrl: `https://jobs.example.com/apply/${reference}`,
    sourceUrl: `https://jobs.example.com/job/${reference}`, sourcePublishedAt: null,
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
      contentType: "text/html", body: portal(provider, name, contact, step),
    }));
    const result = await runApplicationPackage(pkg,
      new ApplicationWorkflow(new MemoryApplicationStateStore()), join(root, "profile"), {
        validateOfficial: async () => true,
        // PDF validity is represented by a real PDF fixture; full résumé QA is
        // deliberately outside this browser-control test.
        verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
          pdfSha256, path: resumePath, pages: 1, verifiedAt: new Date().toISOString() }),
        browserFactory: async (hosts, artifacts) => ({
          browser: new AgentBrowser(context, hosts, artifacts), close: async () => {},
        }),
      });
    const page = context.pages().at(-1)!;
    return {
      checkpoint: result.checkpoint,
      expectedJobId: job.id,
      expectedUrl: job.applicationUrl,
      submitClicks: await page.evaluate(() => (window as unknown as { submitClicks: number }).submitClicks),
      uploadedName: await page.locator('input[name="resume"]').evaluate((input) =>
        (input as HTMLInputElement).files?.[0]?.name),
      email: await page.locator('input[name="email"]').inputValue(),
      name: await page.locator('input[name="name"]').count()
        ? await page.locator('input[name="name"]').inputValue() : null,
      first: await page.locator('input[name="first"]').count()
        ? await page.locator('input[name="first"]').inputValue() : null,
      last: await page.locator('input[name="last"]').count()
        ? await page.locator('input[name="last"]').inputValue() : null,
      phone: await page.locator('input[name="phone"]').count()
        ? await page.locator('input[name="phone"]').inputValue() : null,
      linkedin: await page.locator('input[name="linkedin"]').count()
        ? await page.locator('input[name="linkedin"]').inputValue() : null,
      github: await page.locator('input[name="github"]').count()
        ? await page.locator('input[name="github"]').inputValue() : null,
      website: await page.locator('input[name="website"]').count()
        ? await page.locator('input[name="website"]').inputValue() : null,
      authorization: await page.locator('select[name="authorization"]').count()
        ? await page.locator('select[name="authorization"]').inputValue() : null,
      sponsorship: await page.locator('select[name="sponsorship"]').count()
        ? await page.locator('select[name="sponsorship"]').first().inputValue() : null,
      optionalRevealed: await page.locator("#optional").count()
        ? await page.locator("#optional").getAttribute("hidden") === null : null,
      thirdStepReached: await page.locator("#third").getAttribute("hidden") === null,
      confirmationVisible: await page.locator("#done").isVisible(),
    };
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("controlled provider completions", () => {
  const applicationUrls: string[] = [];
  for (const provider of ["greenhouse", "ashby"] as const) {
    let caseNumber = 0;
    for (const name of nameLayouts) for (const contact of contactLayouts) for (const step of stepLayouts) {
      const current = ++caseNumber;
      applicationUrls.push(`https://jobs.example.com/apply/${provider}-123456-${current}`);
      it(`${provider} ${current}: ${name}/${contact}/${step}`, async () => {
        const result = await run(provider, name, contact, step, current);
        expect(result.checkpoint.stage).toBe("submitted");
        expect(result.checkpoint.jobId).toBe(result.expectedJobId);
        expect(result.checkpoint.officialUrl).toBe(result.expectedUrl);
        expect(result.checkpoint.confirmation).toContain("Thank you for applying");
        expect(result.submitClicks).toBe(1);
        expect(result.uploadedName).toBe("fixture-resume.pdf");
        expect(result.email).toBe("test@example.com");
        if (["split", "given-family"].includes(name) || (provider === "greenhouse" && name === "provider")) {
          expect([result.first, result.last]).toEqual(["Test", "Candidate"]);
        } else expect(result.name).toBe("Test Candidate");
        if (contact === "phone") expect(result.phone).toBe("555-0100");
        if (contact === "profiles") expect([result.linkedin, result.github])
          .toEqual(["https://linkedin.com/in/test", "https://github.com/test"]);
        if (contact === "website") expect(result.website).toBe("https://example.com");
        if (step !== "sponsorship") expect(result.authorization).toBe("Yes");
        if (step !== "authorization") expect(result.sponsorship).toBe("No");
        if (step === "optional-reveal") expect(result.optionalRevealed).toBe(true);
        expect(result.thirdStepReached).toBe(step === "three-step");
        expect(result.confirmationVisible).toBe(true);
      }, 30_000);
    }
  }
  it("uses 200 globally distinct synthetic requisition URLs", () => {
    expect(applicationUrls).toHaveLength(200);
    expect(new Set(applicationUrls).size).toBe(200);
  });
});
