import { describe, expect, it } from "vitest";
import {
  accountForUrl,
  authenticationPolicySchema,
} from "../src/auth/schema.js";

const validPolicy = {
  version: 1,
  browserProfile: {
    strategy: "import-once",
    sourceBrowser: "chrome",
    importCookies: true,
    importPasswords: true,
    persistSessions: true,
    requireInteractiveConsent: true,
  },
  accounts: [{
    id: "jobs",
    email: "candidate@example.com",
    domains: ["*.myworkdayjobs.com", "greenhouse.io"],
    passwordSecretRef: "keychain://openapply/jobs",
    allowAccountCreation: true,
  }],
  emailVerification: {
    enabled: true,
    provider: "gmail",
    accountId: "jobs",
    oauthSecretRef: "keychain://openapply/gmail-oauth",
    allowedSenderDomains: ["example.com"],
    maximumMessageAgeSeconds: 300,
    autoEnter: true,
  },
} as const;

describe("authentication policy", () => {
  it("maps subdomains to the configured account", () => {
    const policy = authenticationPolicySchema.parse(validPolicy);
    expect(accountForUrl(policy, "https://example.wd5.myworkdayjobs.com/job"))
      .toMatchObject({ id: "jobs", email: "candidate@example.com" });
  });

  it("rejects plaintext passwords", () => {
    const result = authenticationPolicySchema.safeParse({
      ...validPolicy,
      accounts: [{ ...validPolicy.accounts[0], passwordSecretRef: "hunter2" }],
    });
    expect(result.success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      accounts: [{ ...validPolicy.accounts[0], password: "plaintext" }],
    }).success).toBe(false);
  });

  it("requires OAuth details before enabling email-code automation", () => {
    const result = authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { enabled: true, autoEnter: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unapproved senders and unknown mailbox accounts", () => {
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { ...validPolicy.emailVerification, allowedSenderDomains: [] },
    }).success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { ...validPolicy.emailVerification, accountId: "other" },
    }).success).toBe(false);
  });

  it("rejects invalid domains and insecure account destinations", () => {
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      accounts: [{ ...validPolicy.accounts[0], domains: ["example.com/path"] }],
    }).success).toBe(false);
    const policy = authenticationPolicySchema.parse(validPolicy);
    expect(accountForUrl(policy, "https://fakegreenhouse.io/job")).toBeUndefined();
    expect(accountForUrl(policy, "http://greenhouse.io/job")).toBeUndefined();
    expect(accountForUrl(policy, "https://jobs.greenhouse.io/job")).toBeUndefined();
  });
});
