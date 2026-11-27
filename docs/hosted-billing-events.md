# Hosted Stripe billing events (staging)

This PR supplies testable domain functions, not a deployed billing endpoint.

1. Register a **snapshot** Stripe webhook endpoint for subscription, invoice, and refund
   events. The HTTP handler must pass the unmodified raw body, `Stripe-Signature`
   header, and endpoint signing secret to `verifiedBillingRequest`. The signing
   secret comes from a server-side secret manager, never a browser or repository.
2. A signed refund may omit its customer ID. Resolve its charge through the
   trusted Stripe API before enqueueing. The resolver must inspect invoice and
   payment links as well as the charge's customer field. A charge proven to be
   unaffiliated with any candidate is recorded in a durable, idempotent audit
   before acknowledgement. A transient lookup failure returns an error so the
   event is retried and an operator is alerted; it is never acknowledged as a
   guest refund. Atomically record a candidate-linked event ID and enqueue one reconciliation
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

The code in this PR implements the HTTP handler, provider API reader, guest audit,
event ledger, and per-customer serialized replay. A separate composition root
must connect the route, secret manager, scheduler, checkout journal, and queue
access check. No production billing route or live charges are involved.
The sparse `gsi1` pending-event index and staging table are defined in
`deploy/aws/hosted-billing-table.yaml`; no table scan is used. Semester access
begins at the paid charge timestamp, lasts four UTC calendar months, and is
revoked on refund or dispute. `DynamoBillingStore.loadEntitlements` is the
authoritative queue read; `hasPaidAccess` is the Checkout guard.
A signed event with a missing Customer binding gets a five-minute grace window
for the Checkout transaction to commit. After that, the worker records a
durable quarantine reason and removes it from the pending index. An operator
must investigate or backfill it if a binding appears later. Quarantine never
grants access and never blocks later events in the same replay batch.
An external employer Submit click cannot be atomic with a Stripe webhook.
The queue must recheck access at its durable submit intent, and a revocation
may still race with a click already in flight.
Refund and dispute handling must be mapped from current provider state to
`paymentReversed`; a user-supplied value is never authoritative. The provider
reader must prove it returned a complete subscription set; partial pagination
must fail rather than delete valid paid access.

Primary guidance: [Stripe webhook signature and retry handling](https://docs.stripe.com/events/manage-webhook-endpoints),
[subscription status and invoice collection](https://docs.stripe.com/api/subscriptions/update).
