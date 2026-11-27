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
same-subject request retries the purge. A conditional 120-second purge claim
prevents two requests from deleting the same candidate concurrently; the claim
is released after a completed or failed attempt. `200 complete` is returned only after
the purge and ledger cleanup finish.

The API and Cloudflare route have a separate `EnableCandidateDeletion=false`
staging default in addition to `EnableOnboarding=false`; enabling intake alone
does not expose deletion. No candidate deletion was run in
AWS by this PR. The route has no hosted UI control yet.

## Gates before enabling

- Add an automatic durable retry trigger for pending deletions. The current
  request-driven retry cannot guarantee completion if the user leaves after a
  crash or after the 240-second hold.
- Coordinate active browser tasks and receipt writers with deletion. The
  deletion check sees the journal's `LEASE` row, but an expired lease does not
  prove a task has stopped. A browser task with a submit intent could still
  write a receipt after the S3 purge. Add a task stop and acknowledgement
  barrier before declaring deletion complete.
- Add a candidate-facing withdraw/edit/delete UI and test it with a disposable
  account. Keep payment records under their separate retention policy.
- Test the exact AWS API, KMS, S3 version purge, interrupted upload, retry,
  and account export path end to end. Test quota and parallel uploads too.

Until those gates pass, the deletion route and hosted onboarding must stay
disabled for candidate use. A pending tombstone is a write-revocation signal,
not a claim that private data has been fully removed.
