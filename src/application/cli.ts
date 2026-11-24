import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import { NeoApplicationBrowser } from "../browser/neo-application.js";
import { assertLocalBrowserEndpoint } from "../resume/overleaf.js";
import { loadApprovedHumanAnswers } from "./human-answers.js";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { getOrCreateStateKey, MacKeychainSecretStore } from "../storage/mac-keychain.js";
import { applicationPackageSchema, approvedDestinationHost, runApplicationPackage } from "./runner.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";
import { confirmManualSubmission, loadManualAttestation } from "./manual-confirm.js";

const packagePath = process.env.OPENAPPLY_PACKAGE;
if (!packagePath) throw new Error("Set OPENAPPLY_PACKAGE to a private application package JSON file");
const pkg = applicationPackageSchema.parse(JSON.parse(await readFile(packagePath, "utf8")));
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
const key = await getOrCreateStateKey(new MacKeychainSecretStore(), "keychain://application-state/main");
const store = new EncryptedApplicationStateStore<ApplicationCheckpoint>(statePath, key);
const workflow = new ApplicationWorkflow(store);
const answerPath = process.env.OPENAPPLY_APPROVED_ANSWERS;
if (answerPath && !resumedJobId) throw new Error("Approved answers require an explicit human resume");
const pending = resumedJobId ? await workflow.current(resumedJobId) : undefined;
const humanAnswerApproval = answerPath
  ? await loadApprovedHumanAnswers(answerPath, resumedJobId!, pending?.browserPageId ?? 0) : undefined;
const endpoint = process.env.OPENAPPLY_BROWSER_ENDPOINT ?? pkg.browserEndpoint;
if (endpoint) assertLocalBrowserEndpoint(endpoint);
if (pkg.browserEndpoint && endpoint !== pkg.browserEndpoint) {
  throw new Error("BrowserOS endpoint differs from the saved application package");
}
const runtimePackage = endpoint ? { ...authorizedPackage, browserEndpoint: endpoint } : authorizedPackage;
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
