import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { AgentBrowser } from "../src/browser/actions.js";

function fixture(fieldName = "email", fieldType: string | null = null) {
  let connected = true;
  let value = "";
  let confirmationVisible = false;
  const handle = {
    isVisible: async () => true,
    evaluate: async (callback: (node: { tagName: string; isConnected: boolean }) => unknown) =>
      callback({ tagName: "INPUT", isConnected: connected }),
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
