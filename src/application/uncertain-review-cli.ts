import { userInfo } from "node:os";
import { join } from "node:path";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { getOrCreateStateKey } from "../storage/mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { openActiveSqliteRuntime } from "../storage/sqlite-runtime.js";
import type { ApplicationCheckpoint } from "./state-machine.js";
import { uncertainReviewItems } from "./uncertain-review.js";
import { startUncertainReviewUi } from "./uncertain-review-ui.js";

const key = await getOrCreateStateKey(createNativeSecretStore(), stateKeyReference());
async function loadItems() {
  const sqlite = await openActiveSqliteRuntime(key);
  try {
    const records = sqlite
      ? sqlite.snapshot("applications") as Array<{ id: string; state?: ApplicationCheckpoint }>
      : await new EncryptedApplicationStateStore<ApplicationCheckpoint>(
        join(userInfo().homedir, ".openapply-agent", "applications.enc.json"), key).snapshotRecords();
    return await uncertainReviewItems(records);
  } finally { sqlite?.close(); }
}
const ui = await startUncertainReviewUi({ loadItems });
console.log(`Open private uncertain-submission review: ${ui.url}`);
console.log("Press Ctrl+C to stop the local review server.");
