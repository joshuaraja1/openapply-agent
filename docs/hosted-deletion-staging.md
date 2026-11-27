# Hosted deletion tombstone, staging slice

`POST /api/candidates/delete` is a same-origin, Cognito-authenticated route in
the optional onboarding API. It does not require an active plan. Its candidate
ID comes only from the verified issuer and subject. The first request writes a
durable `DELETED` marker before it returns `202 pending`; that marker blocks new
onboarding upload leases, run creation, queue admission consent checks, and
durable journal writes. A repeated request returns the same marker state.

Onboarding now acquires a 180-second `UPLOAD#` lease in a transaction that
checks `DELETED` is absent. A request holds the lease through all encrypted
S3 writes and the pending-to-verified marker transition, then releases it.
The onboarding Lambda's hard timeout is 60 seconds. Deletion waits at least
240 seconds after the tombstone and requires no active upload or browser-task
lease before
purging; this leaves an extra minute beyond the longest upload lease. It then
deletes all S3 object versions and delete markers under that candidate's
prefix in bounded pages, removes candidate ledger rows in bounded batches, and marks the
tombstone `complete`. Any failed step leaves the tombstone pending and a later
same-subject request retries the purge. The optional one-minute EventBridge
retry Lambda also queries a `DeletionDueIndex` for at most 25 due tombstones
per tick. It uses the same purge claim and moves pending rows to a later retry
time, so a crashed Lambda or partial S3 failure remains retryable without the
candidate returning. A conditional 120-second purge claim
prevents two requests from deleting the same candidate concurrently; the claim
is released after a completed or failed attempt. `200 complete` is returned only after
the purge and ledger cleanup finish.

The API and Cloudflare route have a separate `EnableCandidateDeletion=false`
staging default in addition to `EnableOnboarding=false`; the retry rule has its
own `EnableDeletionRetry=false` default. The sign-in site exposes a deletion
control only when `OPENAPPLY_STAGING_DELETION_ENABLED=true` at build time.
The status route requires the same signed-in subject and reports only
`none`, `pending`, or `complete`. A `503` never becomes a completion claim.
No candidate deletion was run in AWS by this PR.

The API deletion and retry Lambdas have separate DynamoDB roles. Neither has
direct S3 or KMS access. Each purge assumes a deletion-only S3 role with an
STS session policy intersecting that role's ceiling at exactly
`candidates/<verified-candidate-id>/`. The policy covers all object versions
under `artifacts/` and `runs/<run-id>/receipts/`, including delete markers,
without GetObject, PutObject, or KMS decrypt. The claim and active-writer
checks run before this role is assumed. The broker's transactionally reserved
`GRANT#` records hold the purge until the 15-minute STS credential and its
clock margin expire; malformed grants fail closed. An expired journal lease
still does not prove the ECS task stopped, so this is not the final stop barrier.

## Staging migration and rollback

Add `DeletionDueIndex` to the run ledger stack and wait for the index to become
`ACTIVE` before enabling the retry schedule. Newly written tombstones contain
the index keys atomically. If any pending tombstones were written by an older
version, reconcile those exact marker rows into the index before enabling the
schedule; legacy minimal `DELETED` rows require an authenticated owner to
adopt them and cannot safely be inferred by the scheduler. Keep all three
deletion flags off during the migration. Rollback disables the EventBridge
rule and site/API flags first. Keep the tombstone table, index, and private
artifact bucket; deleting them would lose pending deletion obligations.

## Gates before enabling

- Coordinate active browser tasks and receipt writers with deletion. The
  deletion check sees the journal's `LEASE` row, but an expired lease does not
  prove a task has stopped. A browser task with a submit intent could still
  write a receipt after the S3 purge. Add a task stop and acknowledgement
  barrier before declaring deletion complete.
- Test the candidate-facing delete/status UI with a disposable account; add
  profile edit and data export separately. Keep payment records under their
  separate retention policy.
- Test the exact AWS API, KMS, S3 version purge, interrupted upload, retry,
  and account export path end to end. Test quota and parallel uploads too.

Until those gates pass, the deletion route and hosted onboarding must stay
disabled for candidate use. A pending tombstone is a write-revocation signal,
not a claim that private data has been fully removed.
