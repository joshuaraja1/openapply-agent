# Staging Fargate launcher

`deploy/aws/fargate-launcher-staging.yaml` is disabled by default. It defines a single-slot Lambda launcher and a five-minute sweep. No candidate browser task is deployed or enabled yet. The browser image, tested task definition, deletion stop gate, and trusted run-state boundary are required before enablement.

## Exact dispatch and retries

The authenticated enqueue route validates ownership, consent, and current hosted entitlement, then writes an identifier-only `DISPATCH#<runId>` row. When the launcher is configured, this durable row is the hosted queue; the route does not send the run to shared SQS. The launcher rechecks authorization, reserves one global `LAUNCHER#staging/SLOT#0` slot, mints a candidate/run capability, and starts a private Fargate task. The trusted broker reads only that capability's exact dispatch key; the task has no direct ledger access. It never receives or acknowledges a shared SQS message, so another candidate's DLQ redrive count is untouched.

The first ECS call uses a deterministic token. An ambiguous response retries with the same token and parameters while the slot remains held. The sweep stops the task after the 15-minute staging cap and releases the slot only after ECS reports `STOPPED`. Before release, it reconciles the exact dispatch against the durable submission journal. Confirmed repairs to completed without another Submit. A pre-intent `not_started` run is reindexed for at most two fresh-token launches in the same Dynamo transaction that marks the old task stopped and frees its slot; uncertain or exhausted runs remain in `needs_reconciliation`. If reconciliation fails, the slot remains held and the next sweep retries. A busy slot leaves other candidates' rows indexed for later dispatch. Every relaunch rechecks payment and consent. An AWS outage can delay a stop, so billing alarms remain necessary.

The index scan is bounded to four pages per tick and skips malformed rows while logging only their count. The broker capability is never put in the dispatch row's body, a URL, or a log.

## Consent withdrawal and deletion

The hosted deletion path revokes consent and invokes the ECS stop gate before candidate records and encrypted artifacts are purged. It waits for `STOPPED` and broker grant expiry. AWS deployment keeps `DeletionStopGateReady=false` until this path is validated with a disposable candidate. A task stopped after submit intent remains in reconciliation; automatic retry is permitted only when the journal says no submit intent exists.

## Enablement gates

1. Deploy and verify the tenant-scoped run-state broker from draft PR #261. Its browser task role has only named-broker invoke access; a two-candidate IAM denial drill must verify this in AWS before multi-tenant use.
2. Build and test an immutable synthetic browser image and task definition, with no real-site submission mode and no browser SQS receive/delete grant.
3. Deploy to a private AWS staging environment only after deletion stop acknowledgement is verified. Test two-candidate backlog, crash before and after submit intent, entitlement and consent revocation, exact-job receipt, and no second final click. Capture sanitized Dynamo, ECS, and CloudWatch evidence.
4. Complete independent security review before any candidate beta.
