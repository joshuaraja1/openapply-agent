import { describe, expect, it, vi } from "vitest";
import { authenticationPolicySchema } from "../src/auth/schema.js";
import { getMailboxAccessToken } from "../src/auth/oauth-token.js";

const now = Date.parse("2026-11-24T16:01:00Z");
const policy = authenticationPolicySchema.parse({ version: 1,
  browserProfile: { strategy: "dedicated-profile", sourceBrowser: "none",
    importCookies: false, importPasswords: false, persistSessions: true, requireInteractiveConsent: true },
  accounts: [{ id: "mailbox", email: "candidate@example.com", domains: ["jobs.example.com"],
    passwordSecretRef: "keychain://portal", allowAccountCreation: false }],
  emailVerification: { enabled: true, provider: "gmail", accountId: "mailbox",
    oauthClientId: "client-12345.apps.googleusercontent.com", oauthSecretRef: "keychain://gmail-oauth",
    allowedSenderDomains: ["mail.example.com"], maximumMessageAgeSeconds: 300, autoEnter: true },
});
const token = { version: 1, provider: "gmail", accountEmail: "candidate@example.com",
  clientId: "client-12345.apps.googleusercontent.com", refreshToken: "refresh-private",
  accessToken: "old-access", expiresAt: "2026-11-24T16:00:00Z",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"] };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("Keychain-backed mailbox OAuth token", () => {
  it("refreshes an expired Gmail token and verifies the exact mailbox account", async () => {
    const put = vi.fn(async (_reference: string, _value: string) => {});
    const secrets = { get: async () => JSON.stringify(token), put, delete: async () => {} };
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, options: RequestInit = {}) => {
      calls.push({ url: String(input), options });
      return new URL(String(input)).hostname === "oauth2.googleapis.com"
        ? json({ access_token: "new-access", expires_in: 3600, token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.readonly" })
        : json({ emailAddress: "candidate@example.com" });
    }) as unknown as typeof fetch;
    expect(await getMailboxAccessToken(policy, secrets, fetcher, now)).toBe("new-access");
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]?.options.redirect).toBe("error");
    expect((calls[0]?.options.body as URLSearchParams).get("refresh_token")).toBe("refresh-private");
    expect(calls[1]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(put).toHaveBeenCalledOnce();
    expect(JSON.parse(put.mock.calls[0]![1] as string)).toMatchObject({ accessToken: "new-access" });
  });

  it("rejects a token for the wrong mailbox before storing refresh output", async () => {
    const put = vi.fn(async (_reference: string, _value: string) => {});
    const secrets = { get: async () => JSON.stringify(token), put, delete: async () => {} };
    const fetcher = vi.fn(async (input: URL | RequestInfo) => new URL(String(input)).hostname === "oauth2.googleapis.com"
      ? json({ access_token: "new-access", expires_in: 3600, token_type: "Bearer" })
      : json({ emailAddress: "other@example.com" })) as unknown as typeof fetch;
    await expect(getMailboxAccessToken(policy, secrets, fetcher, now)).rejects.toThrow("identity");
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses missing readonly scope without contacting a mailbox", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const secrets = { get: async () => JSON.stringify({ ...token, scopes: ["https://mail.google.com/"] }),
      put: async () => {}, delete: async () => {} };
    await expect(getMailboxAccessToken(policy, secrets, fetcher, now)).rejects.toThrow("read-only scopes");
    expect(fetcher).not.toHaveBeenCalled();
    const broad = { get: async () => JSON.stringify({ ...token,
      scopes: [...token.scopes, "https://www.googleapis.com/auth/gmail.modify"] }),
      put: async () => {}, delete: async () => {} };
    await expect(getMailboxAccessToken(policy, broad, fetcher, now))
      .rejects.toThrow("outside the approved read-only scopes");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes a Microsoft public-client token against a fixed tenant endpoint", async () => {
    const microsoft = authenticationPolicySchema.parse({ ...policy,
      emailVerification: { ...policy.emailVerification, provider: "microsoft",
        oauthClientId: "12345678-1234-1234-1234-123456789abc", microsoftTenant: "consumers" } });
    const saved = { ...token, provider: "microsoft", clientId: "12345678-1234-1234-1234-123456789abc",
      scopes: ["Mail.Read", "User.Read", "offline_access"] };
    const put = vi.fn(async (_reference: string, _value: string) => {});
    const secrets = { get: async () => JSON.stringify(saved), put, delete: async () => {} };
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      calls.push(String(input));
      return new URL(String(input)).hostname === "login.microsoftonline.com"
        ? json({ access_token: "graph-access", expires_in: 3600, token_type: "Bearer",
          scope: "Mail.Read User.Read offline_access" })
        : json({ mail: "candidate@example.com", userPrincipalName: "candidate@example.com" });
    }) as unknown as typeof fetch;
    expect(await getMailboxAccessToken(microsoft, secrets, fetcher, now)).toBe("graph-access");
    expect(calls).toEqual([
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
      "https://graph.microsoft.com/v1.0/me?%24select=mail%2CuserPrincipalName",
    ]);
    expect(put).toHaveBeenCalledOnce();
  });
});
