import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { getOrCreateStateKey } from "../storage/mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { openActiveSqliteRuntime } from "../storage/sqlite-runtime.js";
import { startHandoffUi } from "./handoff-ui.js";
import { readApplicationPackage } from "./package-file.js";
import type { ApplicationCheckpoint } from "./state-machine.js";

const jobId = process.env.OPENAPPLY_JOB_ID;
if (!jobId) throw new Error("Set OPENAPPLY_JOB_ID to the exact paused job ID");
const home = join(userInfo().homedir, ".openapply-agent");
const secrets = createNativeSecretStore();
const key = await getOrCreateStateKey(secrets, stateKeyReference());
async function loadCheckpoint(): Promise<ApplicationCheckpoint | undefined> {
  const sqlite = await openActiveSqliteRuntime(key);
  try {
    const store = sqlite?.store<ApplicationCheckpoint>("applications")
      ?? new EncryptedApplicationStateStore<ApplicationCheckpoint>(join(home, "applications.enc.json"), key);
    return (await store.read(jobId!))?.state;
  } finally { sqlite?.close(); }
}
const initial = await loadCheckpoint();
if (initial?.stage !== "waiting-human" || !initial.packagePath) {
  throw new Error("This job has no resumable application handoff");
}
const pkg = await readApplicationPackage(initial.packagePath);
if (pkg.job.id !== jobId || pkg.job.applicationUrl !== initial.officialUrl) {
  throw new Error("Handoff package belongs to another application");
}

const ui = await startHandoffUi({ jobId, jobLabel: `${pkg.job.company} — ${pkg.job.title}`,
  loadCheckpoint, resume: async (checkpoint, answers) => {
  const finalApproval = checkpoint.blocker === "Final submission approval required";
  if (finalApproval && answers.length) throw new Error("Final approval does not accept new answers");
  const answerPayload = answers.length ? JSON.stringify({ version: 1,
    jobId, browserPageId: checkpoint.browserPageId ?? 0,
    approveFinalSubmission: true, answers }) : undefined;
    const env = { ...process.env };
    for (const name of ["OPENAPPLY_APPROVE_JOB_ID", "OPENAPPLY_RESUME_JOB_ID",
      "OPENAPPLY_CONFIRM_JOB_ID", "OPENAPPLY_APPROVED_ANSWERS", "OPENAPPLY_APPROVED_ANSWERS_STDIN",
      "OPENAPPLY_CONFIRMATION_ATTESTATION"]) {
      delete env[name];
    }
    env.OPENAPPLY_PACKAGE = checkpoint.packagePath!;
    env[finalApproval ? "OPENAPPLY_APPROVE_JOB_ID" : "OPENAPPLY_RESUME_JOB_ID"] = jobId;
    if (answerPayload) env.OPENAPPLY_APPROVED_ANSWERS_STDIN = "1";
    const child = spawn(process.execPath,
      [...process.execArgv, fileURLToPath(new URL("./cli.js", import.meta.url))],
      { env, stdio: answerPayload ? ["pipe", "inherit", "inherit"] : "inherit" });
    if (answerPayload) {
      child.stdin!.on("error", () => { /* Child exit reports the failure below. */ });
      child.stdin!.end(answerPayload);
    }
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error("Application resume failed");
} });
console.log(`Open private application handoff: ${ui.url}`);
console.log("Press Ctrl+C to stop the local handoff server.");
