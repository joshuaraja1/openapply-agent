import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheWakeSecret, cloudWakeConfigSchema, runCloudWakeOnce } from "../src/cloud/wake.js";
import type { SecretStore } from "../src/storage/contracts.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const secret = "a".repeat(48);
const secrets: SecretStore = { get: async () => secret, put: async () => {}, delete: async () => {} };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "openapply-cloud-"));
  directories.push(directory);
  const queueConfigPath = join(directory, "queue.json");
  await writeFile(queueConfigPath, "{}", { mode: 0o600 });
  const cursorPath = join(directory, "cursor.json");
  return cloudWakeConfigSchema.parse({ version: 1, endpoint: "https://example.workers.dev/v1/tick",
    queueConfigPath, cursorPath, tokenReference: "keychain://cloud-wake/main" });
}
const response = (generation: number) => new Response(JSON.stringify({ generation,
  issuedAt: "2026-11-26T00:00:00.000Z" }), { status: 200 });

describe("cloud wake client", () => {
  it("reads the OS secret once across repeated polls", async () => {
    const config = await fixture();
    let keychainReads = 0;
    const cached = cacheWakeSecret({ get: async () => { keychainReads++; return secret; } });
    const deps = { fetch: async () => response(1), run: async () => {} };
    expect(await runCloudWakeOnce(config, cached, deps)).toBe("ran");
    expect(await runCloudWakeOnce(config, cached, deps)).toBe("idle");
    expect(keychainReads).toBe(1);
  });
  it("runs once per generation and stores the cursor only after success", async () => {
    const config = await fixture();
    let runs = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${secret}`);
      return response(1);
    };
    const deps = { fetch: fetcher, run: async () => { runs++; } };
    expect(await runCloudWakeOnce(config, secrets, deps)).toBe("ran");
    expect(await runCloudWakeOnce(config, secrets, deps)).toBe("idle");
    expect(runs).toBe(1);
    expect(JSON.parse(await readFile(config.cursorPath, "utf8"))).toEqual({ version: 1, generation: 1 });
  });

  it("retries a failed run and refuses a rolled-back or malformed tick", async () => {
    const config = await fixture();
    const deps = { fetch: async () => response(2), run: async () => { throw new Error("crashed"); } };
    await expect(runCloudWakeOnce(config, secrets, deps)).rejects.toThrow("crashed");
    await expect(readFile(config.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runCloudWakeOnce(config, secrets, { fetch: deps.fetch, run: async () => {} })).toBe("ran");
    await expect(runCloudWakeOnce(config, secrets, { fetch: async () => response(1) }))
      .rejects.toThrow("moved backwards");
    await expect(runCloudWakeOnce(config, secrets, { fetch: async () => new Response("{}") }))
      .rejects.toThrow();
  });

  it("rejects HTTP, embedded credentials, redirects, and missing secrets", async () => {
    const config = await fixture();
    for (const endpoint of ["http://example.com/v1/tick", "https://a:b@example.com/v1/tick",
      "https://example.com/v1/tick?token=secret", "https://example.com/other"]) {
      expect(() => cloudWakeConfigSchema.parse({ ...config, endpoint })).toThrow();
    }
    await expect(runCloudWakeOnce(config, { ...secrets, get: async () => undefined })).rejects.toThrow("token");
    await expect(runCloudWakeOnce(config, secrets, { fetch: async () => new Response(null, { status: 302 }) }))
      .rejects.toThrow("302");
  });
});
