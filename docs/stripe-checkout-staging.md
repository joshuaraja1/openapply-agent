# Stripe Checkout staging boundary

`src/hosted/stripe-checkout.ts` creates a hosted Checkout Session from an
authenticated candidate ID, a trusted Stripe Customer binding, and a server-side
plan configuration. The candidate never enters a card number into OpenApply.
Stripe Checkout collects payment details.

The server must supply a durable `CheckoutPorts.reserve` implementation. It
must reject existing paid access and concurrent live checkout attempts, bind the
Stripe Customer to the authenticated candidate, and reuse the same request ID
when an HTTP retry occurs. `recordSession` must atomically bind the resulting
Checkout Session and expiry to that reservation, rejecting a different session.
After 20 hours, an unrecorded reservation needs provider reconciliation before
retry, because Stripe may later prune its idempotency key. An expired attempt
must be explicitly closed before a new one can be reserved. Never accept the candidate ID,
customer ID, price ID, success URL, or idempotency key from a browser request.

The separate OpenApply Agent Stripe sandbox has these test prices:

| Plan | Amount | Price ID | Checkout mode |
| --- | ---: | --- | --- |
| Monthly, renewing until canceled | $39 USD/month | `price_1UgCyzCVueFkF7gPR8i44Jgx` | subscription |
| Semester, four months without automatic renewal | $129 USD | `price_1UgCzICVueFkF7gPnVdBZI4q` | payment |

The adapter checks amount, currency, type, and account mode. The semester
payment needs a verified four-month entitlement projection before its Checkout
endpoint is exposed. Live prices require merchant verification, tax and
cancellation settings, and a customer support path.

This adapter does not grant access when Checkout redirects to a success page.
The signed webhook and fresh Stripe reconciliation in
`docs/hosted-billing-events.md` must establish a settled invoice and paid-through
date for monthly subscriptions. A separate verified payment reconciliation must
establish the four-month paid-through date for semester purchases. That access
must be checked at queue admission, worker start, and before
final job submission. A successful browser redirect is informational only.

The OpenApply account and test Prices exist. No Stripe key, webhook endpoint,
hosted account API, durable reservation store, or payment has been connected.
Store Stripe secret keys and webhook signing secrets in a cloud secret
manager; never commit them or put them in a client bundle.

References: [Stripe Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create),
[subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).
