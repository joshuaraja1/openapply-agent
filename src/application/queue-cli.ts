import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import { NeoApplicationBrowser } from "../browser/neo-application.js";
import { accountForUrl, loadAuthenticationPolicy } from "../auth/schema.js";
import { EmailCodeEntry } from "../auth/email-entry.js";
import { candidateProfileSchema, searchPreferencesSchema } from "../candidate/schema.js";
import { discoveryInputSchema } from "../config.js";
import { createJakeResumeSource } from "../resume/jake.js";
import { assertLocalBrowserEndpoint, renderOverleafResume } from "../resume/overleaf.js";
import { renderOwnedOverleafResume } from "../resume/owned-overleaf.js";
import { getOrCreateStateKey } from "../storage/mac-keychain.js";
import { createNativeSecretStore, stateKeyReference } from "../storage/native-secret-store.js";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { openActiveSqliteRuntime } from "../storage/sqlite-runtime.js";
import { holdWorkflowLease } from "../storage/workflow-lease.js";
import type { DiscoveredJob } from "../types.js";
import { DailyQuota, type DailyQuotaRecord } from "./daily-quota.js";
import { queueRunnerConfigSchema } from "./queue-config.js";
import { createApplicationHandoff } from "./handoff.js";
import { loadHandoffNotificationConfig, notifyHumanHandoff, sendHandoffEmail } from "./notification.js";
import { runApplicationQueue } from "./queue-runner.js";
import { runnableEntries } from "./queue-reconcile.js";
import { RetryLedger, type RetryRecord } from "./retry-ledger.js";
import { applicationPackageSchema, runApplicationPackage } from "./runner.js";
import { queueFileSchema } from "./queue-schema.js";
import { writeApplicationPackage } from "./package-file.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";
import { scoreJob } from "../matching/score.js";
import { PostingClaimLedger, type PostingClaim } from "./posting-claims.js";

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
await holdWorkflowLease();
const configPath = process.env.OPENAPPLY_QUEUE_CONFIG;
if (!configPath) throw new Error("Set OPENAPPLY_QUEUE_CONFIG to a private queue-runner configuration");
const config = queueRunnerConfigSchema.parse(await json(configPath));
if (config.browserEndpoint) assertLocalBrowserEndpoint(config.browserEndpoint);
const authPolicy = config.authenticationPolicyPath
  ? await loadAuthenticationPolicy(config.authenticationPolicyPath) : undefined;
const root = join(userInfo().homedir, ".openapply-agent");
const secrets = createNativeSecretStore();
const notificationConfig = config.notificationConfigPath
  ? await loadHandoffNotificationConfig(config.notificationConfigPath) : undefined;
const key = await getOrCreateStateKey(secrets, stateKeyReference());
const sqlite = await openActiveSqliteRuntime(key);
if (sqlite) sqlite.assertLegacyPaths({ encryptedDirectory: root,
  discoveryStatePath: config.discoveryStatePath, queuePath: config.queuePath });
const [queue, candidate, preferences, discovery] = await Promise.all([
  (sqlite ? sqlite.store("queue").read("current").then((row) => row?.state ?? { queue: [] })
    : json(config.queuePath)).then((value) => queueFileSchema.parse(value)),
  json(config.candidatePath).then((value) => candidateProfileSchema.parse(value)),
  json(config.preferencesPath).then((value) => searchPreferencesSchema.parse(value)),
  json(config.discoveryInputPath).then((value) => discoveryInputSchema.parse(value)),
]);
const workflow = new ApplicationWorkflow(sqlite?.store<ApplicationCheckpoint>("applications")
  ?? new EncryptedApplicationStateStore<ApplicationCheckpoint>(join(root, "applications.enc.json"), key));
const quota = new DailyQuota(sqlite?.store<DailyQuotaRecord>("quota")
  ?? new EncryptedApplicationStateStore<DailyQuotaRecord>(join(root, "daily-quota.enc.json"), key));
const retries = new RetryLedger(sqlite?.store<RetryRecord>("retries")
  ?? new EncryptedApplicationStateStore<RetryRecord>(join(root, "retry-ledger.enc.json"), key));
const postingClaims = new PostingClaimLedger(sqlite?.store<PostingClaim>("postingClaims")
  ?? new EncryptedApplicationStateStore<PostingClaim>(join(root, "posting-claims.enc.json"), key));
const emailCode = authPolicy?.emailVerification.autoEnter
  ? new EmailCodeEntry(authPolicy, secrets, sqlite?.store("emailClaims")
    ?? new EncryptedApplicationStateStore(join(root, "email-code-claims.enc.json"), key)) : undefined;
const template = await readFile("templates/resume/main.tex", "utf8");
const eligible: DiscoveredJob[] = [];
const needsReview: { jobId: string; reasons: string[] }[] = [];
const sources = new Map<string, (typeof discovery.sources)[number]>();
const jobSources = new Map<string, (typeof discovery.sources)[number]>();
for (const source of discovery.sources.filter((entry) => entry.enabled)) {
  const key = `${source.provider}:${source.company}`;
  if (sources.has(key)) throw new Error(`Ambiguous configured source for ${key}`);
  sources.set(key, source);
}
for (const entry of runnableEntries(queue.queue)) {
  const job = entry.job;
  const current = await workflow.current(job.id);
  if (current && ["submitted", "waiting-human", "submission-uncertain", "submit-claimed", "skipped"].includes(current.stage)) continue;
  if (entry.source && entry.source.provider === job.provider
    && entry.source.company === job.company) {
    jobSources.set(job.id, entry.source);
  }
  if (jobSources.has(job.id) || sources.has(`${job.provider}:${job.company}`)) {
    const match = scoreJob(job, candidate, preferences);
    if (match.eligible) eligible.push(job);
    else if (match.reviewFlags.includes("Review mandatory qualifications before applying")) {
      needsReview.push({ jobId: job.id, reasons: match.reasons });
    }
  }
}
const connection = config.browserRuntime === "browseros"
  ? await connectBrowserOs(config.browserEndpoint!) : undefined;
const client: BrowserToolClient | undefined = connection && { callTool: async (request) =>
  await connection.client.callTool(request) as BrowserToolResult };
try {
  const date = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const cap = Math.min(preferences.applicationPolicy.dailyTarget, preferences.applicationPolicy.dailyHardCap);
  const outcomes = await runApplicationQueue(eligible, quota, retries, date, cap, async (job) => {
    const source = jobSources.get(job.id) ?? sources.get(`${job.provider}:${job.company}`)!;
    const resumeSource = createJakeResumeSource(template, job, candidate);
    const artifact = config.browserRuntime === "owned"
      ? await renderOwnedOverleafResume(config.overleafProjectUrl, job, candidate,
        resumeSource, config.outputDirectory, { profileDirectory: join(root, "browser-profile") })
      : await renderOverleafResume(client!, config.overleafProjectUrl, job, candidate,
        resumeSource, config.outputDirectory);
    const host = new URL(job.applicationUrl).hostname;
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, preferences.applicationPolicy.requireFinalApproval),
      resumeSource, resumePdfPath: artifact.path, browserRuntime: config.browserRuntime,
      ...(config.browserEndpoint ? { browserEndpoint: config.browserEndpoint } : {}),
      ...(config.authenticationPolicyPath
        ? { authenticationPolicyPath: config.authenticationPolicyPath } : {}),
      ...(config.expectedConfirmationByDomain[host]
        ? { expectedConfirmation: config.expectedConfirmationByDomain[host] } : {}),
    });
    const packagePath = join(config.outputDirectory, `application-${randomUUID()}.json`);
    await writeApplicationPackage(packagePath, pkg);
    const account = authPolicy ? accountForUrl(authPolicy, job.applicationUrl) : undefined;
    const result = await runApplicationPackage(pkg, workflow, join(root, "browser-profile"), {
      packagePath,
      ...(account ? { account, secretStore: secrets } : {}),
      ...(emailCode ? { emailCode } : {}),
      ...(client ? { browserFactory: async (allowedHosts: ReadonlySet<string>,
        approvedArtifacts: ReadonlyMap<string, string>) => ({
        browser: new NeoApplicationBrowser(client, allowedHosts, approvedArtifacts),
        close: async () => {},
      }) } : {}),
    });
    if (result.checkpoint.stage === "waiting-human") {
      await notifyHumanHandoff().catch(() => console.warn("Desktop handoff notification was unavailable"));
      if (notificationConfig) {
        await sendHandoffEmail(notificationConfig, result.checkpoint, secrets)
          .catch(() => console.warn("Email handoff notification was unavailable"));
      }
    }
  }, async (job) => await postingClaims.claim(job.id, job.applicationUrl) === "claimed");
  console.log(JSON.stringify({ date: date(), outcomes, needsReview }));
} finally {
  await connection?.close();
  sqlite?.close();
}
