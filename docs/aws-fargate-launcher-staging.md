# Staging Fargate launcher

`deploy/aws/fargate-launcher-staging.yaml` is disabled by default in source. It defines a bounded browser pool and a one-minute sweep. `MaxConcurrentBrowserTasks` defaults to 1 and is capped at 32. This is a capacity ceiling, not a standing number of tasks: idle slots consume no Fargate task capacity. In the staging AWS account the launcher is now deployed at **one slot** after the live two-identity broker drill, authenticated active-task deletion test, and private network probe passed. Its empty-queue sweep returned `empty` and started zero tasks. A two-job-seeker backlog and crash drill still gate an increase above one slot.

## Exact dispatch and retries

The authenticated enqueue route validates ownership, consent, and current hosted entitlement, then writes an identifier-only `DISPATCH#<runId>` row. When the launcher is configured, this durable row is the hosted queue; the route does not send the run to shared SQS. The launcher rechecks authorization, reserves an available `LAUNCHER#staging/SLOT#<n>` row and a per-job-seeker `ACTIVE_TASK` row in one Dynamo transaction, mints a job-seeker/run capability, and starts a private Fargate task. The lock limits each job seeker to one browser task at a time while different job seekers can run in parallel. The trusted broker reads only that capability's exact dispatch key; the task has no direct ledger access. It never receives or acknowledges a shared SQS message, so another job seeker's DLQ redrive count is untouched.

The first ECS call uses a deterministic token. An ambiguous response retries with the same token and parameters while its slot remains held. The sweep inspects all 32 possible slots, including ones occupied before a capacity reduction. It stops each task after the 15-minute staging cap and releases its slot and job-seeker lock only after ECS reports `STOPPED`. Before release, it reconciles the exact dispatch against the durable submission journal. Confirmed repairs to completed without another Submit. A pre-intent `not_started` run is reindexed for at most two fresh-token launches in the same Dynamo transaction that marks the old task stopped and frees its slot; uncertain or exhausted runs remain in `needs_reconciliation`. If reconciliation fails, the slot remains held and the next sweep retries. A full pool leaves other job seekers' rows indexed for later dispatch. Every relaunch rechecks payment and consent. An AWS outage can delay a stop, so billing alarms remain necessary.

Each sweep launches pending runs only up to the configured ceiling. The authenticated enqueue path can also trigger the launcher immediately; parallel invocations compete on conditional Dynamo writes, so they cannot overbook a slot. Lowering the ceiling stops new reservations above the new limit but does not kill existing tasks; the sweep still monitors them. Scale the ceiling gradually after measuring queue age, task start failures, Fargate spend, and the rate of paused or uncertain applications. Cloudflare Workers scale the HTTP control plane; they do not host Chromium. This pool is a bounded staging implementation, not a verified production autoscaler.

Before raising a deployment from the legacy one-slot launcher, wait for all old tasks to reach `STOPPED` and for `SLOT#0` to clear. Legacy reservations did not create `ACTIVE_TASK` locks. New reservations create that lock in the same transaction as the slot and run row.

The index scan is bounded to four pages per tick and skips malformed rows while logging only their count. The broker capability is never put in the dispatch row's body, a URL, or a log.

## Consent withdrawal and deletion

The hosted deletion path revokes consent and invokes the ECS stop gate before candidate records and encrypted artifacts are purged. It waits for `STOPPED` and broker grant expiry. AWS deployment keeps `DeletionStopGateReady=false` until this path is validated with a disposable candidate. A task stopped after submit intent remains in reconciliation; automatic retry is permitted only when the journal says no submit intent exists.

## Enablement gates

1. Deploy and verify the tenant-scoped run-state broker from draft PR #261. Its browser task role has only named-broker invoke access; a two-candidate IAM denial drill must verify this in AWS before multi-tenant use.
2. Build and test an immutable synthetic browser image and task definition, with no real-site submission mode and no browser SQS receive/delete grant.
3. Deploy to a private AWS staging environment only after deletion stop acknowledgement is verified. Test two-candidate backlog, crash before and after submit intent, entitlement and consent revocation, exact-job receipt, and no second final click. Capture sanitized Dynamo, ECS, and CloudWatch evidence.
4. Complete independent security review before any candidate beta.
