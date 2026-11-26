import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { probeOwnedOverleafSession } from "../src/setup/overleaf-session.js";

const project = "https://www.overleaf.com/project/0123456789abcdef01234567";

function fixture(url = project) {
  let requestGate: ((route: unknown) => Promise<void>) | undefined;
  const page = { goto: vi.fn(async () => {}), url: () => url,
    getByRole: vi.fn(() => ({ waitFor: vi.fn(async () => {}), count: vi.fn(async () => 1) })),
    close: vi.fn(async () => {}) };
  const context = { route: vi.fn(async (_glob: string, handler: typeof requestGate) => {
    requestGate = handler;
  }), routeWebSocket: vi.fn(async () => {}), serviceWorkers: () => [],
  pages: () => [] as Array<{ url: () => string; close: () => Promise<void> }>,
  newPage: vi.fn(async () => page) };
  const close = vi.fn(async () => {});
  const launch = vi.fn(async () => ({ context, close }));
  return { page, context, close, launch, gate: () => requestGate! };
}

describe("read-only Overleaf session probe", () => {
  it("installs request and WebSocket gates before visiting the exact editor", async () => {
    const f = fixture();
    expect(await probeOwnedOverleafSession(project, f.launch as never)).toBe(true);
    expect(f.context.route).toHaveBeenCalledOnce();
    expect(f.context.routeWebSocket).toHaveBeenCalledOnce();
    expect(f.context.route.mock.invocationCallOrder[0]).toBeLessThan(
      f.context.newPage.mock.invocationCallOrder[0]!);
    expect(f.page.goto).toHaveBeenCalledWith(project, expect.objectContaining({ timeout: 15_000 }));
    expect(f.page.getByRole).toHaveBeenCalledWith("textbox",
      { name: "Source Editor editing", exact: true });
    expect(f.page.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();

    let writeHits = 0;
    const route = (method: string, url: string) => ({
      request: () => ({ method: () => method, url: () => url }),
      abort: vi.fn(async () => {}),
      fallback: vi.fn(async () => { if (url.includes("/api/submit")) writeHits += 1; }),
    });
    const scriptPost = route("POST", "https://www.overleaf.com/project/submit");
    await f.gate()(scriptPost);
    expect(scriptPost.abort).toHaveBeenCalledOnce();
    const outsideGet = route("GET", "https://evil.example/collect");
    await f.gate()(outsideGet);
    expect(outsideGet.abort).toHaveBeenCalledOnce();
    const scriptGet = route("GET", "https://www.overleaf.com/api/submit?write=1");
    await f.gate()(scriptGet);
    expect(scriptGet.abort).toHaveBeenCalledOnce();
    const allowedGet = route("GET", project);
    await f.gate()(allowedGet);
    expect(allowedGet.fallback).toHaveBeenCalledOnce();
    expect(writeHits).toBe(0);
    await expect(probeOwnedOverleafSession("https://evil.example/project/0123456789abcdef01234567",
      f.launch as never)).rejects.toThrow("direct HTTPS Overleaf");
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it("rejects a signed-out or wrong-project editor and closes the browser", async () => {
    for (const url of ["https://www.overleaf.com/login",
      "https://www.overleaf.com/project/aaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const f = fixture(url);
      expect(await probeOwnedOverleafSession(project, f.launch as never)).toBe(false);
      expect(f.page.getByRole).not.toHaveBeenCalled();
      expect(f.page.close).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
    }
  });

  it("rejects restored pages before opening the configured project", async () => {
    const f = fixture();
    const restored = { url: () => "https://www.overleaf.com/project/old",
      close: vi.fn(async () => {}) };
    f.context.pages = () => [restored];
    await expect(probeOwnedOverleafSession(project, f.launch as never))
      .rejects.toThrow("manual inspection");
    expect(restored.close).toHaveBeenCalledOnce();
    expect(f.context.newPage).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "blocks controlled page-script GET and POST writes before the editor becomes visible", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-session-probe-"));
      let writeHits = 0;
      try {
        const ready = await probeOwnedOverleafSession(project, async () => {
          const context = await chromium.launchPersistentContext(join(root, "profile"),
            { headless: true, serviceWorkers: "block" });
          await context.route("**/*", async (route) => {
            const request = route.request();
            if (request.url().includes("/api/submit")) {
              writeHits += 1;
              await route.fulfill({ status: 204 });
            } else {
              await route.fulfill({ status: 200, contentType: "text/html",
                body: `<label for="editor">Source Editor editing</label>
                  <textarea id="editor" hidden></textarea>
                  <script>Promise.allSettled([
                    fetch('/api/submit?write=1'),
                    fetch('/api/submit',{method:'POST',body:'write'})
                  ]).finally(()=>document.getElementById('editor').hidden=false)</script>` });
            }
          });
          return { context, close: () => context.close() };
        });
        expect(ready).toBe(true);
        expect(writeHits).toBe(0);
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 30_000,
  );
});
