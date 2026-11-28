# Cloud execution for OpenApply

Status: staging architecture, not a public autonomous release. The Cloudflare
front door, AWS queue and ledger, private artifact bucket, and on-demand
Fargate launcher are deployed. The launcher currently permits one preview
browser task and forces real employer submission off. Draft submission and
handoff code has controlled tests but is not deployed as a live application
runner.

## Decision

Use a shared AWS control plane and start an isolated ECS Fargate browser task
for each admitted job seeker run. The job seeker's laptop is a setup and handoff client,
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
3. **Application:** launch one isolated, non-root Chromium worker for an admitted
   job seeker run. Restore its encrypted browser profile to local task disk; do not run
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
5. **Human handoff:** notify by email first. A signed-in web screen should show
   the exact application and blocker and collect a reviewed answer or profile
   update. A stopped Fargate task cannot restore unsent DOM edits or a selected
   upload from Playwright storage state. The current safe design stores an
   encrypted checkpoint, leaves the blocked run terminal, and creates a new
   exact-job run from a newly approved profile after fresh consent, payment,
   and posting checks. The review UI and real-site replay still need validation.
   Never email credentials, codes, résumés, or application answers. Protect
   remote browser viewing with an authenticated, time-limited session; do not
   expose VNC/CDP to the internet.

## AWS implementation path

| Layer | First private beta | Scale path |
| --- | --- | --- |
| Jobs | SQS FIFO plus a durable run lease and exact-job journal | Same, with worker concurrency limits |
| Worker | ECS Fargate task per admitted run, low concurrency | Batch multiple exact-job runs per job seeker only after recovery and cost tests |
| Browser | Non-root Chromium, local encrypted task disk | Same image and task contract |
| State | DynamoDB for leases, quota, handoffs, submit intent; S3 for encrypted artifacts/profile snapshots | Same with tenant-scoped IAM and measured capacity |
| Identity and secrets | Product login and KMS-encrypted candidate vault; AWS workload identity | Per-tenant key and access isolation audit |
| Scheduling | EventBridge to SQS | Same with backpressure and source rate limits |
| Handoff | Web UI plus Resend email | Same; SMS only after consent and delivery testing |

AWS Fargate's task disk is ephemeral. A task restart must use the external job
journal before touching a possibly submitted application. A pre-submit handoff
can restore browser cookies and local storage, but must replay the form from a
reviewed profile in a new run; it cannot restore unsent fields or file selection.
Do not rely on a live browser tab surviving a task crash. SQS can redeliver
messages, so queue receipt alone is never proof that a job application was
submitted exactly once.

## Demand scaling contract

Cloudflare Workers handle authenticated HTTP requests and can schedule or
admit a run. Creating a separate Worker deployment for every job seeker would
not create browser capacity. The browser pool is bounded by durable DynamoDB
slot reservations: each queued job seeker's run claims one free slot and one
per-job-seeker active-task lock before ECS starts a Fargate task. A scheduler
tick fills free slots from the durable dispatch index; completed tasks release
slots only after ECS reports `STOPPED`. With no queued runs, no browser task
is launched. Current staging defaults to one task and permits at most 32 after
capacity and cost validation. This is a hard ceiling, not an automatic target
that expands indefinitely.

For a paid product, capacity changes should be driven by queue age, active
users, job-seeker daily caps, task startup latency, cost per confirmed
application, provider limits, and the rate of unresolved handoffs. Define
minimum and maximum capacity and alert before queue age or spend exceeds
budget. The staging launcher currently uses a configured maximum and an
EventBridge sweep; a measured controller that adjusts that maximum is still
required for production. Increasing the ceiling alone does not make real
application submission safe or autonomous.

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

The first cloud beta must keep real submission disabled until the job seeker's
verified history, preferences, account sessions, provider allowlist, and
durable submit journal are present and the exact provider receipt is proven on
a consented live application. Current controlled Greenhouse HTML-form tests do
not establish coverage for iframe, custom-control, or cross-host forms. The
two-job-seeker scaling and crash drill, 14-day monitored beta, and independent
human security assessment remain release gates. A cloud deployment by itself
does not prove the 99% autonomous-completion goal.

## Staging infrastructure check, 2026-11-28

CloudFormation stack `openapply-staging-control-plane` reached `CREATE_COMPLETE`
in `us-east-1`. It created `openapply-staging-application.fifo`, its dead-letter
queue, `openapply-staging-run-ledger`, and a private, versioned artifact bucket.
The queue has SQS-managed encryption, explicit deduplication IDs, and a
three-receive dead-letter policy. The artifact bucket reports all four S3
public-access blocks enabled. The Fargate launcher is deployed with a one-task
ceiling and preview-only task definition; a read-only preflight found zero
running tasks and both staging slots clear. A two-job-seeker synthetic backlog
and crash drill is prepared but not yet run. No live employer submission is
enabled.
