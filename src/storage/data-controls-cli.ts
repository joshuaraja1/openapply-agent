import { userInfo } from "node:os";
import { join } from "node:path";
import { queueRunnerConfigSchema } from "../application/queue-config.js";
import { createNativeSecretStore, stateKeyReference } from "./native-secret-store.js";
import { readPrivateFile } from "./private-path.js";
import { holdWorkflowLease } from "./workflow-lease.js";
import { DEFAULT_SQLITE_PATH } from "./sqlite-runtime.js";
import { exportLocalState, purgeLocalStateArchive, quarantineLocalState,
  restoreLocalState } from "./data-controls.js";

await holdWorkflowLease();
const configPath = process.env.OPENAPPLY_QUEUE_CONFIG;
if (!configPath) throw new Error("Set OPENAPPLY_QUEUE_CONFIG to the private queue configuration");
const config = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(configPath)));
const root = join(userInfo().homedir, ".openapply-agent");
const paths = { encryptedDirectory: root, databasePath: DEFAULT_SQLITE_PATH,
  discoveryStatePath: config.discoveryStatePath, queuePath: config.queuePath };
const action = process.argv[2] === "state:control" ? process.argv[3] : process.argv[2];
const inactive = process.argv.includes("--confirm-inactive");
const exportPath = process.env.OPENAPPLY_STATE_EXPORT;
const archivePath = process.env.OPENAPPLY_STATE_ARCHIVE;
if (action === "restore") {
  if (!inactive || !archivePath) throw new Error("Restore requires an archive and --confirm-inactive");
  const count = await restoreLocalState(paths, archivePath, true);
  console.log(JSON.stringify({ action: "restored", files: count }));
} else if (action === "purge") {
  if (!inactive || !archivePath || !process.argv.includes("--confirm-permanent-delete")) {
    throw new Error("Purge requires an archive, --confirm-inactive, and --confirm-permanent-delete");
  }
  await purgeLocalStateArchive(paths, archivePath, true, true);
  console.log(JSON.stringify({ action: "purged" }));
} else {
  const encoded = await createNativeSecretStore().get(stateKeyReference());
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error("Existing state key is unavailable; refusing to create or expose one");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Existing state key is invalid");
  if (action === "export") {
    if (!exportPath) throw new Error("Set OPENAPPLY_STATE_EXPORT to a new absolute private JSON path");
    const snapshot = await exportLocalState(paths, key, exportPath);
    console.log(JSON.stringify({ action: "exported", source: snapshot.source,
      records: Object.values(snapshot.records).reduce((sum, records) => sum + records.length, 0) }));
  } else if (action === "delete") {
    if (!inactive || !process.argv.includes("--confirm-delete") || !exportPath || !archivePath) {
      throw new Error("Delete requires an export, archive, --confirm-inactive, and --confirm-delete");
    }
    const count = await quarantineLocalState(paths, key, exportPath, archivePath, true);
    console.log(JSON.stringify({ action: "quarantined", files: count,
      next: "restore or purge with explicit confirmation" }));
  } else throw new Error("Use export, delete, restore, or purge");
}
