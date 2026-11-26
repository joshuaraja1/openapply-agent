import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "../browser/runtime.js";
import { getOrCreateStateKey } from "../storage/mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { openActiveSqliteRuntime } from "../storage/sqlite-runtime.js";
import { holdWorkflowLease } from "../storage/workflow-lease.js";
import { readApplicationPackage } from "./package-file.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";
import { confirmOwnedSubmission, isOwnedReceiptAttested } from "./owned-confirm.js";

await holdWorkflowLease();
const packagePath = process.env.OPENAPPLY_PACKAGE;
if (!packagePath) throw new Error("Set OPENAPPLY_PACKAGE to the original private application package");
const pkg = await readApplicationPackage(packagePath);
if (pkg.browserRuntime !== "owned") throw new Error("This command requires an owned-browser application");
const home = join(userInfo().homedir, ".openapply-agent");
const key = await getOrCreateStateKey(createNativeSecretStore(), stateKeyReference());
const sqlite = await openActiveSqliteRuntime(key);
const store = sqlite?.store<ApplicationCheckpoint>("applications")
  ?? new EncryptedApplicationStateStore<ApplicationCheckpoint>(join(home, "applications.enc.json"), key);
const workflow = new ApplicationWorkflow(store);
const current = await workflow.current(pkg.job.id);
if (current?.stage !== "submission-uncertain" || current.packagePath !== packagePath) {
  sqlite?.close();
  throw new Error("The saved uncertain claim does not match this application package");
}
const runtime = await launchBrowser({ profileDirectory: join(home, "browser-profile"), headless: false });
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log(`Open the employer's application receipt or status for ${pkg.job.company} — ${pkg.job.title}`);
  console.log(`Use the browser window opened by OpenApply. The official application is ${pkg.job.applicationUrl}`);
  console.log("Do not submit again. This command only inspects a page you open yourself.");
  const answer = await terminal.question(`When the receipt is visible in that browser, type the exact job ID ${pkg.job.id}: `);
  const accountAnswer = await terminal.question(
    "Did you submit this application using your own signed-in employer account? Type YES or NO: ");
  if (!isOwnedReceiptAttested(pkg.job.id, answer, accountAnswer)) {
    throw new Error("Candidate account and submission attestation did not match");
  }
  const receiptUrl = await confirmOwnedSubmission(pkg, workflow, runtime.context,
    packagePath, true);
  console.log(JSON.stringify({ jobId: pkg.job.id, stage: "submitted", receiptUrl }));
} finally {
  terminal.close();
  await runtime.close();
  sqlite?.close();
}
