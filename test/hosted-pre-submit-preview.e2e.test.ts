import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PDFDocument, PDFString, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { verifiedOfficialLead } from "../src/cloud/official-lead-sync.js";
import { runHostedPreSubmitPreview } from "../src/cloud/hosted-pre-submit-preview.js";
import type { OfficialLeadRow } from "../src/cloud/official-lead-sync.js";
import type { ResumeSource } from "../src/resume/jake.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const identity = { provider: "greenhouse", employerId: "acme", requisitionId: "123456" };
const url = "https://boards.greenhouse.io/acme/jobs/123456";
const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX",
    email: "test@example.invalid", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { general: ["Python"] }, education: [], projects: [],
  experience: [{ employer: "Example Lab", title: "Engineer", employmentType: "Full-time",
    start: "2024", end: "Present", claims: [{ id: "claim-1", claim: "Built Python services",
      skills: ["Python"], metrics: [], evidence: [{ source: "candidate-reviewed-intake",
        uri: "urn:openapply:onboarding:test#experience-1" }], status: "user-confirmed",
      allowedUses: ["matching", "resume", "application"] }] }], quarantinedClaims: [],
});
const profileBytes = () => new TextEncoder().encode(JSON.stringify({ version: 1,
  provenance: "candidate-entered-and-reviewed", candidateId, applicationProfile: candidate }));

function lead(): OfficialLeadRow {
  const row = verifiedOfficialLead({ provider: "greenhouse", boardToken: "acme", company: "Acme" }, {
    id: "greenhouse:acme:123456", provider: "greenhouse", company: "Acme",
    title: "Backend Engineer", descriptionText: "Python services", applicationUrl: url,
    sourceUrl: url, location: null, department: null, employmentType: null,
    workplaceType: null, compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null,
  }, new Date("2026-11-27T12:00:00Z"));
  expect(row.jobKey).toBe(officialJobKey(identity));
  return row;
}

async function renderFixturePdf(source: ResumeSource, path: string): Promise<string> {
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

const fixtureHtml = (applicationUrl: string, unknown = false, autoPost = false,
  autoSocket = false) => `<!doctype html><html><head><title>Acme application</title></head><body>
  <h1>Backend Engineer at Acme</h1><form method="post" action="${applicationUrl}">
  <label>First Name<input required name="first_name"></label>
  <label>Last Name<input required name="last_name"></label>
  <label>Email<input required name="email" type="email"></label>
  <label>Resume<input required name="resume" type="file"></label>
  ${unknown ? '<label>Security clearance level<input required name="clearance"></label>' : ''}
  <button type="submit">Submit Application</button></form>
  ${autoPost ? `<script>document.querySelector('[name="first_name"]').addEventListener('input', () => {
    fetch('${applicationUrl}', { method: 'POST', body: 'premature-submit' }).catch(() => {});
  });</script>` : ""}
  ${autoSocket ? `<script>document.querySelector('[name="first_name"]').addEventListener('input', () => {
    const socket = new WebSocket('wss://boards.greenhouse.io/acme/submit');
    socket.addEventListener('open', () => socket.send('premature-submit'));
  });</script>` : ""}</body></html>`;

describe.runIf(process.env.OPENAPPLY_RUN_BROWSER_E2E === "1")("hosted pre-submit preview", () => {
  it.each([
    { unknown: false, autoPost: false, autoSocket: false, applicationUrl: url },
    { unknown: true, autoPost: false, autoSocket: false, applicationUrl: url },
    { unknown: false, autoPost: true, autoSocket: false, applicationUrl: url },
    { unknown: false, autoPost: false, autoSocket: true, applicationUrl: url },
    { unknown: false, autoPost: false, autoSocket: false, applicationUrl: `${url}/apply` },
    { unknown: false, autoPost: false, autoSocket: false, applicationUrl: `${url}/application` },
  ])("fills controlled employer fixture without a write: %o", async ({ unknown, autoPost,
    autoSocket, applicationUrl }) => {
    const root = await mkdtemp(join(tmpdir(), "openapply-preview-"));
    const work = join(root, "work");
    const browser = join(root, "browser");
    await mkdir(work, { mode: 0o700 });
    let submitRequests = 0;
    let socketConnections = 0;
    try {
      const bytes = profileBytes();
      const selectedLead = lead();
      selectedLead.canonicalUrl = applicationUrl;
      const result = await runHostedPreSubmitPreview({ candidateId, runJob: identity,
        lead: selectedLead, profileBytes: bytes, privateWorkDirectory: work,
        privateBrowserDirectory: browser }, {
        now: new Date("2026-11-27T12:01:00Z"),
        async renderResume(source, job, profile, directory) {
          expect(job.id).toBe("greenhouse:acme:123456");
          expect(profile.identity.email).toBe("test@example.invalid");
          return renderFixturePdf(source, join(directory, "tailored.pdf"));
        },
        async launch(options) {
          expect(options.headless).toBe(true);
          expect(options.serviceWorkers).toBe("block");
          const context = await chromium.launchPersistentContext(options.profileDirectory, {
            headless: true, serviceWorkers: "block", acceptDownloads: true,
          });
          await context.routeWebSocket("**/*", socket => {
            socketConnections++;
            socket.close();
          });
          return { context, close: () => context.close() };
        },
        async fetchRequest(route) {
          if (route.request().method() === "POST") submitRequests++;
          if (route.request().url() !== applicationUrl) {
            throw new Error("Controlled fixture received a request outside its employer URL");
          }
          return { status: 200, headers: { "content-type": "text/html" },
            body: Buffer.from(fixtureHtml(applicationUrl, unknown, autoPost, autoSocket)) };
        },
      });
      expect(result.status).toBe(unknown || autoPost || autoSocket ? "needs-human" : "ready-for-review");
      expect(result.blockers.some(value => value.includes("Security clearance"))).toBe(unknown);
      expect(result.blockers.some(value => value.includes("attempted a write"))).toBe(autoPost);
      expect(result.blockers.some(value => value.includes("WebSocket"))).toBe(autoSocket);
      expect(result.uploaded).toBe(!unknown);
      expect(submitRequests).toBe(0);
      expect(socketConnections).toBe(0);
      expect(bytes.every(value => value === 0)).toBe(true);
      if (!unknown) expect(result.resumeSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects another requisition before rendering or launching Chromium", async () => {
    let touched = false;
    const mismatched = lead();
    mismatched.canonicalUrl = "https://boards.greenhouse.io/acme/jobs/999999";
    await expect(runHostedPreSubmitPreview({ candidateId, runJob: identity, lead: mismatched,
      profileBytes: profileBytes(), privateWorkDirectory: "/tmp/work",
      privateBrowserDirectory: "/tmp/browser" }, {
      now: new Date("2026-11-27T12:01:00Z"),
      async renderResume() { touched = true; return "/tmp/work/tailored.pdf"; },
    })).rejects.toThrow("requisition");
    expect(touched).toBe(false);
  });

  it("rejects another employer host before rendering or launching Chromium", async () => {
    let touched = false;
    const mismatched = lead();
    mismatched.canonicalUrl = "https://boards.greenhouse.io/other/jobs/123456";
    const bytes = profileBytes();
    await expect(runHostedPreSubmitPreview({ candidateId, runJob: identity, lead: mismatched,
      profileBytes: bytes, privateWorkDirectory: "/tmp/work",
      privateBrowserDirectory: "/tmp/browser" }, {
      now: new Date("2026-11-27T12:01:00Z"),
      async renderResume() { touched = true; return "/tmp/work/tailored.pdf"; },
    })).rejects.toThrow("employer");
    expect(touched).toBe(false);
    expect(bytes.every(value => value === 0)).toBe(true);
  });

  it("blocks a cross-host redirect before Chromium reaches the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-preview-redirect-"));
    const work = join(root, "work");
    await mkdir(work, { mode: 0o700 });
    let originalFetches = 0;
    let foreignFetches = 0;
    try {
      const result = await runHostedPreSubmitPreview({ candidateId, runJob: identity,
        lead: lead(), profileBytes: profileBytes(), privateWorkDirectory: work,
        privateBrowserDirectory: join(root, "browser") }, {
        now: new Date("2026-11-27T12:01:00Z"),
        async renderResume(source, _job, _candidate, directory) {
          return renderFixturePdf(source, join(directory, "tailored.pdf"));
        },
        async launch(options) {
          const context = await chromium.launchPersistentContext(options.profileDirectory, {
            headless: true, serviceWorkers: "block", acceptDownloads: true,
          });
          return { context, close: () => context.close() };
        },
        async fetchRequest(route) {
          if (route.request().url() === url) originalFetches++;
          else foreignFetches++;
          return { status: 302, headers: { location: "https://other.example.invalid/submit" },
            body: Buffer.alloc(0) };
        },
      });
      expect(result.status).toBe("needs-human");
      expect(result.blockers).toContain("Employer form redirected or loaded another host during preview");
      expect(result.uploaded).toBe(false);
      expect(originalFetches).toBe(1);
      expect(foreignFetches).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
