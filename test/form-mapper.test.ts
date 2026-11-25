import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { AgentBrowser, type BrowserSnapshot } from "../src/browser/actions.js";
import { launchBrowser } from "../src/browser/runtime.js";
import { chromium } from "playwright";
import { fillApplicationForm, planApplicationForm } from "../src/application/form-mapper.js";

const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100",
    linkedin: "https://linkedin.com/in/test", github: "https://github.com/test",
    portfolio: "https://example.com" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});

function field(ref: string, name: string, type = "text", required = true) {
  return { ref, tag: "input", role: null, name, type, value: null, required, options: [] };
}

function snapshot(...controls: BrowserSnapshot["controls"]): BrowserSnapshot {
  return { url: "https://jobs.example.com/apply", title: "Apply", controls };
}

describe("deterministic application field mapping", () => {
  it("selects only explicit U.S. authorization answers with exact options", async () => {
    const authorization = { ref: "1", tag: "select", role: null,
      name: "Are you legally authorized to work in the United States?", type: null,
      value: null, required: true, options: ["Select", "Yes", "No"] };
    const sponsorship = { ...authorization, ref: "2",
      name: "Will you now or in the future require visa sponsorship to work in the United States?" };
    const initial = snapshot(authorization, sponsorship);
    const plan = planApplicationForm(initial, candidate, "/tmp/resume.pdf", { allowMissingResume: true });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.map(({ action, value }) => [action, value])).toEqual([
      ["select", "Yes"], ["select", "No"],
    ]);
    const browser = { act: vi.fn().mockResolvedValue(initial) };
    const result = await fillApplicationForm(browser as never, initial, candidate, "/tmp/resume.pdf",
      { allowMissingResume: true });
    expect(result.blockers).toEqual([]);
    expect(browser.act.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["1", "select", "Yes"], ["2", "select", "No"],
    ]);
  });

  it("pauses for ambiguous authorization wording or option labels", () => {
    const select = { ref: "1", tag: "select", role: null, type: null,
      value: null, required: true, options: ["Yes", "No"] };
    for (const control of [
      { ...select, name: "Visa sponsorship" },
      { ...select, name: "Are you legally authorized to work in the United States?",
        options: ["Yes, with restrictions", "No"] },
      { ...select, name: "Are you legally authorized to work in the United States?",
        options: ["Yes", "Yes", "No"] },
    ]) {
      expect(planApplicationForm(snapshot(control), candidate, "/tmp/resume.pdf",
        { allowMissingResume: true }).blockers).toContain(`Required field needs an answer: ${control.name}`);
    }
  });

  it("maps exact Greenhouse and Ashby identity aliases only for their provider", () => {
    const greenhouse = snapshot(field("1", "LinkedIn Profile URL"),
      field("2", "GitHub Profile"), field("3", "Resume", "file"));
    const plan = planApplicationForm(greenhouse, candidate, "/tmp/resume.pdf", { provider: "greenhouse" });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.map(({ value }) => value)).toEqual([
      "https://linkedin.com/in/test", "https://github.com/test", "/tmp/resume.pdf",
    ]);
    expect(planApplicationForm(greenhouse, candidate, "/tmp/resume.pdf", { provider: "lever" }).blockers)
      .toContain("Required field needs an answer: LinkedIn Profile URL");

    const ashby = snapshot(field("1", "Your name"), field("2", "Your phone number"),
      field("3", "Personal website URL"), field("4", "Resume", "file"));
    expect(planApplicationForm(ashby, candidate, "/tmp/resume.pdf", { provider: "ashby" }).actions
      .map(({ value }) => value)).toEqual([
        "Test Candidate", "555-0100", "https://example.com", "/tmp/resume.pdf",
      ]);
  });

  it("maps only exact identity aliases on Lever, SmartRecruiters, and Workday", () => {
    const cases = [
      { provider: "lever" as const, label: "LinkedIn URL", expected: "https://linkedin.com/in/test" },
      { provider: "smartrecruiters" as const, label: "Mobile Phone", expected: "555-0100" },
      { provider: "workday" as const, label: "Primary Email", expected: "test@example.com" },
    ];
    for (const { provider, label, expected } of cases) {
      const plan = planApplicationForm(snapshot(field("1", label), field("2", "Visa sponsorship")),
        candidate, "/tmp/resume.pdf", { provider, allowMissingResume: true });
      expect(plan.actions).toContainEqual(expect.objectContaining({ name: label, value: expected }));
      expect(plan.blockers).toContain("Required field needs an answer: Visa sponsorship");
    }
    const unknown = planApplicationForm(snapshot(field("1", "Primary Email")),
      candidate, "/tmp/resume.pdf", { provider: "lever", allowMissingResume: true });
    expect(unknown.blockers).toContain("Required field needs an answer: Primary Email");
  });

  it("does not answer sensitive or ambiguous provider questions", () => {
    const plan = planApplicationForm(snapshot(field("1", "Visa sponsorship"),
      field("2", "Your race"), field("3", "LinkedIn Profile"), field("4", "Resume", "file")),
    candidate, "/tmp/resume.pdf", { provider: "greenhouse" });
    expect(plan.blockers).toContain("Required field needs an answer: Visa sponsorship");
    expect(plan.blockers).toContain("Required field needs an answer: Your race");
    expect(plan.actions.map(({ name }) => name)).toEqual(["LinkedIn Profile", "Resume"]);
  });
  it("fills only an exact approved plain-text answer after a handoff", () => {
    const plan = planApplicationForm(snapshot(field("1", "Salary expectation"),
      field("2", "Your race")), candidate, "/tmp/resume.pdf", {
      approvedHumanAnswers: new Map([["Salary expectation", "125000"], ["Your race", "Prefer not to say"]]),
      allowMissingResume: true,
    });
    expect(plan.actions).toContainEqual(expect.objectContaining({ name: "Salary expectation", value: "125000" }));
    expect(plan.blockers).toContain("Required field needs an answer: Your race");
  });
  it("maps only supported identity fields and a resume", () => {
    const plan = planApplicationForm(snapshot(
      field("1", "First name"), field("2", "Last name"), field("3", "Email"),
      field("4", "Resume", "file"),
    ), candidate, "/tmp/job-resume.pdf");
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.map(({ value, action }) => [value, action])).toEqual([
      ["Test", "fill"], ["Candidate", "fill"], ["test@example.com", "fill"],
      ["/tmp/job-resume.pdf", "upload"],
    ]);
  });

  it("pauses on unknown required, duplicate, and verification fields", () => {
    const plan = planApplicationForm(snapshot(
      field("1", "Email"), field("2", "Email"), field("3", "Expected salary"),
      field("4", "Verification code"),
    ), candidate, "/tmp/resume.pdf");
    expect(plan.blockers).toHaveLength(5);
    expect(plan.actions).toEqual([]);
  });

  it("refuses to fill any field when a required answer is unknown", async () => {
    const browser = { act: vi.fn() };
    const result = await fillApplicationForm(browser as never,
      snapshot(field("1", "Email"), field("2", "Citizenship details")), candidate, "/tmp/resume.pdf");
    expect(result.blockers).toHaveLength(2);
    expect(browser.act).not.toHaveBeenCalled();
  });

  it("refreshes refs after every action and halts on form drift", async () => {
    const initial = snapshot(field("1", "First name"), field("2", "Email"), field("5", "Resume", "file"));
    const next = snapshot(field("3", "First name"), field("4", "Email"), field("6", "Resume", "file"));
    const browser = { act: vi.fn().mockResolvedValue(next) };
    const result = await fillApplicationForm(browser as never, initial, candidate, "/tmp/resume.pdf");
    expect(result.blockers).toEqual([]);
    expect(browser.act.mock.calls.map((call) => call[0])).toEqual(["1", "4", "6"]);
    const drifted = { ...next, url: "https://jobs.example.com/other" };
    browser.act = vi.fn().mockResolvedValueOnce(next).mockResolvedValueOnce(next).mockResolvedValueOnce(drifted);
    await expect(fillApplicationForm(browser as never, initial, candidate, "/tmp/resume.pdf"))
      .rejects.toThrow("changed during form filling");
  });

  it("pauses when filling reveals a new required question", async () => {
    const initial = snapshot(field("1", "First name"), field("2", "Resume", "file"));
    const conditional = snapshot(field("3", "First name"), field("4", "Resume", "file"),
      field("5", "Salary expectation"));
    const browser = { act: vi.fn(), fillBatch: vi.fn().mockResolvedValue(conditional) };
    const result = await fillApplicationForm(browser as never, initial, candidate, "/tmp/resume.pdf");
    expect(result.blockers).toContain("Required field needs an answer: Salary expectation");
    expect(result.uploaded).toBe(true);
    const known = snapshot(field("3", "First name"), field("4", "Resume", "file"),
      field("5", "Phone"));
    browser.fillBatch = vi.fn().mockResolvedValue(known);
    const knownResult = await fillApplicationForm(browser as never, initial, candidate, "/tmp/resume.pdf");
    expect(knownResult.blockers).toContain("New required field appeared after filling: Phone");
  });

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("fills labeled fields in real Chromium", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-form-"));
    try {
      const resumePath = join(root, "resume.pdf");
      await writeFile(resumePath, "%PDF-1.4\n%%EOF\n");
      const keyPath = join(root, "key.pem");
      const certPath = join(root, "cert.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", keyPath, "-out", certPath, "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
      const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<form><label for="first">First name</label><input id="first" required>
          <label for="email">Email</label><input id="email" type="email" required>
          <label for="authorized">Are you legally authorized to work in the United States?</label>
          <select id="authorized" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
          <label for="sponsorship">Will you now or in the future require visa sponsorship to work in the United States?</label>
          <select id="sponsorship" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
          <label for="reason">Why this company?</label><textarea id="reason"></textarea>
          <label for="resume">Resume</label><input id="resume" type="file" required></form>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Test server did not bind");
        const url = `https://127.0.0.1:${address.port}/apply`;
        const runtime = await launchBrowser({ profileDirectory: join(root, "profile"), headless: true,
          launch: (path, options) => chromium.launchPersistentContext(path, { ...options, ignoreHTTPSErrors: true }) });
        try {
          const verifiedBytes = await readFile(resumePath);
          const browser = new AgentBrowser(runtime.context, new Set(["127.0.0.1"]),
            new Map([[resumePath, createHash("sha256").update(verifiedBytes).digest("hex")]]));
          const first = await browser.navigate(url);
          const result = await fillApplicationForm(browser, first, candidate, resumePath);
          expect(result.blockers).toEqual([]);
          const page = runtime.context.pages().at(-1)!;
          expect(await page.locator("#first").inputValue()).toBe("Test");
          expect(await page.locator("#email").inputValue()).toBe("test@example.com");
          expect(await page.locator("#authorized").inputValue()).toBe("Yes");
          expect(await page.locator("#sponsorship").inputValue()).toBe("No");
          expect(await page.locator("#reason").inputValue()).toBe("");
          expect(await page.locator("#resume").evaluate((element) => (element as HTMLInputElement).files?.[0]?.name)).toBe("resume.pdf");
          await writeFile(resumePath, "%PDF-1.4\nchanged\n%%EOF\n");
          const resumeRef = result.snapshot.controls.find((control) => control.name === "Resume")?.ref ?? "";
          await expect(browser.act(resumeRef, "upload", resumePath)).rejects.toThrow("changed after verification");
        } finally {
          await runtime.close();
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
