import { userInfo } from "node:os";
import { join } from "node:path";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { getOrCreateStateKey } from "../storage/mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { openActiveSqliteRuntime } from "../storage/sqlite-runtime.js";
import { needsResumeVisualReview, type ApplicationCheckpoint } from "../application/state-machine.js";

const key = await getOrCreateStateKey(createNativeSecretStore(), stateKeyReference());
const sqlite = await openActiveSqliteRuntime(key);
try {
  const records = sqlite
    ? sqlite.snapshot("applications") as Array<{ id: string; state?: ApplicationCheckpoint }>
    : await new EncryptedApplicationStateStore<ApplicationCheckpoint>(
      join(userInfo().homedir, ".openapply-agent", "applications.enc.json"), key).snapshotRecords();
  const pending = records.filter((record) => record.state && record.id === record.state.jobId
    && needsResumeVisualReview(record.state)).map((record) => ({
    jobId: record.id, blocker: record.state!.blocker, updatedAt: record.state!.updatedAt,
  }));
  console.log(JSON.stringify({ pending }));
} finally { sqlite?.close(); }
