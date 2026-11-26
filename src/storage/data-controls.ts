import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { EncryptedApplicationStateStore } from "./encrypted-state.js";
import { createPrivateOutput } from "./private-output.js";
import { assertPrivateFile, ensurePrivateDirectory, readPrivateFile } from "./private-path.js";
import { ENCRYPTED_STATE_FILES, openActiveSqliteRuntime,
  type LegacyStatePaths } from "./sqlite-runtime.js";

const namespaces = ["applications", "quota", "retries", "postingClaims", "emailClaims"] as const;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface LocalStatePaths extends LegacyStatePaths { databasePath: string }
interface Snapshot { version: 1; source: "sqlite" | "legacy";
  records: Record<string, Array<{ id: string; version: number; state?: unknown }>> }
interface ArchiveEntry { original: string; saved: string; digest: string }
interface ArchiveManifest { version: 1; entries: ArchiveEntry[] }

function knownFiles(paths: LocalStatePaths): string[] {
  const files = [paths.databasePath,
    ...Object.values(ENCRYPTED_STATE_FILES).map((name) => join(paths.encryptedDirectory, name)),
    paths.discoveryStatePath, paths.queuePath].map((path) => resolve(path));
  if (new Set(files).size !== files.length) throw new Error("State paths must be distinct");
  return files;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Export owned application state without OS secrets or browser cookies. The JSON itself is private. */
export async function snapshotLocalState(paths: LocalStatePaths, key: Uint8Array): Promise<Snapshot> {
  knownFiles(paths);
  const active = await openActiveSqliteRuntime(key, paths.databasePath);
  if (active) {
    try {
      active.assertLegacyPaths(paths);
      return { version: 1, source: "sqlite", records: Object.fromEntries(
        [...namespaces, "discovery", "queue"].map((name) => [name, active.snapshot(name)])) };
    } finally { active.close(); }
  }
  const records: Snapshot["records"] = {};
  for (const name of namespaces) {
    const file = join(paths.encryptedDirectory, ENCRYPTED_STATE_FILES[name]);
    if (await exists(file)) await assertPrivateFile(file);
    records[name] = await new EncryptedApplicationStateStore<unknown>(file, key).snapshotRecords();
  }
  for (const [name, file] of [["discovery", paths.discoveryStatePath],
    ["queue", paths.queuePath]] as const) {
    if (await exists(file)) records[name] = [{ id: "current", version: 1,
      state: JSON.parse(await readPrivateFile(file)) as unknown }];
    else records[name] = [];
  }
  return { version: 1, source: "legacy", records };
}

export async function exportLocalState(paths: LocalStatePaths, key: Uint8Array,
  outputPath: string): Promise<Snapshot> {
  if (!isAbsolute(outputPath) || knownFiles(paths).includes(resolve(outputPath))) {
    throw new Error("Choose a separate absolute path for the private export");
  }
  const snapshot = await snapshotLocalState(paths, key);
  await createPrivateOutput(outputPath, JSON.stringify(snapshot));
  return snapshot;
}

function assertArchiveLocation(paths: LocalStatePaths, archivePath: string, exportPath: string): void {
  if (!isAbsolute(archivePath) || !isAbsolute(exportPath)) throw new Error("Use absolute paths");
  const archive = resolve(archivePath), output = resolve(exportPath);
  if (archive === resolve(paths.encryptedDirectory)
    || knownFiles(paths).some((file) => archive === file || file.startsWith(`${archive}/`))
    || archive === output || output.startsWith(`${archive}/`)) {
    throw new Error("Archive must be separate from state and export paths");
  }
}

/** Move exact known files to a private, restorable archive after checking a fresh export. */
export async function quarantineLocalState(paths: LocalStatePaths, key: Uint8Array,
  exportPath: string, archivePath: string, confirmedInactive: true): Promise<number> {
  if (confirmedInactive !== true) throw new Error("Stop workers and confirm inactivity first");
  assertArchiveLocation(paths, archivePath, exportPath);
  const exported = JSON.parse(await readPrivateFile(exportPath)) as Snapshot;
  const current = await snapshotLocalState(paths, key);
  if (!isDeepStrictEqual(exported, current)) throw new Error("State changed since export");
  const files = [] as string[];
  for (const file of knownFiles(paths)) if (await exists(file)) files.push(file);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await exists(`${paths.databasePath}${suffix}`)) {
      throw new Error("SQLite sidecar exists; stop all processes and checkpoint state before deletion");
    }
  }
  if (await exists(archivePath)) throw new Error("Archive path already exists");
  await ensurePrivateDirectory(dirname(archivePath));
  await mkdir(archivePath, { mode: 0o700 });
  const entries: ArchiveEntry[] = [];
  try {
    for (const [index, original] of files.entries()) {
      await assertPrivateFile(original);
      entries.push({ original, saved: `${index}-${basename(original)}`,
        digest: sha256(await readFile(original)) });
    }
    const manifest: ArchiveManifest = { version: 1, entries };
    await createPrivateOutput(join(archivePath, "manifest.json"), JSON.stringify(manifest));
    for (const entry of entries) await rename(entry.original, join(archivePath, entry.saved));
    return entries.length;
  } catch (error) {
    await restoreLocalState(paths, archivePath, true).catch(() => {});
    throw error;
  }
}

function parseManifest(raw: string, paths: LocalStatePaths): ArchiveManifest {
  const manifest = JSON.parse(raw) as ArchiveManifest;
  const known = new Set(knownFiles(paths));
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)
    || manifest.entries.some((entry, index) => !known.has(entry.original)
      || entry.saved !== `${index}-${basename(entry.original)}`
      || !/^[a-f0-9]{64}$/.test(entry.digest))
    || new Set(manifest.entries.map((entry) => entry.original)).size !== manifest.entries.length) {
    throw new Error("Archive manifest does not match configured state paths");
  }
  return manifest;
}

/** Restore an interrupted or completed quarantine without overwriting newer state. */
export async function restoreLocalState(paths: LocalStatePaths, archivePath: string,
  confirmedInactive: true): Promise<number> {
  if (confirmedInactive !== true) throw new Error("Stop workers and confirm inactivity first");
  await ensurePrivateDirectory(archivePath);
  const manifest = parseManifest(await readPrivateFile(join(archivePath, "manifest.json")), paths);
  let restored = 0;
  for (const entry of manifest.entries) {
    const saved = join(archivePath, entry.saved);
    if (!await exists(saved)) {
      if (!await exists(entry.original)) throw new Error("Archive and original state are both missing");
      await assertPrivateFile(entry.original);
      if (sha256(await readFile(entry.original)) !== entry.digest) {
        throw new Error("Original state changed during archive recovery");
      }
      continue;
    }
    await assertPrivateFile(saved);
    if (sha256(await readFile(saved)) !== entry.digest || await exists(entry.original)) {
      throw new Error("Archive changed or newer state exists; refusing to overwrite");
    }
    await ensurePrivateDirectory(dirname(entry.original));
    await rename(saved, entry.original);
    restored++;
  }
  await rm(archivePath, { recursive: true, force: false });
  return restored;
}

/** Irreversible phase: only a complete archive of the configured state can be purged. */
export async function purgeLocalStateArchive(paths: LocalStatePaths, archivePath: string,
  confirmedInactive: true, confirmedPermanent: true): Promise<void> {
  if (confirmedInactive !== true || confirmedPermanent !== true) {
    throw new Error("Permanent deletion needs both confirmations");
  }
  await ensurePrivateDirectory(archivePath);
  const manifest = parseManifest(await readPrivateFile(join(archivePath, "manifest.json")), paths);
  for (const entry of manifest.entries) {
    const saved = join(archivePath, entry.saved);
    await assertPrivateFile(saved);
    if (sha256(await readFile(saved)) !== entry.digest || await exists(entry.original)) {
      throw new Error("Archive is incomplete or state has been restored");
    }
  }
  const names = await readdir(archivePath);
  if (names.length !== manifest.entries.length + 1) throw new Error("Archive has unexpected files");
  await rm(archivePath, { recursive: true, force: false });
}
