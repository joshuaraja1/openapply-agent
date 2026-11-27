import { z } from "zod";

const instant = z.iso.datetime({ offset: true });
const subscription = z.strictObject({
  kind: z.literal("subscription"),
  subjectId: z.string().min(1),
  subscriptionId: z.string().min(1),
  status: z.enum(["active", "trialing", "past_due", "unpaid", "paused", "canceled", "incomplete"]),
  startsAt: instant,
  endsAt: instant,
  // Projected only from a verified settled invoice, never from subscription.status.
  settledInvoiceId: z.string().min(1),
  paidThrough: instant,
});
const freeGrant = z.strictObject({
  kind: z.literal("free-grant"),
  subjectId: z.string().min(1),
  grantId: z.string().min(1),
  approvedBy: z.string().min(1),
  startsAt: instant,
  endsAt: instant,
  revokedAt: instant.nullable(),
});
const semester = z.strictObject({
  kind: z.literal("semester"),
  subjectId: z.string().min(1),
  checkoutSessionId: z.string().regex(/^cs_[A-Za-z0-9_]+$/),
  paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9]+$/),
  startsAt: instant,
  endsAt: instant,
  revokedAt: instant.nullable(),
});

/** Records must be read from the trusted server store, never from a client request. */
export const hostedEntitlementSchema = z.discriminatedUnion("kind", [subscription, freeGrant, semester]);
export type HostedEntitlement = z.infer<typeof hostedEntitlementSchema>;

export interface HostedAccess {
  kind: HostedEntitlement["kind"];
  sourceId: string;
  accessUntil: string;
}

export class HostedAccessDeniedError extends Error {
  constructor() { super("Hosted access unavailable"); }
}

function accessUntil(record: HostedEntitlement): string {
  return record.kind === "subscription" && Date.parse(record.paidThrough) < Date.parse(record.endsAt)
    ? record.paidThrough : record.endsAt;
}

/** The same gate must run before enqueue and again before starting browser work. */
export function requireHostedAccess(
  subjectId: string,
  storedRecords: readonly unknown[],
  now: Date = new Date(),
): HostedAccess {
  if (!subjectId.trim() || !Number.isFinite(now.getTime())) throw new HostedAccessDeniedError();
  // A damaged record makes the whole account's authorization state uncertain.
  const records = storedRecords.map((record) => hostedEntitlementSchema.parse(record));
  const eligible = records.filter((record) => record.subjectId === subjectId
    && Date.parse(record.startsAt) <= now.getTime()
    && now.getTime() < Date.parse(record.endsAt)
    && (record.kind !== "subscription" || now.getTime() < Date.parse(record.paidThrough))
    && Date.parse(record.startsAt) < Date.parse(record.endsAt)
    && (record.kind === "subscription" ? record.status === "active" :
      record.revokedAt === null));
  if (!eligible.length) throw new HostedAccessDeniedError();
  eligible.sort((a, b) => Date.parse(accessUntil(b)) - Date.parse(accessUntil(a)));
  const chosen = eligible[0]!;
  return { kind: chosen.kind,
    sourceId: chosen.kind === "subscription" ? chosen.subscriptionId
      : chosen.kind === "semester" ? chosen.checkoutSessionId : chosen.grantId,
    accessUntil: accessUntil(chosen) };
}
