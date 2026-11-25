import { readFile } from "node:fs/promises";
import { createApplicationHandoff } from "./application/handoff.js";
import { rankedQueueSchema, reconcileReportedQueue, retainUnavailableJobs, type QueuedJob } from "./application/queue-reconcile.js";
import { selectRankedJobs } from "./application/ranked-queue.js";
import { candidateProfileSchema, searchPreferencesSchema } from "./candidate/schema.js";
import { discoveryInputSchema } from "./config.js";
import { evaluateJob, markJobsReported, selectFreshnessTier } from "./discovery.js";
import { createTailoringBrief } from "./resume/tailoring.js";
import { fetchSourceBatch } from "./sources/batch.js";
import { persistDiscoveryOutput } from "./storage/discovery-output.js";
import type { DiscoveryState } from "./types.js";

const inputPath = process.env.OPENAPPLY_INPUT ?? "examples/discovery-input.json";
const candidatePath = process.env.OPENAPPLY_CANDIDATE ?? "examples/candidate-profile.json";
const preferencesPath = process.env.OPENAPPLY_PREFERENCES ?? "examples/search-preferences.json";
const statePath = process.env.OPENAPPLY_STATE ?? "storage/state.json";
const outputPath = process.env.OPENAPPLY_OUTPUT ?? "output/application-queue.json";

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const [input, candidate, preferences] = await Promise.all([
  json(inputPath).then((value) => discoveryInputSchema.parse(value)),
  json(candidatePath).then((value) => candidateProfileSchema.parse(value)),
  json(preferencesPath).then((value) => searchPreferencesSchema.parse(value)),
]);
const state = await json(statePath).catch(() => ({ jobs: {} })) as DiscoveryState;
const now = new Date();
let previousQueue: QueuedJob[] = [];
try {
  const previous = rankedQueueSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
  previousQueue = previous.queue;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const previouslyQueued = new Set(previousQueue.map((entry) => entry.job.id));
const batch = await fetchSourceBatch(input.sources, input.maxJobsPerSource, now);
const fetched = batch.jobs;
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
const newQueue = selectRankedJobs(evaluated, state, previouslyQueued, candidate, preferences,
  input.preferredFreshnessHours, input.maximumFreshnessHours, now)
  .map(({ job, match }) => ({
    job,
    sourceVerification: "verified" as const,
    match,
    tailoringBrief: createTailoringBrief(job, candidate),
    handoff: createApplicationHandoff(job, preferences.applicationPolicy.requireFinalApproval),
  }));
const queue = [...newQueue, ...retainUnavailableJobs(previousQueue, batch.failures)];
reconcileReportedQueue(state, previouslyQueued, new Set(queue.map((entry) => entry.job.id)));
markJobsReported(state, queue.map((entry) => entry.job.id), now);
const queuedTier = selectFreshnessTier(queue.map((entry) => entry.job),
  input.preferredFreshnessHours, input.maximumFreshnessHours, now);

await persistDiscoveryOutput(outputPath, { generatedAt: now.toISOString(), tier: queuedTier.tier, queue }, statePath, state);
console.log(`Prepared ${queue.length} application handoff(s) in ${outputPath}`);
