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
candidate artifacts in private S3, and the SQS receiver. The trusted run row,
not the SQS body, supplies the subject, job, and profile artifact ID. The vault
restores plaintext to an owner-only task-local file and removes it after use.
The runtime requires a separately reviewed browser adapter and an exact-job
receipt verifier; this PR supplies neither, so it cannot submit to a site.

## Enablement order

1. Finish hosted profile deletion and consent withdrawal, including worker
   interruption and purge of every S3 version (issue #243).
2. Review the browser task's IAM boundary. Giving every candidate task direct
   read access to `candidates/*` would allow a compromised task to request
   another candidate's ciphertext and KMS decryption. Use tenant-scoped
   credentials or a trusted broker that authorizes the active lease and exact
   artifact before returning bytes. Deny public CDP/VNC and task metadata
   access from untrusted browser pages.
3. Install an on-demand task launcher and a reviewed provider adapter. Bound
   task lifetime, renew the durable lease during long preparation, and extend
   SQS visibility or reconcile redelivery. Keep real submission disabled until
   crash tests prove that every post-intent restart makes zero duplicate clicks.
4. Run a disposable staging candidate through encrypted upload, one queued
   synthetic job, task kill/restart at each journal transition, exact-job
   receipt check, duplicate delivery, and deletion. Capture sanitized ledger,
   queue, and CloudWatch evidence. Only then enable low-volume consented
   real-site tests for an explicit provider allowlist.

The test in `test/aws-queue-consumer.test.ts` exercises one synthetic message,
its redelivery, and the actual SQS command boundary with an in-memory AWS
client. It proves local handler ordering, not deployed Fargate behavior.
