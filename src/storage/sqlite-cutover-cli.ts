import { stat } from "node:fs/promises";
import { holdWorkflowLease } from "./workflow-lease.js";
import { join } from "node:path";
import { userInfo } from "node:os";
import { queueRunnerConfigSchema } from "../application/queue-config.js";
import { getOrCreateStateKey } from "./mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "./native-secret-store.js";
import { readPrivateFile } from "./private-path.js";
import { EncryptedApplicationStateStore } from "./encrypted-state.js";
import { stageSqliteMigration } from "./sqlite-migration.js";
import { activateSqliteRuntime, DEFAULT_SQLITE_PATH, ENCRYPTED_STATE_FILES,
  openActiveSqliteRuntime, rollbackActiveSqliteRuntime } from "./sqlite-runtime.js";

await holdWorkflowLease();

if (!process.argv.includes("--confirm-inactive")) {
  throw new Error("Stop the discovery and application workers, then run with --confirm-inactive");
}
const configPath = process.env.OPENAPPLY_QUEUE_CONFIG;
if (!configPath) throw new Error("Set OPENAPPLY_QUEUE_CONFIG to the private queue configuration");
const config = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(configPath)));
const key = await getOrCreateStateKey(createNativeSecretStore(), stateKeyReference());
const root = join(userInfo().homedir, ".openapply-agent");
const paths = { encryptedDirectory: root, discoveryStatePath: config.discoveryStatePath,
  queuePath: config.queuePath };
if (process.argv.includes("--rollback")) {
  await rollbackActiveSqliteRuntime(DEFAULT_SQLITE_PATH, key, paths, true);
  console.log(JSON.stringify({ state: "rolled-back", legacyFiles: "restored" }));
} else {
  const active = await openActiveSqliteRuntime(key);
  if (active) {
    active.close();
    throw new Error("SQLite state is already active");
  }
  const oldApplication = join(root, ENCRYPTED_STATE_FILES.applications);
  let staged = false;
  try { await stat(DEFAULT_SQLITE_PATH); staged = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!staged) {
    try { await stat(oldApplication); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new EncryptedApplicationStateStore(oldApplication, key).replaceFromSnapshot([], true);
    }
    await stageSqliteMigration(oldApplication, DEFAULT_SQLITE_PATH, key, true);
  }
  await activateSqliteRuntime(DEFAULT_SQLITE_PATH, key, paths, true);
  console.log(JSON.stringify({ state: "active", databasePath: DEFAULT_SQLITE_PATH,
    legacyFiles: "preserved" }));
}
