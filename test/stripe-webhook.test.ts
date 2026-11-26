import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import type { HostedEntitlement } from "../src/hosted/entitlement.js";
import { requireHostedAccess } from "../src/hosted/entitlement.js";
import { acceptBillingWebhook, projectPaidStripeAccess, reconcileBillingRequest, verifiedBillingRequest,
  type BillingReconcileRequest, type TrustedStripeBillingSnapshot }
  from "../src/hosted/stripe-webhook.js";

const stripe = new Stripe("local-only-api-key");
const signingSecret = "local-only-webhook-secret";

function signedEvent(type: string, id: string, customer: unknown = "cus_test_1", objectId = "obj_test_1") {
  const body = JSON.stringify({ id, object: "event", type, created: 1,
    data: { object: { id: objectId, customer } } });
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

  it("resolves a signed refund without a customer before enqueueing", async () => {
    const { body, signature } = signedEvent("charge.refunded", "evt_refund", null, "ch_test_1");
    expect(verifiedBillingRequest(body, signature, signingSecret, stripe.webhooks))
      .toEqual({ eventId: "evt_refund", chargeId: "ch_test_1" });
    const enqueue = vi.fn(async () => "queued" as const);
    await expect(acceptBillingWebhook(body, signature, signingSecret, stripe.webhooks, enqueue))
      .rejects.toThrow("could not be resolved");
    expect(enqueue).not.toHaveBeenCalled();
    expect(await acceptBillingWebhook(body, signature, signingSecret, stripe.webhooks,
      enqueue, async () => ({ kind: "customer", customerId: "cus_test_1" })))
      .toBe("queued");
    expect(enqueue).toHaveBeenCalledWith({ eventId: "evt_refund", customerId: "cus_test_1" });
  });

  it("audits a verified unaffiliated guest refund and retries transient lookups", async () => {
    const { body, signature } = signedEvent("charge.refunded", "evt_guest", null, "ch_guest");
    const enqueue = vi.fn(async () => "queued" as const);
    const recordGuestRefund = vi.fn(async () => {});
    await expect(acceptBillingWebhook(body, signature, signingSecret, stripe.webhooks,
      enqueue, async () => undefined, recordGuestRefund)).rejects.toThrow("could not be resolved");
    await expect(acceptBillingWebhook(body, signature, signingSecret, stripe.webhooks,
      enqueue, async () => ({ kind: "verified-unaffiliated-guest" })))
      .rejects.toThrow("audit port");
    expect(await acceptBillingWebhook(body, signature, signingSecret, stripe.webhooks,
      enqueue, async () => ({ kind: "verified-unaffiliated-guest" }), recordGuestRefund))
      .toBe("guest-acknowledged");
    expect(recordGuestRefund).toHaveBeenCalledWith({ eventId: "evt_guest", chargeId: "ch_guest" });
    expect(enqueue).not.toHaveBeenCalled();
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
      verifiedBillingRequest(body, signature, signingSecret, stripe.webhooks) as BillingReconcileRequest);
    const writes: Array<[string, readonly HostedEntitlement[]]> = [];
    const ports = { loadBinding: vi.fn(async () => binding), loadCurrent: vi.fn(async () => [current]),
      replaceSubscriptions: async (subjectId: string,
        entitlements: readonly HostedEntitlement[]) => { writes.push([subjectId, entitlements]); } };
    for (const request of requests) await reconcileBillingRequest(request, ports);
    expect(ports.loadCurrent).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[1]?.[1]).toMatchObject([{ settledInvoiceId: "in_test_1" }]);
  });

  it("does not write when the customer binding belongs to another customer", async () => {
    const replaceSubscriptions = vi.fn(async () => {});
    await expect(reconcileBillingRequest({ eventId: "evt_test_5", customerId: "cus_test_1" }, {
      loadBinding: async () => ({ ...binding, customerId: "cus_other" }),
      loadCurrent: async () => [current],
      replaceSubscriptions,
    })).rejects.toThrow("not bound");
    expect(replaceSubscriptions).not.toHaveBeenCalled();
  });

  it("removes old paid access after a plan switch and later cancellation", async () => {
    const paidById = new Map<string, HostedEntitlement>();
    const grant = { kind: "free-grant", subjectId: binding.subjectId, grantId: "grant-test",
      approvedBy: "admin-test", startsAt: "2026-12-01T00:00:00Z",
      endsAt: "2027-01-01T00:00:00Z", revokedAt: null } as const;
    let providerCurrent: TrustedStripeBillingSnapshot[] = [current];
    const ports = { loadBinding: async () => binding, loadCurrent: async () => providerCurrent,
      replaceSubscriptions: async (_subjectId: string, entitlements: readonly HostedEntitlement[]) => {
        paidById.clear();
        for (const entitlement of entitlements) {
          if (entitlement.kind === "subscription") paidById.set(entitlement.subscriptionId, entitlement);
        }
      } };
    const request = { eventId: "evt_switch", customerId: binding.customerId };
    await reconcileBillingRequest(request, ports);
    expect([...paidById.keys()]).toEqual([current.subscriptionId]);
    const switched = { ...current, subscriptionId: "sub_test_2", settledInvoiceId: "in_test_2" };
    providerCurrent = [switched];
    await reconcileBillingRequest(request, ports);
    expect([...paidById.keys()]).toEqual(["sub_test_2"]);
    providerCurrent = [{ ...switched, paymentReversed: true }];
    await reconcileBillingRequest(request, ports);
    expect([...paidById.keys()]).toEqual([]);
    providerCurrent = [{ ...switched, status: "canceled" as const }];
    await reconcileBillingRequest(request, ports);
    expect([...paidById.keys()]).toEqual([]);
    expect(() => requireHostedAccess(binding.subjectId, [...paidById.values()],
      new Date("2026-11-26T00:00:00Z"))).toThrow("Hosted access unavailable");
    expect(requireHostedAccess(binding.subjectId, [grant],
      new Date("2026-12-10T00:00:00Z")).kind).toBe("free-grant");
  });
});
