import { userInfo } from "node:os";
import { join } from "node:path";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { readPrivateFile } from "../storage/private-path.js";
import { openActiveSqliteRuntime } from "../storage/sqlite-runtime.js";
import { holdWorkflowLease } from "../storage/workflow-lease.js";
import { recordConsent, recordObservation, summarizeBetaEvidence,
  type BetaEvidence } from "./beta-evidence.js";
import type { ApplicationCheckpoint } from "./state-machine.js";

await holdWorkflowLease();
const encoded = await createNativeSecretStore().get(stateKeyReference());
if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
  throw new Error("Existing state key is required for beta evidence");
}
const key = Buffer.from(encoded, "base64");
if (key.length !== 32) throw new Error("Invalid state key");
const root = join(userInfo().homedir, ".openapply-agent");
const sqlite = await openActiveSqliteRuntime(key);
try {
  const evidence = new EncryptedApplicationStateStore<BetaEvidence>(join(root, "beta-evidence.enc.json"), key);
  const action = process.argv[2] === "beta:evidence" ? process.argv[3] : process.argv[2];
  if (action === "summary") {
    const snapshot = await evidence.snapshotRecords();
    console.log(JSON.stringify(summarizeBetaEvidence(snapshot.flatMap((row) => row.state ? [row.state as BetaEvidence] : []))));
  } else if (action === "consent" || action === "observe") {
    const inputPath = process.env.OPENAPPLY_BETA_INPUT;
    if (!inputPath) throw new Error("Set OPENAPPLY_BETA_INPUT to an absolute private JSON file");
    const input = JSON.parse(await readPrivateFile(inputPath)) as unknown;
    if (action === "consent") {
      await recordConsent(evidence, input);
      console.log(JSON.stringify({ action: "consent-recorded" }));
    } else {
      const parsed = input as { jobId?: unknown };
      if (typeof parsed?.jobId !== "string") throw new Error("Observation needs an exact job ID");
      const applications = sqlite?.store<ApplicationCheckpoint>("applications")
        ?? new EncryptedApplicationStateStore<ApplicationCheckpoint>(join(root, "applications.enc.json"), key);
      const checkpoint = (await applications.read(parsed.jobId))?.state;
      if (!checkpoint) throw new Error("No saved checkpoint exists for this exact job");
      await recordObservation(evidence, input, checkpoint);
      console.log(JSON.stringify({ action: "observation-recorded" }));
    }
  } else throw new Error("Use openapply beta:evidence consent, observe, or summary");
} finally { sqlite?.close(); }
