import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRunnerConfigSchema } from "../src/application/queue-config.js";
import { runScheduledBrowserDiscovery, validateScheduledBrowserSearch }
  from "../src/application/autopilot-browser-discovery.js";
import { browserSearchInputSchema } from "../src/browser/schema.js";
import { verifyOfficialBrowserLeads } from "../src/browser/verify-official.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import type { BrowserToolResult } from "../src/browser/client.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(runtime: "browseros" | "owned" = "owned") {
  const root = await mkdtemp(join(tmpdir(), "openapply-autopilot-board-"));
  if (process.platform === "win32") await secureWindowsPrivatePath(root);
  roots.push(root);
  const inputPath = join(root, "search.json");
  const outputDirectory = join(root, "private");
  await ensurePrivateDirectory(outputDirectory);
  const outputPath = join(outputDirectory, "leads.json");
  const input = browserSearchInputSchema.parse({ runtime,
    searches: [
      { label: "broken", platform: "generic", url: "https://bad.example.test/search" },
      { label: "working", platform: "generic", url: "https://good.example.test/search" },
    ] });
  await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
  if (process.platform === "win32") await secureWindowsPrivatePath(inputPath);
  const config = queueRunnerConfigSchema.parse({ version: 1,
    queuePath: join(root, "queue.json"), candidatePath: join(root, "candidate.json"),
    preferencesPath: join(root, "preferences.json"),
    discoveryInputPath: join(root, "discovery.json"), discoveryStatePath: join(root, "state.json"),
    browserRuntime: runtime, ...(runtime === "browseros" ? { browserEndpoint: input.endpoint } : {}),
    browserSearchInputPath: inputPath, browserLeadsOutputPath: outputPath,
    overleafProjectUrl: "https://www.overleaf.com/project/000000000000000000000000",
    outputDirectory: root });
  return { root, input, inputPath, outputPath, config };
}

describe("scheduled browser discovery", () => {
  it("rejects runtime and endpoint mismatch before connecting", async () => {
    const f = await fixture();
    expect(() => validateScheduledBrowserSearch(f.config,
      { ...f.input, runtime: "browseros" })).toThrow("runtime must match");
    const browseros = await fixture("browseros");
    expect(() => validateScheduledBrowserSearch(browseros.config,
      { ...browseros.input, endpoint: "http://127.0.0.1:9999/mcp" })).toThrow("endpoint must match");
    expect(() => queueRunnerConfigSchema.parse({ ...f.config,
      browserLeadsOutputPath: f.config.queuePath })).toThrow();
    expect(() => queueRunnerConfigSchema.parse({ ...f.config,
      browserLeadsOutputPath: f.inputPath })).toThrow();
    expect(() => queueRunnerConfigSchema.parse({ ...f.config,
      browserLeadsOutputPath: undefined })).toThrow();
  });

  it("isolates a failed search, closes the browser before publishing private leads", async () => {
    const f = await fixture("browseros");
    const sequence: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { callTool: vi.fn(async (request: { name: string; arguments: Record<string, unknown> })
      : Promise<BrowserToolResult> => {
      if (request.name === "tabs") {
        if (request.arguments.url === "https://bad.example.test/search") {
          return { isError: true, content: [{ type: "text", text: "offline" }] };
        }
        return { structuredContent: { page: { id: 2 } } };
      }
      if (request.name === "read") return { content: [{ type: "text",
        text: "[Engineer](https://job-boards.greenhouse.io/example/jobs/1234)" }] };
      return { content: [{ type: "text", text: "ok" }] };
    }) };
    try {
      const path = await runScheduledBrowserDiscovery(f.config, {
        connect: async () => ({ client, close: async () => { sequence.push("closed"); } }),
        write: async (path, value) => {
          sequence.push("written");
          const { writePrivateAtomicJson } = await import("../src/storage/discovery-output.js");
          await writePrivateAtomicJson(path, value);
        },
      });
      expect(path).toBe(f.outputPath);
      expect(sequence).toEqual(["closed", "written"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipped browser search broken"));
      const output = JSON.parse(await readFile(f.outputPath, "utf8"));
      expect(output.leads).toHaveLength(1);
      expect(output.leads[0].url).toBe("https://job-boards.greenhouse.io/example/jobs/1234");
      if (process.platform !== "win32") expect((await stat(f.outputPath)).mode & 0o077).toBe(0);
      expect((await readFile(f.inputPath, "utf8"))).toContain("bad.example.test");
    } finally { warn.mockRestore(); }
  });

  it("replaces stale leads with an empty file after all searches fail", async () => {
    const f = await fixture();
    await writeFile(f.outputPath, JSON.stringify({ leads: [{ url: "https://stale.example.test" }] }),
      { mode: 0o600 });
    if (process.platform === "win32") await secureWindowsPrivatePath(f.outputPath);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runScheduledBrowserDiscovery(f.config, { connect: async () => ({
        client: { callTool: async (request) => request.name === "tabs"
          ? { isError: true } : { content: [] } }, close: async () => {},
      }) });
      expect(JSON.parse(await readFile(f.outputPath, "utf8")).leads).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it("does not promote a board lead or closed official posting into the queue input", async () => {
    const f = await fixture();
    const lead = { platform: "generic" as const, title: "Engineer",
      url: "https://job-boards.greenhouse.io/example/jobs/1234",
      sourceSearchUrl: f.input.searches[1]!.url, observedAt: new Date().toISOString() };
    const fetcher = vi.fn(async () => []);
    expect(await verifyOfficialBrowserLeads([lead], new Date(), fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await verifyOfficialBrowserLeads([{ ...lead,
      url: "https://www.linkedin.com/jobs/view/1234/" }], new Date(), fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
