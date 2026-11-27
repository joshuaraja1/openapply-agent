# Hosted application queue admission

The staging billing Lambda can optionally expose `POST /api/applications/enqueue`.
It verifies a Cognito ID token and exact app origin, reads a trusted candidate
run record and current consent from the DynamoDB run ledger, checks the same
durable entitlement table used by the billing reconciler, and writes an
identifier-only durable dispatch row for the exact-run Fargate launcher. A candidate cannot
provide their billing subject, job details, or consent in the HTTP body.
The enqueue route initializes its own lightweight runtime from DynamoDB,
Cognito configuration, and the launcher. It does not fetch Stripe API or
webhook secrets, so a Stripe Secrets Manager outage cannot prevent an
already entitled candidate from enqueueing a run. Billing Checkout and
webhook routes retain their separate Stripe secret initialization.

The default CloudFormation setting is `EnableApplicationEnqueue=false`.
Enabling it now requires the deployed run ledger and the exact-run Fargate
launcher ARN; the browser task does not consume shared SQS. The runtime also
rejects an enabled enqueue route with no launcher, preventing a successful
HTTP response for a message that no worker will receive. With no trusted run
record, every request fails closed. Run creation remains a separate opt-in
route in this stack.

The run creator must write a strongly validated `RUN#<runId>` row under
`CANDIDATE#<candidateId>` with the Cognito subject, positive consent version,
and official employer/provider/requisition identity, plus an opaque private
profile artifact ID. Admission rejects rows missing that artifact pointer.
The trusted run creator writes the corresponding per-run `CONSENT` row in the
same transaction. Admission reads both rows consistently and denies a
`DELETED` tombstone. The final submission journal still checks consent and
deletion atomically before reserving Submit.

Before enabling the route, deploy the official-source lead writer, reviewed
candidate application profile, run creator, exact-run launcher, and protected
browser task in staging. Test ownership, consent revocation, entitlement loss,
duplicate admission, crash recovery, and provider-specific receipts. The
current public browser execution remains disabled. No test here establishes
autonomous public readiness.
