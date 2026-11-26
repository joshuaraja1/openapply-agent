import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("benchmark evidence requires a complete, successful sample set", () => {
  const directory = mkdtempSync(join(tmpdir(), "openapply-benchmark-report-"));
  const path = join(directory, "report.json");
  const report = {
    fixture: "owned-browser-synthetic-v1", sampleCount: 30,
    environment: { platform: "darwin", node: "v22", chromium: "test" },
    startupMs: 1, navigationMs: 1, peakRssBytes: 1,
    snapshot: { count: 30, failures: 0, medianMs: 1, p95Ms: 2 },
    actionAndSnapshot: { count: 30, failures: 0, medianMs: 1, p95Ms: 2 },
  };
  const verify = () => spawnSync(process.execPath,
    ["scripts/assert-browser-benchmark.mjs", path, "30", "macOS"], { encoding: "utf8" });
  try {
    writeFileSync(path, JSON.stringify(report));
    assert.equal(verify().status, 0);
    report.snapshot.count = 29;
    writeFileSync(path, JSON.stringify(report));
    assert.notEqual(verify().status, 0);
    report.snapshot.count = 30;
    report.snapshot.p95Ms = -1;
    writeFileSync(path, JSON.stringify(report));
    assert.notEqual(verify().status, 0);
    report.snapshot.p95Ms = 2;
    report.environment.platform = "linux";
    writeFileSync(path, JSON.stringify(report));
    assert.notEqual(verify().status, 0);
    writeFileSync(path, "not JSON");
    assert.notEqual(verify().status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
