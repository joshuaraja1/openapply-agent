import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { applicationPackageSchema, runApplicationPackage } from "../src/application/runner.js";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const job: DiscoveredJob = {
  id: "test:runner:1", provider: "greenhouse", company: "Example Co", title: "Software Engineer",
  location: "Remote", department: null, employmentType: null, workplaceType: null, compensation: null,
  descriptionText: "Python", applicationUrl: "https://jobs.example.com/apply",
  sourceUrl: "https://jobs.example.com/job", sourcePublishedAt: null, sourceUpdatedAt: null,
  firstSeenAt: "2026-11-24T00:00:00Z", discoveredAt: "2026-11-24T00:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [],
};
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});
const source = { provider: "greenhouse" as const, boardToken: "example", company: "Example Co",
  enabled: true, allowedApplicationHosts: ["jobs.example.com"] };

function browserFixture(extraRequired = false) {
  let confirmationVisible = false;
  const uploaded: Buffer[] = [];
  const fields = [
    { tag: "INPUT", name: "Email", type: "email", required: true, value: "" },
    { tag: "INPUT", name: "Resume", type: "file", required: true, value: "" },
    ...(extraRequired ? [{ tag: "INPUT", name: "Salary expectation", type: "text", required: true, value: "" }] : []),
    { tag: "BUTTON", name: "Submit", type: "submit", required: false, value: "" },
  ];
  const handles = fields.map((field) => ({
    isVisible: async () => true,
    evaluate: async (callback: (node: object) => unknown) => callback({ tagName: field.tag,
      labels: [{ textContent: field.name }], textContent: field.name, isConnected: true,
      matches: () => field.required, getAttribute: (key: string) => key === "name" ? field.name : null }),
    getAttribute: async (key: string) => key === "name" ? field.name : key === "type" ? field.type : null,
    innerText: async () => field.name,
    fill: async (value: string) => { field.value = value; },
    inputValue: async () => field.value,
    setInputFiles: async (file: { buffer: Buffer }) => { uploaded.push(file.buffer); },
    click: async () => { confirmationVisible = true; },
  }));
  const page = { url: () => job.applicationUrl, title: async () => "Apply", goto: async () => {},
    locator: () => ({ elementHandles: async () => handles }),
    getByText: () => ({ count: async () => confirmationVisible ? 1 : 0,
      first: () => ({ waitFor: async () => {}, innerText: async () => "Thank you for applying" }) }) };
  const context = { route: async () => {}, newPage: async () => page, pages: () => [page] } as unknown as BrowserContext;
  return { context, close: vi.fn(async () => {}), fields, uploaded };
}

describe("application runner", () => {
  it("verifies the artifact, fills the form, and records employer confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-runner-"));
    try {
      const path = join(root, "resume.pdf");
      const bytes = Buffer.from("%PDF-1.4\ncontrolled-test-pdf\n%%EOF\n");
      await writeFile(path, bytes);
      const browser = browserFixture();
      const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
        handoff: createApplicationHandoff(job, false),
        resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
        resumePdfPath: path, expectedConfirmation: "Thank you for applying",
        browserEndpoint: "http://127.0.0.1:3333/mcp" });
      const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
      const result = await runApplicationPackage(pkg, workflow, join(root, "profile"), {
        verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
          pdfSha256: createHash("sha256").update(bytes).digest("hex"), path, pages: 1,
          verifiedAt: new Date().toISOString() }),
        launch: async () => browser,
        validateOfficial: async () => true,
      });
      expect(result.checkpoint.stage).toBe("submitted");
      expect(result.checkpoint.confirmation).toBe("Thank you for applying");
      expect(browser.fields[0]?.value).toBe("test@example.com");
      expect(browser.uploaded[0]).toEqual(bytes);
      expect(browser.close).toHaveBeenCalledOnce();
      await expect(runApplicationPackage(pkg, workflow, join(root, "profile"), {
        verify: async () => result.artifact, launch: async () => browser, validateOfficial: async () => true,
      })).rejects.toThrow("submitted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses before filling when the portal asks an unknown required question", async () => {
    const browser = browserFixture(true);
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/resume.pdf", expectedConfirmation: "Thank you for applying" });
    const result = await runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => ({ jobId: job.id, sourceFingerprint: "f".repeat(64),
        pdfSha256: "0".repeat(64), path: "/tmp/resume.pdf", pages: 1, verifiedAt: new Date().toISOString() }),
      launch: async () => browser, validateOfficial: async () => true });
    expect(result.checkpoint.stage).toBe("waiting-human");
    expect(result.checkpoint.blocker).toContain("Salary expectation");
    expect(browser.fields[0]?.value).toBe("");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("does not open the browser when official-source validation fails", async () => {
    const browser = browserFixture();
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/resume.pdf" });
    const launch = vi.fn(async () => browser);
    await expect(runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256: "0".repeat(64), path: "/tmp/resume.pdf", pages: 1,
        verifiedAt: new Date().toISOString() }), validateOfficial: async () => false, launch }))
      .rejects.toThrow("official source");
    expect(launch).not.toHaveBeenCalled();
  });

  it("pauses at final approval when policy requires it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-runner-"));
    try {
      const path = join(root, "resume.pdf");
      const bytes = Buffer.from("%PDF-1.4\ncontrolled-test-pdf\n%%EOF\n");
      await writeFile(path, bytes);
      const browser = browserFixture();
      const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
        handoff: createApplicationHandoff(job, true),
        resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
        resumePdfPath: path });
      const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
      const result = await runApplicationPackage(pkg, workflow,
        join(root, "profile"), { verify: async () => ({ jobId: job.id,
          sourceFingerprint: pkg.resumeSource.fingerprint,
          pdfSha256: createHash("sha256").update(bytes).digest("hex"), path, pages: 1,
          verifiedAt: new Date().toISOString() }), launch: async () => browser,
          validateOfficial: async () => true });
      expect(result.checkpoint.stage).toBe("waiting-human");
      expect(result.checkpoint.blocker).toContain("approval");
      expect(browser.uploaded[0]).toEqual(bytes);
      const approved = applicationPackageSchema.parse({ ...pkg,
        handoff: { ...pkg.handoff, mode: "submit-after-approval",
          stopConditions: pkg.handoff.stopConditions.filter((condition) => condition !== "final-submit") },
        expectedConfirmation: "Thank you for applying" });
      await expect(runApplicationPackage(approved, workflow, join(root, "other-profile"), {
        verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
          pdfSha256: "0".repeat(64), path, pages: 1, verifiedAt: new Date().toISOString() }),
        validateOfficial: async () => true, approvedJobId: job.id,
      })).rejects.toThrow("different résumé artifact");
      const resumed = await runApplicationPackage(approved, workflow,
        join(root, "other-profile"), { verify: async () => ({ jobId: job.id,
          sourceFingerprint: pkg.resumeSource.fingerprint,
          pdfSha256: createHash("sha256").update(bytes).digest("hex"), path, pages: 1,
          verifiedAt: new Date().toISOString() }), launch: async () => browser,
          validateOfficial: async () => true, approvedJobId: job.id });
      expect(resumed.checkpoint.stage).toBe("submitted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an approval token before a final-approval checkpoint exists", async () => {
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/resume.pdf", expectedConfirmation: "Thank you for applying" });
    await expect(runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { approvedJobId: job.id })).rejects.toThrow("pending final-approval");
  });

  it("resumes the exact BrowserOS handoff after a human fills an unknown field", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-handoff-"));
    try {
      const path = join(root, "resume.pdf");
      const bytes = Buffer.from("%PDF-1.4\ncontrolled-test-pdf\n%%EOF\n");
      await writeFile(path, bytes);
      const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
      const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
        handoff: createApplicationHandoff(job, true),
        resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
        resumePdfPath: path, expectedConfirmation: "Thank you for applying",
        browserEndpoint: "http://127.0.0.1:3333/mcp" });
      const controls = (humanAnswered: boolean) => ({ url: job.applicationUrl, title: "Apply", controls: [
        { ref: "email", tag: "input", role: "textbox", name: "Email", type: null, value: null, required: true, options: [] },
        { ref: "salary", tag: "input", role: "textbox", name: "Salary expectation", type: null,
          value: humanAnswered ? "Negotiable" : null, required: true, options: [] },
        { ref: "resume", tag: "input", role: "button", name: "Resume", type: "file", value: null,
          required: false, options: [] },
        { ref: "submit", tag: "button", role: "button", name: "Submit", type: "submit", value: null,
          required: false, options: [] },
      ] });
      const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
      const verification = async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256, path, pages: 1, verifiedAt: new Date().toISOString() });
      const first = await runApplicationPackage(pkg, workflow, join(root, "profile"), {
        verify: verification, validateOfficial: async () => true, packagePath: join(root, "application.json"),
        browserFactory: async () => ({ browser: {
          currentUrl: () => job.applicationUrl, navigate: async () => controls(false),
          act: async () => controls(false), submit: async () => "", pageId: () => 7,
          groupId: () => "AAAAAAAAAAAAAAAA",
        }, close: async () => {} }),
      });
      expect(first.checkpoint.stage).toBe("waiting-human");
      expect(first.checkpoint.browserPageId).toBe(7);
      expect(first.checkpoint.packagePath).toBe(join(root, "application.json"));
      await workflow.advance(job.id, "applying"); // Simulate a crash after the resume transition.
      const attach = vi.fn(async () => controls(true));
      const browserFactory = async () => ({ browser: {
          currentUrl: () => job.applicationUrl, navigate: async () => { throw new Error("Opened a new tab"); },
          attach, act: async () => controls(true), fillBatch: async () => controls(true),
          submit: async () => "Thank you for applying", pageId: () => 7,
          groupId: () => "AAAAAAAAAAAAAAAA",
        }, close: async () => {} });
      await expect(runApplicationPackage(pkg, workflow, join(root, "profile"), {
        verify: verification, validateOfficial: async () => true, browserFactory,
      })).rejects.toThrow("same-tab resume");
      await expect(runApplicationPackage({ ...pkg, browserEndpoint: "http://127.0.0.1:4444/mcp" },
        workflow, join(root, "profile"), {
          verify: verification, validateOfficial: async () => true, resumedJobId: job.id, browserFactory,
        })).rejects.toThrow("saved tab group and endpoint");
      const unapproved = await runApplicationPackage(pkg, workflow, join(root, "profile"), {
        verify: verification, validateOfficial: async () => true, resumedJobId: job.id, browserFactory,
      });
      expect(unapproved.checkpoint.stage).toBe("waiting-human");
      expect(unapproved.checkpoint.blocker).toContain("Salary expectation");
      const resumed = await runApplicationPackage(pkg, workflow, join(root, "profile"), {
        verify: verification, validateOfficial: async () => true, resumedJobId: job.id,
        humanAnswerApproval: { jobId: job.id, browserPageId: 7, approveFinalSubmission: true,
          answers: new Map([["Salary expectation", "Negotiable"]]) }, browserFactory,
      });
      expect(attach).toHaveBeenCalledWith(7, job.applicationUrl, "AAAAAAAAAAAAAAAA");
      expect(resumed.checkpoint.stage).toBe("submitted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a posting whose application host was not independently configured", async () => {
    const pkg = applicationPackageSchema.parse({ version: 1, job,
      source: { ...source, allowedApplicationHosts: [] }, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/resume.pdf" });
    await expect(runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile")).rejects.toThrow("approved employer destination");
  });
});
