# Fail-closed cloud queue bridge

`handleQueuedApplication` is a staging boundary for one received `apply` SQS
message. The message contains only opaque candidate and run IDs. A trusted
authorizer checks that the run belongs to the candidate before taking a lease.
The bridge loads only run identity and the verified official requisition to
check the durable submission status. A confirmed redelivery can be acknowledged
even if consent has since been revoked, without loading or restoring a profile.
For a new attempt, current consent is required before the profile artifact ID
is loaded. The bridge restores the profile to a private temporary path and
removes it after the run.

The future SQS poller must extend message visibility while a task runs and
must not treat `lease_busy` or `needs_reconciliation` as a successful delivery.
The staging queue currently redrives after three receives, so a persistent
reconciliation/handoff record and dead-letter monitoring are required before
live jobs are enabled.

The final Submit action is available only through `PreparedApplication` after
the journal writes a non-expiring submit intent. Once intent exists, a crash,
ambiguous browser result, mismatched requisition, or receipt failure leaves
the message unacknowledged for reconciliation. A second delivery must not click
Submit. The queue receipt is deleted only after exact-job confirmation evidence
is encrypted in the vault and its digest is committed to the durable journal.
Private profile cleanup and lease release complete before queue acknowledgment.
The journal reserves a receipt artifact ID in the same transaction as submit
intent, so reconciliation can find evidence even if the worker dies after vault
storage but before journal confirmation. The vault's create-only put rejects
rewriting that evidence.

This is **not a live cloud application worker**. No SQS poller, run-record
loader, browser action, independent receipt verifier, or remote handoff service
is registered here. Production wiring must enforce candidate authorization on
the record lookup and tenant-scoped AWS credentials or a credential broker,
cap a run to one official requisition, renew leases during
long browser work, and route unresolved messages to a durable human review path
before SQS dead-lettering. Cloud logs should use event codes and opaque run IDs;
never print profile contents, application answers, receipt bodies, or tokens.

Candidate deletion is also a release gate. S3 purge and DynamoDB tombstoning
are not one atomic operation. The deletion service must first tombstone the
candidate, stop and await any active worker, deny new vault writes, then purge
all artifact versions. A worker may otherwise write an artifact after purge.
No real candidate vault writes are wired to an executable in this staging slice.

The handler intentionally favors safety over automatic retry: a crash after
intent but before a click may require a human/provider status check. A future
worker must not infer that a click did not happen from a closed tab or timeout.
Current consent is checked again after preparation, and the journal checks the
stored consent version atomically when it writes intent. The separate second
check improves response time to revocation but cannot replace that transaction.
