import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function assertQueueBenchmark(report, runnerOs) {
  const platform = { Linux: "linux", macOS: "darwin", Windows: "win32" }[runnerOs];
  if (!platform || report?.fixture !== "queue-synthetic-100-v1"
    || report.jobCount !== 100 || report.iterations !== 5
    || report.environment?.platform !== platform
    || !/^v\d+\./.test(report.environment?.node ?? "")) {
    throw new Error("Synthetic queue benchmark metadata is incomplete");
  }
  const stage = report.queue;
  if (stage?.count !== 5 || stage.completedJobsPerRun !== 100 || stage.failures !== 0
    || !Number.isFinite(stage.medianMs) || stage.medianMs < 0
    || !Number.isFinite(stage.p95Ms) || stage.p95Ms < stage.medianMs) {
    throw new Error("Synthetic queue timings are invalid");
  }
  const recovery = report.recovery;
  if (recovery?.stage !== "submission-uncertain" || recovery.clickCount !== 1
    || recovery.separateProcess !== true || recovery.terminatedByParent !== true
    || !Number.isFinite(recovery.processRestartMs)
    || recovery.processRestartMs <= 0) {
    throw new Error("Separate-process recovery evidence is incomplete");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
  assertQueueBenchmark(report, process.argv[3]);
}
