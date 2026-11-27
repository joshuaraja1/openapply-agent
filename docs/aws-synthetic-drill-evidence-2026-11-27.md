# AWS synthetic application drill, November 27, 2026

Status: **staging fixture evidence only**. No real employer application, live
Stripe charge, or customer data was used. This does not establish public
release readiness.

## Reviewed build and deployment

- The drill used the reviewed stacked changes in PRs #262 through #266. PR
  #266 passed all 29 GitHub checks at commit `98a9c02`; two independent bug
  and security reviews found no actionable issue. Local typecheck, 14 focused
  preflight and role tests, and 855 standard tests passed. The standard suite
  skipped 276 tests; it is not a substitute for real-site validation.
- The synthetic browser image was pinned by ECR SHA-256 digest. Its task
  definition ran as an unprivileged user with
  `OPENAPPLY_CLOUD_SYNTHETIC_ONLY=1` and
  `OPENAPPLY_SUBMISSION_MODE=disabled`. The hosted launcher allowed one
  Fargate slot. Every candidate launch followed an `inventoryComplete=true`
  structural preflight and an exact task-definition revision update.
- The run-ledger migration added `gsi1` and `DeletionDueIndex` in separate
  no-replacement changes to an empty table. Each index was verified `ACTIVE`
  before candidate seeding. Staging onboarding, KMS, broker, synthetic task,
  launcher, and private egress stacks were deployed from inspected change
  sets. The temporary NAT was scoped to a single private subnet and no
  ingress security group.
- The two executed run-ledger change sets were
  `synthetic-drill-gsi1-20261127` at 08:01:02 UTC and
  `synthetic-drill-deletion-index-20261127` at 08:18:50 UTC. The first index
  was observed `ACTIVE` before the second update; both were observed `ACTIVE`
  before the onboarding change set at 09:00:47 UTC. These are observation
  bounds, not claimed completion timestamps for index backfill. The reviewed
  control-plane diff added only the index definitions and their key
  attributes; it did not replace the ledger table. The corrected broker and
  task change sets were `synthetic-drill-broker-quota-20261127` and
  `synthetic-drill-execution-role-safe-20261127`.
- The first no-candidate probe could not initialize its CloudWatch log stream
  because the existing browser smoke execution role was scoped to a different
  log group. PR #266 introduced a dedicated synthetic execution role. After
  that fix, the task-credential probe exited zero and directly confirmed
  AccessDenied for DynamoDB, SQS, S3 bucket listing, KMS, STS AssumeRole, and
  invoking an unrelated Lambda. Invoking only the named broker succeeded.
  CloudWatch returned `Throttles` sum `0.0` in the available broker and
  launcher five-minute datapoints from the bounded drill; intervals without
  datapoints were not treated as measured zeros.

## Browser and recovery observations

All five fixtures used fake résumés, fake facts, `.invalid` fixture URLs,
short-lived grants, and separate opaque tenant identities. These rows and
artifacts contain no person's application information.

| Scenario | Deployed observation |
| --- | --- |
| Two-candidate backlog | A started while B remained queued with no task row. After A stopped, a sweep released the only slot and started B. Both browser tasks exited zero, stored synthetic receipts, and had `syntheticClickAttempts=1`. |
| Crash after intent | The one-off task exited 86. Journal stayed at `submit_intent`, click audit was 0, and no receipt existed. Sweep moved dispatch to `needs_reconciliation`; repeat sweep launched no task. |
| Crash after click | The one-off task exited 86. Journal stayed at `submit_intent`, click audit was 1, and no receipt existed. Sweep moved dispatch to `needs_reconciliation`; repeat sweep launched no task. |
| Crash after confirmation | The one-off task exited 86 after the journal stored a confirmed receipt and click audit 1. Sweep repaired dispatch to `completed`; repeat sweep launched no task. |

The click audit is a durable **upper bound** written before the browser's
synthetic final click. The deployed recovery checks show the counter never
exceeded one and no second task was launched for these fixtures. They do not
prove real employer acceptance or every possible browser failure mode.

## Cleanup and remaining gates

All fixture ECS tasks reached `STOPPED`, and the launcher slot was absent.
The launcher rule was disabled before its stack was removed. The temporary
NAT stack was removed and its gateway reported `deleted`. The synthetic task
and artifact broker stacks were removed, and the temporary broker signing
secret was deleted after its consumers were gone. All five browser fixtures
reached complete deletion tombstones through the reviewed deletion API, after
their scoped grants expired. Their entitlement grants and lead rows were
removed. Strongly consistent read-only verification found each of A–E had a
`complete` tombstone, zero other candidate ledger rows, zero S3 object
versions or delete markers, and no fixture grant or lead rows.

The browser fixtures had been derived from a fixture issuer that differed from
the deployed staging Cognito issuer. The scheduled deletion retry correctly
rejected that candidate-ID mismatch and deferred the rows, even after the
grant expiry. The local cleanup harness passed each fixture's issuer to the
reviewed deletion API to finalize them. This means the browser fixture cleanup
does **not** prove the deployed scheduled retry path. A separate deletion-only
fake subject was then derived from the deployed Cognito stack output, and the
script asserted that it matched the retry Lambda configuration before writing
any state. Its scheduled deletion result is recorded below. The local seed
harness now rejects mismatched issuers before any write.

The deletion-only fixture F entered the normal 240-second hold with two fake
S3 object versions and no task or broker grant. Its tombstone became due at
10:32:03 UTC. Without a manual invocation after that time, the enabled
one-minute EventBridge retry completed it at 10:33:01 UTC. A strongly
consistent read found its `complete` tombstone, zero other candidate ledger
rows, zero S3 object versions or delete markers, and no grant or lead row.
This verifies the deployed scheduled retry and assumed purge role for a
fake subject aligned with the staging identity configuration.

The staging KMS key has `DeletionPolicy: Retain` and incurs cost until
explicitly retired. The one-minute deletion retry rule remains enabled for
the staging onboarding service.

This drill did not exercise a valid-capability cross-tenant broker call,
candidate deletion while an ECS task is still active, exhausted pre-intent
retries, or a transient DynamoDB outage. Follow-up scope is tracked in issues
#258 and #256; recurring egress cost monitoring remains in #259, and deletion
retry observability is tracked in #267. These remain release gates alongside
hosted signup and paid checkout, real provider application validation,
signed installers, a monitored beta, and independent human security review.
