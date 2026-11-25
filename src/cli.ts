import { readFile } from "node:fs/promises";
import { createApplicationHandoff } from "./application/handoff.js";
import { mergePendingQueue } from "./application/queue-merge.js";
import { candidateProfileSchema, searchPreferencesSchema } from "./candidate/schema.js";
import { discoveryInputSchema } from "./config.js";
import { evaluateJob, freshnessPriority, markJobsReported, selectFreshnessTier } from "./discovery.js";
import { scoreJob } from "./matching/score.js";
import { createTailoringBrief } from "./resume/tailoring.js";
import { fetchSourceBatch } from "./sources/batch.js";
import { browserLeadsFileSchema, verifyOfficialBrowserLeads } from "./browser/verify-official.js";
import { persistDiscoveryOutput } from "./storage/discovery-output.js";
import { readPrivateFile } from "./storage/private-path.js";
import { openDefaultSqliteRuntimeIfPresent } from "./storage/sqlite-runtime.js";
import type { DiscoveryState } from "./types.js";

const inputPath = process.env.OPENAPPLY_INPUT ?? "examples/discovery-input.json";
const candidatePath = process.env.OPENAPPLY_CANDIDATE ?? "examples/candidate-profile.json";
const preferencesPath = process.env.OPENAPPLY_PREFERENCES ?? "examples/search-preferences.json";
const statePath = process.env.OPENAPPLY_STATE ?? "storage/state.json";
const outputPath = process.env.OPENAPPLY_OUTPUT ?? "output/application-queue.json";
const browserLeadsPath = process.env.OPENAPPLY_BROWSER_LEADS;

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const [input, candidate, preferences] = await Promise.all([
  json(inputPath).then((value) => discoveryInputSchema.parse(value)),
  json(candidatePath).then((value) => candidateProfileSchema.parse(value)),
  json(preferencesPath).then((value) => searchPreferencesSchema.parse(value)),
]);
const sqlite = await openDefaultSqliteRuntimeIfPresent();
const state = sqlite ? (await sqlite.store<DiscoveryState>("discovery").read("current"))?.state
  ?? { jobs: {} } : await readPrivateFile(statePath).then((content) => JSON.parse(content))
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { jobs: {} };
    throw error;
  }) as DiscoveryState;
const now = new Date();
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
  return result && !previous?.reportedAt ? [result] : [];
});
const tier = selectFreshnessTier(evaluated, input.preferredFreshnessHours, input.maximumFreshnessHours, now);
const newQueue = tier.jobs
  .map((job) => ({ job, match: scoreJob(job, candidate, preferences) }))
  .filter((entry) => entry.match.eligible)
  .sort((a, b) => freshnessPriority(a.job, input.preferredFreshnessHours, now)
    - freshnessPriority(b.job, input.preferredFreshnessHours, now)
    || b.match.score - a.match.score)
  .slice(0, preferences.applicationPolicy.dailyHardCap)
  .map(({ job, match }) => ({
    job,
    ...(verifiedSources.has(job.id) ? { source: verifiedSources.get(job.id)! } : {}),
    match,
    tailoringBrief: createTailoringBrief(job, candidate),
    handoff: createApplicationHandoff(job, preferences.applicationPolicy.requireFinalApproval),
  }));
markJobsReported(state, newQueue.map((entry) => entry.job.id), now);
let previousQueue: typeof newQueue = [];
try {
const previous = sqlite ? (await sqlite.store<{ queue?: unknown }>("queue").read("current"))?.state
  ?? { queue: [] } : JSON.parse(await readPrivateFile(outputPath)) as { queue?: unknown };
  if (Array.isArray(previous.queue)) previousQueue = previous.queue.filter((entry): entry is (typeof newQueue)[number] =>
    typeof entry === "object" && entry !== null && "job" in entry
    && typeof entry.job === "object" && entry.job !== null && "id" in entry.job
    && typeof entry.job.id === "string");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const queue = mergePendingQueue(previousQueue, newQueue);

if (sqlite) await sqlite.writeDiscoveryOutput({ generatedAt: now.toISOString(), tier: tier.tier, queue }, state);
else await persistDiscoveryOutput(outputPath, { generatedAt: now.toISOString(), tier: tier.tier, queue }, statePath, state);
sqlite?.close();
console.log(`Prepared ${queue.length} application handoff(s) in ${outputPath}`);
