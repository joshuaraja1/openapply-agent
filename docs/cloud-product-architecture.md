# Cloud execution for OpenApply

Status: proposed product architecture. The staging queue, ledger, and artifact
bucket are deployed. A separate one-off Fargate smoke task started Chromium and
exited successfully; no candidate browser service or application run is active.

## Decision

Use a shared AWS control plane and start an isolated ECS Fargate browser task
for each candidate batch. The candidate's laptop is a setup and handoff client,
never a required scheduler or application host. No always-on candidate VM is
part of the product architecture. Start with low concurrency in the private
beta and scale the same task contract after recovery and isolation tests pass.

The Cloudflare `openapply-wake` Worker is an optional single-user prototype. It
does not host Chromium, preserve browser sessions, or provide the product queue.
Do not merge or market it as the cloud application runner.

## Runtime boundaries

1. **Control plane:** authenticated onboarding, candidate preferences, consent,
   daily limits, handoff answers, and status. Store minimal metadata and an
   immutable audit trail. Schedule discovery with EventBridge; enqueue opaque
   candidate/run IDs in SQS. Do not put résumés, credentials, answers, or links
   with tokens into messages.
2. **Discovery:** short-lived workers collect leads and verify official employer
   postings. Deduplicate by canonical employer requisition. Rank new postings
   first, then eligible older postings up to the candidate's configured limit.
3. **Application:** launch one isolated, non-root Chromium worker per candidate
   batch. Restore its encrypted browser profile to local task disk; do not run
   Chromium directly on a shared network filesystem. Fetch candidate material
   only after a durable single-candidate lease is held. Apply through supported
   official provider adapters, with a per-job résumé and exact-requisition
   receipt check.
4. **Durability:** keep the queue, quota, handoffs, exact-job submit intent, and
   confirmed receipt in a durable store outside the browser task. Write submit
   intent before the final click. If a worker dies after that write, reconcile
   with the provider or ask the user; never click Submit again because a queue
   message was delivered twice. Store encrypted profile snapshots, résumés, and
   transcripts in object storage with per-candidate keys and deletion controls.
5. **Human handoff:** notify by email first. A signed-in web screen shows the
   exact application and question, accepts the answer or CAPTCHA/identity
   handoff, and resumes the same durable job. Never email credentials, codes,
   résumés, or application answers. Protect remote browser viewing with an
   authenticated, time-limited session; do not expose VNC/CDP to the internet.

## AWS implementation path

| Layer | First private beta | Scale path |
| --- | --- | --- |
| Jobs | SQS FIFO plus a durable run lease and exact-job journal | Same, with worker concurrency limits |
| Worker | ECS Fargate task per candidate batch, low concurrency | Same task contract with measured autoscaling |
| Browser | Non-root Chromium, local encrypted task disk | Same image and task contract |
| State | DynamoDB for leases, quota, handoffs, submit intent; S3 for encrypted artifacts/profile snapshots | Same with tenant-scoped IAM and measured capacity |
| Identity and secrets | Product login and KMS-encrypted candidate vault; AWS workload identity | Per-tenant key and access isolation audit |
| Scheduling | EventBridge to SQS | Same with backpressure and source rate limits |
| Handoff | Web UI plus Resend email | Same; SMS only after consent and delivery testing |

AWS Fargate's task disk is ephemeral. A task restart must restore from a durable
encrypted snapshot and must use the external job journal before touching a
possibly submitted application. Do not rely on a live browser tab surviving a
task crash. SQS can redeliver messages, so queue receipt alone is never proof
that a job application was submitted exactly once.

## Release gates

- No shared provider accounts or browser profiles between candidates. Test
  tenant isolation and a malicious page attempting to read another tenant's
  files or metadata. Verify Chromium sandbox support in Fargate; document and
  review the task isolation boundary before browsing untrusted sites.
- Restore a browser profile and application checkpoint after task termination.
  Crash at every submit boundary and prove zero duplicate final clicks.
- Test login, upload, conditional questions, CAPTCHA/MFA handoff, and exact-job
  receipts on consented live sites for each provider advertised.
- Measure discovery-to-application time, task startup, cost per confirmed
  application, failure and handoff rates, and daily-cap enforcement.
- Test account export/deletion, key rotation, backup/restore, signed releases,
  and independent security review before public unattended claims.

The first cloud beta must keep real submission disabled until the candidate's
verified history, preferences, account sessions, provider allowlist, and
durable submit journal are present. A cloud deployment by itself does not prove
the 99% autonomous-completion goal.

## Staging infrastructure check, 2026-11-26

CloudFormation stack `openapply-staging-control-plane` reached `CREATE_COMPLETE`
in `us-east-1`. It created `openapply-staging-application.fifo`, its dead-letter
queue, `openapply-staging-run-ledger`, and a private, versioned artifact bucket.
The queue has SQS-managed encryption, explicit deduplication IDs, a three-receive
dead-letter policy, and zero messages at the check. The artifact bucket reports
all four S3 public-access blocks enabled. This stack has no scheduled task,
consumer, or candidate data. The queue contract and recovery path still require
an end-to-end staging test before application execution can be enabled.
