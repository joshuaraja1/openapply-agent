import { hostedEntitlementSchema, type HostedEntitlement } from "./entitlement.js";

export interface TrustedSemesterPayment {
  customerId: string;
  subjectId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  priceId: string;
  amountCents: number;
  currency: string;
  livemode: boolean;
  checkoutStatus: "complete" | "open" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  intentStatus: string;
  paidAt: string;
  amountRefunded: number;
  disputed: boolean;
}

export interface SemesterPlan {
  priceId: string;
  amountCents: number;
  livemode: boolean;
}

/** Add four UTC calendar months while clamping month-end dates. */
export function fourMonthsAfter(instant: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid payment instant");
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 4);
  const maxDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0))
    .getUTCDate();
  result.setUTCDate(Math.min(day, maxDay));
  return result.toISOString();
}

/** Only a fresh provider read can issue or revoke a one-time paid grant. */
export function projectSemesterPayment(
  binding: { subjectId: string; customerId: string },
  payment: TrustedSemesterPayment,
  plan: SemesterPlan,
): Extract<HostedEntitlement, { kind: "semester" }> | undefined {
  if (!binding.subjectId || binding.customerId !== payment.customerId
    || binding.subjectId !== payment.subjectId) {
    throw new Error("Stripe semester payment is not bound to the candidate");
  }
  if (payment.priceId !== plan.priceId || payment.amountCents !== plan.amountCents
    || payment.currency !== "usd" || payment.livemode !== plan.livemode) {
    throw new Error("Stripe semester payment does not match the configured plan");
  }
  if (!/^cs_[A-Za-z0-9_]+$/.test(payment.checkoutSessionId)
    || !/^pi_[A-Za-z0-9]+$/.test(payment.paymentIntentId)) {
    throw new Error("Stripe semester payment identity is invalid");
  }
  if (payment.checkoutStatus !== "complete" || payment.paymentStatus !== "paid"
    || payment.intentStatus !== "succeeded") return undefined;
  return hostedEntitlementSchema.parse({
    kind: "semester", subjectId: binding.subjectId,
    checkoutSessionId: payment.checkoutSessionId,
    paymentIntentId: payment.paymentIntentId,
    startsAt: payment.paidAt, endsAt: fourMonthsAfter(payment.paidAt),
    revokedAt: payment.amountRefunded > 0 || payment.disputed ? payment.paidAt : null,
  }) as Extract<HostedEntitlement, { kind: "semester" }>;
}

export function projectSemesterSet(
  binding: { subjectId: string; customerId: string },
  payments: readonly TrustedSemesterPayment[],
  plan: SemesterPlan,
): Extract<HostedEntitlement, { kind: "semester" }>[] {
  const seen = new Set<string>();
  const entitlements: Extract<HostedEntitlement, { kind: "semester" }>[] = [];
  for (const payment of payments) {
    if (seen.has(payment.checkoutSessionId)) {
      throw new Error("Duplicate Stripe semester payment in current state");
    }
    seen.add(payment.checkoutSessionId);
    const grant = projectSemesterPayment(binding, payment, plan);
    if (grant) entitlements.push(grant);
  }
  return entitlements;
}

/** Replace the complete current semester set; preserve free and monthly grants. */
export async function reconcileSemesterPayments(
  customerId: string,
  ports: {
    loadBinding(customerId: string): Promise<{ subjectId: string; customerId: string } | undefined>;
    loadCurrent(customerId: string): Promise<readonly TrustedSemesterPayment[]>;
    replaceSemesters(subjectId: string,
      entitlements: readonly Extract<HostedEntitlement, { kind: "semester" }>[]): Promise<void>;
  },
  plan: SemesterPlan,
): Promise<void> {
  const binding = await ports.loadBinding(customerId);
  if (!binding || binding.customerId !== customerId) {
    throw new Error("Stripe customer is not bound to the candidate");
  }
  const payments = await ports.loadCurrent(customerId);
  await ports.replaceSemesters(binding.subjectId,
    projectSemesterSet(binding, payments, plan));
}
