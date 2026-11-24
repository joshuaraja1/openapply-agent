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
  it("signs into an exact-domain portal using an OS-stored password", async () => {
    const boundJob = { ...job, id: "greenhouse:example:123456",
      applicationUrl: "https://jobs.example.com/apply/123456" };
    const login = { url: boundJob.applicationUrl, title: "Sign in", controls: [
      { ref: "password", tag: "input", role: "textbox", name: "Password", type: "password",
        value: null, required: true, options: [] },
      { ref: "sign-in", tag: "button", role: "button", name: "Sign in", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const application = { url: "https://jobs.example.com/apply/123456/step-1", title: "Apply",
      visibleText: "Example Co Software Engineer application", controls: [
      { ref: "resume", tag: "input", role: "button", name: "Resume", type: "file",
        value: null, required: false, options: [] },
      { ref: "submit", tag: "button", role: "button", name: "Submit application", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const account = { id: "example", email: "candidate@example.com", domains: ["jobs.example.com"],
      passwordSecretRef: "keychain://example", allowAccountCreation: false };
    const get = vi.fn(async () => "private-password");
    let currentUrl = boundJob.applicationUrl;
    const authenticate = vi.fn(async () => { currentUrl = application.url; return application; });
    const pkg = applicationPackageSchema.parse({ version: 1, job: boundJob, source, candidate,
      handoff: createApplicationHandoff(boundJob, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/login.pdf", expectedConfirmation: "Thank you for applying" });
    const result = await runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => ({ jobId: boundJob.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1, verifiedAt: new Date().toISOString() }),
      validateOfficial: async () => true, account, secretStore: { get, put: async () => {}, delete: async () => {} },
      browserFactory: async () => ({ browser: { currentUrl: () => currentUrl,
        navigate: async () => login, authenticate, act: async () => application,
        fillBatch: async () => application, submit: async () => "Thank you for applying" }, close: async () => {} }) });
    expect(result.checkpoint.stage).toBe("submitted");
    expect(get).toHaveBeenCalledWith("keychain://example");
    expect(authenticate).toHaveBeenCalledWith("candidate@example.com", "private-password");
    const unmatched = await runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => result.artifact, validateOfficial: async () => true,
        account: { ...account, domains: ["*.example.com"] },
        secretStore: { get, put: async () => {}, delete: async () => {} },
        browserFactory: async () => ({ browser: { currentUrl: () => currentUrl,
          navigate: async () => login, authenticate, act: async () => application,
          fillBatch: async () => application, submit: async () => "Thank you for applying" }, close: async () => {} }),
      });
    expect(unmatched.checkpoint.stage).toBe("waiting-human");
    expect(unmatched.checkpoint.blocker).toContain("exact account domain");
    expect(get).toHaveBeenCalledOnce();
    const wrongApplication = { ...application, url: "https://jobs.example.com/apply/654321/step-1" };
    const wrongSubmit = vi.fn(async () => "Thank you for applying");
    const wrong = await runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => result.artifact, validateOfficial: async () => true,
        account, secretStore: { get, put: async () => {}, delete: async () => {} },
        browserFactory: async () => ({ browser: { currentUrl: () => wrongApplication.url,
          navigate: async () => login, authenticate: async () => wrongApplication,
          act: async () => wrongApplication, fillBatch: async () => wrongApplication,
          submit: wrongSubmit }, close: async () => {} }),
      });
    expect(wrong.checkpoint.stage).toBe("waiting-human");
    expect(wrong.checkpoint.blocker).toContain("cannot be bound to this requisition");
    expect(wrongSubmit).not.toHaveBeenCalled();
  });

  it("resumes the same tab after a human completes external identity-provider sign-in", async () => {
    const login = { url: job.applicationUrl, title: "Sign in", controls: [
      { ref: "password", tag: "input", role: "textbox", name: "Password", type: "password",
        value: null, required: true, options: [] },
      { ref: "sign-in", tag: "button", role: "button", name: "Sign in", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const application = { url: "https://jobs.example.com/apply/step-1", title: "Apply",
      visibleText: "Example Co Software Engineer application", controls: [
      { ref: "resume", tag: "input", role: "button", name: "Resume", type: "file",
        value: null, required: false, options: [] },
      { ref: "submit", tag: "button", role: "button", name: "Submit application", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/identity-provider.pdf", expectedConfirmation: "Thank you for applying",
      browserEndpoint: "http://127.0.0.1:3333/mcp" });
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
    let currentUrl = job.applicationUrl;
    const attach = vi.fn(async () => { currentUrl = application.url; return application; });
    const browser = { currentUrl: () => currentUrl, navigate: async () => login, attach,
      pageId: () => 7, groupId: () => "AAAAAAAAAAAAAAAA", act: async () => application,
      fillBatch: async () => application, submit: async () => "Thank you for applying",
      authenticate: async () => { throw new Error("identity provider redirect"); } };
    const options = { verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
      pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1,
      verifiedAt: new Date().toISOString() }), validateOfficial: async () => true,
      account: { id: "example", email: "candidate@example.com", domains: ["jobs.example.com"],
        passwordSecretRef: "keychain://example", allowAccountCreation: false },
      secretStore: { get: async () => "private-password", put: async () => {}, delete: async () => {} },
      browserFactory: async () => ({ browser, close: async () => {} }) };
    await expect(runApplicationPackage(pkg, workflow, "/tmp/profile", options))
      .rejects.toThrow("identity provider redirect");
    expect(await workflow.current(job.id)).toMatchObject({ stage: "waiting-human",
      blocker: "Portal sign-in needs human completion", browserPageUrl: job.applicationUrl });
    const resumed = await runApplicationPackage(pkg, workflow, "/tmp/profile",
      { ...options, resumedJobId: job.id });
    expect(attach).toHaveBeenCalledWith(7, job.applicationUrl, "AAAAAAAAAAAAAAAA", true);
    expect(resumed.checkpoint.stage).toBe("waiting-human");
    expect(resumed.checkpoint.blocker).toContain("cannot be bound to this requisition");
  });

  it("keeps a human login handoff resumable when credentials leave an MFA form", async () => {
    const login = { url: job.applicationUrl, title: "Sign in", controls: [
      { ref: "password", tag: "input", role: "textbox", name: "Password", type: "password",
        value: null, required: true, options: [] },
      { ref: "sign-in", tag: "button", role: "button", name: "Sign in", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const application = { url: "https://jobs.example.com/apply/step-1", title: "Apply",
      visibleText: "Example Co Software Engineer application", controls: [
        { ref: "resume", tag: "input", role: "button", name: "Resume", type: "file",
          value: null, required: false, options: [] },
        { ref: "submit", tag: "button", role: "button", name: "Submit application", type: "submit",
          value: null, required: false, options: [] },
      ] };
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/mfa.pdf", expectedConfirmation: "Thank you for applying",
      browserEndpoint: "http://127.0.0.1:3333/mcp" });
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
    let currentUrl = job.applicationUrl;
    const attach = vi.fn(async () => { currentUrl = application.url; return application; });
    const browser = { currentUrl: () => currentUrl, navigate: async () => login, attach,
      pageId: () => 7, groupId: () => "AAAAAAAAAAAAAAAA", act: async () => application,
      fillBatch: async () => application, submit: async () => "Thank you for applying",
      authenticate: async () => login };
    const options = { verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
      pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1,
      verifiedAt: new Date().toISOString() }), validateOfficial: async () => true,
      account: { id: "example", email: "candidate@example.com", domains: ["jobs.example.com"],
        passwordSecretRef: "keychain://example", allowAccountCreation: false },
      secretStore: { get: async () => "private-password", put: async () => {}, delete: async () => {} },
      browserFactory: async () => ({ browser, close: async () => {} }) };
    const pending = await runApplicationPackage(pkg, workflow, "/tmp/profile", options);
    expect(pending.checkpoint.stage).toBe("waiting-human");
    expect(pending.checkpoint.blocker).toContain("Portal sign-in needs human completion");
    const resumed = await runApplicationPackage(pkg, workflow, "/tmp/profile",
      { ...options, resumedJobId: job.id });
    expect(attach).toHaveBeenCalledWith(7, job.applicationUrl, "AAAAAAAAAAAAAAAA", true);
    expect(resumed.checkpoint.stage).toBe("waiting-human");
    expect(resumed.checkpoint.blocker).toContain("cannot be bound to this requisition");
  });
  it("continues a two-step form and uploads the verified résumé before submitting", async () => {
    const input = (ref: string, name: string, type: string | null = null) => ({
      ref, tag: "input", role: "textbox", name, type, value: null, required: true, options: [],
    });
    const first = { url: job.applicationUrl, title: "Profile", controls: [
      input("email", "Email"),
      { ref: "next", tag: "button", role: "button", name: "Continue", type: "button",
        value: null, required: false, options: [] },
    ] };
    const second = { url: "https://jobs.example.com/apply/step-2", title: "Documents", controls: [
      input("resume", "Resume", "file"),
      { ref: "submit", tag: "button", role: "button", name: "Submit application", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const steps: string[] = [];
    let current = first;
    const browser = { currentUrl: () => current.url, navigate: async () => first,
      fillBatch: async (actions: Array<{ action: string }>) => {
        steps.push(actions.some((action) => action.action === "upload") ? "upload" : "fill");
        return current;
      },
      act: async () => { steps.push("continue"); current = second; return second; },
      submit: async () => { steps.push("submit"); return "Thank you for applying"; },
    };
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/two-step.pdf", expectedConfirmation: "Thank you for applying" });
    const result = await runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1, verifiedAt: new Date().toISOString() }),
      validateOfficial: async () => true,
      browserFactory: async () => ({ browser, close: async () => {} }) });
    expect(result.checkpoint.stage).toBe("submitted");
    expect(steps).toEqual(["fill", "continue", "upload", "submit"]);
  });

  it("halts before submission when no application step offers a résumé upload", async () => {
    const page = { url: job.applicationUrl, title: "Apply", controls: [
      { ref: "email", tag: "input", role: "textbox", name: "Email", type: null,
        value: null, required: true, options: [] },
      { ref: "submit", tag: "button", role: "button", name: "Submit application", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const submit = vi.fn(async () => "Thank you for applying");
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/missing-resume.pdf", expectedConfirmation: "Thank you for applying" });
    const result = await runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1, verifiedAt: new Date().toISOString() }),
      validateOfficial: async () => true,
      browserFactory: async () => ({ browser: { currentUrl: () => job.applicationUrl,
        navigate: async () => page, act: async () => page, fillBatch: async () => page, submit },
      close: async () => {} }) });
    expect(result.checkpoint.stage).toBe("waiting-human");
    expect(result.checkpoint.blocker).toContain("résumé was not uploaded");
    expect(submit).not.toHaveBeenCalled();
  });

  it("saves the current step after a crash and resumes that exact BrowserOS tab", async () => {
    const first = { url: job.applicationUrl, title: "Step one", controls: [
      { ref: "resume", tag: "input", role: "button", name: "Resume", type: "file",
        value: null, required: false, options: [] },
      { ref: "next", tag: "button", role: "button", name: "Continue", type: "button",
        value: null, required: false, options: [] },
    ] };
    const second = { url: "https://jobs.example.com/apply/step-2", title: "Step two", controls: [
      { ref: "submit", tag: "button", role: "button", name: "Submit application", type: "submit",
        value: null, required: false, options: [] },
    ] };
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/crash.pdf", expectedConfirmation: "Thank you for applying",
      browserEndpoint: "http://127.0.0.1:3333/mcp" });
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
    let fills = 0;
    let current = first;
    const attach = vi.fn(async () => second);
    const browser = { currentUrl: () => current.url, navigate: async () => first,
      attach, pageId: () => 7, groupId: () => "AAAAAAAAAAAAAAAA",
      act: async () => { current = second; return second; }, fillBatch: async () => {
        fills += 1;
        if (fills === 2) {
          throw new Error("browser transport lost");
        }
        return current;
      },
      submit: async () => "Thank you for applying" };
    const options = { verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
      pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1,
      verifiedAt: new Date().toISOString() }), validateOfficial: async () => true,
      browserFactory: async () => ({ browser, close: async () => {} }) };
    await expect(runApplicationPackage(pkg, workflow, "/tmp/profile", options)).rejects.toThrow("transport lost");
    expect(await workflow.current(job.id)).toMatchObject({ stage: "waiting-human",
      browserPageUrl: second.url, resumeUploaded: true });
    const resumed = await runApplicationPackage(pkg, workflow, "/tmp/profile", {
      ...options, resumedJobId: job.id });
    expect(attach).toHaveBeenCalledWith(7, second.url, "AAAAAAAAAAAAAAAA", false);
    expect(resumed.checkpoint.stage).toBe("submitted");
  });

  it("clicks a no-op Continue only once", async () => {
    const page = { url: job.applicationUrl, title: "Step one", controls: [
      { ref: "resume", tag: "input", role: "button", name: "Resume", type: "file",
        value: null, required: false, options: [] },
      { ref: "next", tag: "button", role: "button", name: "Continue", type: "button",
        value: null, required: false, options: [] },
    ], visibleText: "Step 1 of 2" };
    const click = vi.fn(async () => ({ ...page, visibleText: `${page.visibleText}\n- heading "Please correct errors"` }));
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, false),
      resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
      resumePdfPath: "/tmp/no-op.pdf", expectedConfirmation: "Thank you for applying" });
    const result = await runApplicationPackage(pkg, new ApplicationWorkflow(new MemoryApplicationStateStore()),
      "/tmp/profile", { verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1, verifiedAt: new Date().toISOString() }),
      validateOfficial: async () => true,
      browserFactory: async () => ({ browser: { currentUrl: () => job.applicationUrl,
        navigate: async () => page, act: click, fillBatch: async () => page,
        submit: async () => "Thank you for applying" }, close: async () => {} }) });
    expect(click).toHaveBeenCalledOnce();
    expect(result.checkpoint.stage).toBe("waiting-human");
    expect(result.checkpoint.blocker).toContain("did not advance");
  });

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
      expect(attach).toHaveBeenCalledWith(7, job.applicationUrl, "AAAAAAAAAAAAAAAA", false);
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
