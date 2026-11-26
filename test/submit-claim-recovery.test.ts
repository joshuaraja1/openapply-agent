import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { handoffNotificationSchema, notifyPendingHandoff } from "../src/application/notification.js";
import { recoverClaimedSubmission } from "../src/application/recover-submission.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "../src/application/state-machine.js";
import { MemoryApplicationStateStore, type SecretStore } from "../src/storage/contracts.js";
import { holdWorkflowLease } from "../src/storage/workflow-lease.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

it("recovers a claimed final click only under the workflow lease and alerts once", async () => {
  const root = await mkdtemp(join(tmpdir(), "openapply-submit-recovery-"));
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const store = new MemoryApplicationStateStore<ApplicationCheckpoint>();
    const workflow = new ApplicationWorkflow(store);
    const previousHandoff = "previous-human-handoff";
    const recipient = "candidate@example.invalid";
    const previousMarker = `${previousHandoff}:${createHash("sha256").update(recipient).digest("hex")}`;
    const saved: ApplicationCheckpoint = { jobId: "synthetic-job", officialUrl: "https://example.invalid/apply",
      stage: "submit-claimed", updatedAt: "2026-01-01T00:00:00.000Z",
      submissionClaimId: "8460d44b-5218-4c76-a389-5d3e5e4c144d",
      handoffId: previousHandoff, emailNotifiedFor: previousMarker,
      artifactPath: "/synthetic/resume.pdf", artifactSha256: "a".repeat(64),
      sourceFingerprint: "b".repeat(64), packagePath: "/synthetic/package.json" };
    await store.compareAndSwap(saved.jobId, undefined, saved);
    await expect(recoverClaimedSubmission(workflow, saved, root)).rejects.toThrow("exclusive workflow lease");
    await holdWorkflowLease(root);
    await expect(recoverClaimedSubmission(workflow, { ...saved, officialUrl: "https://other.invalid" }, root))
      .rejects.toThrow("saved job and URL");
    await expect(recoverClaimedSubmission(workflow, {
      ...saved, submissionClaimId: "ea86b36d-eb85-40e5-90ec-63e92bd26a28",
    }, root)).rejects.toThrow("claim identity changed");
    const recovered = await recoverClaimedSubmission(workflow, saved, root);
    expect(recovered).toMatchObject({ stage: "submission-uncertain", officialUrl: saved.officialUrl,
      packagePath: saved.packagePath, handoffId: previousHandoff });
    expect(recovered.blocker).toContain("inspect the employer portal");
    expect((await recoverClaimedSubmission(workflow, saved, root)).stage).toBe("submission-uncertain");
    const config = handoffNotificationSchema.parse({ version: 1, email: { provider: "resend",
      from: "alerts@example.invalid", to: recipient,
      apiKeySecretRef: "keychain://openapply/synthetic-alert" } });
    const secrets: SecretStore = { get: async () => "synthetic", put: async () => {}, delete: async () => {} };
    const email = vi.fn(async () => {});
    const options = { desktopEnabled: false, email };
    await notifyPendingHandoff(workflow, recovered, secrets, config, options);
    await notifyPendingHandoff(workflow, (await workflow.current(saved.jobId))!, secrets, config, options);
    expect(email).toHaveBeenCalledTimes(1);
    expect((await workflow.current(saved.jobId))?.emailNotifiedFor).not.toBe(previousMarker);
    const legacy: ApplicationCheckpoint = { jobId: "legacy-job", officialUrl: "https://example.invalid/apply",
      stage: "submit-claimed", updatedAt: "2026-01-01T00:00:00.000Z" };
    await store.compareAndSwap(legacy.jobId, undefined, legacy);
    await expect(recoverClaimedSubmission(workflow, {
      ...legacy, updatedAt: "2026-01-02T00:00:00.000Z",
    }, root)).rejects.toThrow("Legacy interrupted submission checkpoint changed");
    expect((await recoverClaimedSubmission(workflow, legacy, root)).stage).toBe("submission-uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
