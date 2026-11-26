import { performance } from "node:perf_hooks";
import { ApplicationWorkflow } from "../dist/src/application/state-machine.js";
import { submitApplication } from "../dist/src/application/submit.js";
import { createApplicationHandoff } from "../dist/src/application/handoff.js";
import { runApplicationQueue } from "../dist/src/application/queue-runner.js";
import { DailyQuota } from "../dist/src/application/daily-quota.js";
import { RetryLedger } from "../dist/src/application/retry-ledger.js";
import { MemoryApplicationStateStore } from "../dist/src/storage/contracts.js";
import { summarizeTimings } from "../dist/src/performance/summary.js";

const warmSamples = 30;
const ambiguousAttempts = 1_000;
const confirmation = "Thank you for applying to Example Co as Software Engineer";

function job(index) {
  const id = String(index).padStart(6, "0");
  const applicationUrl = `https://jobs.example.invalid/apply/${id}`;
  return { id: `lever:example:${id}`, applicationUrl, provider: "lever",
    company: "Example Co", title: "Software Engineer", descriptionText: "Synthetic posting",
    sourceUrl: applicationUrl, location: null, department: null, employmentType: null,
    workplaceType: null, compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null,
    firstSeenAt: "2026-01-01T00:00:00Z", discoveredAt: "2026-01-01T00:00:00Z",
    isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [] };
}

async function readyWorkflow(posting) {
  const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
  await workflow.create(posting.id, posting.applicationUrl);
  for (const stage of ["validated", "matched", "tailored"]) {
    await workflow.advance(posting.id, stage);
  }
  await workflow.advance(posting.id, "rendered", { artifactPath: "/synthetic/resume.pdf",
    artifactSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) });
  await workflow.advance(posting.id, "applying");
  return workflow;
}

async function measureSyntheticConfirmation() {
  const queueTimes = [];
  const workflowTimes = [];
  const confirmationTimes = [];
  let finalClicks = 0;
  for (let index = 0; index < warmSamples; index += 1) {
    const posting = job(index);
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const queueStart = performance.now();
    const outcomes = await runApplicationQueue([posting], quota, retries, () => "2026-01-01", 1,
      async (candidate) => {
        const workflowStart = performance.now();
        const workflow = await readyWorkflow(candidate);
        workflowTimes.push(performance.now() - workflowStart);
        const browser = { currentUrl: () => candidate.applicationUrl,
          submit: async () => { finalClicks += 1; return confirmation; } };
        const submitStart = performance.now();
        await submitApplication(workflow, browser, candidate.id, "synthetic-submit",
          "Thank you for applying", createApplicationHandoff(candidate, false),
          undefined, undefined, undefined, undefined, undefined,
          { company: candidate.company, title: candidate.title });
        confirmationTimes.push(performance.now() - submitStart);
        const checkpoint = await workflow.current(candidate.id);
        if (checkpoint?.stage !== "submitted" || checkpoint.confirmation !== confirmation) {
          throw new Error("Synthetic job-bound confirmation was not recorded");
        }
        return "submitted";
      }, async () => true);
    queueTimes.push(performance.now() - queueStart);
    if (outcomes.length !== 1 || outcomes[0]?.status !== "submitted") {
      throw new Error("Synthetic queue did not record the confirmed application");
    }
  }
  if (finalClicks !== warmSamples) throw new Error("Synthetic confirmation count changed");
  return { warmSamples, finalClicks, queueMs: summarizeTimings(queueTimes),
    checkpointMs: summarizeTimings(workflowTimes), confirmationMs: summarizeTimings(confirmationTimes) };
}

async function measureAmbiguousRetry() {
  const durations = [];
  let finalClicks = 0;
  let repeatedClicks = 0;
  let uncertain = 0;
  for (let index = 0; index < ambiguousAttempts; index += 1) {
    const posting = job(100_000 + index);
    const workflow = await readyWorkflow(posting);
    let clicksForJob = 0;
    const browser = { currentUrl: () => posting.applicationUrl,
      submit: async () => { clicksForJob += 1; finalClicks += 1;
        throw new Error("Synthetic renderer lost the receipt after the final click"); } };
    const handoff = createApplicationHandoff(posting, false);
    const started = performance.now();
    try {
      await submitApplication(workflow, browser, posting.id, "synthetic-submit",
        "Thank you for applying", handoff);
      throw new Error("Ambiguous synthetic click unexpectedly completed");
    } catch (error) {
      if (!String(error).includes("Synthetic renderer lost")) throw error;
    }
    if ((await workflow.current(posting.id))?.stage !== "submission-uncertain") {
      throw new Error("Ambiguous synthetic click did not remain uncertain");
    }
    try {
      await submitApplication(workflow, browser, posting.id, "synthetic-submit",
        "Thank you for applying", handoff);
      throw new Error("A retry of an uncertain submission unexpectedly completed");
    } catch (error) {
      if (!String(error).includes("Invalid application transition")) throw error;
    }
    durations.push(performance.now() - started);
    uncertain += 1;
    if (clicksForJob !== 1) repeatedClicks += 1;
  }
  if (finalClicks !== ambiguousAttempts || uncertain !== ambiguousAttempts || repeatedClicks !== 0) {
    throw new Error("Synthetic ambiguous retry duplicated or lost a final click");
  }
  return { attempts: ambiguousAttempts, uncertain, finalClicks, repeatedClicks,
    claimAndRetryMs: summarizeTimings(durations) };
}

const report = { fixture: "application-stage-synthetic-v1", synthetic: true,
  scope: { sourceFetch: false, browser: false, pdfRender: false, employerNetwork: false,
    operatingSystemCrashes: 0 },
  environment: { platform: process.platform, node: process.version },
  confirmed: await measureSyntheticConfirmation(), ambiguous: await measureAmbiguousRetry() };
process.stdout.write(`${JSON.stringify(report)}\n`);
