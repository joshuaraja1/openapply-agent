import type Stripe from "stripe";
import { hostedEntitlementSchema, type HostedEntitlement } from "./entitlement.js";

const billingEvents = new Set([
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed", "charge.refunded",
]);

export interface BillingReconcileRequest {
  eventId: string;
  customerId: string;
}

/** Verify the raw snapshot event before accepting any customer identifier. */
export function verifiedBillingRequest(
  rawBody: string | Buffer,
  signature: string,
  endpointSecret: string,
  verifier: Pick<Stripe["webhooks"], "constructEvent">,
): BillingReconcileRequest | undefined {
  if (!signature || !endpointSecret) throw new Error("Stripe webhook signature configuration is missing");
  const event = verifier.constructEvent(rawBody, signature, endpointSecret);
  if (!billingEvents.has(event.type)) return undefined;
  const object = event.data.object as { customer?: string | { id?: string } | null };
  const customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
  if (!customerId || !customerId.startsWith("cus_") || !event.id) {
    throw new Error("Verified Stripe event has no customer identity");
  }
  return { eventId: event.id, customerId };
}

/** The port must persist an event ID and enqueue request atomically. */
export async function acceptBillingWebhook(
  rawBody: string | Buffer,
  signature: string,
  endpointSecret: string,
  verifier: Pick<Stripe["webhooks"], "constructEvent">,
  enqueueOnce: (request: BillingReconcileRequest) => Promise<"queued" | "duplicate">,
): Promise<"queued" | "duplicate" | "ignored"> {
  const request = verifiedBillingRequest(rawBody, signature, endpointSecret, verifier);
  return request ? enqueueOnce(request) : "ignored";
}

export interface TrustedStripeBillingSnapshot {
  customerId: string;
  subscriptionId: string;
  status: "active" | "trialing" | "past_due" | "unpaid" | "paused" | "canceled" | "incomplete";
  startsAt: string;
  endsAt: string;
  settledInvoiceId?: string;
  paidThrough?: string;
  paymentReversed: boolean;
}

/** Derive access from a fresh provider read, never from a webhook's event snapshot. */
export function projectPaidStripeAccess(
  binding: { subjectId: string; customerId: string },
  current: TrustedStripeBillingSnapshot,
): HostedEntitlement | undefined {
  if (!binding.subjectId || !binding.customerId || binding.customerId !== current.customerId) {
    throw new Error("Stripe customer is not bound to the candidate");
  }
  if (current.status !== "active" || current.paymentReversed
    || !current.settledInvoiceId || !current.paidThrough) return undefined;
  return hostedEntitlementSchema.parse({
    kind: "subscription", subjectId: binding.subjectId, subscriptionId: current.subscriptionId,
    status: current.status, startsAt: current.startsAt, endsAt: current.endsAt,
    settledInvoiceId: current.settledInvoiceId, paidThrough: current.paidThrough,
  });
}

/** Run requests serially per customer. Fetch current Stripe state, not event.data. */
export async function reconcileBillingRequest(
  request: BillingReconcileRequest,
  ports: {
    loadBinding(customerId: string): Promise<{ subjectId: string; customerId: string } | undefined>;
    loadCurrent(customerId: string): Promise<TrustedStripeBillingSnapshot>;
    replaceSubscription(subjectId: string, subscriptionId: string,
      entitlement: HostedEntitlement | undefined): Promise<void>;
  },
): Promise<void> {
  const binding = await ports.loadBinding(request.customerId);
  if (!binding || binding.customerId !== request.customerId) {
    throw new Error("Stripe customer is not bound to the candidate");
  }
  const current = await ports.loadCurrent(request.customerId);
  const entitlement = projectPaidStripeAccess(binding, current);
  await ports.replaceSubscription(binding.subjectId, current.subscriptionId, entitlement);
}
