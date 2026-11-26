import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DailyQuota } from "../dist/src/application/daily-quota.js";
import { RetryLedger } from "../dist/src/application/retry-ledger.js";
import { runApplicationQueue } from "../dist/src/application/queue-runner.js";
import { MemoryApplicationStateStore } from "../dist/src/storage/contracts.js";
import { secureWindowsPrivatePath } from "../dist/src/storage/windows-acl.js";

const jobCount = 100;
const iterations = 5;
const childPath = fileURLToPath(new URL("./queue-recovery-child.mjs", import.meta.url));
const jobs = Array.from({ length: jobCount }, (_, index) => ({
  id: `synthetic-${String(index).padStart(3, "0")}`,
  applicationUrl: `https://example.invalid/jobs/${index}`,
}));

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: sorted[Math.floor((sorted.length - 1) / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

async function measureQueue() {
  const durations = [];
  for (let run = 0; run < iterations; run += 1) {
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const claimed = new Set();
    const start = performance.now();
    const outcomes = await runApplicationQueue(jobs, quota, retries, () => "2026-01-01", jobCount,
      async () => "waiting-human", async (job) => {
        if (claimed.has(job.applicationUrl)) return false;
        claimed.add(job.applicationUrl);
        return true;
      });
    durations.push(performance.now() - start);
    if (outcomes.length !== jobCount || outcomes.some((result) => result.status !== "waiting-human")
      || claimed.size !== jobCount) throw new Error("Synthetic queue did not process all 100 jobs");
  }
  return { ...summary(durations), completedJobsPerRun: jobCount, failures: 0 };
}

function child(mode, root, key, killOnReady = false) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const processChild = spawn(process.execPath, [childPath, mode, root], {
      env: { ...process.env, OPENAPPLY_BENCHMARK_KEY_HEX: key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => processChild.kill("SIGKILL"), 15_000);
    processChild.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (killOnReady && stdout.includes("READY\n") && !killed) {
        killed = processChild.kill("SIGKILL");
      }
    });
    processChild.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    processChild.on("error", reject);
    processChild.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killOnReady ? !killed || !stdout.includes("READY\n") : code !== 0) {
        reject(new Error(`Synthetic ${mode} process failed: ${stderr || signal || code}`));
      } else resolve({ stdout: stdout.trim(), elapsedMs: performance.now() - started,
        terminatedByParent: killOnReady && killed });
    });
  });
}

async function measureRecovery() {
  const root = await mkdtemp(join(tmpdir(), "openapply-recovery-benchmark-"));
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const key = randomBytes(32).toString("hex");
    const claimed = await child("claim", root, key, true);
    const recovered = await child("recover", root, key);
    return { ...JSON.parse(recovered.stdout), processRestartMs: recovered.elapsedMs,
      separateProcess: true, terminatedByParent: claimed.terminatedByParent };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const report = { fixture: "queue-synthetic-100-v1", jobCount, iterations,
  environment: { platform: process.platform, node: process.version },
  queue: await measureQueue(), recovery: await measureRecovery() };
process.stdout.write(`${JSON.stringify(report)}\n`);
