import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { AgentBrowser } from "./actions.js";
import { launchBrowser } from "./runtime.js";
import { summarizeTimings } from "../performance/summary.js";
import { secureWindowsPrivatePath } from "../storage/windows-acl.js";

export interface BrowserBenchmarkReport {
  fixture: "owned-browser-synthetic-v1";
  sampleCount: number;
  environment: { platform: string; arch: string; cpu: string; node: string; chromium: string };
  startupMs: number;
  navigationMs: number;
  snapshot: ReturnType<typeof summarizeTimings>;
  actionAndSnapshot: ReturnType<typeof summarizeTimings>;
  peakRssBytes: number;
}

/** Measures local browser overhead on a fixed synthetic page; no employer traffic or user profile. */
export async function benchmarkOwnedBrowser(sampleCount = 30): Promise<BrowserBenchmarkReport> {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 1_000) {
    throw new Error("Sample count must be an integer from 1 to 1000");
  }
  const root = await mkdtemp(join(tmpdir(), "openapply-benchmark-"));
  const snapshots: number[] = [];
  const actions: number[] = [];
  let snapshotFailures = 0;
  let actionFailures = 0;
  let peakRssBytes = process.memoryUsage().rss;
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const launchStarted = performance.now();
    const runtime = await launchBrowser({ profileDirectory: join(root, "profile"), headless: true });
    const startupMs = performance.now() - launchStarted;
    try {
      await runtime.context.route("https://benchmark.openapply.invalid/**", (route) => route.fulfill({
        contentType: "text/html", body: '<!doctype html><title>OpenApply benchmark</title>'
          + '<label>Benchmark field<input name="benchmark"></label>',
      }));
      const browser = new AgentBrowser(runtime.context, new Set(["benchmark.openapply.invalid"]));
      const navigationStarted = performance.now();
      await browser.navigate("https://benchmark.openapply.invalid/apply/123456");
      const navigationMs = performance.now() - navigationStarted;
      for (let index = 0; index < sampleCount; index += 1) {
        let stage: "snapshot" | "action" = "snapshot";
        try {
          const snapshotStarted = performance.now();
          const snapshot = await browser.snapshot();
          snapshots.push(performance.now() - snapshotStarted);
          stage = "action";
          const input = snapshot.controls.find((control) => control.name === "Benchmark field");
          if (!input) throw new Error("Synthetic benchmark control is missing");
          const actionStarted = performance.now();
          await browser.act(input.ref, "fill", `sample-${index}`);
          actions.push(performance.now() - actionStarted);
        } catch {
          if (stage === "action") actionFailures += 1;
          else snapshotFailures += 1;
          await browser.navigate("https://benchmark.openapply.invalid/apply/123456");
        }
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }
      return { fixture: "owned-browser-synthetic-v1", sampleCount,
        environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown",
          node: process.version, chromium: runtime.context.browser()?.version() ?? "unknown" },
        startupMs: Math.round(startupMs * 100) / 100,
        navigationMs: Math.round(navigationMs * 100) / 100,
        snapshot: summarizeTimings(snapshots, snapshotFailures),
        actionAndSnapshot: summarizeTimings(actions, actionFailures), peakRssBytes };
    } finally { await runtime.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
