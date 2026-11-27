# Stripe Checkout staging boundary

`src/hosted/stripe-checkout.ts` creates a hosted Checkout Session from an
authenticated candidate ID, a trusted Stripe Customer binding, and a server-side
plan configuration. The candidate never enters a card number into OpenApply.
Stripe Checkout collects payment details.

The server must supply a durable `CheckoutPorts.reserve` implementation. It
must reject existing paid access and concurrent live checkout attempts, bind the
Stripe Customer to the authenticated candidate, and reuse the same request ID
when an HTTP retry occurs. `recordSession` must durably bind the resulting
Checkout Session ID to that reservation. Never accept the candidate ID,
customer ID, price ID, success URL, or idempotency key from a browser request.

Configure two active USD recurring Prices in **Stripe test mode** before using
this adapter. Monthly is one month; a semester Price is four months. The exact
amounts and semester renewal terms require a product decision before any live
price is published. The configured expected amount is checked against the
retrieved Stripe Price, so a wrong Price ID fails closed. Only replace test IDs
with live IDs after the terms, tax treatment, and cancellation flow are ready.

This adapter does not grant access when Checkout redirects to a success page.
The signed webhook and fresh Stripe reconciliation in
`docs/hosted-billing-events.md` must establish a settled invoice and paid-through
date. That access must be checked at queue admission, worker start, and before
final job submission. A successful browser redirect is informational only.

No Stripe account, Price, API key, webhook endpoint, or payment has been created
by this PR. The hosted account/API and durable reservation store are still
required. Store Stripe secret keys and webhook signing secrets in a cloud secret
manager; never commit them or put them in a client bundle.

References: [Stripe Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create),
[subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).
