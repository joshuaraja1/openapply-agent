import type Stripe from "stripe";

export type HostedPlan = "monthly" | "semester";

export interface CheckoutReservation {
  /** Opaque ID of an authenticated, durably reserved checkout attempt. */
  requestId: string;
  subjectId: string;
  customerId: string;
}

export interface CheckoutPorts {
  /** Must reject an existing paid plan or another live checkout for this subject. */
  reserve(subjectId: string, plan: HostedPlan): Promise<CheckoutReservation>;
  /** Reuse the reservation after a retry; never create a second customer binding. */
  recordSession(requestId: string, sessionId: string): Promise<void>;
}

export interface CheckoutConfig {
  prices: Record<HostedPlan, { id: string; amountCents: number }>;
  /** The account mode expected by this deployment, independent of caller input. */
  livemode: boolean;
  appOrigin: string;
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
): Promise<{ sessionId: string; url: string }> {
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
  const intervalCount = plan === "monthly" ? 1 : 4;
  if (!price.active || price.livemode !== config.livemode || price.currency !== "usd"
    || price.recurring?.interval !== "month"
    || (price.recurring.interval_count ?? 1) !== intervalCount
    || price.unit_amount !== configuredPrice.amountCents) {
    throw new Error("Stripe price does not match the configured hosted plan");
  }
  const reservation = await ports.reserve(subjectId, plan);
  if (reservation.subjectId !== subjectId || !reservation.requestId.trim()
    || !/^cus_[A-Za-z0-9]+$/.test(reservation.customerId)) {
    throw new Error("Checkout reservation is not bound to this candidate");
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: reservation.customerId,
    client_reference_id: subjectId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { subjectId, plan, requestId: reservation.requestId },
    subscription_data: { metadata: { subjectId, plan } },
  }, { idempotencyKey: `openapply-checkout-${reservation.requestId}` });
  if (!session.id.startsWith("cs_") || !session.url
    || new URL(session.url).origin !== "https://checkout.stripe.com") {
    throw new Error("Stripe did not return a hosted checkout session");
  }
  await ports.recordSession(reservation.requestId, session.id);
  return { sessionId: session.id, url: session.url };
}
