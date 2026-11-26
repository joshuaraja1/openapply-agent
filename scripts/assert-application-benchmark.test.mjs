import { test } from "node:test";
import { strict as assert } from "node:assert";
import { assertApplicationBenchmark } from "./assert-application-benchmark.mjs";

const timing = (count) => ({ count, failures: 0, medianMs: 1, p95Ms: 2 });
const valid = () => ({ fixture: "application-stage-synthetic-v1", synthetic: true,
  scope: { sourceFetch: false, browser: false, pdfRender: false, employerNetwork: false,
    operatingSystemCrashes: 0 },
  environment: { platform: "darwin", node: "v22.13.0" },
  confirmed: { warmSamples: 30, finalClicks: 30,
    queueMs: timing(30), checkpointMs: timing(30), confirmationMs: timing(30) },
  ambiguous: { attempts: 1_000, uncertain: 1_000, finalClicks: 1_000,
    repeatedClicks: 0, claimAndRetryMs: timing(1_000) } });

test("accepts complete synthetic evidence", () => {
  assert.doesNotThrow(() => assertApplicationBenchmark(valid(), "macOS"));
});

test("rejects missing samples, duplicate clicks, and nonmatching platform", () => {
  const missing = valid();
  missing.confirmed.queueMs.count = 29;
  assert.throws(() => assertApplicationBenchmark(missing, "macOS"));
  const duplicated = valid();
  duplicated.ambiguous.repeatedClicks = 1;
  assert.throws(() => assertApplicationBenchmark(duplicated, "macOS"));
  assert.throws(() => assertApplicationBenchmark(valid(), "Windows"));
});
