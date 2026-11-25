import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountForUrl,
  authenticationPolicySchema,
  loadAuthenticationPolicy,
} from "../src/auth/schema.js";

const validPolicy = {
  version: 1,
  browserProfile: {
    strategy: "import-once",
    sourceBrowser: "chrome",
    importCookies: true,
    importPasswords: false,
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
    oauthClientId: "test-client.apps.googleusercontent.com",
    oauthSecretRef: "keychain://openapply/gmail-oauth",
    allowedSenderDomains: ["example.com"],
    maximumMessageAgeSeconds: 300,
    autoEnter: true,
  },
} as const;

describe("authentication policy", () => {
  it("defaults password import off and rejects an unsupported browser-vault import", () => {
    const profile = { ...validPolicy.browserProfile };
    const { importPasswords: _unused, ...withoutPasswordImport } = profile;
    expect(authenticationPolicySchema.parse({ ...validPolicy,
      browserProfile: withoutPasswordImport }).browserProfile.importPasswords).toBe(false);
    expect(authenticationPolicySchema.safeParse({ ...validPolicy,
      browserProfile: { ...profile, importPasswords: true } }).success).toBe(false);
  });
  it("loads only a private user-owned policy file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-auth-"));
    try {
      const path = join(root, "policy.json");
      await writeFile(path, JSON.stringify(validPolicy), { mode: 0o600 });
      expect((await loadAuthenticationPolicy(path)).accounts[0]?.id).toBe("jobs");
      await chmod(path, 0o644);
      await expect(loadAuthenticationPolicy(path)).rejects.toThrow("unsafe permissions");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("fails closed for an old password-import policy until its private file is updated", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-auth-migration-"));
    try {
      const path = join(root, "policy.json");
      await writeFile(path, JSON.stringify({ ...validPolicy,
        browserProfile: { ...validPolicy.browserProfile, importPasswords: true } }), { mode: 0o600 });
      await expect(loadAuthenticationPolicy(path)).rejects.toThrow();
      await writeFile(path, JSON.stringify(validPolicy), { mode: 0o600 });
      expect((await loadAuthenticationPolicy(path)).browserProfile.importPasswords).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      accounts: [{ ...validPolicy.accounts[0], passwordSecretRef: "keychain://application-state/main" }],
    }).success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { ...validPolicy.emailVerification,
        oauthSecretRef: "keychain://application-state/main" },
    }).success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      accounts: [{ ...validPolicy.accounts[0], passwordSecretRef: "secret-service://application-state/main" }],
    }).success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { ...validPolicy.emailVerification,
        oauthSecretRef: "secret-service://application-state/main" },
    }).success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      accounts: [{ ...validPolicy.accounts[0],
        passwordSecretRef: "credential-manager://application-state/main" }],
    }).success).toBe(false);
  });

  it("requires OAuth details before enabling email-code automation", () => {
    const result = authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { enabled: true, autoEnter: true },
    });
    expect(result.success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { enabled: false, autoEnter: true },
    }).success).toBe(false);
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      emailVerification: { ...validPolicy.emailVerification,
        oauthSecretRef: validPolicy.accounts[0].passwordSecretRef },
    }).success).toBe(false);
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

  it("selects the most specific account and rejects duplicate domain mappings", () => {
    const policy = authenticationPolicySchema.parse({
      ...validPolicy,
      accounts: [
        validPolicy.accounts[0],
        { id: "tenant", email: "tenant@example.com", domains: ["salesforce.wd12.myworkdayjobs.com"], passwordSecretRef: "keychain://openapply/tenant" },
      ],
    });
    expect(accountForUrl(policy, "https://salesforce.wd12.myworkdayjobs.com/job")?.id).toBe("tenant");
    expect(authenticationPolicySchema.safeParse({
      ...validPolicy,
      accounts: [validPolicy.accounts[0], { ...validPolicy.accounts[0], id: "duplicate" }],
    }).success).toBe(false);
    expect(authenticationPolicySchema.safeParse({ ...validPolicy,
      accounts: [validPolicy.accounts[0], { ...validPolicy.accounts[0],
        id: "other", domains: ["other.example.com"] }],
    }).success).toBe(false);
  });
});
