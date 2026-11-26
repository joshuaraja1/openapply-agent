import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportLocalState, purgeLocalStateArchive, quarantineLocalState,
  restoreLocalState } from "../src/storage/data-controls.js";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { stageSqliteMigration } from "../src/storage/sqlite-migration.js";
import { activateSqliteRuntime, openActiveSqliteRuntime } from "../src/storage/sqlite-runtime.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openapply-data-controls-"));
  if (process.platform === "win32") await secureWindowsPrivatePath(root);
  const privateDir = join(root, "private");
  await ensurePrivateDirectory(privateDir);
  const paths = { encryptedDirectory: privateDir, databasePath: join(privateDir, "state.sqlite"),
    discoveryStatePath: join(privateDir, "discovery.json"), queuePath: join(privateDir, "queue.json") };
  const key = randomBytes(32);
  const applications = new EncryptedApplicationStateStore(join(privateDir, "applications.enc.json"), key);
  await applications.compareAndSwap("job:1", undefined,
    { stage: "waiting-human", privateEmail: "fixture@example.com" });
  await applications.compareAndSwap("job:deleted", undefined, { stage: "found" });
  await applications.delete("job:deleted", 1);
  await writeFile(paths.discoveryStatePath, JSON.stringify({ jobs: {} }), { mode: 0o600 });
  await writeFile(paths.queuePath, JSON.stringify({ queue: [] }), { mode: 0o600 });
  if (process.platform === "win32") {
    await secureWindowsPrivatePath(paths.discoveryStatePath);
    await secureWindowsPrivatePath(paths.queuePath);
  }
  return { root, privateDir, paths, key, applications,
    output: join(privateDir, "candidate-export.json"), archive: join(privateDir, "removed-state") };
}

describe("private state export and deletion", () => {
  it("exports legacy records with tombstones, quarantines exact files, and restores them", async () => {
    const f = await fixture();
    try {
      const exported = await exportLocalState(f.paths, f.key, f.output);
      expect(exported.source).toBe("legacy");
      expect(exported.records.applications).toHaveLength(2);
      expect(exported.records.applications).toContainEqual({ id: "job:deleted", version: 1 });
      expect(await readFile(f.output, "utf8")).not.toContain(f.key.toString("base64"));
      if (process.platform !== "win32") expect((await lstat(f.output)).mode & 0o077).toBe(0);
      await expect(quarantineLocalState(f.paths, f.key, f.output, f.archive, false as true))
        .rejects.toThrow("confirm inactivity");
      expect(await quarantineLocalState(f.paths, f.key, f.output, f.archive, true)).toBe(3);
      expect(await f.applications.read("job:1")).toBeUndefined();
      await writeFile(f.paths.queuePath, JSON.stringify({ queue: [{ id: "new" }] }), { mode: 0o600 });
      if (process.platform === "win32") await secureWindowsPrivatePath(f.paths.queuePath);
      await expect(restoreLocalState(f.paths, f.archive, true))
        .rejects.toThrow("refusing to overwrite");
      expect(await f.applications.read("job:1")).toBeUndefined();
      await rm(f.paths.queuePath);
      expect(await restoreLocalState(f.paths, f.archive, true)).toBe(3);
      expect((await f.applications.read("job:1"))?.state)
        .toEqual({ stage: "waiting-human", privateEmail: "fixture@example.com" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("exports active SQLite, refuses stale export, and purges only a complete archive", async () => {
    const f = await fixture();
    try {
      await stageSqliteMigration(join(f.privateDir, "applications.enc.json"),
        f.paths.databasePath, f.key, true);
      await activateSqliteRuntime(f.paths.databasePath, f.key, f.paths, true);
      const initial = await exportLocalState(f.paths, f.key, f.output);
      expect(initial.source).toBe("sqlite");
      const runtime = (await openActiveSqliteRuntime(f.key, f.paths.databasePath))!;
      await runtime.store("applications").compareAndSwap("job:2", undefined, { stage: "found" });
      runtime.close();
      await expect(quarantineLocalState(f.paths, f.key, f.output, f.archive, true))
        .rejects.toThrow("changed since export");
      const freshExport = join(f.privateDir, "fresh-export.json");
      await exportLocalState(f.paths, f.key, freshExport);
      expect(await quarantineLocalState(f.paths, f.key, freshExport, f.archive, true)).toBe(4);
      expect(await restoreLocalState(f.paths, f.archive, true)).toBe(4);
      const reopened = (await openActiveSqliteRuntime(f.key, f.paths.databasePath))!;
      expect((await reopened.store("applications").read("job:2"))?.state)
        .toEqual({ stage: "found" });
      reopened.close();
      expect(await quarantineLocalState(f.paths, f.key, freshExport, f.archive, true)).toBe(4);
      await expect(purgeLocalStateArchive(f.paths, f.archive, true, false as true))
        .rejects.toThrow("both confirmations");
      await purgeLocalStateArchive(f.paths, f.archive, true, true);
      await expect(lstat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(f.paths.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
