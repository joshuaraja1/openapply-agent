import assert from "node:assert/strict";
import { test } from "node:test";
import { assertQueueBenchmark } from "./assert-queue-benchmark.mjs";

const valid = () => ({ fixture: "queue-synthetic-100-v1", jobCount: 100, iterations: 5,
  environment: { platform: "linux", node: "v22.0.0" },
  queue: { count: 5, completedJobsPerRun: 100, failures: 0, medianMs: 2, p95Ms: 4 },
  recovery: { stage: "submission-uncertain", clickCount: 1,
    separateProcess: true, terminatedByParent: true, activeWorkerFenced: true,
    staleLockClearedAfterExit: true, processRestartMs: 100 } });

test("accepts complete synthetic queue and separate-process recovery report", () => {
  assert.doesNotThrow(() => assertQueueBenchmark(valid(), "Linux"));
});

test("rejects missing jobs, wrong platform, invalid timings, and duplicate clicks", () => {
  for (const mutate of [
    (report) => { report.jobCount = 99; },
    (report) => { report.environment.platform = "darwin"; },
    (report) => { report.queue.p95Ms = -1; },
    (report) => { report.queue.completedJobsPerRun = 99; },
    (report) => { report.recovery.clickCount = 2; },
    (report) => { report.recovery.separateProcess = false; },
    (report) => { report.recovery.terminatedByParent = false; },
    (report) => { report.recovery.activeWorkerFenced = false; },
    (report) => { report.recovery.staleLockClearedAfterExit = false; },
    (report) => { delete report.recovery.processRestartMs; },
  ]) {
    const report = valid();
    mutate(report);
    assert.throws(() => assertQueueBenchmark(report, "Linux"));
  }
});
