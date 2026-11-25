import { z } from "zod";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const secretReferenceSchema = z.string().regex(
  /^(keychain|credential-manager|secret-service):\/\/[A-Za-z0-9._/@:-]+$/,
  "Use an operating-system secret reference; never put a password in configuration",
);
const userSecretReferenceSchema = secretReferenceSchema.refine(
  (reference) => !/^(?:keychain|credential-manager|secret-service):\/\/application-state\//.test(reference),
  "Application-state encryption keys cannot be used as account credentials",
);

const domainSchema = z.string().regex(
  /^(?:\*\.)?(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i,
  "Use a DNS domain such as example.com or *.example.com",
);

export const siteAccountSchema = z.strictObject({
  id: z.string().min(1),
  email: z.string().email(),
  username: z.string().min(1).optional(),
  domains: z.array(domainSchema).min(1),
  passwordSecretRef: userSecretReferenceSchema,
  allowAccountCreation: z.boolean().default(false),
});

export const authenticationPolicySchema = z.strictObject({
  version: z.literal(1),
  browserProfile: z.strictObject({
    strategy: z.enum(["import-once", "dedicated-profile"]),
    sourceBrowser: z.enum(["chrome", "edge", "brave", "firefox", "safari", "none"]),
    sourceProfile: z.string().min(1).optional(),
    importCookies: z.boolean().default(true),
    // Browser-vault imports are disabled until an explicit OS-store migration exists.
    importPasswords: z.literal(false).default(false),
    persistSessions: z.boolean().default(true),
    requireInteractiveConsent: z.literal(true),
  }),
  accounts: z.array(siteAccountSchema).min(1),
  emailVerification: z.strictObject({
    enabled: z.boolean().default(false),
    provider: z.enum(["gmail", "microsoft"]).optional(),
    accountId: z.string().min(1).optional(),
    oauthClientId: z.string().regex(/^[A-Za-z0-9._-]{10,200}$/).optional(),
    microsoftTenant: z.string().regex(/^(?:common|organizations|consumers|[a-f0-9-]{36})$/i).optional(),
    oauthSecretRef: userSecretReferenceSchema.optional(),
    allowedSenderDomains: z.array(domainSchema).default([]),
    maximumMessageAgeSeconds: z.number().int().min(30).max(900).default(300),
    autoEnter: z.boolean().default(false),
  }).superRefine((value, context) => {
    if (value.autoEnter && !value.enabled) {
      context.addIssue({
        code: "custom",
        path: ["autoEnter"],
        message: "Enable email verification before automatic code entry",
      });
    }
    if (!value.enabled) return;
    for (const field of ["provider", "accountId", "oauthClientId", "oauthSecretRef"] as const) {
      if (!value[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when email verification is enabled`,
        });
      }
    }
    if (value.autoEnter && value.allowedSenderDomains.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["allowedSenderDomains"],
        message: "Automatic entry requires at least one approved sender domain",
      });
    }
  }),
}).superRefine((policy, context) => {
  const accountIds = policy.accounts.map((account) => account.id);
  if (new Set(accountIds).size !== accountIds.length) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "Account IDs must be unique" });
  }
  const passwordReferences = policy.accounts.map((account) => account.passwordSecretRef);
  if (new Set(passwordReferences).size !== passwordReferences.length) {
    context.addIssue({ code: "custom", path: ["accounts"],
      message: "Each site account needs its own password secret reference" });
  }
  if (policy.emailVerification.oauthSecretRef
    && passwordReferences.includes(policy.emailVerification.oauthSecretRef)) {
    context.addIssue({ code: "custom", path: ["emailVerification", "oauthSecretRef"],
      message: "Mailbox OAuth tokens need a separate secret reference" });
  }
  const domains = policy.accounts.flatMap((account) => account.domains.map((domain) => domain.toLowerCase()));
  if (new Set(domains).size !== domains.length) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "A domain may belong to only one account" });
  }
  if (policy.emailVerification.enabled && !accountIds.includes(policy.emailVerification.accountId ?? "")) {
    context.addIssue({ code: "custom", path: ["emailVerification", "accountId"], message: "Select a configured account" });
  }
});

export type AuthenticationPolicy = z.infer<typeof authenticationPolicySchema>;
export type SiteAccount = z.infer<typeof siteAccountSchema>;

export async function loadAuthenticationPolicy(path: string): Promise<AuthenticationPolicy> {
  if (process.platform === "win32" || !isAbsolute(path)) {
    throw new Error("Authentication policy requires an absolute private file path");
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
    || (info.mode & 0o077) !== 0) {
    throw new Error("Authentication policy must be a private regular file");
  }
  return authenticationPolicySchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function accountForUrl(
  policy: AuthenticationPolicy,
  url: string,
): SiteAccount | undefined {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return undefined;
  const hostname = parsed.hostname.toLowerCase();
  const matches = policy.accounts.flatMap((account) => account.domains
    .filter((configuredDomain) => {
      const domain = configuredDomain.toLowerCase().replace(/^\*\./, "");
      return configuredDomain.startsWith("*.")
        ? hostname.endsWith(`.${domain}`)
        : hostname === domain;
    })
    .map((domain) => ({ account, specificity: domain.length })));
  matches.sort((a, b) => b.specificity - a.specificity);
  if (matches[0] && matches[1] && matches[0].specificity === matches[1].specificity) return undefined;
  return matches[0]?.account;
}
