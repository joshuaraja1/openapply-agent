import { userInfo } from "node:os";
import { join } from "node:path";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { getOrCreateStateKey } from "../storage/mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import type { ApplicationCheckpoint } from "./state-machine.js";

const jobId = process.env.OPENAPPLY_JOB_ID;
if (!jobId) throw new Error("Set OPENAPPLY_JOB_ID to an exact job ID");
const key = await getOrCreateStateKey(createNativeSecretStore(), stateKeyReference());
const store = new EncryptedApplicationStateStore<ApplicationCheckpoint>(
  join(userInfo().homedir, ".openapply-agent", "applications.enc.json"), key);
const checkpoint = (await store.read(jobId))?.state;
if (!checkpoint) throw new Error("No application checkpoint exists for that job ID");
console.log(JSON.stringify({ jobId: checkpoint.jobId, stage: checkpoint.stage,
  blocker: checkpoint.blocker ?? null, officialUrl: checkpoint.officialUrl,
  browserPageId: checkpoint.browserPageId ?? null, packagePath: checkpoint.packagePath ?? null,
  updatedAt: checkpoint.updatedAt }));
