import { describe, expect, it, vi } from "vitest";
import { authenticationPolicySchema } from "../src/auth/schema.js";
import { inspectMailboxConsent } from "../src/auth/oauth-doctor.js";

const now = Date.parse("2026-11-24T16:01:00Z");
const policy = authenticationPolicySchema.parse({ version: 1,
  browserProfile: { strategy: "dedicated-profile", sourceBrowser: "none",
    importPasswords: false, requireInteractiveConsent: true },
  accounts: [{ id: "mailbox", email: "candidate@example.com", domains: ["jobs.example.com"],
    passwordSecretRef: "keychain://portal" }],
  emailVerification: { enabled: true, provider: "gmail", accountId: "mailbox",
    oauthClientId: "client-12345.apps.googleusercontent.com", oauthSecretRef: "keychain://oauth",
    autoEnter: false },
});
const token = { version: 1, provider: "gmail", accountEmail: "candidate@example.com",
  clientId: "client-12345.apps.googleusercontent.com", refreshToken: "private-refresh",
  accessToken: "private-access", expiresAt: "2026-11-24T17:00:00Z",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"] };

describe("explicit mailbox consent doctor", () => {
  it("distinguishes disabled and missing consent without contacting providers", async () => {
    const get = vi.fn(async () => undefined);
    const fetcher = vi.fn() as unknown as typeof fetch;
    const secrets = { get, put: async () => {}, delete: async () => {} };
    expect(await inspectMailboxConsent({ ...policy,
      emailVerification: { ...policy.emailVerification, enabled: false } }, secrets, fetcher, now))
      .toBe("disabled");
    expect(get).not.toHaveBeenCalled();
    expect(await inspectMailboxConsent(policy, secrets, fetcher, now)).toBe("consent-required");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies a saved grant with the exact mailbox even when auto-entry is off", async () => {
    const secrets = { get: async () => JSON.stringify(token), put: async () => {}, delete: async () => {} };
    const fetcher = vi.fn(async (_input: URL | RequestInfo) => new Response(
      JSON.stringify({ emailAddress: "candidate@example.com" })));
    expect(await inspectMailboxConsent(policy, secrets, fetcher as unknown as typeof fetch, now)).toBe("verified");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  });

  it("fails closed for another account, revoked grant, or broad scope without leaking details", async () => {
    const bad = [{ ...token, accountEmail: "other@example.com" },
      { ...token, scopes: ["https://mail.google.com/"] }, token];
    for (const saved of bad) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }),
        { status: 401 })) as unknown as typeof fetch;
      const secrets = { get: async () => JSON.stringify(saved), put: async () => {}, delete: async () => {} };
      expect(await inspectMailboxConsent(policy, secrets, fetcher, now)).toBe("verification-failed");
      expect(JSON.stringify(await inspectMailboxConsent(policy, secrets, fetcher, now)))
        .not.toMatch(/private-refresh|candidate@example.com|invalid_grant/);
    }
  });
});
