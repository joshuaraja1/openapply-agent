import { z } from "zod";

const secretReferenceSchema = z.string().regex(
  /^(keychain|credential-manager|secret-service):\/\/[A-Za-z0-9._/@:-]+$/,
  "Use an operating-system secret reference; never put a password in configuration",
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
  passwordSecretRef: secretReferenceSchema,
  allowAccountCreation: z.boolean().default(false),
});

export const authenticationPolicySchema = z.strictObject({
  version: z.literal(1),
  browserProfile: z.strictObject({
    strategy: z.enum(["import-once", "dedicated-profile"]),
    sourceBrowser: z.enum(["chrome", "edge", "brave", "firefox", "safari", "none"]),
    sourceProfile: z.string().min(1).optional(),
    importCookies: z.boolean().default(true),
    importPasswords: z.boolean().default(true),
    persistSessions: z.boolean().default(true),
    requireInteractiveConsent: z.literal(true),
  }),
  accounts: z.array(siteAccountSchema).min(1),
  emailVerification: z.strictObject({
    enabled: z.boolean().default(false),
    provider: z.enum(["gmail", "microsoft"]).optional(),
    accountId: z.string().min(1).optional(),
    oauthSecretRef: secretReferenceSchema.optional(),
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
    for (const field of ["provider", "accountId", "oauthSecretRef"] as const) {
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
  if (policy.emailVerification.enabled && !accountIds.includes(policy.emailVerification.accountId ?? "")) {
    context.addIssue({ code: "custom", path: ["emailVerification", "accountId"], message: "Select a configured account" });
  }
});

export type AuthenticationPolicy = z.infer<typeof authenticationPolicySchema>;
export type SiteAccount = z.infer<typeof siteAccountSchema>;

export function accountForUrl(
  policy: AuthenticationPolicy,
  url: string,
): SiteAccount | undefined {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return undefined;
  const hostname = parsed.hostname.toLowerCase();
  return policy.accounts.find((account) => account.domains.some((configuredDomain) => {
    const domain = configuredDomain.toLowerCase().replace(/^\*\./, "");
    return configuredDomain.startsWith("*.")
      ? hostname.endsWith(`.${domain}`)
      : hostname === domain;
  }));
}
