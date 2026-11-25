import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import { renderOwnedOverleafResume } from "../src/resume/owned-overleaf.js";
import { launchBrowser } from "../src/browser/runtime.js";
import type { VerifiedResumeArtifact } from "../src/resume/verify-pdf.js";
import type { CandidateProfile } from "../src/candidate/schema.js";
import type { DiscoveredJob } from "../src/types.js";
import type { ResumeSource } from "../src/resume/jake.js";

const projectUrl = `https://www.overleaf.com/project/${"a".repeat(24)}`;
const job = { id: "test:123" } as DiscoveredJob;
const candidate = {} as CandidateProfile;
const source = { latex: "\\documentclass{article}", fingerprint: "a".repeat(64) } as ResumeSource;
const verified = (path: string): VerifiedResumeArtifact => ({ path, jobId: job.id,
  sourceFingerprint: source.fingerprint,
  pdfSha256: createHash("sha256").update(Buffer.alloc(200, 7)).digest("hex"), pages: 1,
  verifiedAt: new Date().toISOString() });

function fixture() {
  const fill = vi.fn(async () => {});
  const compileClick = vi.fn(async () => {});
  const downloadClick = vi.fn(async () => {});
  const page = {
    goto: vi.fn(async () => {}), url: () => projectUrl,
    getByRole: vi.fn((role: string, options: { name: string }) => ({
      count: async () => 1,
      fill: role === "textbox" ? fill : undefined,
      click: options.name === "Recompile" ? compileClick : downloadClick,
    })),
    locator: vi.fn(() => ({ waitFor: vi.fn(async () => {}) })),
    waitForEvent: vi.fn(async () => ({ createReadStream: async () => Readable.from([Buffer.alloc(200, 7)]) })),
  } as unknown as Page;
  const context = { route: vi.fn(async () => {}), newPage: vi.fn(async () => page) } as unknown as BrowserContext;
  const close = vi.fn(async () => {});
  return { page, context, close, fill, compileClick, downloadClick };
}

describe.skipIf(process.platform === "win32")("owned Overleaf renderer", () => {
  it("compiles, downloads, verifies, and closes the local browser", async () => {
    const output = await mkdtemp(join(tmpdir(), "openapply-owned-overleaf-"));
    try {
      const { context, close, fill, compileClick, downloadClick } = fixture();
      const verify = vi.fn(async (path: string) => verified(path));
      const artifact = await renderOwnedOverleafResume(projectUrl, job, candidate, source, output, {
        launch: async () => ({ context, close }), verify: verify as never,
      });
      expect(fill).toHaveBeenCalledWith(source.latex);
      expect(compileClick).toHaveBeenCalledOnce();
      expect(downloadClick).toHaveBeenCalledOnce();
      expect(await readFile(artifact.path)).toHaveLength(200);
      expect(verify).toHaveBeenCalledWith(artifact.path, job, candidate, source);
      expect(close).toHaveBeenCalledOnce();
      const routeHandler = vi.mocked(context.route).mock.calls[0]?.[1] as (route: Route) => Promise<void>;
      const abort = vi.fn(async () => {});
      await routeHandler({ request: () => ({ isNavigationRequest: () => true,
        url: () => "https://evil.example/" }), abort } as unknown as Route);
      expect(abort).toHaveBeenCalledOnce();
    } finally { await rm(output, { recursive: true, force: true }); }
  });

  it("removes an unverified PDF and releases the profile", async () => {
    const output = await mkdtemp(join(tmpdir(), "openapply-owned-overleaf-"));
    try {
      const { context, close } = fixture();
      await expect(renderOwnedOverleafResume(projectUrl, job, candidate, source, output, {
        launch: async () => ({ context, close }),
        verify: async () => { throw new Error("PDF failed verification"); },
      })).rejects.toThrow("PDF failed verification");
      expect(await readdir(output)).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
    } finally { await rm(output, { recursive: true, force: true }); }
  });

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "compiles and downloads through a controlled Chromium page", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owned-overleaf-e2e-"));
      try {
        const output = join(root, "output");
        const bytes = Buffer.alloc(200, 7);
        const html = `<label for="editor">Source Editor editing</label><textarea id="editor"></textarea>
          <button class="compile-button" data-ol-loading="false">Recompile</button>
          <a download="resume.pdf" href="data:application/pdf;base64,${bytes.toString("base64")}">Download PDF</a>`;
        const verify = vi.fn(async (path: string) => {
          expect(await readFile(path)).toEqual(bytes);
          return verified(path);
        });
        const artifact = await renderOwnedOverleafResume(projectUrl, job, candidate, source, output, {
          launch: async () => {
            const runtime = await launchBrowser({ profileDirectory: join(root, "profile"), headless: true,
              launch: (path, options) => chromium.launchPersistentContext(path, options) });
            await runtime.context.route("https://www.overleaf.com/project/**", async (route) => {
              await route.fulfill({ status: 200, contentType: "text/html", body: html });
            });
            return runtime;
          },
          verify: verify as never,
        });
        expect(artifact.path.endsWith(".pdf")).toBe(true);
        expect(verify).toHaveBeenCalledOnce();
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 30_000,
  );
});
