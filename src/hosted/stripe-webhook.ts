import type Stripe from "stripe";
import { hostedEntitlementSchema, type HostedEntitlement } from "./entitlement.js";

const billingEvents = new Set([
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed", "charge.refunded",
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

export interface BillingReconcileRequest {
  eventId: string;
  customerId: string;
}
export interface UnresolvedChargeRequest {
  eventId: string;
  chargeId: string;
}
export type TrustedChargeResolution =
  | { kind: "customer"; customerId: string }
  | { kind: "verified-unaffiliated-guest" };

/** Verify the raw snapshot event before accepting any customer identifier. */
export function verifiedBillingRequest(
  rawBody: string | Buffer,
  signature: string,
  endpointSecret: string,
  verifier: Pick<Stripe["webhooks"], "constructEvent">,
  expectedLivemode?: boolean,
): BillingReconcileRequest | UnresolvedChargeRequest | undefined {
  if (!signature || !endpointSecret) throw new Error("Stripe webhook signature configuration is missing");
  const event = verifier.constructEvent(rawBody, signature, endpointSecret);
  if (expectedLivemode !== undefined && event.livemode !== expectedLivemode) {
    throw new Error("Stripe event mode does not match deployment");
  }
  if (!billingEvents.has(event.type)) return undefined;
  const object = event.data.object as { id?: string; customer?: string | { id?: string } | null };
  const customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
  if (event.type === "charge.refunded" && !customerId && event.id && object.id?.startsWith("ch_")) {
    return { eventId: event.id, chargeId: object.id };
  }
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
  resolveCharge?: (chargeId: string) => Promise<TrustedChargeResolution | undefined>,
  recordGuestRefund?: (request: UnresolvedChargeRequest) => Promise<void>,
  expectedLivemode?: boolean,
): Promise<"queued" | "duplicate" | "ignored" | "guest-acknowledged"> {
  const request = verifiedBillingRequest(rawBody, signature, endpointSecret, verifier,
    expectedLivemode);
  if (!request) return "ignored";
  if ("customerId" in request) return enqueueOnce(request);
  // A null customer field in the event is not proof that the refund is unrelated
  // to a candidate. The trusted reader must inspect the current charge and its
  // invoice/payment links before classifying it as an unaffiliated guest.
  const resolution = await resolveCharge?.(request.chargeId);
  if (resolution?.kind === "verified-unaffiliated-guest") {
    if (!recordGuestRefund) throw new Error("Guest refund audit port is unavailable");
    await recordGuestRefund(request);
    return "guest-acknowledged";
  }
  if (resolution?.kind !== "customer" || !resolution.customerId.startsWith("cus_")) {
    throw new Error("Refund charge customer could not be resolved");
  }
  return enqueueOnce({ eventId: request.eventId, customerId: resolution.customerId });
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

/** Run requests serially per customer. Replace the complete paid set, not one ID. */
export async function reconcileBillingRequest(
  request: BillingReconcileRequest,
  ports: {
    loadBinding(customerId: string): Promise<{ subjectId: string; customerId: string } | undefined>;
    /** Must return every current OpenApply subscription for this customer. */
    loadCurrent(customerId: string): Promise<readonly TrustedStripeBillingSnapshot[]>;
    /** Atomically replace only subscription-derived records; preserve free grants. */
    replaceSubscriptions(subjectId: string,
      entitlements: readonly Extract<HostedEntitlement, { kind: "subscription" }>[]): Promise<void>;
  },
): Promise<void> {
  const binding = await ports.loadBinding(request.customerId);
  if (!binding || binding.customerId !== request.customerId) {
    throw new Error("Stripe customer is not bound to the candidate");
  }
  const current = await ports.loadCurrent(request.customerId);
  const seen = new Set<string>();
  const entitlements: Extract<HostedEntitlement, { kind: "subscription" }>[] = [];
  for (const snapshot of current) {
    if (seen.has(snapshot.subscriptionId)) throw new Error("Duplicate Stripe subscription in current state");
    seen.add(snapshot.subscriptionId);
    const entitlement = projectPaidStripeAccess(binding, snapshot);
    if (entitlement?.kind === "subscription") entitlements.push(entitlement);
  }
  await ports.replaceSubscriptions(binding.subjectId, entitlements);
}
