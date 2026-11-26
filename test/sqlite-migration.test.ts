import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

const verificationFailure = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/storage/private-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/private-path.js")>();
  return { ...actual, assertPrivateFile: async (path: string) => {
    if (path === verificationFailure.path) throw new Error("Injected target verification failure");
    await actual.assertPrivateFile(path);
  } };
});
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";
import { readStagedRecords, rollbackStagedMigration, stageSqliteMigration }
  from "../src/storage/sqlite-migration.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openapply-sqlite-"));
  if (process.platform === "win32") await secureWindowsPrivatePath(root);
  const privateDirectory = join(root, "private");
  await ensurePrivateDirectory(privateDirectory);
  const legacyPath = join(privateDirectory, "applications.enc.json");
  const databasePath = join(privateDirectory, "state.sqlite");
  const key = randomBytes(32);
  const legacy = new EncryptedApplicationStateStore<unknown>(legacyPath, key);
  const secret = "jane.secret@example.com";
  await legacy.compareAndSwap("job:123", undefined, { stage: "applying", email: secret });
  await legacy.compareAndSwap("daily-quota:2026-11-24", undefined, { count: 1 });
  await legacy.compareAndSwap("retry:job:123", undefined, { attempts: 2 });
  await legacy.compareAndSwap("posting:opaque", undefined, { claimed: true });
  await legacy.compareAndSwap("job:deleted", undefined, { email: secret });
  await legacy.delete("job:deleted", 1);
  return { root, legacyPath, databasePath, key, legacy, secret };
}

describe("staged SQLite migration", () => {
  it("copies all encrypted versions and tombstones, then rolls back without changing the live file", async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.legacyPath);
      const expected = await f.legacy.snapshotRecords();
      await expect(stageSqliteMigration(f.legacyPath, f.databasePath, f.key, true))
        .resolves.toBe(expected.length);
      const actual = await readStagedRecords(f.databasePath, f.key);
      expect(actual.sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
      expect(actual.find((record) => record.id === "job:deleted"))
        .toEqual({ id: "job:deleted", version: 1 });
      const dbBytes = await readFile(f.databasePath);
      expect(dbBytes.includes(Buffer.from(f.secret))).toBe(false);
      expect(dbBytes.includes(Buffer.from("job:123"))).toBe(false);
      if (process.platform !== "win32") expect((await lstat(f.databasePath)).mode & 0o077).toBe(0);
      expect(await readFile(f.legacyPath)).toEqual(before);
      await rollbackStagedMigration(f.legacyPath, f.databasePath, f.key, true);
      await expect(readFile(f.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.legacyPath)).toEqual(before);
      expect(await f.legacy.read("job:123")).toEqual({ version: 1,
        state: { stage: "applying", email: f.secret } });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it("refuses duplicate targets, wrong keys, and a database modified after staging", async () => {
    const f = await fixture();
    try {
      await stageSqliteMigration(f.legacyPath, f.databasePath, f.key, true);
      const stagedBytes = await readFile(f.databasePath);
      await expect(stageSqliteMigration(f.legacyPath, f.databasePath, f.key, true)).rejects.toThrow();
      expect(await readFile(f.databasePath)).toEqual(stagedBytes);
      await expect(readStagedRecords(f.databasePath, randomBytes(32))).rejects.toThrow();
      await expect(rollbackStagedMigration(f.legacyPath, f.databasePath, randomBytes(32), true))
        .rejects.toThrow();
      const db = new DatabaseSync(f.databasePath);
      try {
        db.prepare(`INSERT INTO retry_counts (job_key, failures, updated_at)
          VALUES (?, 1, '2026-11-24T00:00:00Z')`).run("a".repeat(64));
      } finally { db.close(); }
      await expect(rollbackStagedMigration(f.legacyPath, f.databasePath, f.key, true))
        .rejects.toThrow("changed");
      expect(await readFile(f.databasePath)).toBeDefined();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30_000);

  // Windows ACL verification launches PowerShell for each private path. These
  // cases exceeded 30 seconds in the serial Windows CI smoke without assertion failures.
  it("requires an inactive run and rejects legacy state changed after staging", async () => {
    const f = await fixture();
    try {
      await expect(stageSqliteMigration(f.legacyPath, f.databasePath, f.key,
        false as true)).rejects.toThrow("inactive");
      await stageSqliteMigration(f.legacyPath, f.databasePath, f.key, true);
      await f.legacy.compareAndSwap("job:new", undefined, { stage: "found" });
      await expect(rollbackStagedMigration(f.legacyPath, f.databasePath, f.key, true))
        .rejects.toThrow("changed");
      expect(await readFile(f.databasePath)).toBeDefined();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 120_000);

  it("removes only its newly published database when target verification fails", async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.legacyPath);
      verificationFailure.path = f.databasePath;
      await expect(stageSqliteMigration(f.legacyPath, f.databasePath, f.key, true))
        .rejects.toThrow("Injected target verification failure");
      verificationFailure.path = "";
      await expect(readFile(f.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.legacyPath)).toEqual(before);
      await expect(stageSqliteMigration(f.legacyPath, f.databasePath, f.key, true))
        .resolves.toBeGreaterThan(0);
    } finally {
      verificationFailure.path = "";
      await rm(f.root, { recursive: true, force: true });
    }
  }, 120_000);
});
