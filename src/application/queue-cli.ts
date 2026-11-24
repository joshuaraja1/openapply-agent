import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import { candidateProfileSchema, searchPreferencesSchema } from "../candidate/schema.js";
import { discoveryInputSchema } from "../config.js";
import { createJakeResumeSource } from "../resume/jake.js";
import { assertLocalBrowserEndpoint, renderOverleafResume } from "../resume/overleaf.js";
import { getOrCreateStateKey, MacKeychainSecretStore } from "../storage/mac-keychain.js";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import type { DiscoveredJob } from "../types.js";
import { DailyQuota, type DailyQuotaRecord } from "./daily-quota.js";
import { queueRunnerConfigSchema } from "./queue-config.js";
import { createApplicationHandoff } from "./handoff.js";
import { runApplicationQueue } from "./queue-runner.js";
import { RetryLedger, type RetryRecord } from "./retry-ledger.js";
import { applicationPackageSchema, jobSchema, runApplicationPackage } from "./runner.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";

const queueSchema = z.object({ queue: z.array(z.object({ job: jobSchema })) });
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const configPath = process.env.OPENAPPLY_QUEUE_CONFIG;
if (!configPath) throw new Error("Set OPENAPPLY_QUEUE_CONFIG to a private queue-runner configuration");
const config = queueRunnerConfigSchema.parse(await json(configPath));
assertLocalBrowserEndpoint(config.browserEndpoint);
const [queue, candidate, preferences, discovery] = await Promise.all([
  json(config.queuePath).then((value) => queueSchema.parse(value)),
  json(config.candidatePath).then((value) => candidateProfileSchema.parse(value)),
  json(config.preferencesPath).then((value) => searchPreferencesSchema.parse(value)),
  json(config.discoveryInputPath).then((value) => discoveryInputSchema.parse(value)),
]);
const root = join(userInfo().homedir, ".openapply-agent");
const key = await getOrCreateStateKey(new MacKeychainSecretStore(), "keychain://application-state/main");
const workflow = new ApplicationWorkflow(new EncryptedApplicationStateStore<ApplicationCheckpoint>(
  join(root, "applications.enc.json"), key));
const quota = new DailyQuota(new EncryptedApplicationStateStore<DailyQuotaRecord>(
  join(root, "daily-quota.enc.json"), key));
const retries = new RetryLedger(new EncryptedApplicationStateStore<RetryRecord>(
  join(root, "retry-ledger.enc.json"), key));
const template = await readFile("templates/resume/main.tex", "utf8");
const eligible: DiscoveredJob[] = [];
const sources = new Map<string, (typeof discovery.sources)[number]>();
for (const source of discovery.sources.filter((entry) => entry.enabled)) {
  const key = `${source.provider}:${source.company}`;
  if (sources.has(key)) throw new Error(`Ambiguous configured source for ${key}`);
  sources.set(key, source);
}
for (const entry of queue.queue) {
  const job = entry.job as DiscoveredJob;
  const current = await workflow.current(job.id);
  if (current && ["submitted", "waiting-human", "submission-uncertain", "submit-claimed", "skipped"].includes(current.stage)) continue;
  if (sources.has(`${job.provider}:${job.company}`)) eligible.push(job);
}
const connection = await connectBrowserOs(config.browserEndpoint);
const client: BrowserToolClient = { callTool: async (request) =>
  await connection.client.callTool(request) as BrowserToolResult };
try {
  const date = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const cap = Math.min(preferences.applicationPolicy.dailyTarget, preferences.applicationPolicy.dailyHardCap);
  const outcomes = await runApplicationQueue(eligible, quota, retries, date, cap, async (job) => {
    const source = sources.get(`${job.provider}:${job.company}`)!;
    const resumeSource = createJakeResumeSource(template, job, candidate);
    const artifact = await renderOverleafResume(client, config.overleafProjectUrl, job, candidate,
      resumeSource, config.outputDirectory);
    const host = new URL(job.applicationUrl).hostname;
    const pkg = applicationPackageSchema.parse({ version: 1, job, source, candidate,
      handoff: createApplicationHandoff(job, preferences.applicationPolicy.requireFinalApproval),
      resumeSource, resumePdfPath: artifact.path,
      ...(config.expectedConfirmationByDomain[host]
        ? { expectedConfirmation: config.expectedConfirmationByDomain[host] } : {}),
    });
    const packagePath = join(config.outputDirectory, `application-${randomUUID()}.json`);
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await runApplicationPackage(pkg, workflow, join(root, "browser-profile"));
  });
  console.log(JSON.stringify({ date: date(), outcomes }));
} finally {
  await connection.close();
}
