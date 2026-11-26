import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SecretStore } from "../src/storage/contracts.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import { handoffNotificationSchema, loadHandoffNotificationConfig,
  notifyPendingHandoff, sendHandoffEmail } from "../src/application/notification.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "../src/application/state-machine.js";

const config = handoffNotificationSchema.parse({ version: 1, email: {
  provider: "resend", from: "alerts@example.org", to: "user@example.net",
  apiKeySecretRef: "keychain://openapply/notification-resend",
} });
const checkpoint: ApplicationCheckpoint = { jobId: "private-job-123",
  officialUrl: "https://example.com/jobs/private", stage: "waiting-human",
  blocker: "Private legal question", updatedAt: "2026-11-25T18:00:00.000Z" };
function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return { get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); } };
}

describe("human handoff email", () => {
  it("replays unsent alerts once per durable handoff, including a second pause in the same millisecond", async () => {
    const store = new MemoryApplicationStateStore<ApplicationCheckpoint>();
    const workflow = new ApplicationWorkflow(store);
    const first = { ...checkpoint, handoffId: "af77eec9-8ab1-4f01-97f0-e30f69f297ab",
      artifactPath: "/private/resume.pdf", artifactSha256: "a".repeat(64),
      sourceFingerprint: "b".repeat(64) };
    await store.compareAndSwap(first.jobId, undefined, first);
    const desktop = vi.fn(async () => {});
    const email = vi.fn(async () => {});
    const options = { desktopEnabled: true, desktop, email };
    const secrets = memorySecrets();
    await notifyPendingHandoff(workflow, first, secrets, config, options);
    expect(await workflow.current(first.jobId)).toMatchObject({
      desktopNotifiedFor: first.handoffId, emailNotifiedFor: first.handoffId });
    await notifyPendingHandoff(workflow, (await workflow.current(first.jobId))!, secrets, config, options);
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
    await workflow.advance(first.jobId, "applying");
    const second = await workflow.advance(first.jobId, "waiting-human", { blocker: "New question" });
    expect(second.handoffId).not.toBe(first.handoffId);
    await expect(workflow.markNotification(first.jobId, "email", first.handoffId)).rejects.toThrow("different");
    await notifyPendingHandoff(workflow, second, secrets, config, options);
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(email).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed alert pending for the next run", async () => {
    const store = new MemoryApplicationStateStore<ApplicationCheckpoint>();
    const workflow = new ApplicationWorkflow(store);
    await store.compareAndSwap(checkpoint.jobId, undefined, checkpoint);
    const secrets = memorySecrets();
    const email = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await notifyPendingHandoff(workflow, checkpoint, secrets, config,
        { desktopEnabled: false, email });
      expect((await workflow.current(checkpoint.jobId))?.emailNotifiedFor).toBeUndefined();
      await notifyPendingHandoff(workflow, checkpoint, secrets, config,
        { desktopEnabled: false, email });
      expect((await workflow.current(checkpoint.jobId))?.emailNotifiedFor).toBe(checkpoint.updatedAt);
      expect(email).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
  });
  it("sends only generic content with a stable retry key", async () => {
    const secrets = memorySecrets();
    await secrets.put(config.email!.apiKeySecretRef, "test-secret");
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    await sendHandoffEmail(config, checkpoint, secrets, fetcher as typeof fetch);
    await sendHandoffEmail(config, checkpoint, secrets, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const request = options as RequestInit;
    expect(request.redirect).toBe("error");
    expect((request.headers as Record<string, string>).Authorization).toBe("Bearer test-secret");
    expect((request.headers as Record<string, string>)["Idempotency-Key"])
      .toBe(((fetcher.mock.calls[1]![1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    const body = JSON.stringify(JSON.parse(String(request.body)));
    expect(body).toContain("user@example.net");
    for (const privateValue of [checkpoint.jobId, checkpoint.officialUrl, checkpoint.blocker!]) {
      expect(body).not.toContain(privateValue);
    }
  });

  it("does not send outside a human handoff and reports missing credentials", async () => {
    const fetcher = vi.fn();
    const secrets = memorySecrets();
    await sendHandoffEmail(config, { ...checkpoint, stage: "submitted" }, secrets,
      fetcher as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(sendHandoffEmail(config, checkpoint, secrets, fetcher as typeof fetch))
      .rejects.toThrow("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports provider failure without logging the secret or private application", async () => {
    const secrets = memorySecrets();
    await secrets.put(config.email!.apiKeySecretRef, "test-secret");
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response("provider internals", { status: 429 }));
    await expect(sendHandoffEmail(config, checkpoint, secrets, fetcher as typeof fetch))
      .rejects.toThrow("HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires a private config and rejects embedded keys or broader permission refs", async () => {
    expect(() => handoffNotificationSchema.parse({ ...config, email: {
      ...config.email, apiKey: "plaintext" } })).toThrow();
    expect(() => handoffNotificationSchema.parse({ ...config, email: {
      ...config.email, apiKeySecretRef: "keychain://application-state/key" } })).toThrow();
    const root = await mkdtemp(join(tmpdir(), "openapply-notification-"));
    try {
      const path = join(root, "notification.json");
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      expect(await loadHandoffNotificationConfig(path)).toEqual(config);
      await expect(loadHandoffNotificationConfig("notification.json")).rejects.toThrow("absolute");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
