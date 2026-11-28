import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PDFDocument, PDFString, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { verifiedOfficialLead } from "../src/cloud/official-lead-sync.js";
import { GreenhouseReceiptVerifier, HostedSubmissionBlocked,
  prepareHostedGreenhouseApplication } from "../src/cloud/hosted-greenhouse-application.js";
import type { ResumeSource } from "../src/resume/jake.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const job = { provider: "greenhouse", employerId: "acme", requisitionId: "123456" };
const url = "https://boards.greenhouse.io/acme/jobs/123456";
const profile = candidateProfileSchema.parse({
  version: 1, identity: { fullName: "Test Candidate", location: "Dallas, TX",
    email: "test@example.invalid", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { general: ["Python"] }, education: [], projects: [],
  experience: [{ employer: "Example Lab", title: "Engineer", employmentType: "Full-time",
    start: "2024", end: "Present", claims: [{ id: "claim-1", claim: "Built Python services",
      skills: ["Python"], metrics: [], evidence: [{ source: "candidate-reviewed-intake",
        uri: "urn:openapply:onboarding:test#experience-1" }], status: "user-confirmed",
      allowedUses: ["matching", "resume", "application"] }] }], quarantinedClaims: [],
});

function lead() {
  return verifiedOfficialLead({ provider: "greenhouse", boardToken: "acme", company: "Acme" }, {
    id: "greenhouse:acme:123456", provider: "greenhouse", company: "Acme",
    title: "Backend Engineer", descriptionText: "Python services", applicationUrl: url,
    sourceUrl: url, location: null, department: null, employmentType: null,
    workplaceType: null, compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null,
  }, new Date("2026-11-27T12:00:00Z"));
}

async function renderPdf(source: ResumeSource, path: string): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setSubject(`OpenApply:${source.renderToken}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Test Candidate", { x: 40, y: 740, font, size: 16 });
  page.drawText("Backend Engineer", { x: 40, y: 710, font, size: 11 });
  page.drawText("Acme", { x: 40, y: 690, font, size: 11 });
  page.drawText("Built Python services", { x: 40, y: 665, font, size: 11 });
  const annotation = pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 730, 170, 748],
    Border: [0, 0, 0], A: { Type: "Action", S: "URI",
      URI: PDFString.of("mailto:test@example.invalid") } });
  page.node.addAnnot(pdf.context.register(annotation));
  await writeFile(path, await pdf.save(), { flag: "wx", mode: 0o600 });
  return path;
}

const formHtml = (extra = "") => `<!doctype html><html><title>Acme application</title><body>
<h1>Backend Engineer at Acme</h1><form method="post" action="${url}">
<label>First Name<input required name="first_name"></label>
<label>Last Name<input required name="last_name"></label>
<label>Email<input required name="email" type="email"></label>
<label>Resume<input required name="resume" type="file"></label>
${extra}<button type="submit">Submit Application</button></form></body></html>`;

async function fixture(options: { unknown?: boolean; wrongReceipt?: boolean; errorReceipt?: boolean;
  xhr?: boolean; crossHost?: boolean; duplicatePost?: boolean; redirect?: boolean;
  preexistingReceipt?: boolean; delayedButton?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openapply-greenhouse-fixture-"));
  const work = join(root, "work");
  await mkdir(work, { mode: 0o700 });
  const profilePath = join(root, "profile.json");
  await writeFile(profilePath, JSON.stringify({ version: 1,
    provenance: "candidate-entered-and-reviewed", candidateId, applicationProfile: profile }),
  { mode: 0o600 });
  let posts = 0;
  const prepare = () => prepareHostedGreenhouseApplication({ candidateId, runJob: job,
    lead: lead(), profilePath, privateWorkDirectory: work,
    privateBrowserDirectory: join(root, "browser") }, {
    now: new Date("2026-11-27T12:01:00Z"),
    async renderResume(source, _job, _profile, directory) {
      return renderPdf(source, join(directory, "tailored.pdf"));
    },
    async launch(options) {
      const context = await chromium.launchPersistentContext(options.profileDirectory, {
        headless: true, serviceWorkers: "block", acceptDownloads: true,
      });
      return { context, close: () => context.close() };
    },
    async fetchRequest(route) {
      expect(route.request().url()).toBe(url);
      if (route.request().method() === "POST") {
        posts++;
        const success = options.wrongReceipt ? "Application received for requisition 999999"
          : "Application received for requisition 123456";
        const body = options.duplicatePost
          ? `<script>fetch('${url}',{method:'POST'}).catch(()=>{}).finally(()=>{document.body.innerText='${success}'})</script>`
          : `<p>${success}</p>`;
        return { status: options.errorReceipt ? 500 : 200,
          headers: { "content-type": "text/html" }, body: Buffer.from(body) };
      }
      if (options.redirect) return { status: 302,
        headers: { location: "https://example.invalid/elsewhere" }, body: Buffer.from("") };
      const script = options.xhr ? `<script>fetch('${url}',{method:'POST'}).catch(()=>{})</script>`
        : options.crossHost ? `<script>fetch('https://example.invalid/collect').catch(()=>{})</script>`
          : options.delayedButton ? `<script>setTimeout(()=>{document.querySelector('button').disabled=false},500)</script>`
            : "";
      const extra = `${options.unknown ? '<label>Security clearance level<input required name="clearance"></label>' : ""}
        ${options.preexistingReceipt ? '<p>Application received for requisition 123456</p>' : ""}${script}`;
      return { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(formHtml(
        extra).replace(options.delayedButton ? '<button type="submit">' : '__never__',
          '<button disabled type="submit">')) };
    },
  });
  return { prepare, getPosts: () => posts, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe.runIf(process.env.OPENAPPLY_RUN_BROWSER_E2E === "1")("hosted Greenhouse application", () => {
  it("performs one final POST and verifies a requisition-bound receipt", async () => {
    const f = await fixture();
    try {
      const prepared = await f.prepare();
      try {
        expect(f.getPosts()).toBe(0);
        const receipt = await prepared.submitOnce(async () => true);
        expect(receipt).not.toBeNull();
        expect(f.getPosts()).toBe(1);
        expect(await new GreenhouseReceiptVerifier().verify(receipt!, job)).toBe(true);
        expect(officialJobKey(receipt!.job)).toBe(officialJobKey(job));
        await expect(prepared.submitOnce(async () => true)).rejects.toThrow("no longer available");
        expect(f.getPosts()).toBe(1);
      } finally { await prepared.close?.(); }
    } finally { await f.cleanup(); }
  });

  it("blocks unknown required fields without any POST", async () => {
    const f = await fixture({ unknown: true });
    try {
      await expect(f.prepare()).rejects.toBeInstanceOf(HostedSubmissionBlocked);
      expect(f.getPosts()).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("blocks the final click after an authorization change", async () => {
    const f = await fixture();
    try {
      const prepared = await f.prepare();
      try {
        expect(await prepared.submitOnce(async () => false)).toBeNull();
        expect(f.getPosts()).toBe(0);
      } finally { await prepared.close?.(); }
    } finally { await f.cleanup(); }
  });

  it("does not accept another requisition's receipt", async () => {
    const f = await fixture({ wrongReceipt: true });
    try {
      const prepared = await f.prepare();
      try {
        await expect(prepared.submitOnce(async () => true)).rejects.toThrow("receipt");
        expect(f.getPosts()).toBe(1);
      } finally { await prepared.close?.(); }
    } finally { await f.cleanup(); }
  }, 15_000);

  it("rejects an HTTP error even when its body claims success", async () => {
    const f = await fixture({ errorReceipt: true });
    try {
      const prepared = await f.prepare();
      try {
        await expect(prepared.submitOnce(async () => true)).rejects.toThrow("receipt");
        expect(f.getPosts()).toBe(1);
      } finally { await prepared.close?.(); }
    } finally { await f.cleanup(); }
  });

  it("checks authorization after a delayed button becomes actionable", async () => {
    const f = await fixture({ delayedButton: true });
    try {
      const prepared = await f.prepare();
      try {
        expect(await prepared.submitOnce(async () => false)).toBeNull();
        expect(f.getPosts()).toBe(0);
      } finally { await prepared.close?.(); }
    } finally { await f.cleanup(); }
  });

  it.each(["xhr", "crossHost", "redirect"] as const)("blocks %s before any final POST",
    async kind => {
      const f = await fixture({ [kind]: true });
      try {
        await expect(f.prepare()).rejects.toThrow();
        expect(f.getPosts()).toBe(0);
      } finally { await f.cleanup(); }
    });

  it("rejects a pre-existing confirmation before final click", async () => {
    const f = await fixture({ preexistingReceipt: true });
    try {
      const prepared = await f.prepare();
      try {
        await expect(prepared.submitOnce(async () => true)).rejects.toThrow("before final click");
        expect(f.getPosts()).toBe(0);
      } finally { await prepared.close?.(); }
    } finally { await f.cleanup(); }
  });

  it("rejects a second POST attempt after the guarded final POST", async () => {
    const f = await fixture({ duplicatePost: true });
    try {
      const prepared = await f.prepare();
      try {
        await expect(prepared.submitOnce(async () => true)).rejects.toThrow("receipt");
        expect(f.getPosts()).toBe(1);
      } finally { await prepared.close?.(); }
    } finally { await f.cleanup(); }
  });
});
