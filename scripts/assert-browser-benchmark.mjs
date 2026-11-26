import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const samples = Number(process.argv[3]);
const platform = { Linux: "linux", macOS: "darwin", Windows: "win32" }[process.argv[4]];
if (!Number.isSafeInteger(samples) || samples < 1 || !platform
  || report.fixture !== "owned-browser-synthetic-v1" || report.sampleCount !== samples
  || report.environment?.platform !== platform || !report.environment?.node
  || !report.environment?.chromium
  || !Number.isFinite(report.startupMs) || report.startupMs < 0
  || !Number.isFinite(report.navigationMs) || report.navigationMs < 0
  || !Number.isFinite(report.peakRssBytes) || report.peakRssBytes <= 0) {
  throw new Error("Browser benchmark report is incomplete");
}
for (const stage of [report.snapshot, report.actionAndSnapshot]) {
  if (stage?.count !== samples || stage.failures !== 0
    || !Number.isFinite(stage.medianMs) || stage.medianMs < 0
    || !Number.isFinite(stage.p95Ms) || stage.p95Ms < stage.medianMs) {
    throw new Error("Browser benchmark report has missing or failed samples");
  }
}
