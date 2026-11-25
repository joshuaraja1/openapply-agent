import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createApplicationHandoff } from "./application/handoff.js";
import { reconcileReportedQueue, retainUnavailableJobs, type QueuedJob } from "./application/queue-reconcile.js";
import { queueFileSchema } from "./application/queue-schema.js";
import { selectRankedJobs } from "./application/ranked-queue.js";
import { candidateProfileSchema, searchPreferencesSchema } from "./candidate/schema.js";
import { discoveryInputSchema } from "./config.js";
import { evaluateJob, markJobsReported, selectFreshnessTier } from "./discovery.js";
import { createTailoringBrief } from "./resume/tailoring.js";
import { fetchSourceBatch } from "./sources/batch.js";
import { browserLeadsFileSchema, verifyOfficialBrowserLeads } from "./browser/verify-official.js";
import { persistDiscoveryOutput } from "./storage/discovery-output.js";
import { readPrivateFile } from "./storage/private-path.js";
import { openDefaultSqliteRuntimeIfPresent } from "./storage/sqlite-runtime.js";
import { holdWorkflowLease } from "./storage/workflow-lease.js";
import type { DiscoveryState } from "./types.js";

const inputPath = process.env.OPENAPPLY_INPUT ?? "examples/discovery-input.json";
const candidatePath = process.env.OPENAPPLY_CANDIDATE ?? "examples/candidate-profile.json";
const preferencesPath = process.env.OPENAPPLY_PREFERENCES ?? "examples/search-preferences.json";
const statePath = process.env.OPENAPPLY_STATE ?? "storage/state.json";
const outputPath = process.env.OPENAPPLY_OUTPUT ?? "output/application-queue.json";
const browserLeadsPath = process.env.OPENAPPLY_BROWSER_LEADS;
await holdWorkflowLease();

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const [input, candidate, preferences] = await Promise.all([
  json(inputPath).then((value) => discoveryInputSchema.parse(value)),
  json(candidatePath).then((value) => candidateProfileSchema.parse(value)),
  json(preferencesPath).then((value) => searchPreferencesSchema.parse(value)),
]);
const sqlite = await openDefaultSqliteRuntimeIfPresent();
if (sqlite) sqlite.assertLegacyPaths({
  encryptedDirectory: join(userInfo().homedir, ".openapply-agent"),
  discoveryStatePath: statePath,
  queuePath: outputPath,
});
const state = sqlite ? (await sqlite.store<DiscoveryState>("discovery").read("current"))?.state
  ?? { jobs: {} } : await readPrivateFile(statePath).then((content) => JSON.parse(content))
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { jobs: {} };
    throw error;
  }) as DiscoveryState;
const now = new Date();
let previousQueue: QueuedJob[] = [];
try {
  const previousValue = sqlite ? (await sqlite.store("queue").read("current"))?.state ?? { queue: [] }
    : JSON.parse(await readPrivateFile(outputPath));
  const previous = queueFileSchema.parse(previousValue);
  previousQueue = previous.queue;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const previouslyQueued = new Set(previousQueue.map((entry) => entry.job.id));
const batch = await fetchSourceBatch(input.sources, input.maxJobsPerSource, now);
const verified = browserLeadsPath
  ? await json(browserLeadsPath).then((value) => browserLeadsFileSchema.parse(value))
    .then((value) => verifyOfficialBrowserLeads(value.leads, now)) : [];
const fetched = [...new Map([...batch.jobs, ...verified.map((entry) => entry.job)]
  .map((job) => [job.id, job])).values()];
const verifiedSources = new Map(verified.map((entry) => [entry.job.id, entry.source]));
for (const failure of batch.failures) {
  console.warn(`Skipped ${failure.source.company} (${failure.source.provider}): ${failure.message}`);
}

const evaluated = fetched.flatMap((job) => {
  const result = evaluateJob(job, input, state, now);
  const previous = state.jobs[job.id];
  state.jobs[job.id] = {
    firstSeenAt: previous?.firstSeenAt ?? now.toISOString(),
    lastSeenAt: now.toISOString(),
    ...(previous?.reportedAt ? { reportedAt: previous.reportedAt } : {}),
  };
  return result ? [result] : [];
});
const newQueue = selectRankedJobs(evaluated, candidate, preferences,
  input.preferredFreshnessHours, input.maximumFreshnessHours, now)
  .map(({ job, match }) => ({
    job,
    ...(verifiedSources.has(job.id) ? { source: verifiedSources.get(job.id)! } : {}),
    sourceVerification: "verified" as const,
    match,
    tailoringBrief: createTailoringBrief(job, candidate),
    handoff: createApplicationHandoff(job, preferences.applicationPolicy.requireFinalApproval),
  }));
const queue = [...newQueue, ...retainUnavailableJobs(previousQueue, batch.failures,
  new Set(newQueue.map((entry) => entry.job.id)))];
reconcileReportedQueue(state, previouslyQueued, new Set(queue.map((entry) => entry.job.id)));
markJobsReported(state, queue.map((entry) => entry.job.id), now);
const queuedTier = selectFreshnessTier(newQueue.map((entry) => entry.job),
  input.preferredFreshnessHours, input.maximumFreshnessHours, now);

if (sqlite) await sqlite.writeDiscoveryOutput({ generatedAt: now.toISOString(), tier: queuedTier.tier, queue }, state);
else await persistDiscoveryOutput(outputPath, { generatedAt: now.toISOString(), tier: queuedTier.tier, queue }, statePath, state);
sqlite?.close();
console.log(`Prepared ${queue.length} application handoff(s) in ${outputPath}`);
