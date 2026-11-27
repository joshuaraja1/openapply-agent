import { PutCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createHostedBillingRuntime } from "../src/hosted/billing-runtime.js";

const stripe = new Stripe("sk_test_local");
const webhookSecret = "whsec_localonly";
const config = {
  tableName: "openapply-staging-billing",
  entitlementTableName: "openapply-staging-entitlements",
  checkout: {
    prices: { monthly: { id: "price_monthly", amountCents: 3900 },
      semester: { id: "price_semester", amountCents: 12900 } },
    livemode: false,
    appOrigin: "https://openapply.example",
  },
  oidc: { issuer: "https://accounts.example/", audience: "openapply",
    jwksUrl: "https://accounts.example/.well-known/jwks.json" },
  stripeWebhookSecret: webhookSecret,
};

describe("hosted billing composition", () => {
  it("routes signed Stripe events to the durable table and rejects unsigned events", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(PutCommand);
      const input = (command as PutCommand).input;
      expect(input.TableName).toBe(config.tableName);
      expect(input.Item).toMatchObject({ pk: "BILLING_EVENT#evt_valid1",
        sk: "RECONCILE", customerId: "cus_valid1", status: "pending" });
      return {};
    });
    const runtime = createHostedBillingRuntime(config, { send } as never, stripe);
    const body = JSON.stringify({ id: "evt_valid1", object: "event",
      type: "checkout.session.completed", livemode: false,
      data: { object: { id: "cs_valid1", customer: "cus_valid1" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload: body,
      secret: webhookSecret });
    const url = "https://openapply.example/api/billing/stripe-webhook";
    expect((await runtime.handleRequest(new Request(url, { method: "POST",
      headers: { "stripe-signature": "invalid" }, body }))).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect((await runtime.handleRequest(new Request(url, { method: "POST",
      headers: { "stripe-signature": signature }, body }))).status).toBe(204);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("exposes only the two billing paths and requires a configured signing secret", async () => {
    const runtime = createHostedBillingRuntime(config, { send: vi.fn() } as never, stripe);
    expect((await runtime.handleRequest(new Request("https://openapply.example/other"))).status)
      .toBe(404);
    expect(() => createHostedBillingRuntime({ ...config, stripeWebhookSecret: "" },
      { send: vi.fn() } as never, stripe)).toThrow();
  });
});
