import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page, Route } from "playwright";
import { OwnedDiscoveryBrowserClient } from "../src/browser/owned-discovery.js";
import { resultText } from "../src/browser/client.js";

function fixture() {
  let currentUrl = "about:blank";
  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    url: () => currentUrl,
    close: vi.fn(async () => {}),
    isClosed: () => false,
    locator: vi.fn((selector: string) => ({
      evaluateAll: vi.fn(async () => selector === "a[href]" ? [
        { href: "https://jobs.example.test/jobs/123", label: "Software Engineer" },
        { href: "javascript:alert(1)", label: "Bad link" },
      ] : []),
      first: () => ({ waitFor: vi.fn(async () => {}) }),
    })),
  } as unknown as Page;
  const context = {
    route: vi.fn(async () => {}),
    newPage: vi.fn(async () => page),
  } as unknown as BrowserContext;
  return { page, context };
}

describe("owned browser discovery", () => {
  it("extracts linked job leads from an approved search", async () => {
    const { context, page } = fixture();
    const client = await OwnedDiscoveryBrowserClient.create(context, ["https://jobs.example.test/search"]);
    const opened = await client.callTool({ name: "tabs", arguments: {
      action: "new", url: "https://jobs.example.test/search",
    } });
    expect(opened.structuredContent).toEqual({ page: { id: 1 } });
    const read = await client.callTool({ name: "read", arguments: {
      page: 1, format: "markdown", includeLinks: true,
    } });
    expect(resultText(read)).toBe("[Software Engineer](https://jobs.example.test/jobs/123)");
    await client.callTool({ name: "tabs", arguments: { action: "close", page: 1 } });
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("rejects off-origin search tabs and navigation", async () => {
    const { context } = fixture();
    const client = await OwnedDiscoveryBrowserClient.create(context, ["https://jobs.example.test/search"]);
    await expect(client.callTool({ name: "tabs", arguments: {
      action: "new", url: "https://other.test/search",
    } })).rejects.toThrow("outside approved origins");
    expect(context.newPage).not.toHaveBeenCalled();

    const handler = vi.mocked(context.route).mock.calls[0]?.[1] as (route: Route) => Promise<void>;
    const abort = vi.fn(async () => {});
    const continueRequest = vi.fn(async () => {});
    await handler({ request: () => ({ isNavigationRequest: () => true,
      url: () => "https://other.test/signin" }), abort, continue: continueRequest } as unknown as Route);
    expect(abort).toHaveBeenCalledOnce();
    expect(continueRequest).not.toHaveBeenCalled();
  });

  it("rejects credentialed or non-HTTPS search URLs", async () => {
    const { context } = fixture();
    await expect(OwnedDiscoveryBrowserClient.create(context,
      ["http://jobs.example.test/search"])).rejects.toThrow("credential-free HTTPS");
    await expect(OwnedDiscoveryBrowserClient.create(context,
      ["https://user:password@jobs.example.test/search"])).rejects.toThrow("credential-free HTTPS");
  });
});
