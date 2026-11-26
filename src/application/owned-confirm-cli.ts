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
import { confirmOwnedSubmission } from "./owned-confirm.js";
import { withOwnedReceiptPrompt } from "./owned-confirm-session.js";

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
  console.log("Do not submit again. This command only inspects a page you open yourself. You have two minutes.");
  const receiptUrl = await withOwnedReceiptPrompt(runtime, terminal, pkg.job.id, async () => {
    await holdWorkflowLease();
    return confirmOwnedSubmission(pkg, workflow, runtime.context, packagePath, true);
  });
  console.log(JSON.stringify({ jobId: pkg.job.id, stage: "submitted", receiptUrl }));
} finally {
  sqlite?.close();
}
