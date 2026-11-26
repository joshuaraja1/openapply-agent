import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function validTiming(value, count) {
  return value?.count === count && value.failures === 0
    && Number.isFinite(value.medianMs) && value.medianMs >= 0
    && Number.isFinite(value.p95Ms) && value.p95Ms >= value.medianMs;
}

export function assertApplicationBenchmark(report, runnerOs) {
  const platform = { Linux: "linux", macOS: "darwin", Windows: "win32" }[runnerOs];
  if (!platform || report?.fixture !== "application-stage-synthetic-v1"
    || report.synthetic !== true || report.environment?.platform !== platform
    || report.scope?.sourceFetch !== false || report.scope.browser !== false
    || report.scope.pdfRender !== false || report.scope.employerNetwork !== false
    || report.scope.operatingSystemCrashes !== 0
    || !/^v\d+\./.test(report.environment?.node ?? "")) {
    throw new Error("Synthetic application benchmark metadata is incomplete");
  }
  const confirmed = report.confirmed;
  if (confirmed?.warmSamples !== 30 || confirmed.finalClicks !== 30
    || !validTiming(confirmed.queueMs, 30)
    || !validTiming(confirmed.checkpointMs, 30)
    || !validTiming(confirmed.confirmationMs, 30)) {
    throw new Error("Synthetic job-bound confirmation evidence is incomplete");
  }
  const ambiguous = report.ambiguous;
  if (ambiguous?.attempts !== 1_000 || ambiguous.uncertain !== 1_000
    || ambiguous.finalClicks !== 1_000 || ambiguous.repeatedClicks !== 0
    || !validTiming(ambiguous.claimAndRetryMs, 1_000)) {
    throw new Error("Synthetic ambiguous retry evidence is incomplete");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
  assertApplicationBenchmark(report, process.argv[3]);
}
