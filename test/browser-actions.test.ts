import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { AgentBrowser } from "../src/browser/actions.js";

function fixture() {
  let connected = true;
  let value = "";
  const handle = {
    isVisible: async () => true,
    evaluate: async (callback: (node: { tagName: string; isConnected: boolean }) => unknown) =>
      callback({ tagName: "INPUT", isConnected: connected }),
    getAttribute: async (name: string) => name === "name" ? "email" : null,
    innerText: async () => "",
    inputValue: async () => value,
    fill: async (next: string) => { value = next; },
  };
  const page = {
    url: () => "https://jobs.example.com/apply",
    title: async () => "Apply",
    goto: vi.fn(async () => {}),
    locator: () => ({ elementHandles: async () => [handle] }),
  };
  const context = {
    route: vi.fn(async () => {}),
    newPage: vi.fn(async () => page),
  } as unknown as BrowserContext;
  return { browser: new AgentBrowser(context, new Set(["jobs.example.com"])), page, disconnect: () => { connected = false; } };
}

describe("agent browser controls", () => {
  it("rejects unapproved navigation before creating a page", async () => {
    const { browser, page } = fixture();
    await expect(browser.navigate("https://evil.example/apply")).rejects.toThrow("outside");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("fills a control and invalidates prior refs", async () => {
    const { browser } = fixture();
    const first = await browser.navigate("https://jobs.example.com/apply");
    const ref = first.controls[0]?.ref ?? "";
    const next = await browser.act(ref, "fill", "candidate@example.com");
    expect(next.controls[0]?.value).toBe("candidate@example.com");
    await expect(browser.act(ref, "fill", "wrong@example.com")).rejects.toThrow("Stale");
  });

  it("rejects controls removed after a snapshot", async () => {
    const { browser, disconnect } = fixture();
    const first = await browser.navigate("https://jobs.example.com/apply");
    disconnect();
    await expect(browser.act(first.controls[0]?.ref ?? "", "click")).rejects.toThrow("changed");
  });
});
