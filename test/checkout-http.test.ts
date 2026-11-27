import { describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type Stripe from "stripe";
import { createOidcSubjectVerifier, handleCheckoutHttp } from "../src/hosted/checkout-http.js";
import type { CheckoutConfig, CheckoutPorts } from "../src/hosted/stripe-checkout.js";

const config: CheckoutConfig = {
  appOrigin: "https://openapplyagent.xyz", livemode: false,
  prices: {
    monthly: { id: "price_monthly1", amountCents: 3900 },
    semester: { id: "price_semester1", amountCents: 12900 },
  },
};

async function signedToken(sub = "candidate-1", audience = "openapply-client",
  expiration = "30m", issuer = "https://auth.openapplyagent.xyz/", tokenUse = "id") {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  const verifier = createOidcSubjectVerifier({
    issuer: "https://auth.openapplyagent.xyz/", audience: "openapply-client",
    jwksUrl: "https://auth.openapplyagent.xyz/.well-known/jwks.json",
  }, createLocalJWKSet({ keys: [publicJwk] }));
  const token = await new SignJWT({ token_use: tokenUse }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer).setAudience(audience)
    .setSubject(sub).setIssuedAt().setExpirationTime(expiration).sign(privateKey);
  return { token, verifier };
}

function request(token: string, body: unknown, origin = config.appOrigin): Request {
  return new Request(`${config.appOrigin}/api/billing/checkout`, { method: "POST",
    headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
}

function services() {
  const reserve = vi.fn(async (subjectId: string, plan: string) => ({
    requestId: "req_1", subjectId, customerId: "cus_test123", plan,
    createdAt: new Date().toISOString(),
  }));
  const recordSession = vi.fn(async () => {});
  const priceRetrieve = vi.fn(async (id: string) => ({ id, active: true, livemode: false,
    currency: "usd", unit_amount: id === "price_monthly1" ? 3900 : 12900,
    type: id === "price_monthly1" ? "recurring" : "one_time",
    recurring: id === "price_monthly1" ? { interval: "month", interval_count: 1 } : null,
  }));
  const create = vi.fn(async () => ({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123",
    expires_at: Math.floor(Date.now() / 1000) + 1800 }));
  const stripe = { prices: { retrieve: priceRetrieve }, checkout: { sessions: { create } } } as unknown as
    Pick<Stripe, "prices" | "checkout">;
  return { ports: { reserve, recordSession } as CheckoutPorts, stripe,
    reserve, recordSession, priceRetrieve, create };
}

describe("hosted checkout HTTP boundary", () => {
  it("derives subject from a verified token and uses trusted plan prices", async () => {
    const { token, verifier } = await signedToken();
    const deps = services();
    const response = await handleCheckoutHttp(request(token, { plan: "monthly" }),
      { ...deps, config, verifySubject: verifier });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ checkoutUrl: expect.stringContaining("checkout.stripe.com") });
    expect(deps.reserve).toHaveBeenCalledWith("candidate-1", "monthly");
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({
      customer: "cus_test123", mode: "subscription",
      line_items: [{ price: "price_monthly1", quantity: 1 }],
    }), expect.objectContaining({ idempotencyKey: "openapply-checkout-req_1" }));
  });

  it("accepts an opaque OIDC subject containing an identity-provider separator", async () => {
    const { token, verifier } = await signedToken("google-oauth2|123");
    const deps = services();
    const response = await handleCheckoutHttp(request(token, { plan: "semester" }),
      { ...deps, config, verifySubject: verifier });
    expect(response.status).toBe(200);
    expect(deps.reserve).toHaveBeenCalledWith("google-oauth2|123", "semester");
  });

  it("rejects C1 controls in a signed subject before billing", async () => {
    const { token, verifier } = await signedToken("candidate\u0085id");
    const deps = services();
    const response = await handleCheckoutHttp(request(token, { plan: "monthly" }),
      { ...deps, config, verifySubject: verifier });
    expect(response.status).toBe(401);
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it("rejects a signed access token even with matching audience", async () => {
    const { token, verifier } = await signedToken("candidate-1", "openapply-client",
      "30m", "https://auth.openapplyagent.xyz/", "access");
    const deps = services();
    const response = await handleCheckoutHttp(request(token, { plan: "monthly" }),
      { ...deps, config, verifySubject: verifier });
    expect(response.status).toBe(401);
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it("rejects untrusted Origin before calling Stripe", async () => {
    const { token, verifier } = await signedToken();
    const deps = services();
    const response = await handleCheckoutHttp(request(token, { plan: "monthly" }, "https://evil.example"),
      { ...deps, config, verifySubject: verifier });
    expect(response.status).toBe(403);
    expect(deps.priceRetrieve).not.toHaveBeenCalled();
  });

  it("rejects bad audience and cannot take subject or customer from request JSON", async () => {
    const { token, verifier } = await signedToken("candidate-1", "wrong-audience");
    const deps = services();
    const badToken = await handleCheckoutHttp(request(token, { plan: "monthly" }),
      { ...deps, config, verifySubject: verifier });
    expect(badToken.status).toBe(401);
    const valid = await signedToken();
    const forgedBody = await handleCheckoutHttp(request(valid.token,
      { plan: "monthly", subjectId: "victim", customerId: "cus_victim" }),
    { ...deps, config, verifySubject: valid.verifier });
    expect(forgedBody.status).toBe(400);
    expect(deps.priceRetrieve).not.toHaveBeenCalled();
  });

  it("rejects expired, wrong-issuer, and empty-subject identity tokens", async () => {
    const deps = services();
    for (const input of [
      await signedToken("candidate-1", "openapply-client", "-1h"),
      await signedToken("candidate-1", "openapply-client", "30m", "https://other.example/"),
      await signedToken("", "openapply-client", "30m"),
    ]) {
      const response = await handleCheckoutHttp(request(input.token, { plan: "monthly" }),
        { ...deps, config, verifySubject: input.verifier });
      expect(response.status).toBe(401);
    }
    expect(deps.priceRetrieve).not.toHaveBeenCalled();
  });

  it("rejects missing authorization, large bodies, and unsupported plans", async () => {
    const { token, verifier } = await signedToken();
    const deps = services();
    const noAuth = request(token, { plan: "monthly" });
    noAuth.headers.delete("authorization");
    expect((await handleCheckoutHttp(noAuth, { ...deps, config, verifySubject: verifier })).status).toBe(401);
    expect((await handleCheckoutHttp(request(token, { plan: "monthly", padding: "x".repeat(2000) }),
      { ...deps, config, verifySubject: verifier })).status).toBe(413);
    expect((await handleCheckoutHttp(request(token, { plan: "free" }),
      { ...deps, config, verifySubject: verifier })).status).toBe(400);
  });
});
