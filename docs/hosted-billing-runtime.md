# Hosted billing and queue integration

`createHostedBillingRuntime` connects the OpenApply hosted billing components to
one Stripe account, one DynamoDB table, and one Cognito issuer. The host supplies
its Stripe client and secrets at runtime. The module exposes:

| Route or operation | Effect |
| --- | --- |
| `POST /api/billing/checkout` | Verifies an ID token, reserves a candidate-bound Checkout attempt, and returns a Stripe-hosted URL. |
| `POST /api/billing/stripe-webhook` | Verifies the Stripe signature on the raw request and durably queues the customer for reconciliation. |
| `POST /api/applications/enqueue` | Verifies an ID token, run ownership, current consent, and a current entitlement before placing opaque IDs on the queue. |
| `processReady()` | Reads current Stripe payment state and atomically replaces paid entitlements. |
| `billing` | Supplies the same authoritative entitlement reader to the queue consumer. |

The Checkout redirect does not grant access. A signed webhook queues work; the
scheduled reconciler obtains current Stripe state before granting or revoking
access. The browser task rechecks entitlement and consent before its final
Submit action. A billing store outage prevents a new application attempt.

Staging resource `openapply-staging-billing` is in the isolated OpenApply AWS
account. It uses on-demand DynamoDB capacity, encryption, point-in-time
recovery, and a sparse pending-event index. The scoped IAM policy is currently
unattached. A non-sensitive conditional-write/read/index smoke passed and its
row was deleted. The table is retained on stack deletion and continues to
incur usage-based storage and PITR charges until explicitly removed.

Before enabling customer traffic, deploy a TLS host for these routes, attach
only the scoped IAM policy, load Stripe test credentials and the webhook
signing secret from a secret store, mount the Cognito callback UI, and schedule
`processReady`. Connect the enqueue route to durable run ownership/consent
records and a FIFO queue. Validate real Cognito sign-in and token expiry,
test-mode Checkout and signed webhook delivery, paid access after settled
payment, refund and cancellation revocation, and a browser submission that
cannot repeat after a crash. Keep production billing and applications disabled
until these checks and the public release gates pass.
