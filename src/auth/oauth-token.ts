import { z } from "zod";
import type { SecretStore } from "../storage/contracts.js";
import type { AuthenticationPolicy } from "./schema.js";
import { fetchMailboxAccountEmail } from "./mailbox-clients.js";

const storedTokenSchema = z.strictObject({ version: z.literal(1),
  provider: z.enum(["gmail", "microsoft"]), accountEmail: z.email(),
  clientId: z.string().min(10), refreshToken: z.string().min(1),
  accessToken: z.string().min(1), expiresAt: z.string().datetime(),
  scopes: z.array(z.string().min(1)).min(1),
});
export type StoredMailboxToken = z.infer<typeof storedTokenSchema>;
const refreshedTokenSchema = z.object({ access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(),
  token_type: z.literal("Bearer"), scope: z.string().optional() });

function requiredScopes(provider: "gmail" | "microsoft"): string[] {
  return provider === "gmail" ? ["https://www.googleapis.com/auth/gmail.readonly"]
    : ["Mail.Read", "User.Read"];
}

export function mailboxConsentScopes(provider: "gmail" | "microsoft"): string[] {
  return provider === "gmail" ? requiredScopes(provider) : [...requiredScopes(provider), "offline_access"];
}

function tokenEndpoint(provider: "gmail" | "microsoft", tenant?: string): string {
  if (tenant && !/^(?:common|organizations|consumers|[a-f0-9-]{36})$/i.test(tenant)) {
    throw new Error("Microsoft tenant is invalid");
  }
  return provider === "gmail" ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${tenant ?? "common"}/oauth2/v2.0/token`;
}

function assertScopes(provider: "gmail" | "microsoft", scopes: string[]): void {
  const names = new Set(scopes.map((scope) => scope.toLowerCase()));
  if (!requiredScopes(provider).every((scope) => names.has(scope.toLowerCase()))) {
    throw new Error("Mailbox token lacks required read-only scopes");
  }
  const allowed = new Set(["openid", "email", "profile", "offline_access",
    ...requiredScopes(provider).map((scope) => scope.toLowerCase())]);
  if ([...names].some((scope) => !allowed.has(scope))) {
    throw new Error("Mailbox token includes permissions outside the approved read-only scopes");
  }
}

async function readTokenResponse(response: Response): Promise<string> {
  const limit = 100_000;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("Mailbox token response is too large");
  if (!response.body) throw new Error("Mailbox token response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Mailbox token response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function refreshToken(token: StoredMailboxToken, tenant: string | undefined,
  fetcher: typeof fetch, now: number): Promise<StoredMailboxToken> {
  const endpoint = tokenEndpoint(token.provider, tenant);
  const body = new URLSearchParams({ client_id: token.clientId,
    grant_type: "refresh_token", refresh_token: token.refreshToken });
  if (token.provider === "microsoft") body.set("scope", "Mail.Read User.Read offline_access");
  const response = await fetcher(endpoint, { method: "POST", body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Mailbox token refresh failed with HTTP ${response.status}`);
  const text = await readTokenResponse(response);
  const renewed = refreshedTokenSchema.parse(JSON.parse(text));
  const scopes = renewed.scope ? renewed.scope.split(/\s+/).filter(Boolean) : token.scopes;
  assertScopes(token.provider, scopes);
  return { ...token, refreshToken: renewed.refresh_token ?? token.refreshToken,
    accessToken: renewed.access_token, expiresAt: new Date(now + renewed.expires_in * 1000).toISOString(),
    scopes };
}

/** Exchanges a loopback PKCE authorization code and stores it only after mailbox identity verification. */
export async function exchangeMailboxAuthorizationCode(policy: AuthenticationPolicy,
  secrets: SecretStore, code: string, verifier: string, redirectUri: string,
  fetcher: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const config = policy.emailVerification;
  if (!config.enabled || !config.provider || !config.accountId || !config.oauthClientId
    || !config.oauthSecretRef) throw new Error("Mailbox OAuth setup is not configured");
  const account = policy.accounts.find((entry) => entry.id === config.accountId);
  if (!account) throw new Error("Mailbox account is not configured");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1"
    || !redirect.port || redirect.pathname !== "/callback" || redirect.search || redirect.hash
    || redirect.username || redirect.password
    || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
    || !code || code.length > 4096 || /[\r\n]/.test(code)) {
    throw new Error("Mailbox OAuth callback is invalid");
  }
  const body = new URLSearchParams({ client_id: config.oauthClientId,
    grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: redirectUri });
  if (config.provider === "microsoft") body.set("scope", mailboxConsentScopes(config.provider).join(" "));
  const response = await fetcher(tokenEndpoint(config.provider, config.microsoftTenant), {
    method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Mailbox OAuth exchange failed with HTTP ${response.status}`);
  const result = refreshedTokenSchema.parse(JSON.parse(await readTokenResponse(response)));
  if (!result.refresh_token || !result.scope) {
    throw new Error("Mailbox OAuth consent did not grant durable read-only access");
  }
  const scopes = result.scope.split(/\s+/).filter(Boolean);
  assertScopes(config.provider, scopes);
  const mailboxEmail = await fetchMailboxAccountEmail(config.provider, result.access_token, fetcher);
  if (mailboxEmail !== account.email.toLowerCase()) throw new Error("Mailbox identity does not match the selected account");
  const token: StoredMailboxToken = { version: 1, provider: config.provider,
    accountEmail: account.email, clientId: config.oauthClientId,
    refreshToken: result.refresh_token, accessToken: result.access_token,
    expiresAt: new Date(now + result.expires_in * 1000).toISOString(), scopes };
  await secrets.put(config.oauthSecretRef, JSON.stringify(token));
}

/** Reads and refreshes only the configured account's mailbox token, then verifies mailbox identity. */
export async function getMailboxAccessToken(policy: AuthenticationPolicy, secrets: SecretStore,
  fetcher: typeof fetch = fetch, now = Date.now(), requireAutoEnter = true): Promise<string> {
  const verification = policy.emailVerification;
  if (!verification.enabled || (requireAutoEnter && !verification.autoEnter) || !verification.provider
    || !verification.accountId || !verification.oauthClientId || !verification.oauthSecretRef) {
    throw new Error("Automatic email verification is not configured");
  }
  const account = policy.accounts.find((entry) => entry.id === verification.accountId);
  if (!account) throw new Error("Mailbox account is not configured");
  const saved = await secrets.get(verification.oauthSecretRef);
  if (!saved) throw new Error("Mailbox OAuth consent is required");
  const token = storedTokenSchema.parse(JSON.parse(saved));
  if (token.provider !== verification.provider || token.clientId !== verification.oauthClientId
    || token.accountEmail.toLowerCase() !== account.email.toLowerCase()) {
    throw new Error("Mailbox token belongs to another provider or account");
  }
  assertScopes(token.provider, token.scopes);
  const current = Date.parse(token.expiresAt) <= now + 60_000
    ? await refreshToken(token, verification.microsoftTenant, fetcher, now) : token;
  const mailboxEmail = await fetchMailboxAccountEmail(current.provider, current.accessToken, fetcher);
  if (mailboxEmail !== account.email.toLowerCase()) throw new Error("Mailbox identity does not match the selected account");
  if (current !== token) await secrets.put(verification.oauthSecretRef, JSON.stringify(current));
  return current.accessToken;
}
