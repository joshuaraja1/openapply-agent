import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fillApplicationForm } from "../src/application/form-mapper.js";
import { planApplicationForm } from "../src/application/form-mapper.js";
import { NeoApplicationBrowser, parseNeoSnapshot } from "../src/browser/neo-application.js";
import type { BrowserToolClient, BrowserToolResult } from "../src/browser/client.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";

const url = "https://jobs.example.com/apply";
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});
const result = (text: string): BrowserToolResult => ({ content: [{ type: "text", text }] });
const tree = (filled: boolean, submitted: boolean, origin = url) =>
  `[UNTRUSTED_PAGE_CONTENT nonce=fixture origin=${origin}] Untrusted page content follows.\n`
  + (submitted ? '- heading "Thank you for applying" [level=1]\n' : `- form\n`
    + `  - textbox "First name" [required] [ref=e1]${filled ? ': "Test"' : ''}\n`
    + `  - textbox "Email" [required] [ref=e2]${filled ? ': "test@example.com"' : ''}\n`
    + `  - button "Resume" [ref=e3]\n  - button "Submit application" [ref=e4]\n`)
  + `[END_UNTRUSTED_PAGE_CONTENT nonce=fixture]`;

describe("BrowserOS application adapter", () => {
  it("parses visible required fields and the résumé control", () => {
    const snapshot = parseNeoSnapshot(tree(false, false));
    expect(snapshot.controls.map(({ name, type, required }) => [name, type, required]))
      .toEqual([["First name", null, true], ["Email", null, true],
        ["Resume", "file", false], ["Submit application", "submit", false]]);
    expect(() => parseNeoSnapshot(tree(false, false, "http://localhost/apply"))).toThrow("HTTPS");
    expect(planApplicationForm({ ...snapshot, visibleText: `${snapshot.visibleText}\nVerify you are human` },
      candidate, "/private/resume.pdf").blockers).toContain("Human verification is present on the application page");
  });

  it("fills a form in one call, uploads only the approved PDF, and verifies confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-neo-"));
    try {
      const path = join(root, "resume.pdf");
      const bytes = Buffer.from("%PDF-1.4\nfixture\n");
      await writeFile(path, bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      let filled = false;
      let submitted = false;
      const client: BrowserToolClient = { callTool: vi.fn(async ({ name, arguments: args }) => {
        if (name === "name_session") return result("renamed");
        if (name === "tabs" && args.action === "list") return result("tabs");
        if (name === "tabs" && args.action === "new") return result("opened page 7");
        if (name === "snapshot") return result(tree(filled, submitted));
        if (name === "act" && args.kind === "fill") { filled = true; return result("ok (fill)"); }
        if (name === "act" && args.kind === "click") { submitted = true; return result("ok (click)"); }
        if (name === "upload") return result("Selected 1 file(s) on page 7");
        if (name === "wait") return result("matched (text)");
        throw new Error(`Unexpected BrowserOS call ${name}`);
      }) };
      const browser = new NeoApplicationBrowser(client, new Set(["jobs.example.com"]), new Map([[path, hash]]));
      const first = await browser.navigate(url);
      const filledForm = await fillApplicationForm(browser, first, candidate, path);
      expect(filledForm.blockers).toEqual([]);
      expect(await browser.submit(filledForm.snapshot.controls.find((entry) => entry.type === "submit")!.ref,
        "Thank you for applying")).toBe("Thank you for applying");
      const calls = vi.mocked(client.callTool).mock.calls.map(([call]) => call);
      expect(calls.filter((call) => call.name === "act" && call.arguments.kind === "fill")).toHaveLength(1);
      expect(calls.filter((call) => call.name === "upload")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops before filling when an application redirects off the approved host", async () => {
    const client: BrowserToolClient = { callTool: vi.fn(async ({ name }) => {
      if (name === "name_session") return result("renamed");
      if (name === "tabs") return result("opened page 7");
      if (name === "snapshot") return result(tree(false, false, "https://other.example/apply"));
      throw new Error(`Unexpected browser action ${name}`);
    }) };
    const browser = new NeoApplicationBrowser(client, new Set(["jobs.example.com"]), new Map());
    await expect(browser.navigate(url)).rejects.toThrow("approved employer domain");
    expect(vi.mocked(client.callTool).mock.calls.some(([call]) => call.name === "act"
      || call.name === "upload")).toBe(false);
  });
});
