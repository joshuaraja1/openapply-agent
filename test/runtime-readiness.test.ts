import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectRuntimeReadiness, runSetupBrowserDoctor } from "../src/setup/runtime-readiness.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe("first-run runtime readiness", () => {
  it("checks private queue settings without returning account, URL, or secret values", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-runtime-ready-"));
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(root);
      const configPath = join(root, "queue.json");
      const preferencesPath = join(root, "search-preferences.json");
      const notificationPath = join(root, "notification.json");
      const authPath = join(root, "auth.json");
      const save = async (path: string, data: unknown) => {
        await writeFile(path, JSON.stringify(data), { mode: 0o600 });
        if (process.platform === "win32") await secureWindowsPrivatePath(path);
      };
      expect(await inspectRuntimeReadiness(undefined, root)).toMatchObject({
        queueConfig: "missing", browser: "missing", dailyLimit: null,
      });
      await save(configPath, { version: 1, queuePath: join(root, "queue.jsonl"),
        candidatePath: join(root, "candidate-profile.json"), preferencesPath,
        discoveryInputPath: join(root, "sources.json"), discoveryStatePath: join(root, "discovery.json"),
        browserRuntime: "owned", overleafProjectUrl: "https://www.overleaf.com/project/0123456789abcdef01234567",
        notificationConfigPath: notificationPath, authenticationPolicyPath: authPath,
        outputDirectory: join(root, "artifacts") });
      expect(await inspectRuntimeReadiness(configPath, root)).toMatchObject({
        queueConfig: "ready", preferences: "missing", profilePaths: "ready",
        browser: "owned-configured", overleaf: "ready", notification: "missing", mailbox: "invalid",
      });
      await save(preferencesPath, { version: 1, targetRoles: ["Software Engineer"],
        workArrangements: { preferred: ["Remote"], accepted: ["Hybrid"] },
        compensation: { preferredBaseFloor: 90000 },
        applicationPolicy: { dailyTarget: 10, dailyHardCap: 4, requireFinalApproval: false } });
      await save(notificationPath, { version: 1, email: { provider: "resend",
        from: "alerts@example.com", to: "candidate@example.com",
        apiKeySecretRef: "keychain://openapply/notification" } });
      await save(authPath, { version: 1, browserProfile: { strategy: "dedicated-profile",
        sourceBrowser: "none", importPasswords: false, requireInteractiveConsent: true },
        accounts: [{ id: "job-account", email: "candidate@example.com", domains: ["example.com"],
          passwordSecretRef: "keychain://openapply/job-account" }],
        emailVerification: { enabled: true, provider: "gmail", accountId: "job-account",
          oauthClientId: "desktop-client-id-123", oauthSecretRef: "keychain://openapply/oauth" } });
      const ready = await inspectRuntimeReadiness(configPath, root);
      expect(ready).toEqual({ queueConfig: "ready", preferences: "ready", profilePaths: "ready",
        dailyLimit: 4, browser: "owned-configured", overleaf: "ready",
        notification: "ready", mailbox: "client-configured" });
      expect(JSON.stringify(ready)).not.toMatch(/candidate@example|desktop-client|keychain|overleaf.com/);
      const doctor = vi.fn(async () => ({ status: "ready" as const, startupMs: 1, browserVersion: "test" }));
      expect(await runSetupBrowserDoctor(configPath, doctor, join(root, "browser-profile"))).toBe("ready");
      expect(doctor).toHaveBeenCalledOnce();
      expect(doctor).toHaveBeenCalledWith(join(root, "browser-profile"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a remote BrowserOS endpoint and never launches an owned browser for it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-runtime-browseros-"));
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(root);
      const configPath = join(root, "queue.json");
      await writeFile(configPath, JSON.stringify({ version: 1, queuePath: join(root, "queue.jsonl"),
        candidatePath: join(root, "candidate-profile.json"),
        preferencesPath: join(root, "search-preferences.json"),
        discoveryInputPath: join(root, "sources.json"), discoveryStatePath: join(root, "discovery.json"),
        browserRuntime: "browseros", browserEndpoint: "https://remote.example/mcp",
        overleafProjectUrl: "https://example.com/other-project", outputDirectory: join(root, "artifacts") }),
      { mode: 0o600 });
      if (process.platform === "win32") await secureWindowsPrivatePath(configPath);
      const result = await inspectRuntimeReadiness(configPath, root);
      expect(result).toMatchObject({ queueConfig: "ready", browser: "invalid", overleaf: "invalid" });
      const doctor = vi.fn(async () => ({ status: "ready" as const, startupMs: 1, browserVersion: "test" }));
      await expect(runSetupBrowserDoctor(configPath, doctor)).rejects.toThrow("local HTTP");
      expect(doctor).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
