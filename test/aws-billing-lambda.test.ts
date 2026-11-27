import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";
import { handleBillingSchedule, handleHttpApiEvent, type HttpApiEvent }
  from "../src/hosted/aws-lambda-adapter.js";
import { createStagingApplicationQueuePorts, createStagingEnqueueRuntime,
  loadStagingBillingConfig, selectStagingHttpRuntime }
  from "../src/hosted/aws-billing-lambda.js";

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
    expect(result.headers["access-control-allow-origin"]).toBe(appOrigin);
  });

  it("answers only an exact-origin Checkout preflight", async () => {
    const runtime = { handleRequest: vi.fn(), processReady: vi.fn() };
    const preflight = { ...event(""), rawPath: "/api/billing/checkout",
      requestContext: { http: { method: "OPTIONS" } },
      headers: { origin: appOrigin, "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type" } };
    const allowed = await handleHttpApiEvent(preflight, runtime, appOrigin);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(appOrigin);
    expect(allowed.headers["access-control-allow-headers"]).toBe("authorization, content-type");
    expect((await handleHttpApiEvent({ ...preflight,
      headers: { ...preflight.headers, origin: "https://evil.example" } }, runtime,
    appOrigin)).statusCode).toBe(403);
    expect((await handleHttpApiEvent({ ...preflight,
      headers: { ...preflight.headers, "access-control-request-headers": "x-secret" } }, runtime,
    appOrigin)).statusCode).toBe(403);
    expect(runtime.handleRequest).not.toHaveBeenCalled();
  });

  it("answers an exact-origin application enqueue preflight", async () => {
    const runtime = { handleRequest: vi.fn(), processReady: vi.fn() };
    const input = { ...event(""), rawPath: "/api/applications/enqueue",
      requestContext: { http: { method: "OPTIONS" } },
      headers: { origin: appOrigin, "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type" } };
    const result = await handleHttpApiEvent(input, runtime, appOrigin);
    expect(result.statusCode).toBe(204);
    expect(result.headers["access-control-allow-origin"]).toBe(appOrigin);
    expect(runtime.handleRequest).not.toHaveBeenCalled();
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
      ENTITLEMENT_TABLE_NAME: "entitlements",
      APP_ORIGIN: appOrigin, MONTHLY_PRICE_ID: "price_monthly",
      SEMESTER_PRICE_ID: "price_semester", COGNITO_ISSUER: "https://issuer.example/pool",
      COGNITO_CLIENT_ID: "client", COGNITO_JWKS_URL: "https://issuer.example/jwks" };
    const read = vi.fn(async (name: string) => name === "key-arn"
      ? "rk_test_localkey" : "whsec_localhook");
    const result = await loadStagingBillingConfig(env, read);
    expect(result.runtime.checkout.livemode).toBe(false);
    expect(result.runtime.entitlementTableName).toBe("entitlements");
    expect(read).toHaveBeenCalledTimes(2);
    await expect(loadStagingBillingConfig({ ...env, STRIPE_MODE: "live" }, read)).rejects.toThrow();
    await expect(loadStagingBillingConfig(env, async (name) => name === "key-arn"
      ? "sk_live_wrong" : "whsec_localhook")).rejects.toThrow();
  });

  it("keeps application enqueue disabled unless the staged resources are complete", () => {
    const db = { send: vi.fn() } as never;
    const sqs = { send: vi.fn() } as never;
    expect(createStagingApplicationQueuePorts({}, db, sqs)).toBeUndefined();
    expect(() => createStagingApplicationQueuePorts({ ENQUEUE_ENABLED: "true" }, db, sqs))
      .toThrow("RUN_LEDGER_TABLE_NAME");
    expect(() => createStagingApplicationQueuePorts({ ENQUEUE_ENABLED: "true",
      RUN_LEDGER_TABLE_NAME: "ledger" }, db, sqs)).toThrow("APPLICATION_QUEUE_URL");
    expect(() => createStagingApplicationQueuePorts({ ENQUEUE_ENABLED: "true",
      RUN_LEDGER_TABLE_NAME: "ledger", APPLICATION_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/205064803661/openapply-staging-application.fifo",
    }, db, sqs)).toThrow("FARGATE_LAUNCHER_ARN");
    const ports = createStagingApplicationQueuePorts({ ENQUEUE_ENABLED: "true",
      RUN_LEDGER_TABLE_NAME: "openapply-staging-run-ledger", APPLICATION_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/205064803661/openapply-staging-application.fifo",
      FARGATE_LAUNCHER_ARN: "arn:aws:lambda:us-east-1:205064803661:function:openapply-staging-fargate-launcher",
    }, db, sqs);
    expect(ports?.dispatch).toBeDefined();
    expect(ports?.launcher).toBeDefined();
  });

  it("routes enqueue without reading Stripe secrets during a billing outage", async () => {
    const candidateId = "00000000-0000-4000-8000-000000000091";
    const runId = "00000000-0000-4000-8000-000000000092";
    const artifactId = "00000000-0000-4000-8000-000000000093";
    const envelope = encodeCloudRunEnvelope({ version: 1, candidateId, runId,
      kind: "apply", scheduledAt: new Date().toISOString() });
    const entitlement = { kind: "subscription", subjectId: "job-seeker-1",
      subscriptionId: "sub_test_paid", status: "active", settledInvoiceId: "in_test_paid",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      paidThrough: new Date(Date.now() + 3_600_000).toISOString() };
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof QueryCommand) return { Items: [{ pk: "SUBJECT#job-seeker-1",
        sk: "ENTITLEMENT#subscription#sub_test_paid", record: entitlement }] };
      if (command instanceof GetCommand) {
        const key = command.input.Key;
        if (key?.sk === `RUN#${runId}`) return { Item: { pk: `CANDIDATE#${candidateId}`,
          sk: key.sk, candidateId, runId, subjectId: "job-seeker-1",
          consentVersion: 1, profileArtifactId: artifactId,
          job: { provider: "greenhouse", employerId: "example", requisitionId: "42" } } };
        if (key?.sk === `CONSENT#${runId}`) return { Item: { pk: `CANDIDATE#${candidateId}`,
          sk: key.sk, runId, version: 1, state: "granted" } };
        if (key?.sk === `DISPATCH#${runId}`) return { Item: { pk: `CANDIDATE#${candidateId}`,
          sk: key.sk, candidateId, runId, state: "launched", ...envelope,
          createdAt: new Date().toISOString() } };
        return { Item: undefined };
      }
      throw new Error("Unexpected Dynamo command");
    });
    const db = { send } as never;
    const sqs = { send: vi.fn() } as never;
    const env = { ENQUEUE_ENABLED: "true", APP_ORIGIN: appOrigin,
      BILLING_TABLE_NAME: "billing", ENTITLEMENT_TABLE_NAME: "entitlements",
      RUN_LEDGER_TABLE_NAME: "openapply-staging-run-ledger", APPLICATION_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/205064803661/openapply-staging-application.fifo",
      FARGATE_LAUNCHER_ARN:
        "arn:aws:lambda:us-east-1:205064803661:function:openapply-staging-fargate-launcher",
    };
    const readStripeSecret = vi.fn(async () => { throw new Error("Stripe secret unavailable"); });
    const unavailableBilling = async () => {
      await loadStagingBillingConfig({ ...env, STRIPE_MODE: "test",
        STRIPE_TEST_SECRET_ARN: "missing-key",
        STRIPE_WEBHOOK_SECRET_ARN: "missing-webhook" }, readStripeSecret);
      return createStagingEnqueueRuntime(env, db, sqs, async () => "job-seeker-1");
    };
    const enqueueEvent = { ...event(JSON.stringify({ candidateId, runId })),
      rawPath: "/api/applications/enqueue",
      headers: { origin: appOrigin, authorization: "Bearer a.b.c",
        "content-type": "application/json" } };
    const app = await selectStagingHttpRuntime(enqueueEvent, unavailableBilling,
      () => createStagingEnqueueRuntime(env, db, sqs, async () => "job-seeker-1"));
    const response = await handleHttpApiEvent(enqueueEvent, app, appOrigin);
    expect(response.statusCode).toBe(202);
    expect(readStripeSecret).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
    await expect(unavailableBilling()).rejects.toThrow("Stripe secret unavailable");
  });
});
