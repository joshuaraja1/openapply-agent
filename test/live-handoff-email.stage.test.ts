import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DailyQuota } from "../src/application/daily-quota.js";
import { assertAutonomousNotificationReady, loadHandoffNotificationConfig,
  notifyPendingHandoff, sendHandoffEmail } from "../src/application/notification.js";
import { runApplicationQueue } from "../src/application/queue-runner.js";
import { RetryLedger } from "../src/application/retry-ledger.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "../src/application/state-machine.js";
import { createNativeSecretStore } from "../src/storage/native-secret-store.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";
import type { DiscoveredJob } from "../src/types.js";

const enabled = process.env.OPENAPPLY_LIVE_HANDOFF_EMAIL === "send-once";

it.runIf(enabled)("sends one queue-created alert to the explicitly approved recipient", async () => {
  const configPath = process.env.OPENAPPLY_NOTIFICATION_CONFIG;
  const recipientHash = process.env.OPENAPPLY_LIVE_HANDOFF_RECIPIENT_SHA256;
  if (!configPath || !/^[a-f0-9]{64}$/.test(recipientHash ?? "")) {
    throw new Error("Set a private notification config and the approved recipient SHA-256");
  }
  const config = await loadHandoffNotificationConfig(configPath);
  if (!config.email || createHash("sha256").update(config.email.to.toLowerCase()).digest("hex") !== recipientHash) {
    throw new Error("Staging recipient does not match the approved recipient hash");
  }
  const secrets = createNativeSecretStore();
  await assertAutonomousNotificationReady(false, config, secrets);

  const root = await mkdtemp(join(tmpdir(), "openapply-live-handoff-"));
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const statePath = join(root, "applications.enc.json");
    const stateKey = randomBytes(32);
    const workflow = new ApplicationWorkflow(
      new EncryptedApplicationStateStore<ApplicationCheckpoint>(statePath, stateKey));
    const id = `staging:${randomUUID()}`;
    const job = { id, applicationUrl: "https://staging.invalid/apply" } as DiscoveredJob;
    let requests = 0;
    const email = async (...args: Parameters<typeof sendHandoffEmail>) => {
      await sendHandoffEmail(args[0], args[1], args[2], async (...fetchArgs) => {
        requests += 1;
        return fetch(...fetchArgs);
      });
    };
    const outcomes = await runApplicationQueue([job],
      new DailyQuota(new MemoryApplicationStateStore()),
      new RetryLedger(new MemoryApplicationStateStore()),
      () => new Date().toISOString().slice(0, 10), 1, async () => {
        await workflow.create(id, job.applicationUrl);
        for (const stage of ["validated", "matched", "tailored"] as const) {
          await workflow.advance(id, stage);
        }
        await workflow.advance(id, "rendered", { artifactPath: "/synthetic/no-file.pdf",
          artifactSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) });
        await workflow.advance(id, "applying");
        const checkpoint = await workflow.advance(id, "waiting-human", {
          blocker: "Synthetic staging handoff; no employer site was opened",
        });
        await notifyPendingHandoff(workflow, checkpoint, secrets, config,
          { desktopEnabled: false, email });
        return "waiting-human";
      });
    expect(outcomes).toEqual([{ jobId: id, status: "waiting-human" }]);
    const sent = await workflow.current(id);
    expect(sent?.emailNotifiedFor).toBeTruthy();
    expect(requests).toBe(1);
    const restarted = new ApplicationWorkflow(
      new EncryptedApplicationStateStore<ApplicationCheckpoint>(statePath, stateKey));
    await notifyPendingHandoff(restarted, (await restarted.current(id))!, secrets, config,
      { desktopEnabled: false, email });
    expect(requests).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
