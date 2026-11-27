# Cloud application journal contract

`DurableApplicationJournal` is a DynamoDB-backed safety primitive for the
future ECS worker. This PR does not switch the existing local runner to AWS.

1. A trusted authenticated service writes a granted `CONSENT` record for a
   candidate, run ID, and monotonically increasing version. Revoking that
   version or replacing it with a newer grant blocks the old run at the
   submit-intent transaction. The worker cannot grant its own consent. The
   consent version comes from the durable, authenticated run record, not from
   an SQS message or browser page.
2. Claim a candidate lease. Only one owner token may hold an unexpired lease.
   Renew it throughout a browser batch and before the submit boundary. The
   default 120-second lease must be renewed while an SQS message remains
   invisible; the queue visibility timeout is 900 seconds and must also be
   extended for a longer batch. A lease alone does not authorize a click.
3. Verify the live employer posting and derive the job key from the official
   provider, employer, and requisition ID. `beginSubmission` atomically checks
   the live lease and current consent for the same candidate/run/version, then
   writes a non-expiring submit intent with a reserved receipt artifact ID.
   Only its first returned ID grants one final-click attempt. A worker restart, a different run ID,
   or an SQS redelivery gets false and must reconcile the employer portal or
   ask the user. It must never click Submit again automatically.
4. Save the exact-job confirmation evidence under the reserved ID in encrypted
   artifact storage. `readSubmission` exposes that same ID after a restart.
   Only after verifying it, call `confirmAfterVerification` with its opaque
   artifact ID and digest. A different lease owner may confirm after a crash,
   but cannot replace an existing receipt. An ambiguous click stays in
   `needs_reconciliation` and is not described as submitted.
5. On candidate deletion, write the non-expiring `DELETED` tombstone, stop and
   drain any active browser task, then purge queue messages and candidate
   records. Every lease and journal write checks the tombstone. Queued messages
   cannot recreate the candidate. The actual purge
   workflow must remove candidate profile, browser snapshot, artifacts, and
   non-tombstone ledger items, including S3 object versions and backups under
   the published retention policy.

The ledger stores only opaque candidate/run IDs, a hash of the official job
identity, owner tokens, consent epoch/state, timestamps, and opaque receipt
artifact ID/digest. It
does not store application answers, résumé content, provider credentials, or
confirmation HTML. Lease rows have `expiresAt` for DynamoDB TTL; submit intent,
receipt, and deletion tombstone rows deliberately do not. DynamoDB point-in-time
recovery and CloudFormation `Retain` still preserve deleted data in backups for
their retention period, so public account deletion needs a documented policy
and verification before launch.

Revocation prevents a new submit intent once it commits. If an intent was
already committed, an in-flight click may still happen; stopping and draining
the active task is a separate control-plane operation.

This protocol prefers at-most-once final-click attempts to uncertain duplicate
applications. It does not promise exactly-once submission or a 99% completion
rate. Provider reconciliation, receipt validation, crash injection against a
real DynamoDB staging table, and integration with the browser owner remain
release gates.
