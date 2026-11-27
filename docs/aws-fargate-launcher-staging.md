# Staging Fargate launcher

`deploy/aws/fargate-launcher-staging.yaml` is disabled by default. It creates a
single staging Lambda with a five-minute sweep, narrow ECS/IAM permissions, and
no browser task definition or ongoing ECS service. The billing API must be
updated with its output ARN separately. The existing smoke image is **not** a
queue worker; do not enable this template with the smoke task definition.

## Dispatch and retries

The authenticated enqueue route validates ownership, current consent, and
current hosted entitlement. It sends an identifier-only FIFO message first.
Only after SQS accepts the message does the optional launcher Lambda receive
the candidate and run IDs. The launcher rechecks consent and entitlement,
atomically writes a `TASK#<runId>` row and the sole non-expiring
`LAUNCHER#staging/SLOT#0` reservation in the run ledger, and calls ECS
`RunTask` with `count=1`, a deterministic 64-character client token, a private
subnet, and no public IP. The signing capability is minted by the launcher,
stored in the encrypted ledger row, and sent only in the ECS task override.
It is never put in SQS, a URL, or a log. The worker must claim the fenced journal
lease before it asks the broker for candidate-scoped artifact credentials.

An ambiguous ECS timeout retains the reservation. A retry within 20 minutes
uses the exact original capability and `RunTask` parameters. ECS documents
that an equal client token and parameters are idempotent, with a maximum token
TTL of 24 hours. After 20 minutes, the launcher fails closed for operator
reconciliation. The scheduled sweep looks up the task by `startedBy=runId`,
records its ARN, stops it when the reservation reaches 15 minutes, and only
releases the slot after ECS reports `STOPPED`. An ambiguous reservation older
than 20 minutes is cleared only when ECS lists no active tasks in the dedicated
browser cluster. Missing or contradictory ECS state retains the slot; it cannot
produce a speculative second task. This sweep is a best-effort duration limit:
an AWS outage can delay `StopTask`, so billing alarms remain necessary.

If the slot is busy, the enqueue API returns a retryable error while the SQS
message stays durable. **Automatic backlog dispatch is not yet implemented.**
The caller must retry enqueue after the slot clears, or a future durable
dispatcher must scan queued runs without receiving SQS messages. Do not use an
SQS receive merely to inspect the queue: each receive consumes a redrive
attempt. The current queue sends a message to the DLQ after three receives.
An ambiguous launch reconciled as unlaunched needs a new authorized dispatch
attempt; it is not silently claimed as completed.

## Consent withdrawal and deletion

The deletion orchestrator must first revoke run consent and stop new enqueue.
It then calls `stopCandidateFargateTask` and repeats until every candidate
`TASK#` row is `stopped` and the global slot is clear. That function calls
`StopTask`, observes `DescribeTasks` `STOPPED`, and keeps an ambiguous or
unlaunched reservation fenced. Only then may deletion purge candidate rows
and encrypted artifacts, subject also to the credential broker's grant expiry
fence. This hook is **not wired into the current deletion route**; keep
hosted deletion and launch disabled until the stop/ack integration is tested.
If the task was stopped after a durable submission intent, the application
journal remains in `needs_reconciliation`; no automatic second Submit occurs.

## Enablement gates

1. Build and test an actual single-message browser worker image. Its task role
   may read the run ledger and receive from SQS and invoke the scoped artifact
   broker, but it must have no direct S3 or KMS access.
2. Prove that the private subnets have controlled ECR, CloudWatch, SQS, Dynamo,
   Lambda, and employer-site egress. Register that exact image digest and task
   definition; pass only those ARNs to the launcher template.
3. Wire the deletion stop/ack hook, then run a deployed crash/retry, consent
   revocation, entitlement loss, and task duration test with synthetic data.
4. Add a durable backlog dispatcher and confirmed queue-to-task telemetry.
   Turn on `EnableFargateLauncher` and set the billing stack's
   `FargateLauncherArn` only after these tests pass.

No real application submission or AWS deployment is part of this change.
