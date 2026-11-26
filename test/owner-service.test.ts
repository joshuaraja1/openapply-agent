import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectOwnedTab, startOwnerInspectionService } from "../src/browser/owner-service.js";

const execFileAsync = promisify(execFile);
const hash = "a".repeat(64);
const requestFor = (generation: string, tabId: string, claimId: string) => ({
  version: 1 as const, action: "inspect-tab" as const, requestId: randomUUID(), generation,
  tabId, claimId, jobId: "ashby:example:123", officialUrl: "https://jobs.example.test/123",
  packageSha256: hash, artifactSha256: hash,
});
const bindingFor = (request: ReturnType<typeof requestFor>) => ({
  tabId: request.tabId, claimId: request.claimId, jobId: request.jobId,
  officialUrl: request.officialUrl, packageSha256: request.packageSha256,
  artifactSha256: request.artifactSha256,
});

async function worker(input: { socketPath: string; secret: Buffer;
  request: ReturnType<typeof requestFor> }) {
  const source = `import { inspectOwnedTab } from ${JSON.stringify(pathToFileURL(resolve("src/browser/owner-service.ts")).href)};
const input = JSON.parse(process.env.OWNER_TEST_INPUT);
try { const result = await inspectOwnedTab({ socketPath: input.socketPath,
 secret: Buffer.from(input.secret, "hex"), request: input.request });
 process.stdout.write(JSON.stringify(result)); } catch { process.exitCode = 2; }`;
  return execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: resolve("."), env: { ...process.env, OWNER_TEST_INPUT: JSON.stringify({
      socketPath: input.socketPath, secret: input.secret.toString("hex"), request: input.request }) },
    timeout: 15_000,
  });
}

describe.skipIf(process.platform === "win32")("private browser-owner inspection socket", () => {
  it("preserves one registered tab across worker process restarts and rejects a new owner generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-owner-"));
    const socketPath = join(directory, "owner.sock");
    const secret = randomBytes(32);
    const generation = randomUUID();
    const tabId = randomUUID();
    const claimId = randomUUID();
    let inspections = 0;
    const owner = await startOwnerInspectionService({ socketPath, secret, generation });
    try {
      expect((await lstat(socketPath)).mode & 0o077).toBe(0);
      const firstRequest = requestFor(generation, tabId, claimId);
      owner.register(bindingFor(firstRequest), async () => {
        inspections += 1;
        return { url: "https://jobs.example.test/123", title: "Confirmation",
          visibleText: "Application received for Example role" };
      });
      const first = await worker({ socketPath, secret, request: firstRequest });
      const second = await worker({ socketPath, secret, request: requestFor(generation, tabId, claimId) });
      expect(JSON.parse(first.stdout).tabId).toBe(tabId);
      expect(JSON.parse(second.stdout).tabId).toBe(tabId);
      expect(inspections).toBe(2);
      await expect(worker({ socketPath, secret, request: firstRequest })).rejects.toThrow();
      await expect(worker({ socketPath, secret: randomBytes(32),
        request: requestFor(generation, tabId, claimId) })).rejects.toThrow();
      await expect(worker({ socketPath, secret, request: requestFor(randomUUID(), tabId, claimId) }))
        .rejects.toThrow();
      await expect(worker({ socketPath, secret, request: requestFor(generation, tabId, randomUUID()) }))
        .rejects.toThrow();
      expect(inspections).toBe(2);
    } finally {
      await owner.close();
      await rm(directory, { recursive: true });
    }
  });

  it("returns no receipt evidence when a live tab leaves the official requisition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-owner-"));
    const socketPath = join(directory, "owner.sock");
    const secret = randomBytes(32);
    const generation = randomUUID();
    const request = requestFor(generation, randomUUID(), randomUUID());
    const owner = await startOwnerInspectionService({ socketPath, secret, generation });
    try {
      owner.register(bindingFor(request), async () => ({ url: "https://jobs.example.test/other",
        title: "Thanks", visibleText: "Thank you" }));
      await expect(inspectOwnedTab({ socketPath, secret, request })).rejects.toThrow();
    } finally {
      await owner.close();
      await rm(directory, { recursive: true });
    }
  });
});
