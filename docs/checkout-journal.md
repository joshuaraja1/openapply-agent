# Hosted checkout journal

`DynamoCheckoutJournal` implements `CheckoutPorts` for the hosted Checkout
adapter. Its DynamoDB table needs String partition key `pk` and String sort key
`sk`, point-in-time recovery, server-side encryption, and an IAM policy limited
to this table. Store the Stripe key outside DynamoDB in a secret manager.

| Row | `pk` | `sk` | Purpose |
| --- | --- | --- | --- |
| Customer claim | `SUBJECT#<sub>` | `CUSTOMER_CLAIM` | Stable Stripe Customer idempotency key after a crash |
| Customer binding | `SUBJECT#<sub>` | `CUSTOMER` | One Customer per authenticated subject |
| Reverse binding | `CUSTOMER#<cus>` | `SUBJECT` | Resolve signed billing events to one subject |
| Checkout attempt | `SUBJECT#<sub>` | `CHECKOUT` | One open reservation per subject, regardless of plan |
| Attempt lookup | `REQUEST#<requestId>` | `CHECKOUT` | Resolve `recordSession` after a restart |
| Entitlement | `SUBJECT#<sub>` | `ENTITLEMENT#<kind>#<sourceId>` | Read by the queue gate; written only after verified billing reconciliation |
| Billing event | `BILLING_EVENT#<eventId>` | `RECONCILE` | Webhook deduplication and retry record |

The journal's `assertNoPaidAccess` callback is required. The composition root
must call the billing store's strongly validated `hasPaidAccess(subjectId)` and
throw when an active paid subscription or semester grant exists. Billing read
errors must fail closed. A free grant may upgrade to a paid plan. The server derives
`subjectId` from a verified login; neither subject nor customer IDs may come
from a browser body. Customer binding and the reverse row are committed in one
transaction. Reservation and request lookup are also committed together.
Conditional writes let concurrent same-plan requests reuse the same attempt and
reject a different plan while one attempt is open. Customer
metadata includes the durable claim ID so an unresolved claim can be located
in the Stripe dashboard for reconciliation. The Stripe
request uses that attempt ID as its idempotency key, so a lost local response
can be retried without a second Checkout Session. An unrecorded customer claim
or Checkout attempt older than 20 hours must be reconciled manually before a
retry; Stripe API v1 idempotency keys may expire after 24 hours.

An expired attempt remains in the journal. `closeReservation` reads the exact
session from Stripe and closes only when Stripe says `expired`, the Customer
matches the subject binding, and metadata matches the request ID. Then the next
reserve creates a new attempt. A completed payment remains locked for billing
reconciliation. Never infer terminal state from a
browser redirect or a local timeout. A successfully paid Checkout must be
reflected by signed billing reconciliation before queue access is granted.

The same table also needs a sparse GSI named `gsi1` with String keys `gsi1pk`
and `gsi1sk` for pending billing-event replay. Checkout rows do not project to
that index. The billing writer controls GSI attributes on event rows.
