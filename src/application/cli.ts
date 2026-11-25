import { userInfo } from "node:os";
import { join } from "node:path";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import { NeoApplicationBrowser } from "../browser/neo-application.js";
import { accountForUrl, loadAuthenticationPolicy } from "../auth/schema.js";
import { EmailCodeEntry } from "../auth/email-entry.js";
import { assertLocalBrowserEndpoint } from "../resume/overleaf.js";
import { loadApprovedHumanAnswers } from "./human-answers.js";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { getOrCreateStateKey } from "../storage/mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { approvedDestinationHost, runApplicationPackage } from "./runner.js";
import { readApplicationPackage } from "./package-file.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";
import { confirmManualSubmission, loadManualAttestation } from "./manual-confirm.js";
import { savedBrowserEndpoint } from "./runtime-selection.js";

const packagePath = process.env.OPENAPPLY_PACKAGE;
if (!packagePath) throw new Error("Set OPENAPPLY_PACKAGE to a private application package JSON file");
const pkg = await readApplicationPackage(packagePath);
const approvedJobId = process.env.OPENAPPLY_APPROVE_JOB_ID;
if (approvedJobId && approvedJobId !== pkg.job.id) throw new Error("Approval job ID does not match the package");
const resumedJobId = process.env.OPENAPPLY_RESUME_JOB_ID;
if (resumedJobId && resumedJobId !== pkg.job.id) throw new Error("Resume job ID does not match the package");
const confirmJobId = process.env.OPENAPPLY_CONFIRM_JOB_ID;
if (confirmJobId && confirmJobId !== pkg.job.id) throw new Error("Confirmation job ID does not match the package");
if ([approvedJobId, resumedJobId, confirmJobId].filter(Boolean).length > 1) {
  throw new Error("Use one approval, resume, or confirmation action per run");
}
const authorizedPackage = approvedJobId
  ? { ...pkg, handoff: { ...pkg.handoff, mode: "submit-after-approval" as const,
    stopConditions: pkg.handoff.stopConditions.filter((condition) => condition !== "final-submit") } } : pkg;
const home = join(userInfo().homedir, ".openapply-agent");
const statePath = join(home, "applications.enc.json");
const profileDirectory = join(home, "browser-profile");
const secrets = createNativeSecretStore();
const key = await getOrCreateStateKey(secrets, stateKeyReference());
const store = new EncryptedApplicationStateStore<ApplicationCheckpoint>(statePath, key);
const workflow = new ApplicationWorkflow(store);
const answerPath = process.env.OPENAPPLY_APPROVED_ANSWERS;
if (answerPath && !resumedJobId) throw new Error("Approved answers require an explicit human resume");
const pending = resumedJobId ? await workflow.current(resumedJobId) : undefined;
const humanAnswerApproval = answerPath
  ? await loadApprovedHumanAnswers(answerPath, resumedJobId!, pending?.browserPageId ?? 0) : undefined;
const endpoint = savedBrowserEndpoint(pkg, process.env.OPENAPPLY_BROWSER_ENDPOINT);
if (endpoint) assertLocalBrowserEndpoint(endpoint);
if (pkg.browserEndpoint && endpoint !== pkg.browserEndpoint) {
  throw new Error("BrowserOS endpoint differs from the saved application package");
}
const runtimePackage = endpoint ? { ...authorizedPackage, browserEndpoint: endpoint } : authorizedPackage;
const authPolicy = runtimePackage.authenticationPolicyPath
  ? await loadAuthenticationPolicy(runtimePackage.authenticationPolicyPath) : undefined;
const account = authPolicy ? accountForUrl(authPolicy, pkg.job.applicationUrl) : undefined;
const emailCode = authPolicy?.emailVerification.autoEnter
  ? new EmailCodeEntry(authPolicy, secrets, new EncryptedApplicationStateStore(
    join(home, "email-code-claims.enc.json"), key)) : undefined;
const connection = endpoint ? await connectBrowserOs(endpoint) : undefined;
try {
  const client: BrowserToolClient | undefined = connection && { callTool: async (request) =>
    await connection.client.callTool(request) as BrowserToolResult };
  if (confirmJobId) {
    if (!client) throw new Error("Manual confirmation requires the saved BrowserOS endpoint");
    const attestationPath = process.env.OPENAPPLY_CONFIRMATION_ATTESTATION;
    if (!attestationPath) throw new Error("Manual confirmation requires a private job-bound attestation file");
    const browser = new NeoApplicationBrowser(client, new Set([approvedDestinationHost(pkg)]), new Map());
    await confirmManualSubmission(runtimePackage, workflow, browser, await loadManualAttestation(attestationPath));
    console.log(JSON.stringify({ jobId: pkg.job.id, stage: "submitted" }));
  } else {
  const result = await runApplicationPackage(runtimePackage, workflow, profileDirectory,
    { packagePath, ...(approvedJobId ? { approvedJobId } : {}), ...(resumedJobId ? { resumedJobId } : {}),
      ...(account ? { account, secretStore: secrets } : {}),
      ...(emailCode ? { emailCode } : {}),
      ...(humanAnswerApproval ? { humanAnswerApproval } : {}),
      ...(client ? { browserFactory: async (allowedHosts, approvedArtifacts) => ({
        browser: new NeoApplicationBrowser(client, allowedHosts, approvedArtifacts), close: async () => {},
      }) } : {}),
    });
  console.log(JSON.stringify({ jobId: pkg.job.id, stage: result.checkpoint.stage,
    blocker: result.checkpoint.blocker ?? null }));
  }
} finally {
  await connection?.close();
}
