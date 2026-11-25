import { describe, expect, it, vi } from "vitest";
import type { BrowserRuntime } from "../src/browser/runtime.js";
import { authenticationPolicySchema } from "../src/auth/schema.js";
import { assertMailboxConsentUrl, openOwnedMailboxConsent } from "../src/auth/owned-consent.js";

const policy = authenticationPolicySchema.parse({ version: 1,
  browserProfile: { strategy: "dedicated-profile", sourceBrowser: "none",
    importCookies: false, importPasswords: false, persistSessions: true, requireInteractiveConsent: true },
  accounts: [{ id: "mailbox", email: "candidate@example.com", domains: ["jobs.example.com"],
    passwordSecretRef: "keychain://portal", allowAccountCreation: false }],
  emailVerification: { enabled: true, provider: "gmail", accountId: "mailbox",
    oauthClientId: "client-12345.apps.googleusercontent.com", oauthSecretRef: "keychain://gmail-oauth",
    allowedSenderDomains: ["mail.example.com"], maximumMessageAgeSeconds: 300, autoEnter: true },
});

describe("owned mailbox consent", () => {
  it("accepts only the configured provider origin", () => {
    expect(() => assertMailboxConsentUrl("https://accounts.google.com/o/oauth2/v2/auth", policy))
      .not.toThrow();
    for (const url of ["http://accounts.google.com/o/oauth2/v2/auth",
      "https://accounts.google.com.evil.test/", "https://login.microsoftonline.com/",
      "https://user@accounts.google.com/"]) {
      expect(() => assertMailboxConsentUrl(url, policy)).toThrow("unexpected origin");
    }
  });

  it("opens consent in the private persistent profile and closes on navigation failure", async () => {
    const goto = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const runtime = { context: { newPage: async () => ({ goto }) }, close } as unknown as BrowserRuntime;
    const launch = vi.fn(async () => runtime);
    await openOwnedMailboxConsent("https://accounts.google.com/o/oauth2/v2/auth", policy,
      launch as never);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false,
      profileDirectory: expect.stringContaining("browser-profile") }));
    expect(goto).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth",
      { waitUntil: "domcontentloaded", timeout: 15_000 });
    expect(close).not.toHaveBeenCalled();
    goto.mockRejectedValueOnce(new Error("navigation failed"));
    await expect(openOwnedMailboxConsent("https://accounts.google.com/o/oauth2/v2/auth", policy,
      launch as never)).rejects.toThrow("navigation failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
