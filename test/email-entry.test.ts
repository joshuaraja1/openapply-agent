import { describe, expect, it, vi } from "vitest";
import { EmailCodeEntry } from "../src/auth/email-entry.js";
import { authenticationPolicySchema } from "../src/auth/schema.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";

const policy = authenticationPolicySchema.parse({ version: 1,
  browserProfile: { strategy: "dedicated-profile", sourceBrowser: "none",
    importCookies: false, importPasswords: false, persistSessions: true, requireInteractiveConsent: true },
  accounts: [{ id: "mailbox", email: "candidate@example.com", domains: ["jobs.example.com"],
    passwordSecretRef: "keychain://portal", allowAccountCreation: false }],
  emailVerification: { enabled: true, provider: "gmail", accountId: "mailbox",
    oauthClientId: "client-12345.apps.googleusercontent.com", oauthSecretRef: "keychain://gmail-oauth",
    allowedSenderDomains: ["mail.example.com"], maximumMessageAgeSeconds: 300, autoEnter: true },
});
const json = (value: unknown) => new Response(JSON.stringify(value));

describe("one-use email code entry", () => {
  it("binds the mailbox and application, then claims the message before returning its code", async () => {
    const now = Date.now();
    const token = { version: 1, provider: "gmail", accountEmail: "candidate@example.com",
      clientId: policy.emailVerification.oauthClientId, refreshToken: "refresh-private",
      accessToken: "access-private", expiresAt: new Date(now + 60_000_000).toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"] };
    const secrets = { get: async () => JSON.stringify(token), put: async () => {}, delete: async () => {} };
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return json({ emailAddress: "candidate@example.com" });
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "message-1" }] });
      return json({ id: "message-1", internalDate: String(now), payload: {
        headers: [{ name: "from", value: "Example <noreply@mail.example.com>" },
          { name: "to", value: "candidate@example.com" },
          { name: "subject", value: "Example Co verification code" }],
        mimeType: "text/plain", body: { data: Buffer.from("Example Co verification code 123456")
          .toString("base64url") },
      } });
    }) as unknown as typeof fetch;
    const ledger = new MemoryApplicationStateStore<{ entries: Array<{ id: string; at: string }>;
      challenges: Array<{ jobId: string; accountEmail: string; company: string; at: string }> }>();
    const entry = new EmailCodeEntry(policy, secrets, ledger, fetcher, 0);
    const request = { jobId: "job-1",
      accountEmail: "candidate@example.com", company: "Example Co",
      portalHost: "jobs.example.com", requestedAt: new Date(now - 30_000).toISOString() };
    expect(await entry.resolve({ ...request, accountEmail: "other@example.com" })).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await entry.resolve(request)).toBe("123456");
    expect(await ledger.read("mailbox-message-claims")).toMatchObject({ state: {
      entries: [{ id: "message-1" }] } });
    expect(await entry.resolve(request)).toBeUndefined();
    const beforeOverlap = vi.mocked(fetcher).mock.calls.length;
    expect(await entry.resolve({ ...request, jobId: "job-2" })).toBeUndefined();
    expect(vi.mocked(fetcher).mock.calls.length).toBe(beforeOverlap);
    const olderChallenge = new MemoryApplicationStateStore<{ entries: Array<{ id: string; at: string }>;
      challenges: Array<{ jobId: string; accountEmail: string; company: string; at: string }> }>();
    await olderChallenge.compareAndSwap("mailbox-message-claims", undefined, { entries: [], challenges: [{
      jobId: "job-1", accountEmail: request.accountEmail, company: request.company.toLowerCase(),
      at: new Date(now - 65_000).toISOString(),
    }] });
    const blocked = new EmailCodeEntry(policy, secrets, olderChallenge, fetcher, 0);
    expect(await blocked.resolve({ ...request, jobId: "job-2" })).toBeUndefined();
    expect(vi.mocked(fetcher).mock.calls.length).toBe(beforeOverlap);
    const unrelated = new EmailCodeEntry(policy, secrets,
      new MemoryApplicationStateStore(), fetcher, 0);
    expect(await unrelated.resolve({ ...request, company: "Other Company" })).toBeUndefined();
  });

  it("polls briefly for a delayed message", async () => {
    const now = Date.now();
    const token = { version: 1, provider: "gmail", accountEmail: "candidate@example.com",
      clientId: policy.emailVerification.oauthClientId, refreshToken: "refresh-private",
      accessToken: "access-private", expiresAt: new Date(now + 60_000_000).toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"] };
    const secrets = { get: async () => JSON.stringify(token), put: async () => {}, delete: async () => {} };
    let listing = 0;
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return json({ emailAddress: "candidate@example.com" });
      if (url.pathname.endsWith("/messages")) return json({ messages: ++listing === 1 ? [] : [{ id: "later" }] });
      return json({ id: "later", internalDate: String(now), payload: {
        headers: [{ name: "from", value: "noreply@mail.example.com" },
          { name: "to", value: "candidate@example.com" },
          { name: "subject", value: "Example Co verification code" }],
        mimeType: "text/plain", body: { data: Buffer.from("verification code 654321").toString("base64url") },
      } });
    }) as unknown as typeof fetch;
    const entry = new EmailCodeEntry(policy, secrets, new MemoryApplicationStateStore(), fetcher, 100, 1);
    expect(await entry.resolve({ jobId: "job-3",
      accountEmail: "candidate@example.com", company: "Example Co",
      portalHost: "jobs.example.com", requestedAt: new Date(now - 10_000).toISOString() }))
      .toBe("654321");
    expect(listing).toBe(2);
  });
});
