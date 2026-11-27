import { describe, expect, it, vi } from "vitest";
import { handleBillingSchedule, handleHttpApiEvent, type HttpApiEvent }
  from "../src/hosted/aws-lambda-adapter.js";
import { loadStagingBillingConfig } from "../src/hosted/aws-billing-lambda.js";

const appOrigin = "https://staging.openapplyagent.xyz";
const event = (body: string, isBase64Encoded = false): HttpApiEvent => ({
  version: "2.0", rawPath: "/api/billing/stripe-webhook", rawQueryString: "",
  requestContext: { http: { method: "POST" } },
  headers: { "stripe-signature": "t=1,v1=opaque", origin: appOrigin },
  body, isBase64Encoded,
});

describe("AWS hosted billing adapter", () => {
  it("preserves the exact raw Stripe bytes through the HTTP API v2 bridge", async () => {
    const raw = Buffer.from(" {\"x\": \"ümlaut\"}\n", "utf8");
    const runtime = { handleRequest: vi.fn(async (request: Request) => {
      expect(request.headers.get("stripe-signature")).toBe("t=1,v1=opaque");
      expect(Buffer.from(await request.arrayBuffer())).toEqual(raw);
      return new Response(null, { status: 204 });
    }), processReady: vi.fn(async () => ({ processed: 0, deferred: 0 })) };
    const result = await handleHttpApiEvent(event(raw.toString("base64"), true), runtime, appOrigin);
    expect(result.statusCode).toBe(204);
    expect(runtime.handleRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps bearer headers and returns only response bytes", async () => {
    const runtime = { handleRequest: vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBe("Bearer a.b.c");
      return new Response('{"ok":true}', { status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }), processReady: vi.fn(async () => ({ processed: 0, deferred: 0 })) };
    const input = { ...event('{"plan":"monthly"}'),
      rawPath: "/api/billing/checkout",
      headers: { origin: appOrigin, authorization: "Bearer a.b.c" } };
    const result = await handleHttpApiEvent(input, runtime, appOrigin);
    expect(result.statusCode).toBe(200);
    expect(Buffer.from(result.body, "base64").toString()).toBe('{"ok":true}');
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("runs scheduled reconciliation without an HTTP route", async () => {
    const runtime = { handleRequest: vi.fn(), processReady: vi.fn(async () =>
      ({ processed: 2, deferred: 1 })) };
    expect(await handleBillingSchedule(runtime)).toEqual({ processed: 2, deferred: 1 });
    expect(runtime.processReady).toHaveBeenCalledWith(25);
    expect(runtime.handleRequest).not.toHaveBeenCalled();
  });

  it("rejects oversized or malformed API Gateway input before invoking billing", async () => {
    const runtime = { handleRequest: vi.fn(), processReady: vi.fn() };
    await expect(handleHttpApiEvent(event("x".repeat(1_048_577)), runtime, appOrigin))
      .rejects.toThrow("too large");
    await expect(handleHttpApiEvent({ ...event("{}"), version: "1.0" }, runtime, appOrigin))
      .rejects.toThrow("Unsupported");
    expect(runtime.handleRequest).not.toHaveBeenCalled();
  });

  it("loads separate Stripe test secrets and rejects live credentials", async () => {
    const env = { STRIPE_MODE: "test", STRIPE_TEST_SECRET_ARN: "key-arn",
      STRIPE_WEBHOOK_SECRET_ARN: "webhook-arn", BILLING_TABLE_NAME: "billing",
      APP_ORIGIN: appOrigin, MONTHLY_PRICE_ID: "price_monthly",
      SEMESTER_PRICE_ID: "price_semester", COGNITO_ISSUER: "https://issuer.example/pool",
      COGNITO_CLIENT_ID: "client", COGNITO_JWKS_URL: "https://issuer.example/jwks" };
    const read = vi.fn(async (name: string) => name === "key-arn"
      ? "rk_test_localkey" : "whsec_localhook");
    const result = await loadStagingBillingConfig(env, read);
    expect(result.runtime.checkout.livemode).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(loadStagingBillingConfig({ ...env, STRIPE_MODE: "live" }, read)).rejects.toThrow();
    await expect(loadStagingBillingConfig(env, async (name) => name === "key-arn"
      ? "sk_live_wrong" : "whsec_localhook")).rejects.toThrow();
  });
});
