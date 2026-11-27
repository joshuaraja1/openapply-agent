# One-message AWS application task boundary

Status: code contract and synthetic tests only. There is no enabled queue
consumer or candidate application task in staging or production.

`SqsApplicationQueueReceiver` long-polls the FIFO queue for at most one message.
`runOneApplicationQueueTick` passes it to the existing durable handler, then
the task exits. A confirmed exact-job receipt is stored before `DeleteMessage`.
Redelivery after a successful submit cannot click again because the ledger is
read first. A crash after submit intent leaves the job in reconciliation.
Empty polls exit without reading candidate state. Invalid messages are not
deleted and reach the queue's dead-letter queue after its configured retries.

`createAwsQueuedRunRuntime` connects the handler to strongly consistent
entitlement and run/consent reads, the DynamoDB submit journal, KMS-wrapped
candidate artifacts in private S3, and the SQS receiver. It now requires a
launcher-minted candidate/run capability. It invokes the broker only after
acquiring the durable lease and constructs artifact clients from the returned
short-lived grant. Its receipt upload goes through the create-only broker
operation; worker credentials cannot Put to S3. See
`docs/aws-artifact-credential-broker.md`. The trusted run row,
not the SQS body, supplies the subject, job, and profile artifact ID. The vault
restores plaintext to an owner-only task-local file and removes it after use.
The next staging slice adds `SyntheticBrowserApplication` and
`SyntheticReceiptVerifier`. They use the existing owned Playwright browser on
an intercepted `.invalid` host, fill only two reviewed profile answers, and
accept only explicit confirmation containing the exact requisition ID. The
Docker entrypoint defaults to its existing smoke. Synthetic queue mode needs
three deliberate environment flags and accepts no real provider identity.
The adapter closes its private browser before the queue receipt is deleted.
This is a controlled fixture, not evidence of real ATS completion.

## Enablement order

1. Finish hosted profile deletion and consent withdrawal, including worker
   interruption and purge of every S3 version (issue #243).
2. Deploy and test the artifact credential broker. The task role must have no
   direct S3/KMS access; a 15-minute STS grant must be restricted to one
   candidate. The trusted launcher, capability distribution, cross-tenant IAM
   proof, and credential expiry behavior remain untested. Deny public CDP/VNC
   and task metadata access from untrusted browser pages.
3. Install an on-demand task launcher and a reviewed provider adapter. Bound
   task lifetime, renew the durable lease during long preparation, and extend
   SQS visibility or reconcile redelivery. Keep real submission disabled until
   crash tests prove that every post-intent restart makes zero duplicate clicks.
4. Run a disposable staging candidate through encrypted upload, one queued
   synthetic job, task kill/restart at each journal transition, exact-job
   receipt check, duplicate delivery, and deletion. Capture sanitized ledger,
   queue, and CloudWatch evidence. Only then enable low-volume consented
   real-site tests for an explicit provider allowlist.

`test/aws-queue-consumer.test.ts` exercises one synthetic message, its
redelivery, and the SQS command boundary with an in-memory AWS client.
`test/synthetic-browser-application.test.ts` runs a real Chromium final click
and redelivery when `OPENAPPLY_BROWSER_E2E=1`; CI's owned-browser job enables
it. These prove local ordering, not deployed Fargate behavior.
