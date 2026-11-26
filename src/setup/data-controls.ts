import { mkdir, rmdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { queueRunnerConfigSchema } from "../application/queue-config.js";
import type { SecretStore } from "../storage/contracts.js";
import { exportLocalState, purgeLocalStateArchive, quarantineLocalState,
  restoreLocalState } from "../storage/data-controls.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { ensurePrivateDirectory, readPrivateFile } from "../storage/private-path.js";
import { secureWindowsPrivatePath } from "../storage/windows-acl.js";

export type StateControlAction = "export" | "quarantine" | "restore" | "purge";
export interface StateControlOptions {
  queueConfigPath: string;
  stateRoot?: string;
  secretStore?: SecretStore;
}

const defaultRoot = () => join(userInfo().homedir, ".openapply-agent");

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A short exclusive lease for one UI operation; the CLI's process-long lease cannot be used by a server. */
async function withLease<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(root);
  const lock = join(root, "workflow.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another workflow is active or its lock needs inspection");
    }
    throw error;
  }
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(lock);
    return await operation();
  } finally { await rmdir(lock); }
}

export async function stateControlStatus(options: StateControlOptions) {
  const root = options.stateRoot ?? defaultRoot();
  return { exportReady: await exists(join(root, "state-export.json")),
    archiveReady: await exists(join(root, "removed-state")) };
}

export async function runStateControl(action: StateControlAction, options: StateControlOptions) {
  const root = options.stateRoot ?? defaultRoot();
  const exportPath = join(root, "state-export.json");
  const archivePath = join(root, "removed-state");
  return withLease(root, async () => {
    const config = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(options.queueConfigPath)));
    const paths = { encryptedDirectory: root, databasePath: join(root, "state.sqlite"),
      discoveryStatePath: config.discoveryStatePath, queuePath: config.queuePath };
    if ((action === "restore" || action === "purge") && !await exists(archivePath)) {
      throw new Error("No restorable archive exists");
    }
    if (action === "restore") {
      const files = await restoreLocalState(paths, archivePath, true);
      return { action: "restored", files };
    }
    if (action === "purge") {
      await purgeLocalStateArchive(paths, archivePath, true, true);
      return { action: "purged" };
    }
    const encoded = await (options.secretStore ?? createNativeSecretStore()).get(stateKeyReference());
    if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
      throw new Error("Existing state key is unavailable; no new key was created");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("Existing state key is invalid");
    if (action === "export") {
      const snapshot = await exportLocalState(paths, key, exportPath);
      return { action: "exported", source: snapshot.source,
        records: Object.values(snapshot.records).reduce((count, entries) => count + entries.length, 0) };
    }
    const files = await quarantineLocalState(paths, key, exportPath, archivePath, true);
    return { action: "quarantined", files };
  });
}
