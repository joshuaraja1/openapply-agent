import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ApplicationStateStore } from "./contracts.js";
import { EncryptedApplicationStateStore } from "./encrypted-state.js";
import { assertPrivateFile, readPrivateFile } from "./private-path.js";
import { readStagedRecords, type MigratedRecord } from "./sqlite-migration.js";
import { persistDiscoveryOutput } from "./discovery-output.js";
import { queueFileSchema } from "../application/queue-schema.js";
import { getOrCreateStateKey } from "./mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "./native-secret-store.js";

const activeSchema = `
CREATE TABLE state_records (
  namespace TEXT NOT NULL,
  record_key TEXT NOT NULL CHECK (length(record_key) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL,
  PRIMARY KEY (namespace, record_key)
) STRICT;
`;

export const DEFAULT_SQLITE_PATH = join(userInfo().homedir, ".openapply-agent", "state.sqlite");
export const ENCRYPTED_STATE_FILES = {
  applications: "applications.enc.json",
  quota: "daily-quota.enc.json",
  retries: "retry-ledger.enc.json",
  postingClaims: "posting-claims.enc.json",
  emailClaims: "email-code-claims.enc.json",
} as const;

export interface LegacyStatePaths {
  encryptedDirectory: string;
  discoveryStatePath: string;
  queuePath: string;
}

interface StoredRow { version: number; nonce: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }
interface RecordValue<State> { id: string; version: number; state?: State }

function keyBuffer(key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error("SQLite runtime requires a 256-bit state key");
  return Buffer.from(key);
}

function opaque(namespace: string, id: string, key: Buffer): string {
  return createHmac("sha256", key).update(`${namespace}\0${id}`).digest("hex");
}

function keyCheck(key: Buffer): string {
  return createHmac("sha256", key).update("openapply-sqlite-state-v2-key-check").digest("hex");
}

function rollbackMarker(db: DatabaseSync, key: Buffer): string {
  const hmac = createHmac("sha256", key).update("openapply-sqlite-v2-rollback\0");
  const rows = db.prepare(`SELECT namespace, record_key, version, nonce, tag, ciphertext
    FROM state_records ORDER BY namespace, record_key`).all() as unknown as
    Array<StoredRow & { namespace: string; record_key: string }>;
  for (const row of rows) {
    hmac.update(JSON.stringify([row.namespace, row.record_key, row.version,
      Buffer.from(row.nonce).toString("base64"), Buffer.from(row.tag).toString("base64"),
      Buffer.from(row.ciphertext).toString("base64")]));
    hmac.update("\n");
  }
  return hmac.digest("hex");
}

function boundPaths(paths: LegacyStatePaths): Array<[string, string]> {
  return [...Object.entries(ENCRYPTED_STATE_FILES).map(([namespace, filename]) =>
    [namespace, join(paths.encryptedDirectory, filename)] as [string, string]),
  ["discovery", paths.discoveryStatePath], ["queue", paths.queuePath]];
}

function pathKey(namespace: string, path: string, key: Buffer): string {
  return createHmac("sha256", key).update(`path:${namespace}:${resolve(path)}`).digest("hex");
}

function seal<State>(namespace: string, record: RecordValue<State>, key: Buffer) {
  const recordKey = opaque(namespace, record.id, key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`state:${namespace}:${recordKey}:${record.version}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return { recordKey, nonce, tag: cipher.getAuthTag(), ciphertext };
}

function unseal<State>(namespace: string, id: string, row: StoredRow, key: Buffer): RecordValue<State> {
  const recordKey = opaque(namespace, id, key);
  const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
  decipher.setAAD(Buffer.from(`state:${namespace}:${recordKey}:${row.version}`));
  decipher.setAuthTag(row.tag);
  const record = JSON.parse(Buffer.concat([decipher.update(row.ciphertext),
    decipher.final()]).toString("utf8")) as RecordValue<State>;
  if (record.id !== id || record.version !== row.version) throw new Error("SQLite state identity changed");
  return record;
}

function meta(db: DatabaseSync, name: string): string | undefined {
  return (db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(name) as
    { value: string } | undefined)?.value;
}

function upsert<State>(db: DatabaseSync, namespace: string, record: RecordValue<State>, key: Buffer): void {
  const value = seal(namespace, record, key);
  db.prepare(`INSERT INTO state_records
    (namespace, record_key, version, nonce, tag, ciphertext) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(namespace, record_key) DO UPDATE SET version=excluded.version,
      nonce=excluded.nonce, tag=excluded.tag, ciphertext=excluded.ciphertext`)
    .run(namespace, value.recordKey, record.version, value.nonce, value.tag, value.ciphertext);
}

async function maybePrivateFile(path: string): Promise<string | undefined> {
  try { return await readPrivateFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Promote a verified v1 staged database while all workflow processes are stopped. */
export async function activateSqliteRuntime(
  databasePath: string, keyBytes: Uint8Array, paths: LegacyStatePaths, confirmedInactive: true,
): Promise<void> {
  if (confirmedInactive !== true) throw new Error("SQLite cutover requires inactive-run confirmation");
  const key = keyBuffer(keyBytes);
  const path = resolve(databasePath);
  const applicationPath = join(paths.encryptedDirectory, ENCRYPTED_STATE_FILES.applications);
  if (resolve(paths.discoveryStatePath) === resolve(paths.queuePath)
    || [applicationPath, paths.discoveryStatePath, paths.queuePath]
      .some((file) => resolve(file) === path)) {
    throw new Error("SQLite database and legacy state paths must be distinct");
  }
  const applications = await readStagedRecords(path, key);
  const sourceApplications = await new EncryptedApplicationStateStore<unknown>(applicationPath, key)
    .snapshotRecords();
  const byId = (a: MigratedRecord, b: MigratedRecord) => a.id.localeCompare(b.id);
  if (!isDeepStrictEqual([...applications].sort(byId), [...sourceApplications].sort(byId))) {
    throw new Error("Staged application records changed from the original state");
  }
  const sources: Array<{ namespace: string; path: string; records: MigratedRecord[]; digest: string }> = [
    { namespace: "applications", path: applicationPath, records: applications,
      digest: createHash("sha256").update(await readPrivateFile(applicationPath)).digest("hex") },
  ];
  for (const [namespace, filename] of Object.entries(ENCRYPTED_STATE_FILES)) {
    if (namespace === "applications") continue;
    const file = join(paths.encryptedDirectory, filename);
    const raw = await maybePrivateFile(file);
    if (raw !== undefined) {
      const records = await new EncryptedApplicationStateStore<unknown>(file, key).snapshotRecords();
      sources.push({ namespace, path: file, records,
        digest: createHash("sha256").update(raw).digest("hex") });
    }
  }
  for (const [namespace, file] of [["discovery", paths.discoveryStatePath],
    ["queue", paths.queuePath]] as const) {
    const raw = await maybePrivateFile(file);
    if (raw !== undefined) {
      const parsed = JSON.parse(raw) as unknown;
      if (namespace === "queue") queueFileSchema.parse(parsed);
      if (namespace === "discovery" && (!parsed || typeof parsed !== "object"
        || !(parsed as { jobs?: unknown }).jobs
        || typeof (parsed as { jobs?: unknown }).jobs !== "object"
        || Array.isArray((parsed as { jobs?: unknown }).jobs))) {
        throw new Error("Legacy discovery state is invalid");
      }
      sources.push({ namespace, path: file, records: [{ id: "current", version: 1,
        state: parsed }],
        digest: createHash("sha256").update(raw).digest("hex") });
    }
  }
  const digests = sources.map((source) => source.digest);
  await assertPrivateFile(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    if (meta(db, "schema_version") !== "1" || meta(db, "migration_state") !== "staged"
      || meta(db, "legacy_source_sha256") !== digests[0]) {
      throw new Error("Staged database or original application file changed before cutover");
    }
    for (const table of ["sources", "jobs", "queue_entries", "applications", "application_events",
      "posting_claims", "daily_reservations", "retry_counts", "handoffs", "artifacts"]) {
      if ((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count !== 0) {
        throw new Error("Staged database has runtime writes; inspect before cutover");
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(activeSchema);
      for (const source of sources) for (const record of source.records) {
        upsert(db, source.namespace, record, key);
      }
      for (let i = 0; i < sources.length; i++) {
        const current = createHash("sha256").update(await readPrivateFile(sources[i]!.path)).digest("hex");
        if (current !== digests[i]) throw new Error("Legacy state changed during SQLite cutover");
        db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
          .run(`source_sha256:${sources[i]!.namespace}`, current);
      }
      for (const [namespace, file] of boundPaths(paths)) {
        db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
          .run(`path_key:${namespace}`, pathKey(namespace, file, key));
      }
      db.prepare("UPDATE schema_meta SET value='2' WHERE key='schema_version'").run();
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('key_check', ?)").run(keyCheck(key));
      db.prepare("UPDATE schema_meta SET value='active' WHERE key='migration_state'").run();
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

/** Open only an active private database. A staged file continues using legacy state. */
export async function openActiveSqliteRuntime(
  keyBytes: Uint8Array, databasePath = DEFAULT_SQLITE_PATH,
): Promise<SqliteRuntime | undefined> {
  try { await stat(databasePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  await assertPrivateFile(databasePath);
  const key = keyBuffer(keyBytes);
  const db = new DatabaseSync(databasePath);
  try {
    const version = meta(db, "schema_version");
    const migrationState = meta(db, "migration_state");
    const hasActiveTable = !!db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'state_records'`).get();
    if (migrationState === "staged" && version === "1" && !hasActiveTable
      && meta(db, "key_check") === undefined) {
      db.close();
      return undefined;
    }
    if (migrationState === "rolled-back" && version === "2" && hasActiveTable) {
      if (meta(db, "key_check") !== keyCheck(key)
        || meta(db, "rollback_marker") !== rollbackMarker(db, key)) {
        throw new Error("SQLite rollback marker is missing or invalid");
      }
      db.close();
      return undefined;
    }
    if (migrationState !== "active" || version !== "2" || !hasActiveTable
      || meta(db, "rollback_marker") !== undefined) {
      throw new Error("Unsupported SQLite state version or cutover status");
    }
    if (meta(db, "key_check") !== keyCheck(key)) throw new Error("SQLite state key does not match");
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    return new SqliteRuntime(db, key);
  } catch (error) { if (db.isOpen) db.close(); throw error; }
}

/** Export current SQLite state back to the private legacy files before disabling SQLite. */
export async function rollbackActiveSqliteRuntime(
  databasePath: string, keyBytes: Uint8Array, paths: LegacyStatePaths, confirmedInactive: true,
): Promise<void> {
  if (confirmedInactive !== true) throw new Error("SQLite rollback requires inactive-run confirmation");
  const runtime = await openActiveSqliteRuntime(keyBytes, databasePath);
  if (!runtime) throw new Error("No active SQLite state exists to roll back");
  try {
    runtime.assertLegacyPaths(paths);
    for (const [namespace, filename] of Object.entries(ENCRYPTED_STATE_FILES)) {
      const snapshot = runtime.snapshot(namespace);
      const file = join(paths.encryptedDirectory, filename);
      const legacy = new EncryptedApplicationStateStore<unknown>(file, keyBytes);
      await legacy.replaceFromSnapshot(snapshot, true);
      const restored = await legacy.snapshotRecords();
      const byId = (a: MigratedRecord, b: MigratedRecord) => a.id.localeCompare(b.id);
      if (!isDeepStrictEqual([...restored].sort(byId), [...snapshot].sort(byId))) {
        throw new Error(`SQLite rollback verification failed for ${namespace}`);
      }
    }
    const queue = (await runtime.store<unknown>("queue").read("current"))?.state ?? { queue: [] };
    const discovery = (await runtime.store<unknown>("discovery").read("current"))?.state ?? { jobs: {} };
    await persistDiscoveryOutput(paths.queuePath, queue, paths.discoveryStatePath, discovery);
    const restoredQueue = JSON.parse(await readPrivateFile(paths.queuePath)) as unknown;
    const restoredDiscovery = JSON.parse(await readPrivateFile(paths.discoveryStatePath)) as unknown;
    if (JSON.stringify(restoredQueue) !== JSON.stringify(queue)
      || JSON.stringify(restoredDiscovery) !== JSON.stringify(discovery)) {
      throw new Error("SQLite rollback verification failed for discovery or queue");
    }
    runtime.markRolledBack(true);
  } finally { runtime.close(); }
}

export async function openDefaultSqliteRuntimeIfPresent(): Promise<SqliteRuntime | undefined> {
  try { await stat(DEFAULT_SQLITE_PATH); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const key = await getOrCreateStateKey(createNativeSecretStore(), stateKeyReference());
  return await openActiveSqliteRuntime(key);
}

export class SqliteRuntime {
  constructor(private readonly db: DatabaseSync, private readonly key: Buffer) {}
  close(): void { this.db.close(); }

  assertLegacyPaths(paths: LegacyStatePaths): void {
    for (const [namespace, file] of boundPaths(paths)) {
      if (meta(this.db, `path_key:${namespace}`) !== pathKey(namespace, file, this.key)) {
        throw new Error("SQLite rollback paths do not match the cutover sources");
      }
    }
  }

  snapshot(namespace: string): MigratedRecord[] {
    const rows = this.db.prepare(`SELECT record_key, version, nonce, tag, ciphertext
      FROM state_records WHERE namespace = ? ORDER BY record_key`).all(namespace) as unknown as
      Array<StoredRow & { record_key: string }>;
    return rows.map((row) => {
      const decipher = createDecipheriv("aes-256-gcm", this.key, row.nonce);
      decipher.setAAD(Buffer.from(`state:${namespace}:${row.record_key}:${row.version}`));
      decipher.setAuthTag(row.tag);
      const record = JSON.parse(Buffer.concat([decipher.update(row.ciphertext),
        decipher.final()]).toString("utf8")) as MigratedRecord;
      if (!record.id || record.version !== row.version
        || opaque(namespace, record.id, this.key) !== row.record_key) {
        throw new Error("SQLite snapshot identity changed");
      }
      return record;
    });
  }

  markRolledBack(confirmedInactive: true): void {
    if (confirmedInactive !== true) throw new Error("SQLite rollback requires inactive-run confirmation");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('rollback_marker', ?)")
        .run(rollbackMarker(this.db, this.key));
      this.db.prepare("UPDATE schema_meta SET value = 'rolled-back' WHERE key = 'migration_state'").run();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  store<State>(namespace: string): ApplicationStateStore<State> {
    if (!/^[a-z][a-zA-Z]*$/.test(namespace)) throw new Error("Invalid SQLite state namespace");
    return {
      read: async (id) => {
        const row = this.getRow(namespace, id);
        if (!row) return undefined;
        const record = unseal<State>(namespace, id, row, this.key);
        return record.state === undefined ? undefined : { version: record.version, state: record.state };
      },
      compareAndSwap: async (id, expectedVersion, state) => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const row = this.getRow(namespace, id);
          const current = row && unseal<State>(namespace, id, row, this.key);
          if ((current?.state === undefined ? undefined : current.version) !== expectedVersion) {
            this.db.exec("ROLLBACK");
            return undefined;
          }
          const version = (current?.version ?? 0) + 1;
          upsert(this.db, namespace, { id, version, state }, this.key);
          this.db.exec("COMMIT");
          return version;
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      },
      delete: async (id, expectedVersion) => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const row = this.getRow(namespace, id);
          const current = row && unseal<State>(namespace, id, row, this.key);
          if (current?.state === undefined || current.version !== expectedVersion) {
            this.db.exec("ROLLBACK");
            return false;
          }
          upsert(this.db, namespace, { id, version: current.version }, this.key);
          this.db.exec("COMMIT");
          return true;
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      },
    };
  }

  /** Queue and reported-state updates commit together, so restart cannot lose a handoff. */
  async writeDiscoveryOutput(queue: unknown, state: unknown): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [namespace, value] of [["queue", queue], ["discovery", state]] as const) {
        const row = this.getRow(namespace, "current");
        const current = row && unseal<unknown>(namespace, "current", row, this.key);
        upsert(this.db, namespace, { id: "current", version: (current?.version ?? 0) + 1,
          state: value }, this.key);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private getRow(namespace: string, id: string): StoredRow | undefined {
    return this.db.prepare(`SELECT version, nonce, tag, ciphertext FROM state_records
      WHERE namespace = ? AND record_key = ?`).get(namespace, opaque(namespace, id, this.key)) as
      unknown as StoredRow | undefined;
  }
}
