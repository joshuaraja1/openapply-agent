import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const samples = Number(process.argv[3]);
if (report.fixture !== "owned-browser-synthetic-v1" || report.sampleCount !== samples
  || !report.environment?.platform || !report.environment?.node || !report.environment?.chromium
  || !Number.isFinite(report.startupMs) || !Number.isFinite(report.navigationMs)
  || !Number.isFinite(report.peakRssBytes)) {
  throw new Error("Browser benchmark report is incomplete");
}
for (const stage of [report.snapshot, report.actionAndSnapshot]) {
  if (stage?.count !== samples || stage.failures !== 0
    || !Number.isFinite(stage.medianMs) || !Number.isFinite(stage.p95Ms)) {
    throw new Error("Browser benchmark report has missing or failed samples");
  }
}
