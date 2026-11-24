import { describe, expect, it, vi } from "vitest";
import { authenticationPolicySchema } from "../src/auth/schema.js";
import { connectMailboxOAuth, createOAuthAuthorizationRequest } from "../src/auth/oauth-connect.js";

const policy = authenticationPolicySchema.parse({ version: 1,
  browserProfile: { strategy: "dedicated-profile", sourceBrowser: "none",
    importCookies: false, importPasswords: false, persistSessions: true, requireInteractiveConsent: true },
  accounts: [{ id: "mailbox", email: "candidate@example.com", domains: ["jobs.example.com"],
    passwordSecretRef: "keychain://portal", allowAccountCreation: false }],
  emailVerification: { enabled: true, provider: "gmail", accountId: "mailbox",
    oauthClientId: "client-12345.apps.googleusercontent.com", oauthSecretRef: "keychain://gmail-oauth",
    allowedSenderDomains: ["mail.example.com"], maximumMessageAgeSeconds: 300, autoEnter: true },
});
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("local mailbox consent", () => {
  it("uses PKCE, a random state, and a fixed Google authorization host", () => {
    const one = createOAuthAuthorizationRequest(policy, "http://127.0.0.1:43210/callback");
    const two = createOAuthAuthorizationRequest(policy, "http://127.0.0.1:43210/callback");
    const url = new URL(one.url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(one.state);
    expect(one.state).not.toBe(two.state);
    expect(one.verifier).not.toBe(two.verifier);
    expect(() => createOAuthAuthorizationRequest(policy, "http://localhost:43210/callback"))
      .toThrow("local callback");
  });

  it("rejects a wrong state and stores the token only after a valid callback", async () => {
    const put = vi.fn(async (_reference: string, _value: string) => {});
    const secrets = { get: async () => undefined, put, delete: async () => {} };
    const fetcher = vi.fn(async (input: URL | RequestInfo) =>
      new URL(String(input)).hostname === "oauth2.googleapis.com"
        ? json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
          token_type: "Bearer", scope: "https://www.googleapis.com/auth/gmail.readonly" })
        : json({ emailAddress: "candidate@example.com" })) as unknown as typeof fetch;
    await connectMailboxOAuth(policy, secrets, async (authorizationUrl) => {
      const auth = new URL(authorizationUrl);
      const callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", "wrong-state");
      callback.searchParams.set("code", "authorization-code");
      expect((await fetch(callback)).status).toBe(400);
      expect(put).not.toHaveBeenCalled();
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      expect((await fetch(callback)).status).toBe(200);
    }, fetcher, 1000);
    expect(put).toHaveBeenCalledOnce();
    expect(JSON.parse(put.mock.calls[0]![1])).toMatchObject({ refreshToken: "new-refresh" });
  });

  it("bounds a hung browser opener and closes the callback listener", async () => {
    const secrets = { get: async () => undefined, put: async () => {}, delete: async () => {} };
    await expect(connectMailboxOAuth(policy, secrets,
      async () => new Promise<void>(() => {}), fetch, 1000)).rejects.toThrow("timed out");
  });
});
