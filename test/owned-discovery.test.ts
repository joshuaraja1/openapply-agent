import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import { OwnedDiscoveryBrowserClient } from "../src/browser/owned-discovery.js";
import { resultText } from "../src/browser/client.js";
import { discoverBrowserLeads } from "../src/browser/discover.js";
import { launchBrowser } from "../src/browser/runtime.js";
import { browserSearchInputSchema } from "../src/browser/schema.js";

function fixture() {
  let currentUrl = "about:blank";
  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    url: () => currentUrl,
    close: vi.fn(async () => {}),
    isClosed: () => false,
    locator: vi.fn((selector: string) => ({
      evaluateAll: vi.fn(async (callback: (anchors: Array<{ href: string; textContent: string;
        getAttribute(name: string): string | null }>) => unknown) => callback(selector === "a[href]" ? [
        { href: "https://jobs.example.test/jobs/123", textContent: "Software Engineer", getAttribute: () => null },
        { href: "javascript:alert(1)", textContent: "Bad link", getAttribute: () => null },
        { href: `https://jobs.example.test/jobs/${"x".repeat(5_000)}`,
          textContent: "Oversized", getAttribute: () => null },
        { href: "https://user:secret@jobs.example.test/jobs/456",
          textContent: "Credentialed", getAttribute: () => null },
      ] : [])),
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

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "discovers job links from a synthetic HTTPS page in real Chromium", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owned-discovery-"));
      try {
        const keyPath = join(root, "key.pem");
        const certPath = join(root, "cert.pem");
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
          "-keyout", keyPath, "-out", certPath, "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
        const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) },
          (_request, response) => {
            response.writeHead(200, { "content-type": "text/html" });
            response.end(`<a href="/jobs/123?jobId=123&access_token=secret">Software Engineer</a>
              <a href="/account/settings">Account</a>`);
          });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Test server did not bind");
          const url = `https://127.0.0.1:${address.port}/search`;
          const runtime = await launchBrowser({ profileDirectory: join(root, "profile"), headless: true,
            launch: (path, options) => chromium.launchPersistentContext(path,
              { ...options, ignoreHTTPSErrors: true }) });
          try {
            const client = await OwnedDiscoveryBrowserClient.create(runtime.context, [url]);
            const leads = await discoverBrowserLeads(client, browserSearchInputSchema.parse({
              runtime: "owned", searches: [{ label: "Synthetic", platform: "generic", url }],
            }));
            expect(leads.map((lead) => lead.url)).toEqual([
              `https://127.0.0.1:${address.port}/jobs/123?jobId=123`,
            ]);
          } finally { await runtime.close(); }
        } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
});
