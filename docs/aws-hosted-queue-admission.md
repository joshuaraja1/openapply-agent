# Hosted application queue admission

The staging billing Lambda can optionally expose `POST /api/applications/enqueue`.
It verifies a Cognito ID token and exact app origin, reads a trusted candidate
run record and current consent from the DynamoDB run ledger, checks the same
durable entitlement table used by the billing reconciler, and sends an
identifier-only message to the SQS FIFO application queue. A candidate cannot
provide their billing subject, job details, or consent in the HTTP body.

The default CloudFormation setting is `EnableApplicationEnqueue=false`.
Enabling it requires the deployed run ledger name, FIFO queue URL and ARN.
The API role then receives only `GetItem` on that run ledger and `SendMessage`
on that queue. There is no application browser task or public run-creation
route in this stack. With no trusted run record, every request fails closed.

The run creator must write a strongly validated `RUN#<runId>` row under
`CANDIDATE#<candidateId>` with the Cognito subject, positive consent version,
and official employer/provider/requisition identity. The authenticated
consent service writes the corresponding `CONSENT` row through
`DurableApplicationJournal.grantConsent`. Admission reads both rows
consistently and denies a `DELETED` tombstone. The final submission journal
still checks consent and deletion atomically before reserving Submit.

Before enabling the route, deploy `cloud/aws-control-plane.yaml` in staging,
implement the trusted run creator, and test ownership, consent revocation,
entitlement loss, duplicate SQS delivery, and crash recovery against the
deployed queue and browser worker. The current staging browser execution
remains disabled. No test here establishes autonomous public readiness.
