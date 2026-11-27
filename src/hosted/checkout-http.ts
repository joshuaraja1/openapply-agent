import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type Stripe from "stripe";
import { z } from "zod";
import { createHostedCheckout, type CheckoutConfig, type CheckoutPorts } from "./stripe-checkout.js";

const checkoutBody = z.strictObject({ plan: z.enum(["monthly", "semester"]) });
const MAX_BODY_BYTES = 1024;

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export type VerifySubject = (token: string) => Promise<string>;

function trustedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("OIDC URLs must use HTTPS without credentials or query parameters");
  }
  return url;
}

/** The caller receives an identity only after signature, issuer, audience and
 * lifetime validation. Never derive an identity from request JSON or headers. */
export function createOidcSubjectVerifier(config: OidcConfig, keySet?: JWTVerifyGetKey): VerifySubject {
  const issuer = trustedUrl(config.issuer);
  const jwks = trustedUrl(config.jwksUrl);
  if (jwks.origin !== issuer.origin || !config.audience.trim()) {
    throw new Error("OIDC issuer, JWKS, or audience is not configured safely");
  }
  const keys = keySet ?? createRemoteJWKSet(jwks);
  return async (token: string) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: "30 seconds",
      maxTokenAge: "1 hour",
    });
    if (!payload.exp || !payload.sub?.trim() || payload.sub.length > 160
      || /[\u0000-\u001f\u007f]/.test(payload.sub)) {
      throw new Error("OIDC token lacks a usable subject or expiry");
    }
    return payload.sub;
  };
}

export interface CheckoutHttpDeps {
  config: CheckoutConfig;
  verifySubject: VerifySubject;
  stripe: Pick<Stripe, "prices" | "checkout">;
  ports: CheckoutPorts;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
  } });
}

async function boundedBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new RangeError("Checkout request is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Framework-neutral POST /api/billing/checkout handler. It has no cookie
 * authentication, no cross-origin CORS, and never grants access on redirect. */
export async function handleCheckoutHttp(request: Request, deps: CheckoutHttpDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/billing/checkout") return json(404, { error: "Not found" });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (request.headers.get("origin") !== deps.config.appOrigin) {
    return json(403, { error: "Origin not allowed" });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) return json(401, { error: "Authentication required" });
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return json(401, { error: "Authentication required" }); }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json(415, { error: "JSON request required" });
  }
  let body: unknown;
  try { body = await boundedBody(request); }
  catch (error) {
    return json(error instanceof RangeError ? 413 : 400, { error: "Invalid checkout request" });
  }
  const parsed = checkoutBody.safeParse(body);
  if (!parsed.success) return json(400, { error: "Unsupported checkout plan" });
  try {
    const session = await createHostedCheckout(subjectId, parsed.data.plan,
      deps.config, deps.stripe, deps.ports);
    return json(200, { checkoutUrl: session.url, expiresAt: session.expiresAt });
  } catch {
    // Do not expose Stripe details, reservation IDs, or configuration secrets.
    return json(503, { error: "Checkout is temporarily unavailable" });
  }
}
