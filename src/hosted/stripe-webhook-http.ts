import type Stripe from "stripe";
import { acceptBillingWebhook, type BillingReconcileRequest,
  type TrustedChargeResolution, type UnresolvedChargeRequest } from "./stripe-webhook.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface StripeWebhookHttpPorts {
  /** Commit event ID and customer reconciliation request in one durable write. */
  enqueueOnce(request: BillingReconcileRequest): Promise<"queued" | "duplicate">;
  resolveCharge(chargeId: string): Promise<TrustedChargeResolution | undefined>;
  recordGuestRefund(request: UnresolvedChargeRequest): Promise<void>;
}

/** Acknowledgement follows durable enqueue, never a redirect or raw event value. */
export async function handleStripeWebhookHttp(
  request: Request,
  options: {
    endpointSecret: string;
    livemode: boolean;
    verifier: Pick<Stripe["webhooks"], "constructEvent">;
    ports: StripeWebhookHttpPorts;
  },
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405,
    headers: { Allow: "POST" } });
  const signature = request.headers.get("stripe-signature");
  if (!signature || !options.endpointSecret) return new Response(null, { status: 400 });
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength)
    || Number(declaredLength) > MAX_BODY_BYTES)) {
    return new Response(null, { status: 413 });
  }
  let rawBody: Buffer;
  try {
    if (!request.body) return new Response(null, { status: 400 });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* Response remains oversized. */ }
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
    rawBody = Buffer.concat(chunks, length);
  } catch { return new Response(null, { status: 400 }); }

  try {
    const event = options.verifier.constructEvent(rawBody, signature, options.endpointSecret);
    if (event.livemode !== options.livemode) return new Response(null, { status: 400 });
  } catch { return new Response(null, { status: 400 }); }

  try {
    await acceptBillingWebhook(rawBody, signature, options.endpointSecret, options.verifier,
      options.ports.enqueueOnce, options.ports.resolveCharge,
      options.ports.recordGuestRefund, options.livemode);
    return new Response(null, { status: 204 });
  } catch {
    // Stripe retries non-2xx deliveries. Never acknowledge an uncertain write.
    return new Response(null, { status: 503 });
  }
}
