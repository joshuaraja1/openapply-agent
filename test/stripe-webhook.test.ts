import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import type { HostedEntitlement } from "../src/hosted/entitlement.js";
import { requireHostedAccess } from "../src/hosted/entitlement.js";
import { acceptBillingWebhook, projectPaidStripeAccess, reconcileBillingRequest, verifiedBillingRequest }
  from "../src/hosted/stripe-webhook.js";

const stripe = new Stripe("local-only-api-key");
const signingSecret = "local-only-webhook-secret";

function signedEvent(type: string, id: string, customer: unknown = "cus_test_1") {
  const body = JSON.stringify({ id, object: "event", type, created: 1,
    data: { object: { id: "obj_test_1", customer } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret: signingSecret });
  return { body, signature };
}

const binding = { subjectId: "candidate-a", customerId: "cus_test_1" };
const current = { customerId: "cus_test_1", subscriptionId: "sub_test_1",
  status: "active" as const, startsAt: "2026-11-01T00:00:00Z",
  endsAt: "2026-12-01T00:00:00Z", settledInvoiceId: "in_test_1",
  paidThrough: "2026-12-01T00:00:00Z", paymentReversed: false };

describe("Stripe billing event boundary", () => {
  it("verifies raw body before accepting a billing event", () => {
    const { body, signature } = signedEvent("invoice.paid", "evt_test_1");
    expect(verifiedBillingRequest(body, signature, signingSecret, stripe.webhooks))
      .toEqual({ eventId: "evt_test_1", customerId: "cus_test_1" });
    expect(() => verifiedBillingRequest(`${body} `, signature, signingSecret, stripe.webhooks))
      .toThrow();
    expect(() => verifiedBillingRequest(body, "bad", signingSecret, stripe.webhooks)).toThrow();
    expect(() => verifiedBillingRequest(body, signature, "wrong", stripe.webhooks)).toThrow();
  });

  it("ignores unrelated events and rejects missing customer identity", () => {
    const unrelated = signedEvent("customer.created", "evt_test_2");
    expect(verifiedBillingRequest(unrelated.body, unrelated.signature, signingSecret, stripe.webhooks))
      .toBeUndefined();
    const noCustomer = signedEvent("invoice.paid", "evt_test_3", null);
    expect(() => verifiedBillingRequest(noCustomer.body, noCustomer.signature,
      signingSecret, stripe.webhooks)).toThrow("no customer");
  });

  it("passes a verified event ID to an atomic enqueue port exactly once", async () => {
    const { body, signature } = signedEvent("customer.subscription.updated", "evt_test_4");
    const seen = new Set<string>();
    const enqueue = vi.fn(async ({ eventId }: { eventId: string }) => {
      if (seen.has(eventId)) return "duplicate" as const;
      seen.add(eventId);
      return "queued" as const;
    });
    expect(await acceptBillingWebhook(body, signature, signingSecret, stripe.webhooks, enqueue))
      .toBe("queued");
    expect(await acceptBillingWebhook(body, signature, signingSecret, stripe.webhooks, enqueue))
      .toBe("duplicate");
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("projects only current settled and tenant-bound paid coverage", () => {
    const projected = projectPaidStripeAccess(binding, current);
    expect(requireHostedAccess("candidate-a", [projected],
      new Date("2026-11-26T00:00:00Z"))).toMatchObject({ kind: "subscription" });
    const { settledInvoiceId: _invoiceId, ...unpaid } = current;
    expect(projectPaidStripeAccess(binding, unpaid))
      .toBeUndefined();
    expect(projectPaidStripeAccess(binding, { ...current, status: "canceled" }))
      .toBeUndefined();
    expect(projectPaidStripeAccess(binding, { ...current, paymentReversed: true }))
      .toBeUndefined();
    expect(() => projectPaidStripeAccess({ ...binding, customerId: "cus_other" }, current))
      .toThrow("not bound");
  });

  it("re-reads canonical provider state when old events arrive after new ones", async () => {
    const newer = signedEvent("invoice.paid", "evt_newer");
    const older = signedEvent("invoice.payment_failed", "evt_older");
    const requests = [newer, older].map(({ body, signature }) =>
      verifiedBillingRequest(body, signature, signingSecret, stripe.webhooks)!);
    const writes: Array<[string, string, HostedEntitlement | undefined]> = [];
    const ports = { loadBinding: vi.fn(async () => binding), loadCurrent: vi.fn(async () => current),
      replaceSubscription: async (subjectId: string, subscriptionId: string,
        entitlement: HostedEntitlement | undefined) => { writes.push([subjectId, subscriptionId, entitlement]); } };
    for (const request of requests) await reconcileBillingRequest(request, ports);
    expect(ports.loadCurrent).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[1]?.[2]).toMatchObject({ settledInvoiceId: "in_test_1" });
  });

  it("does not write when the customer binding belongs to another customer", async () => {
    const replaceSubscription = vi.fn(async () => {});
    await expect(reconcileBillingRequest({ eventId: "evt_test_5", customerId: "cus_test_1" }, {
      loadBinding: async () => ({ ...binding, customerId: "cus_other" }),
      loadCurrent: async () => current,
      replaceSubscription,
    })).rejects.toThrow("not bound");
    expect(replaceSubscription).not.toHaveBeenCalled();
  });
});
