import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrowserToolClient, BrowserToolResult } from "../src/browser/client.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { assertLocalBrowserEndpoint, assertOverleafProjectUrl, renderOverleafResume } from "../src/resume/overleaf.js";
import type { ResumeSource } from "../src/resume/jake.js";
import type { DiscoveredJob } from "../src/types.js";

const projectUrl = "https://www.overleaf.com/project/6b05f83c59202882195bf8d7";
const job = { id: "test:job", title: "Engineer", company: "Example Co" } as DiscoveredJob;
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});
const source: ResumeSource = { latex: "synthetic LaTeX", fingerprint: "f".repeat(64),
  renderToken: "a".repeat(64), claimIds: ["claim"] };

function result(text: string): BrowserToolResult {
  return { content: [{ type: "text", text }] };
}

describe("Overleaf renderer adapter", () => {
  it("limits connection and project URLs", () => {
    expect(() => assertLocalBrowserEndpoint("http://127.0.0.1:9200/mcp")).not.toThrow();
    expect(() => assertLocalBrowserEndpoint("https://remote.example/mcp")).toThrow("local");
    expect(() => assertOverleafProjectUrl(projectUrl)).not.toThrow();
    expect(() => assertOverleafProjectUrl("https://evil.example/project/6b05f83c59202882195bf8d7"))
      .toThrow("Overleaf");
  });

  it.skipIf(process.platform === "win32")("fills, compiles, downloads, and verifies a private artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-overleaf-"));
    try {
      const downloads = join(root, "Downloads");
      const artifacts = join(root, "artifacts");
      const downloaded = join(downloads, "fixture.pdf");
      const bytes = Buffer.from("%PDF-1.4\n" + "x".repeat(120));
      await mkdir(downloads);
      await writeFile(downloaded, bytes);
      let snapshots = 0;
      const client: BrowserToolClient = { callTool: vi.fn(async ({ name, arguments: args }) => {
        if (name === "name_session") return result("renamed");
        if (name === "tabs" && args.action === "new") return result("opened page 7");
        if (name === "tabs" && args.action === "close") return result("closed");
        if (name === "snapshot") {
          snapshots += 1;
          return result(snapshots === 1 ? '- textbox "Source Editor editing" [ref=e3]'
            : snapshots === 2 ? '- button "Recompile" [ref=e4]'
              : '- link "Download PDF" [ref=e5]');
        }
        if (name === "act") return result("acted");
        if (name === "wait") return result("matched (selector)");
        if (name === "download") return result(`Downloaded "fixture.pdf" (128 bytes) on this machine, to: ${downloaded}`);
        throw new Error(`Unexpected BrowserOS call ${name}`);
      }) };
      const verify = vi.fn(async (path: string) => ({ jobId: job.id,
        sourceFingerprint: source.fingerprint, pdfSha256: createHash("sha256").update(bytes).digest("hex"),
        path, pages: 1, verifiedAt: new Date().toISOString() }));
      const artifact = await renderOverleafResume(client, projectUrl, job, candidate, source, artifacts,
        { downloadsDirectory: downloads, verify: verify as never });
      expect(await readFile(artifact.path)).toEqual(bytes);
      await expect(readFile(downloaded)).rejects.toMatchObject({ code: "ENOENT" });
      expect(verify).toHaveBeenCalledOnce();
      const calls = vi.mocked(client.callTool).mock.calls.map(([call]) => call);
      expect(calls.map(({ name }) => name)).toEqual(["name_session", "tabs", "snapshot", "act",
        "snapshot", "act", "wait", "snapshot", "download", "tabs"]);
      expect(calls[3]?.arguments).toMatchObject({ kind: "fill", sensitive: true, value: source.latex });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("blocks BrowserOS downloads without a Windows artifact ACL", async () => {
    const client: BrowserToolClient = { callTool: vi.fn(async () => result("unexpected")) };
    await expect(renderOverleafResume(client, projectUrl, job, candidate, source, "C:\\private"))
      .rejects.toThrow("Windows private artifact support");
    expect(client.callTool).not.toHaveBeenCalled();
  });
});
