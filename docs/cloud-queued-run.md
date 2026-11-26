# Fail-closed cloud queue bridge

`handleQueuedApplication` is a staging boundary for one received `apply` SQS
message. The message contains only opaque candidate and run IDs. A trusted
authorizer checks that the run belongs to the candidate and still has consent
before the bridge takes a lease or reads candidate data. A trusted run-record
loader supplies the verified official requisition and encrypted profile
artifact ID after a candidate lease is acquired. The bridge restores the
profile to a private temporary path and removes it after the run.

The final Submit action is available only through `PreparedApplication` after
the journal writes a non-expiring submit intent. Once intent exists, a crash,
ambiguous browser result, mismatched requisition, or receipt failure leaves
the message unacknowledged for reconciliation. A second delivery must not click
Submit. The queue receipt is deleted only after exact-job confirmation evidence
is encrypted in the vault and its digest is committed to the durable journal.

This is **not a live cloud application worker**. No SQS poller, run-record
loader, browser action, independent receipt verifier, or remote handoff service
is registered here. Production wiring must enforce candidate authorization on
the record lookup and tenant-scoped AWS credentials or a credential broker,
cap a run to one official requisition, renew leases during
long browser work, and route unresolved messages to a durable human review path
before SQS dead-lettering. Cloud logs should use event codes and opaque run IDs;
never print profile contents, application answers, receipt bodies, or tokens.

The handler intentionally favors safety over automatic retry: a crash after
intent but before a click may require a human/provider status check. A future
worker must not infer that a click did not happen from a closed tab or timeout.
