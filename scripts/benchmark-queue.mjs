import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
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
// Hang guard only: Windows fixture setup can spawn several ACL and encryption
// operations. This limit is not a throughput acceptance threshold.
const childSafetyTimeoutMs = 120_000;
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

function runChild(mode, root, key) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const worker = spawn(process.execPath, [childPath, mode, root], {
      env: { ...process.env, OPENAPPLY_BENCHMARK_KEY_HEX: key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => worker.kill("SIGKILL"), childSafetyTimeoutMs);
    worker.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    worker.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    worker.on("error", reject);
    worker.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.trim(), stderr,
        elapsedMs: performance.now() - started });
    });
  });
}

function startClaim(root, key) {
  const worker = spawn(process.execPath, [childPath, "claim", root], {
    env: { ...process.env, OPENAPPLY_BENCHMARK_KEY_HEX: key },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => worker.once("close", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => { worker.kill("SIGKILL"); reject(new Error("Claim worker timed out")); }, childSafetyTimeoutMs);
    worker.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    worker.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("READY\n")) { clearTimeout(timer); resolve(); }
    });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    worker.once("close", (code) => {
      if (!output.includes("READY\n")) {
        clearTimeout(timer);
        reject(new Error(`Claim worker exited before READY: ${code}; ${stderr.slice(0, 2000)}`));
      }
    });
  });
  return { worker, closed, ready };
}

async function measureRecovery() {
  // A Windows custom workflow root requires a protected parent. LOCALAPPDATA
  // itself may inherit ACLs on hosted runners, so create and secure one child.
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (!base) throw new Error("Windows queue benchmark requires LOCALAPPDATA");
  const privateParent = process.platform === "win32"
    ? await mkdtemp(join(base, "openapply-recovery-private-")) : undefined;
  try {
    if (privateParent) await secureWindowsPrivatePath(privateParent);
    const root = await mkdtemp(join(privateParent ?? base, "openapply-recovery-benchmark-"));
    let holder;
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(root);
      const key = randomBytes(32).toString("hex");
      holder = startClaim(root, key);
      await holder.ready;
      const probe = await runChild("probe", root, key);
      const activeWorkerFenced = probe.code !== 0 && probe.stderr.includes("Another workflow is active");
      if (!activeWorkerFenced) throw new Error("A second worker was not fenced by the active lease");
      const terminatedByParent = holder.worker.kill("SIGKILL");
      await holder.closed;
      if (!terminatedByParent) throw new Error("Claim worker did not terminate");
      // This fixture has proved the child exited. Production requires operator inspection
      // before clearing a stale workflow lock after an unclean exit.
      await rmdir(join(root, "workflow.lock"));
      const recovered = await runChild("recover", root, key);
      if (recovered.code !== 0) throw new Error(`Recovery worker failed: ${recovered.stderr}`);
      return { ...JSON.parse(recovered.stdout), processRestartMs: recovered.elapsedMs,
        separateProcess: true, terminatedByParent, activeWorkerFenced,
        staleLockClearedAfterExit: true };
    } finally {
      holder?.worker.kill("SIGKILL");
      if (holder) await holder.closed;
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    if (privateParent) await rm(privateParent, { recursive: true, force: true });
  }
}

const report = { fixture: "queue-synthetic-100-v1", jobCount, iterations,
  environment: { platform: process.platform, node: process.version },
  queue: await measureQueue(), recovery: await measureRecovery() };
process.stdout.write(`${JSON.stringify(report)}\n`);
