import { describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser/actions.js";
import { planApplicationForm } from "../src/application/form-mapper.js";
import type { CandidateProfile } from "../src/candidate/schema.js";

function fixture(fieldName = "email", fieldType: string | null = null, text = "") {
  let connected = true;
  let value = "";
  let confirmationVisible = false;
  const handle = {
    isVisible: async () => true,
    evaluate: async (callback: (node: object) => unknown) => callback({
      tagName: "INPUT", isConnected: connected, labels: [], textContent: "",
      matches: () => false, getAttribute: (name: string) => name === "name" ? fieldName : null,
    }),
    getAttribute: async (name: string) => name === "name" ? fieldName : name === "type" ? fieldType : null,
    innerText: async () => "",
    inputValue: async () => value,
    fill: async (next: string) => { value = next; },
    click: async () => { confirmationVisible = true; },
  };
  const page = {
    url: () => "https://jobs.example.com/apply",
    title: async () => "Apply",
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({ text: text.slice(0, 50_000), overflow: text.length > 50_000 })),
    locator: () => ({ elementHandles: async () => [handle] }),
    getByText: () => ({
      count: async () => confirmationVisible ? 1 : 0,
      first: () => ({ waitFor: async () => {}, innerText: async () => "Thank you for applying" }),
    }),
  };
  const context = {
    route: vi.fn(async () => {}),
    newPage: vi.fn(async () => page),
    pages: () => [page],
  } as unknown as BrowserContext;
  return {
    browser: new AgentBrowser(context, new Set(["jobs.example.com"])), page,
    getValue: () => value,
    setConfirmation: () => { confirmationVisible = true; },
    disconnect: () => { connected = false; },
  };
}

describe("agent browser controls", () => {
  it("rejects unapproved navigation before creating a page", async () => {
    const { browser, page } = fixture();
    await expect(browser.navigate("https://evil.example/apply")).rejects.toThrow("outside");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("fills a control and invalidates prior refs", async () => {
    const { browser, getValue } = fixture();
    const first = await browser.navigate("https://jobs.example.com/apply");
    const ref = first.controls[0]?.ref ?? "";
    const next = await browser.act(ref, "fill", "candidate@example.com");
    expect(next.controls[0]?.value).toBeNull();
    expect(getValue()).toBe("candidate@example.com");
    await expect(browser.act(ref, "fill", "wrong@example.com")).rejects.toThrow("Stale");
  });

  it("rejects controls removed after a snapshot", async () => {
    const { browser, disconnect } = fixture();
    const first = await browser.navigate("https://jobs.example.com/apply");
    disconnect();
    await expect(browser.act(first.controls[0]?.ref ?? "", "click")).rejects.toThrow("changed");
  });

  it("redacts secrets from snapshots", async () => {
    const { browser } = fixture("verificationCode", "text");
    const first = await browser.navigate("https://jobs.example.com/apply");
    const next = await browser.act(first.controls[0]?.ref ?? "", "fill", "123456");
    expect(next.controls[0]?.value).toBeNull();
  });

  it("includes visible challenge text so form planning pauses", async () => {
    const { browser } = fixture("email", "text", "Please verify you are human");
    const snapshot = await browser.navigate("https://jobs.example.com/apply");
    expect(planApplicationForm(snapshot, { identity: { fullName: "Test Candidate" } } as CandidateProfile,
      "/private/resume.pdf").blockers)
      .toContain("Human verification is present on the application page");
  });

  it("fails closed when visible page text exceeds the snapshot limit", async () => {
    const { browser } = fixture("email", "text", "a".repeat(50_001));
    await expect(browser.navigate("https://jobs.example.com/apply")).rejects.toThrow("safe snapshot limit");
  });

  it("invalidates old controls after a snapshot exceeds the page-text limit", async () => {
    const { browser, page } = fixture("email", "text");
    const first = await browser.navigate("https://jobs.example.com/apply");
    page.evaluate.mockResolvedValueOnce({ text: "a".repeat(50_000), overflow: true });
    await expect(browser.snapshot()).rejects.toThrow("safe snapshot limit");
    await expect(browser.act(first.controls[0]!.ref, "fill", "old@example.com"))
      .rejects.toThrow("Stale");
  });

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "reads a visible challenge from a controlled Chromium application page", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-snapshot-"));
      const context = await chromium.launchPersistentContext(join(root, "profile"), { headless: true });
      try {
        await context.route("https://jobs.example.com/**", async (route) => {
          await route.fulfill({ contentType: "text/html", body:
            '<label for="email">Email</label><input id="email"><p>Verify you are human</p>' });
        });
        const browser = new AgentBrowser(context, new Set(["jobs.example.com"]));
        const snapshot = await browser.navigate("https://jobs.example.com/apply/123456");
        expect(snapshot.visibleText).toContain("Verify you are human");
        expect(planApplicationForm(snapshot,
          { identity: { fullName: "Test Candidate" } } as CandidateProfile, "/private/resume.pdf").blockers)
          .toContain("Human verification is present on the application page");
      } finally { await context.close(); await rm(root, { recursive: true, force: true }); }
    }, 30_000,
  );

  it("blocks generic submit clicks and unapproved uploads", async () => {
    const submit = fixture("apply", "submit");
    const first = await submit.browser.navigate("https://jobs.example.com/apply");
    await expect(submit.browser.act(first.controls[0]?.ref ?? "", "click")).rejects.toThrow("Submission");
    const upload = fixture("resume", "file");
    const second = await upload.browser.navigate("https://jobs.example.com/apply");
    await expect(upload.browser.act(second.controls[0]?.ref ?? "", "upload", "/tmp/private.txt"))
      .rejects.toThrow("not approved");
  });

  it("rejects pre-existing confirmation text before submitting", async () => {
    const { browser, setConfirmation } = fixture("apply", "submit");
    const snapshot = await browser.navigate("https://jobs.example.com/apply");
    setConfirmation();
    await expect(browser.submit(snapshot.controls[0]?.ref ?? "", "Thank you for applying"))
      .rejects.toThrow("already visible");
  });
});
