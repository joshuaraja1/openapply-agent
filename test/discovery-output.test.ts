import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistDiscoveryOutput } from "../src/storage/discovery-output.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath, assertWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe("discovery persistence order", () => {
  it("writes the recoverable queue before reported state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-persist-"));
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(root);
      const directory = join(root, "private");
      await ensurePrivateDirectory(directory);
      const outputPath = join(directory, "queue.json");
      const invalidStatePath = directory;
      await expect(persistDiscoveryOutput(outputPath, { queue: [{ job: { id: "one" } }] },
        invalidStatePath, { jobs: {} })).rejects.toThrow();
      expect(JSON.parse(await readFile(outputPath, "utf8")).queue[0].job.id).toBe("one");
      await expect(persistDiscoveryOutput(outputPath, {}, outputPath, {})).rejects.toThrow("separate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects shared queue/state files instead of silently replacing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-persist-"));
    const directory = join(root, "private");
    const outputPath = join(directory, "queue.json");
    const statePath = join(directory, "state.json");
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(root);
      await ensurePrivateDirectory(directory);
      await persistDiscoveryOutput(outputPath, { queue: [1] }, statePath, { jobs: {} });
      if (process.platform === "win32") {
        await assertWindowsPrivatePath(outputPath);
        await assertWindowsPrivatePath(statePath);
        execFileSync("icacls", [outputPath, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      } else {
        expect((await lstat(outputPath)).mode & 0o077).toBe(0);
        expect((await lstat(statePath)).mode & 0o077).toBe(0);
        await chmod(outputPath, 0o644);
      }
      await expect(persistDiscoveryOutput(outputPath, { queue: [2] }, statePath, { jobs: {} }))
        .rejects.toThrow();
      expect(JSON.parse(await readFile(outputPath, "utf8")).queue).toEqual([1]);
    } finally {
      if (process.platform === "win32") await secureWindowsPrivatePath(outputPath).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});
