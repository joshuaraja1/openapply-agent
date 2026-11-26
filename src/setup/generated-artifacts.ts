import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertPrivateFile, assertSameFileIdentity, ensurePrivateDirectory, readPrivateFile } from "../storage/private-path.js";
import { secureWindowsPrivatePath } from "../storage/windows-acl.js";

export type GeneratedArtifactAction = "export-artifacts" | "quarantine-artifacts"
  | "restore-artifacts" | "purge-artifacts";

interface Entry { name: string; size: number; sha256: string }
interface Manifest { version: 1; files: Entry[] }

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const generatedName = new RegExp(`^(?:[a-f0-9]{16}-${uuid}\\.pdf|application-${uuid}\\.json)$`);
const maxFileBytes = 5_000_000;
const maxExportBytes = 500_000_000;
const maxFiles = 10_000;
const maxManifestBytes = 2_000_000;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function privateBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const pinned = await handle.stat();
    await assertPrivateFile(path);
    const named = await lstat(path);
    assertSameFileIdentity(pinned, named);
    if (!pinned.isFile() || pinned.nlink !== 1 || pinned.size < 1 || pinned.size > maxFileBytes) {
      throw new Error("Generated artifact has an unsafe file type, link count, or size");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== pinned.size) throw new Error("Generated artifact changed during inspection");
    return bytes;
  } finally { await handle.close(); }
}

async function scan(directory: string, allowManifest = false): Promise<Entry[]> {
  await ensurePrivateDirectory(directory);
  const names = (await readdir(directory)).sort();
  if (names.length > maxFiles + Number(allowManifest)) throw new Error("Too many generated artifacts");
  if (allowManifest && names.includes("manifest.json")) await assertPrivateFile(join(directory, "manifest.json"));
  const entries: Entry[] = [];
  let total = 0;
  for (const name of names) {
    if (allowManifest && name === "manifest.json") continue;
    if (!generatedName.test(name)) throw new Error("Artifact directory contains an unrecognized entry");
    const bytes = await privateBytes(join(directory, name));
    total += bytes.length;
    if (total > maxExportBytes) throw new Error("Generated artifacts exceed the export budget");
    entries.push({ name, size: bytes.length, sha256: digest(bytes) });
  }
  return entries;
}

function parseManifest(raw: string): Manifest {
  const value = JSON.parse(raw) as Manifest;
  if (value?.version !== 1 || !Array.isArray(value.files) || value.files.length > maxFiles
    || value.files.some((entry) => !entry || !generatedName.test(entry.name)
      || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > maxFileBytes
      || !/^[a-f0-9]{64}$/.test(entry.sha256))
    || new Set(value.files.map((entry) => entry.name)).size !== value.files.length
    || value.files.some((entry, index) => index > 0 && value.files[index - 1]!.name >= entry.name)) {
    throw new Error("Generated artifact manifest is invalid");
  }
  return value;
}

async function readManifest(path: string): Promise<Manifest> {
  await assertPrivateFile(path);
  if ((await lstat(path)).size > maxManifestBytes) throw new Error("Generated artifact manifest is too large");
  return parseManifest(await readPrivateFile(path));
}

async function manifestFor(archive: string, exported: string): Promise<Manifest> {
  const path = await exists(join(archive, "manifest.json"))
    ? join(archive, "manifest.json") : join(exported, "manifest.json");
  return readManifest(path);
}

function assertMatches(actual: Entry[], expected: Entry[], allowMissing = false): void {
  const allowed = new Map(expected.map((entry) => [entry.name, entry]));
  if (!allowMissing && actual.length !== expected.length) throw new Error("Generated artifacts changed since export");
  for (const entry of actual) {
    const saved = allowed.get(entry.name);
    if (!saved || saved.size !== entry.size || saved.sha256 !== entry.sha256) {
      throw new Error("Generated artifacts changed since export");
    }
  }
}

/** Only the default private app directory is eligible; callers enforce that configured path. */
export async function generatedArtifactStatus(root: string) {
  await ensurePrivateDirectory(root);
  return { artifactExportReady: await exists(join(root, "artifact-export")),
    artifactArchiveReady: await exists(join(root, "removed-artifacts")) };
}

export async function runGeneratedArtifactControl(action: GeneratedArtifactAction, root: string) {
  await ensurePrivateDirectory(root);
  const source = join(root, "artifacts"), exported = join(root, "artifact-export");
  const archive = join(root, "removed-artifacts");
  if (action === "export-artifacts") {
    if (!await exists(source)) throw new Error("No generated artifact directory exists");
    if (await exists(exported) || await exists(archive)) throw new Error("An artifact export or archive already exists");
    const entries = await scan(source);
    await mkdir(exported, { mode: 0o700 });
    if (process.platform === "win32") await secureWindowsPrivatePath(exported);
    try {
      for (const entry of entries) {
        const bytes = await privateBytes(join(source, entry.name));
        if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) {
          throw new Error("Generated artifact changed during export");
        }
        const path = join(exported, entry.name);
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        if (process.platform === "win32") await secureWindowsPrivatePath(path);
      }
      const path = join(exported, "manifest.json");
      await writeFile(path, JSON.stringify({ version: 1, files: entries } satisfies Manifest),
        { flag: "wx", mode: 0o600 });
      if (process.platform === "win32") await secureWindowsPrivatePath(path);
      return { action: "artifacts-exported", files: entries.length };
    } catch (error) {
      for (const entry of entries) await unlink(join(exported, entry.name)).catch(() => {});
      await unlink(join(exported, "manifest.json")).catch(() => {});
      await rmdir(exported).catch(() => {});
      throw error;
    }
  }
  if (action === "quarantine-artifacts") {
    if (!await exists(source) || !await exists(exported) || await exists(archive)) {
      throw new Error("A fresh artifact export and source directory are required");
    }
    const manifest = await readManifest(join(exported, "manifest.json"));
    assertMatches(await scan(exported, true), manifest.files);
    assertMatches(await scan(source), manifest.files);
    await rename(source, archive);
    try {
      const path = join(archive, "manifest.json");
      await writeFile(path, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
      if (process.platform === "win32") await secureWindowsPrivatePath(path);
    } catch (error) {
      await rename(archive, source).catch(() => {});
      throw error;
    }
    return { action: "artifacts-quarantined", files: manifest.files.length };
  }
  if (!await exists(archive)) throw new Error("No generated artifact archive exists");
  if (action === "purge-artifacts" && await exists(source)) {
    throw new Error("Newer generated artifacts exist; refusing to purge the archive");
  }
  if (action === "purge-artifacts" && !await exists(join(archive, "manifest.json"))
    && !await exists(join(exported, "manifest.json"))) {
    await ensurePrivateDirectory(archive);
    if ((await readdir(archive)).length !== 0) throw new Error("Artifact archive lost its manifest");
    await rmdir(archive); // Interrupted after the last file was deleted.
    return { action: "artifacts-purged", files: 0 };
  }
  const manifest = await manifestFor(archive, exported);
  const archived = await scan(archive, true);
  assertMatches(archived, manifest.files, action === "purge-artifacts");
  if (action === "restore-artifacts") {
    if (await exists(source)) throw new Error("Newer generated artifacts exist; refusing to overwrite");
    if (await exists(join(archive, "manifest.json"))) await unlink(join(archive, "manifest.json"));
    await rename(archive, source);
    return { action: "artifacts-restored", files: archived.length };
  }
  // A process can die after the directory move but before writing its manifest.
  // Make the archive self-contained before removing the export copy.
  if (!await exists(join(archive, "manifest.json"))) {
    const path = join(archive, "manifest.json");
    await writeFile(path, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") await secureWindowsPrivatePath(path);
  }
  if (await exists(exported)) {
    const copies = await scan(exported, true);
    assertMatches(copies, manifest.files, true);
    for (const entry of copies) await unlink(join(exported, entry.name));
    if (await exists(join(exported, "manifest.json"))) await unlink(join(exported, "manifest.json"));
    await rmdir(exported);
  }
  for (const entry of archived) await unlink(join(archive, entry.name));
  if (await exists(join(archive, "manifest.json"))) await unlink(join(archive, "manifest.json"));
  await rmdir(archive);
  return { action: "artifacts-purged", files: manifest.files.length };
}
