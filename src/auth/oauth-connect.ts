import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SecretStore } from "../storage/contracts.js";
import type { AuthenticationPolicy } from "./schema.js";
import { exchangeMailboxAuthorizationCode, mailboxConsentScopes } from "./oauth-token.js";

export interface OAuthAuthorizationRequest { url: string; state: string; verifier: string }

export function createOAuthAuthorizationRequest(policy: AuthenticationPolicy,
  redirectUri: string): OAuthAuthorizationRequest {
  const config = policy.emailVerification;
  if (!config.enabled || !config.provider || !config.accountId || !config.oauthClientId) {
    throw new Error("Mailbox OAuth setup is not configured");
  }
  const account = policy.accounts.find((entry) => entry.id === config.accountId);
  if (!account) throw new Error("Mailbox account is not configured");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1"
    || !redirect.port || redirect.pathname !== "/callback" || redirect.search || redirect.hash
    || redirect.username || redirect.password) {
    throw new Error("Mailbox OAuth redirect must be a local callback");
  }
  if (config.microsoftTenant
    && !/^(?:common|organizations|consumers|[a-f0-9-]{36})$/i.test(config.microsoftTenant)) {
    throw new Error("Microsoft tenant is invalid");
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const tenant = config.microsoftTenant ?? "common";
  const url = new URL(config.provider === "gmail"
    ? "https://accounts.google.com/o/oauth2/v2/auth"
    : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", config.oauthClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", mailboxConsentScopes(config.provider).join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("login_hint", account.email);
  if (config.provider === "gmail") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return { url: url.href, state, verifier };
}

/** Runs a one-time local browser consent flow; only the resulting token reaches Keychain. */
export async function connectMailboxOAuth(policy: AuthenticationPolicy, secrets: SecretStore,
  openUrl: (url: string) => Promise<void>, fetcher: typeof fetch = fetch,
  timeoutMs = 180_000): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new Error("OAuth setup timeout is invalid");
  }
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codeReceived = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let expectedState = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.method !== "GET" || !request.url?.startsWith("/callback?")) {
      response.writeHead(404).end("Not found");
      return;
    }
    const callback = new URL(request.url, "http://127.0.0.1");
    if (callback.searchParams.getAll("state").length !== 1
      || callback.searchParams.get("state") !== expectedState
      || callback.searchParams.getAll("code").length !== 1) {
      response.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    const code = callback.searchParams.get("code") ?? "";
    if (!code || code.length > 4096) {
      response.writeHead(400).end("Invalid OAuth code");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Mailbox consent received. Return to OpenApply.");
    resolveCode(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authorization = createOAuthAuthorizationRequest(policy, redirectUri);
    expectedState = authorization.state;
    timeout = setTimeout(() => rejectCode(new Error("Mailbox OAuth consent timed out")), timeoutMs);
    await openUrl(authorization.url);
    const code = await codeReceived;
    await exchangeMailboxAuthorizationCode(policy, secrets, code, authorization.verifier,
      redirectUri, fetcher);
  } finally {
    if (timeout) clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
