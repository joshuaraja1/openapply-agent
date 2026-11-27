import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { handleStripeWebhookHttp } from "../src/hosted/stripe-webhook-http.js";

const stripe = new Stripe("sk_test_local");
const endpointSecret = "whsec_local_only";

function signedRequest(id = "evt_test_1", type = "checkout.session.completed",
  livemode = false): Request {
  const body = JSON.stringify({ id, object: "event", type, livemode,
    data: { object: { id: "cs_test_1", customer: "cus_test_1" } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload: body,
    secret: endpointSecret });
  return new Request("https://openapply.example/webhooks/stripe", {
    method: "POST", headers: { "stripe-signature": signature }, body,
  });
}

function harness() {
  const seen = new Set<string>();
  const enqueueOnce = vi.fn(async (request: { eventId: string; customerId: string }) => {
    if (seen.has(request.eventId)) return "duplicate" as const;
    seen.add(request.eventId);
    return "queued" as const;
  });
  return { endpointSecret, livemode: false, verifier: stripe.webhooks,
    ports: { enqueueOnce, resolveCharge: async () => undefined,
      recordGuestRefund: async () => {} } };
}

describe("Stripe raw HTTP webhook", () => {
  it("enqueues a signed event once and safely acknowledges a replay", async () => {
    const h = harness();
    expect((await handleStripeWebhookHttp(signedRequest(), h)).status).toBe(204);
    expect((await handleStripeWebhookHttp(signedRequest(), h)).status).toBe(204);
    expect(h.ports.enqueueOnce).toHaveBeenCalledTimes(2);
    expect(h.ports.enqueueOnce).toHaveBeenCalledWith({ eventId: "evt_test_1",
      customerId: "cus_test_1" });
  });

  it("rejects altered signatures, wrong mode, and oversized raw bodies", async () => {
    const h = harness();
    expect((await handleStripeWebhookHttp(new Request("https://openapply.example/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "wrong" }, body: "{}",
    }), h)).status).toBe(400);
    expect((await handleStripeWebhookHttp(signedRequest("evt_live", "invoice.paid", true), h))
      .status).toBe(400);
    expect((await handleStripeWebhookHttp(new Request("https://openapply.example/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "wrong", "content-length": "1048577" },
      body: "{}",
    }), h)).status).toBe(413);
    expect(h.ports.enqueueOnce).not.toHaveBeenCalled();
  });

  it("returns retryable failure when durable enqueue fails", async () => {
    const h = harness();
    h.ports.enqueueOnce = vi.fn(async () => { throw new Error("DynamoDB unavailable"); });
    expect((await handleStripeWebhookHttp(signedRequest(), h)).status).toBe(503);
  });

  it("does not mutate state for a non-POST request", async () => {
    const h = harness();
    expect((await handleStripeWebhookHttp(new Request("https://openapply.example/webhooks/stripe"),
      h)).status).toBe(405);
    expect(h.ports.enqueueOnce).not.toHaveBeenCalled();
  });
});
