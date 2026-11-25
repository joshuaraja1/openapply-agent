import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID }
  from "node:crypto";
import { chmod, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateFile, ensurePrivateDirectory, readPrivateFile } from "./private-path.js";
import { secureWindowsPrivatePath } from "./windows-acl.js";
import { EncryptedApplicationStateStore } from "./encrypted-state.js";
import { SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from "./sqlite-schema.js";

export interface MigratedRecord<State = unknown> { id: string; version: number; state?: State }

interface SealedRow {
  record_key: string;
  version: number;
  kind: string;
  nonce: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

const domainTables = ["sources", "jobs", "queue_entries", "applications", "application_events", "posting_claims",
  "daily_reservations", "retry_counts", "handoffs", "artifacts"] as const;

function requireKey(key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error("SQLite migration requires the 256-bit application state key");
  return Buffer.from(key);
}

function recordKey(id: string, key: Buffer): string {
  return createHmac("sha256", key).update(id).digest("hex");
}

function kindOf(id: string): string {
  if (id.startsWith("daily-quota:")) return "daily-quota";
  if (id.startsWith("retry:")) return "retry";
  if (id.startsWith("posting:")) return "posting-claim";
  return "application";
}

function seal(record: MigratedRecord, key: Buffer): SealedRow {
  const nonce = randomBytes(12);
  const record_key = recordKey(record.id, key);
  const kind = kindOf(record.id);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`legacy:${record_key}:${record.version}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return { record_key, version: record.version, kind, nonce, tag: cipher.getAuthTag(), ciphertext };
}

function metadata(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    { value: string } | undefined)?.value;
}

/**
 * Copy the legacy encrypted state into a new private SQLite file. The old file
 * remains the only live store; activation is a separate release-gated step.
 */
export async function stageSqliteMigration(
  legacyPath: string, databasePath: string, keyBytes: Uint8Array, confirmedInactive: true,
): Promise<number> {
  if (confirmedInactive !== true) throw new Error("Migration requires inactive-run confirmation");
  const key = requireKey(keyBytes);
  const source = resolve(legacyPath);
  const target = resolve(databasePath);
  if (source === target) throw new Error("Legacy state and SQLite target need separate paths");
  await assertPrivateFile(source);
  await ensurePrivateDirectory(dirname(target));
  const sourceDigest = createHash("sha256").update(await readPrivateFile(source)).digest("hex");
  const records = await new EncryptedApplicationStateStore<unknown>(source, key).snapshotRecords();
  const temporary = `${target}.staging-${randomUUID()}`;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(temporary);
    if (process.platform === "win32") await secureWindowsPrivatePath(temporary);
    else await chmod(temporary, 0o600);
    await assertPrivateFile(temporary);
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    db.exec(SQLITE_SCHEMA);
    const insert = db.prepare(`INSERT INTO legacy_records
      (record_key, version, kind, nonce, tag, ciphertext) VALUES (?, ?, ?, ?, ?, ?)`);
    const setMeta = db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const row = seal(record, key);
        insert.run(row.record_key, row.version, row.kind, row.nonce, row.tag, row.ciphertext);
      }
      setMeta.run("schema_version", String(SQLITE_SCHEMA_VERSION));
      setMeta.run("migration_state", "staged");
      setMeta.run("legacy_source_sha256", sourceDigest);
      setMeta.run("legacy_record_count", String(records.length));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.close();
    db = undefined;
    const currentDigest = createHash("sha256").update(await readPrivateFile(source)).digest("hex");
    if (currentDigest !== sourceDigest) throw new Error("Legacy state changed during migration");
    // Hard-link publication fails if another process already created the target.
    await link(temporary, target);
    await assertPrivateFile(target);
    if ((await readStagedRecords(target, key)).length !== records.length) {
      throw new Error("Staged SQLite record parity failed");
    }
    return records.length;
  } finally {
    db?.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Read back staged records for migration parity checks; never logs payloads. */
export async function readStagedRecords<State = unknown>(
  databasePath: string, keyBytes: Uint8Array,
): Promise<MigratedRecord<State>[]> {
  const key = requireKey(keyBytes);
  await assertPrivateFile(databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (metadata(db, "schema_version") !== String(SQLITE_SCHEMA_VERSION)
      || metadata(db, "migration_state") !== "staged") {
      throw new Error("SQLite migration is not a supported staged database");
    }
    const rows = db.prepare("SELECT * FROM legacy_records ORDER BY record_key").all() as
      unknown as SealedRow[];
    const records = rows.map((row) => {
      const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
      decipher.setAAD(Buffer.from(`legacy:${row.record_key}:${row.version}`));
      decipher.setAuthTag(row.tag);
      const record = JSON.parse(Buffer.concat([decipher.update(row.ciphertext),
        decipher.final()]).toString("utf8")) as MigratedRecord<State>;
      if (!record.id || record.version !== row.version || recordKey(record.id, key) !== row.record_key
        || kindOf(record.id) !== row.kind) throw new Error("Staged record identity changed");
      return record;
    });
    if (records.length !== Number(metadata(db, "legacy_record_count"))) {
      throw new Error("Staged record count changed");
    }
    return records;
  } finally { db.close(); }
}

/** Roll back only an inactive, unchanged staged database. The legacy file stays untouched. */
export async function rollbackStagedMigration(
  legacyPath: string, databasePath: string, keyBytes: Uint8Array, confirmedInactive: true,
): Promise<void> {
  if (confirmedInactive !== true) throw new Error("Rollback requires inactive-run confirmation");
  await assertPrivateFile(legacyPath);
  await assertPrivateFile(databasePath);
  const digest = createHash("sha256").update(await readPrivateFile(legacyPath)).digest("hex");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (metadata(db, "schema_version") !== String(SQLITE_SCHEMA_VERSION)
      || metadata(db, "migration_state") !== "staged"
      || metadata(db, "legacy_source_sha256") !== digest
      || Number(metadata(db, "legacy_record_count")) !==
        (db.prepare("SELECT COUNT(*) AS count FROM legacy_records").get() as { count: number }).count
      || domainTables.some((table) =>
        (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count !== 0)) {
      throw new Error("Staged SQLite database changed; inspect before rollback");
    }
  } finally { db.close(); }
  await readStagedRecords(databasePath, keyBytes);
  await unlink(databasePath);
}
