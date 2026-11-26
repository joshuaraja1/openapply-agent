import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SecretStore } from "../src/storage/contracts.js";
import { handoffNotificationSchema, loadHandoffNotificationConfig,
  sendHandoffEmail } from "../src/application/notification.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";

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
