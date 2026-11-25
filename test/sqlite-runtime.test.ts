import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";
import { rollbackStagedMigration, stageSqliteMigration } from "../src/storage/sqlite-migration.js";
import { activateSqliteRuntime, openActiveSqliteRuntime, rollbackActiveSqliteRuntime }
  from "../src/storage/sqlite-runtime.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openapply-cutover-"));
  if (process.platform === "win32") await secureWindowsPrivatePath(root);
  const privateDir = join(root, "private");
  await ensurePrivateDirectory(privateDir);
  const applicationPath = join(privateDir, "applications.enc.json");
  const quotaPath = join(privateDir, "daily-quota.enc.json");
  const discoveryStatePath = join(privateDir, "discovery.json");
  const queuePath = join(privateDir, "queue.json");
  const databasePath = join(privateDir, "state.sqlite");
  const key = randomBytes(32);
  const applications = new EncryptedApplicationStateStore(applicationPath, key);
  const quota = new EncryptedApplicationStateStore(quotaPath, key);
  await applications.compareAndSwap("job:1", undefined, { stage: "waiting-human", email: "private@example.com" });
  await applications.compareAndSwap("job:deleted", undefined, { stage: "found" });
  await applications.delete("job:deleted", 1);
  await quota.compareAndSwap("daily-quota:2026-11-24", undefined, { reserved: 1 });
  await writeFile(discoveryStatePath, JSON.stringify({ jobs: { "job:1": { firstSeenAt: "today" } } }),
    { mode: 0o600 });
  const job = { id: "job:1", provider: "greenhouse", company: "Example", title: "Engineer",
    descriptionText: "Python", applicationUrl: "https://example.com/apply", sourceUrl: "https://example.com/apply",
    location: null, department: null, employmentType: null, workplaceType: null, compensation: null,
    sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: "2026-11-24T00:00:00Z",
    discoveredAt: "2026-11-24T00:00:00Z", isNew: true, isFresh: true,
    freshnessBasis: "first-seen", matchedKeywords: [] };
  await writeFile(queuePath, JSON.stringify({ queue: [{ job }] }), { mode: 0o600 });
  if (process.platform === "win32") {
    await secureWindowsPrivatePath(discoveryStatePath);
    await secureWindowsPrivatePath(queuePath);
  }
  return { root, privateDir, applicationPath, quotaPath, discoveryStatePath, queuePath,
    databasePath, key, job };
}

describe("SQLite runtime cutover", () => {
  it("migrates all ledgers and queue state, preserves original files, and runs CAS across connections", async () => {
    const f = await setup();
    try {
      const oldApplication = await readFile(f.applicationPath);
      const oldQueue = await readFile(f.queuePath);
      await stageSqliteMigration(f.applicationPath, f.databasePath, f.key, true);
      expect(await openActiveSqliteRuntime(f.key, f.databasePath)).toBeUndefined();
      await activateSqliteRuntime(f.databasePath, f.key, { encryptedDirectory: f.privateDir,
        discoveryStatePath: f.discoveryStatePath, queuePath: f.queuePath }, true);
      const a = (await openActiveSqliteRuntime(f.key, f.databasePath))!;
      const b = (await openActiveSqliteRuntime(f.key, f.databasePath))!;
      try {
        expect((await a.store("applications").read("job:1"))?.state)
          .toEqual({ stage: "waiting-human", email: "private@example.com" });
        expect((await a.store("quota").read("daily-quota:2026-11-24"))?.state)
          .toEqual({ reserved: 1 });
        expect((await a.store("queue").read("current"))?.state)
          .toEqual({ queue: [{ job: f.job }] });
        expect((await a.store("discovery").read("current"))?.state)
          .toEqual({ jobs: { "job:1": { firstSeenAt: "today" } } });
        expect(await a.store("applications").compareAndSwap("job:deleted", undefined,
          { stage: "found" })).toBe(2);
        expect(await b.store("applications").compareAndSwap("job:1", 1, { stage: "submitted" }))
          .toBe(2);
        expect(await a.store("applications").compareAndSwap("job:1", 1, { stage: "found" }))
          .toBeUndefined();
        expect((await a.store("applications").read("job:1"))?.state).toEqual({ stage: "submitted" });
        const before = await a.store("queue").read("current");
        await expect(a.writeDiscoveryOutput({ queue: [] }, { broken: 1n })).rejects.toThrow();
        expect(await a.store("queue").read("current")).toEqual(before);
        await a.writeDiscoveryOutput({ queue: [] }, { jobs: {} });
        expect((await b.store("queue").read("current"))?.state).toEqual({ queue: [] });
      } finally { a.close(); b.close(); }
      expect(await readFile(f.applicationPath)).toEqual(oldApplication);
      expect(await readFile(f.queuePath)).toEqual(oldQueue);
      const raw = await readFile(f.databasePath);
      expect(raw.includes(Buffer.from("private@example.com"))).toBe(false);
      expect(raw.includes(Buffer.from("job:1"))).toBe(false);
      if (process.platform !== "win32") expect((await lstat(f.databasePath)).mode & 0o077).toBe(0);
      await expect(rollbackStagedMigration(f.applicationPath, f.databasePath, f.key, true))
        .rejects.toThrow("changed");
      await rollbackActiveSqliteRuntime(f.databasePath, f.key, { encryptedDirectory: f.privateDir,
        discoveryStatePath: f.discoveryStatePath, queuePath: f.queuePath }, true);
      expect(await openActiveSqliteRuntime(f.key, f.databasePath)).toBeUndefined();
      expect((await new EncryptedApplicationStateStore(f.applicationPath, f.key).read("job:1"))?.state)
        .toEqual({ stage: "submitted" });
      expect(JSON.parse(await readFile(f.queuePath, "utf8"))).toEqual({ queue: [] });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 120_000);

  it("rejects source changes before activation and keeps the staged database inactive", async () => {
    const f = await setup();
    try {
      await stageSqliteMigration(f.applicationPath, f.databasePath, f.key, true);
      await new EncryptedApplicationStateStore(f.applicationPath, f.key)
        .compareAndSwap("job:2", undefined, { stage: "found" });
      await expect(activateSqliteRuntime(f.databasePath, f.key, { encryptedDirectory: f.privateDir,
        discoveryStatePath: f.discoveryStatePath, queuePath: f.queuePath }, true))
        .rejects.toThrow("changed");
      expect(await openActiveSqliteRuntime(f.key, f.databasePath)).toBeUndefined();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 120_000);

  it("rejects a staged ledger with a deleted record even when its count metadata is altered", async () => {
    const f = await setup();
    try {
      await stageSqliteMigration(f.applicationPath, f.databasePath, f.key, true);
      const db = new DatabaseSync(f.databasePath);
      try {
        db.exec("DELETE FROM legacy_records WHERE rowid = (SELECT MIN(rowid) FROM legacy_records)");
        db.prepare("UPDATE schema_meta SET value = '1' WHERE key = 'legacy_record_count'").run();
      } finally { db.close(); }
      await expect(activateSqliteRuntime(f.databasePath, f.key, { encryptedDirectory: f.privateDir,
        discoveryStatePath: f.discoveryStatePath, queuePath: f.queuePath }, true))
        .rejects.toThrow("Staged application records changed");
      expect(await openActiveSqliteRuntime(f.key, f.databasePath)).toBeUndefined();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 120_000);

  it("rejects a metadata-only rollback that would expose stale legacy state", async () => {
    const f = await setup();
    try {
      await stageSqliteMigration(f.applicationPath, f.databasePath, f.key, true);
      await activateSqliteRuntime(f.databasePath, f.key, { encryptedDirectory: f.privateDir,
        discoveryStatePath: f.discoveryStatePath, queuePath: f.queuePath }, true);
      const active = (await openActiveSqliteRuntime(f.key, f.databasePath))!;
      await active.store("applications").compareAndSwap("job:after-cutover", undefined,
        { stage: "submitted" });
      active.close();
      const db = new DatabaseSync(f.databasePath);
      try {
        db.prepare("UPDATE schema_meta SET value = 'rolled-back' WHERE key = 'migration_state'").run();
      } finally { db.close(); }
      await expect(openActiveSqliteRuntime(f.key, f.databasePath))
        .rejects.toThrow("rollback marker is missing or invalid");
      expect(await new EncryptedApplicationStateStore(f.applicationPath, f.key)
        .read("job:after-cutover")).toBeUndefined();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 120_000);

  it("keeps SQLite active when rollback cannot safely export the queue", async () => {
    const f = await setup();
    try {
      await stageSqliteMigration(f.applicationPath, f.databasePath, f.key, true);
      await activateSqliteRuntime(f.databasePath, f.key, { encryptedDirectory: f.privateDir,
        discoveryStatePath: f.discoveryStatePath, queuePath: f.queuePath }, true);
      await expect(rollbackActiveSqliteRuntime(f.databasePath, f.key,
        { encryptedDirectory: f.privateDir, discoveryStatePath: f.discoveryStatePath,
          queuePath: f.discoveryStatePath }, true)).rejects.toThrow("paths do not match");
      const active = await openActiveSqliteRuntime(f.key, f.databasePath);
      expect(active).toBeDefined();
      active?.close();
      await expect(openActiveSqliteRuntime(randomBytes(32), f.databasePath))
        .rejects.toThrow("key does not match");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 120_000);
});
