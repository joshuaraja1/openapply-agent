import type Stripe from "stripe";

export type HostedPlan = "monthly" | "semester";

export interface CheckoutReservation {
  /** Opaque ID of an authenticated, durably reserved checkout attempt. */
  requestId: string;
  subjectId: string;
  customerId: string;
  createdAt: string;
  session?: CheckoutSessionRecord;
}

export interface CheckoutSessionRecord {
  sessionId: string;
  url: string;
  expiresAt: string;
}

export interface CheckoutPorts {
  /** Reuse an open attempt for this subject and plan. Never replace it without
   * expiring its Stripe session and closing the attempt in durable state. */
  reserve(subjectId: string, plan: HostedPlan): Promise<CheckoutReservation>;
  /** Atomically attach a session if empty or identical; reject a different ID. */
  recordSession(requestId: string, session: CheckoutSessionRecord): Promise<void>;
}

export interface CheckoutConfig {
  prices: Record<HostedPlan, { id: string; amountCents: number }>;
  /** The account mode expected by this deployment, independent of caller input. */
  livemode: boolean;
  appOrigin: string;
}

const MAX_RETRY_AGE_MS = 20 * 60 * 60 * 1000;

function validSession(record: CheckoutSessionRecord, now: number): void {
  if (!/^cs_[A-Za-z0-9_]+$/.test(record.sessionId)
    || new URL(record.url).origin !== "https://checkout.stripe.com"
    || !Number.isFinite(Date.parse(record.expiresAt))
    || Date.parse(record.expiresAt) <= now) {
    throw new Error("Stripe checkout session is invalid or expired");
  }
}

function appUrl(origin: string, path: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") throw new Error("Invalid hosted application origin");
  return new URL(path, url).toString();
}

/** Stripe Checkout owns card entry. Access is granted only by later reconciliation. */
export async function createHostedCheckout(
  subjectId: string,
  plan: HostedPlan,
  config: CheckoutConfig,
  stripe: Pick<Stripe, "prices" | "checkout">,
  ports: CheckoutPorts,
  now: Date = new Date(),
): Promise<CheckoutSessionRecord> {
  if (!subjectId.trim() || (plan !== "monthly" && plan !== "semester")) {
    throw new Error("Authenticated candidate and supported plan required");
  }
  const configuredPrice = config.prices[plan];
  const priceId = configuredPrice?.id;
  if (!/^price_[A-Za-z0-9]+$/.test(priceId ?? "")) throw new Error("Stripe price is not configured");
  if (!Number.isSafeInteger(configuredPrice.amountCents) || configuredPrice.amountCents <= 0) {
    throw new Error("Hosted plan amount is not configured");
  }
  const [successUrl, cancelUrl] = [
    appUrl(config.appOrigin, "/billing/success?session_id={CHECKOUT_SESSION_ID}"),
    appUrl(config.appOrigin, "/billing/cancel"),
  ];
  const price = await stripe.prices.retrieve(priceId);
  if (!price.active || price.livemode !== config.livemode || price.currency !== "usd"
    || (plan === "monthly"
      ? price.recurring?.interval !== "month" || (price.recurring.interval_count ?? 1) !== 1
      : price.type !== "one_time" || price.recurring !== null)
    || price.unit_amount !== configuredPrice.amountCents) {
    throw new Error("Stripe price does not match the configured hosted plan");
  }
  const reservation = await ports.reserve(subjectId, plan);
  if (reservation.subjectId !== subjectId || !/^[A-Za-z0-9_-]{1,160}$/.test(reservation.requestId)
    || !/^cus_[A-Za-z0-9]+$/.test(reservation.customerId)) {
    throw new Error("Checkout reservation is not bound to this candidate");
  }
  const nowMs = now.getTime();
  const createdMs = Date.parse(reservation.createdAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs) || createdMs > nowMs + 5 * 60_000) {
    throw new Error("Checkout reservation has an invalid creation time");
  }
  if (reservation.session) {
    validSession(reservation.session, nowMs);
    return reservation.session;
  }
  // Stripe API v1 may forget an idempotency key after 24 hours. A crash after
  // Stripe creates the session but before our journal records it must fail
  // closed rather than create a second session after the key is pruned.
  if (nowMs - createdMs >= MAX_RETRY_AGE_MS) {
    throw new Error("Checkout reservation requires reconciliation before retry");
  }
  const session = await stripe.checkout.sessions.create({
    mode: plan === "monthly" ? "subscription" : "payment",
    customer: reservation.customerId,
    client_reference_id: subjectId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { subjectId, plan, requestId: reservation.requestId },
    ...(plan === "monthly" ? { subscription_data: { metadata: { subjectId, plan } } } : {}),
  }, { idempotencyKey: `openapply-checkout-${reservation.requestId}` });
  if (!session.url || !session.expires_at) {
    throw new Error("Stripe did not return a hosted checkout session");
  }
  const record = { sessionId: session.id, url: session.url,
    expiresAt: new Date(session.expires_at * 1000).toISOString() };
  validSession(record, nowMs);
  await ports.recordSession(reservation.requestId, record);
  return record;
}
