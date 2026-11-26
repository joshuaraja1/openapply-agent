# Hosted Stripe event boundary (staging)

This PR supplies testable domain functions, not a deployed billing endpoint.

1. Register a **snapshot** Stripe webhook endpoint for subscription, invoice, and refund
   events. The HTTP handler must pass the unmodified raw body, `Stripe-Signature`
   header, and endpoint signing secret to `verifiedBillingRequest`. The signing
   secret comes from a server-side secret manager, never a browser or repository.
2. A signed refund may omit its customer ID. Resolve its charge through the
   trusted Stripe API before enqueueing; if resolution fails, return an error
   so the event is retried and alert an operator. Never acknowledge it as
   handled. Atomically record the verified event ID and enqueue one reconciliation
   request. The queue groups requests by Stripe customer ID so only one
   reconciliation for a customer runs at a time. A durable event ledger, not
   short queue deduplication alone, handles retries.
3. Resolve the customer ID to one candidate in a trusted tenant-scoped store.
   Fetch the **complete current set** of this customer's OpenApply subscriptions
   and invoice/payment state from Stripe;
   ignore status and payment claims in the event payload. Adapt that fresh
   provider response to `TrustedStripeBillingSnapshot` and call
   `reconcileBillingRequest`. Atomically replace **all** subscription-derived
   entitlements for that subject while preserving free grants. A plan switch,
   cancellation, or refund must remove old paid access. An active subscription
   without a settled invoice remains denied.
4. Reconcile periodically as well as on webhooks, because webhooks may be missed
   or arrive out of order. The worker must re-check entitlement before a
   candidate batch and at its final-submit authorization fence.

The current code does not implement the HTTP endpoint, provider API reader,
customer binding store, event ledger, serialized queue, periodic reconciliation,
or atomic final-submit fence. No live Stripe account or charges are involved.
Refund and dispute handling must be mapped from current provider state to
`paymentReversed`; a user-supplied value is never authoritative. The provider
reader must prove it returned a complete subscription set; partial pagination
must fail rather than delete valid paid access.

Primary guidance: [Stripe webhook signature and retry handling](https://docs.stripe.com/events/manage-webhook-endpoints),
[subscription status and invoice collection](https://docs.stripe.com/api/subscriptions/update).
