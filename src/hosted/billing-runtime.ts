import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type Stripe from "stripe";
import { createOidcSubjectVerifier, handleCheckoutHttp, type OidcConfig } from "./checkout-http.js";
import { handleBillingStatusHttp } from "./billing-status-http.js";
import { assertNoPaidAccessFromBilling, DynamoCheckoutJournal } from "./checkout-journal.js";
import { DynamoBillingStore } from "./stripe-billing-store.js";
import { StripeBillingReader } from "./stripe-billing-reader.js";
import { processReadyBillingEvents } from "./stripe-billing-worker.js";
import { handleStripeWebhookHttp } from "./stripe-webhook-http.js";
import type { CheckoutConfig } from "./stripe-checkout.js";
import { handleApplicationEnqueueHttp } from "./application-enqueue-http.js";
import type { enqueueHostedApplication } from "../cloud/paid-enqueue.js";

export interface HostedBillingRuntimeConfig {
  tableName: string;
  entitlementTableName: string;
  checkout: CheckoutConfig;
  oidc: OidcConfig;
  stripeWebhookSecret: string;
}

/** One composition root for Checkout, signed events, reconciliation, and the
 * queue's entitlement reader. All paths share the same Stripe account, mode,
 * price IDs, and durable table. Secrets are supplied by the host at runtime. */
export function createHostedBillingRuntime(
  config: HostedBillingRuntimeConfig,
  db: Pick<DynamoDBDocumentClient, "send">,
  stripe: Stripe,
  applicationQueue?: Omit<Parameters<typeof enqueueHostedApplication>[3], "billing">,
) {
  if (!config.tableName || !config.entitlementTableName
    || config.tableName === config.entitlementTableName || !config.stripeWebhookSecret
    || !/^whsec_[A-Za-z0-9]+$/.test(config.stripeWebhookSecret)) {
    throw new Error("Hosted billing table and webhook secret are required");
  }
  const billing = new DynamoBillingStore(db, config.tableName,
    config.entitlementTableName);
  const journal = new DynamoCheckoutJournal(db, config.tableName, stripe,
    assertNoPaidAccessFromBilling(billing));
  const semester = { ...config.checkout.prices.semester,
    priceId: config.checkout.prices.semester.id,
    livemode: config.checkout.livemode };
  const reader = new StripeBillingReader(stripe, config.checkout.prices.monthly.id,
    semester, config.checkout.prices.monthly.amountCents);
  const verifySubject = createOidcSubjectVerifier(config.oidc);

  return {
    /** Explicit billing paths only. Redirects never grant access. */
    handleRequest(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/api/billing/checkout") return handleCheckoutHttp(request, {
        config: config.checkout, verifySubject, stripe, ports: journal,
      });
      if (path === "/api/billing/status") return handleBillingStatusHttp(request, {
        appOrigin: config.checkout.appOrigin, verifySubject,
        loadEntitlements: subjectId => billing.loadEntitlements(subjectId),
      });
      if (path === "/api/billing/stripe-webhook") return handleStripeWebhookHttp(request, {
        endpointSecret: config.stripeWebhookSecret,
        livemode: config.checkout.livemode,
        verifier: stripe.webhooks,
        ports: { enqueueOnce: event => billing.enqueueOnce(event),
          resolveCharge: chargeId => reader.resolveCharge(chargeId),
          recordGuestRefund: event => billing.recordGuestRefund(event) },
      });
      if (path === "/api/applications/enqueue") {
        if (!applicationQueue) return Promise.resolve(new Response(null, { status: 503 }));
        return handleApplicationEnqueueHttp(request, {
          appOrigin: config.checkout.appOrigin, verifySubject,
          ports: { ...applicationQueue, billing },
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
    /** A scheduled host calls this after the webhook has durably enqueued. */
    processReady(limit = 25) {
      return processReadyBillingEvents(billing, reader, semester, limit);
    },
    /** Pass this exact reader to enqueueHostedApplication and CloudRunPorts. */
    billing,
  };
}
