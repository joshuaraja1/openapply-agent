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
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
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
