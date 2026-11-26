# ADR: hosted account and cloud browser boundary

**Status:** proposed. This is the target architecture for the hosted product in
[#214](https://github.com/joshuaraja1/openapply-agent/pull/214), not a deployed
system. It leaves the free self-hosted workflow intact.

## Decision

Use Cloudflare for the product domain and static candidate UI. Use AWS Cognito
User Pools managed login for consumer identity, API Gateway and Lambda for
authenticated control-plane APIs, and the existing AWS staging stack for
durable queue/state and isolated Fargate browser batches. Stripe handles hosted
billing. Candidate documents, sessions, receipts, and entitlements remain in
AWS under tenant-scoped authorization; the Cloudflare edge is not a candidate
data store or the browser runtime.

```text
Candidate browser
  ├─ Cloudflare-hosted static UI ── Cognito managed login
  └─ API Gateway JWT routes ────── Lambda control plane
                                 ├─ candidate/entitlement/consent records
Stripe signed webhooks ──────────┤
Official feeds → discovery ──────┤
                                 └─ SQS FIFO per candidate → Fargate task
                                      ├─ isolated Chromium + bounded batch
                                      ├─ encrypted candidate vault / S3
                                      └─ DynamoDB exact-job journal + receipt
```

## Trust boundaries

1. **Account.** Cognito managed login uses authorization code with PKCE. The
   API accepts scoped **access tokens**, not an email address or an unchecked
   ID token, and verifies issuer, audience/client, signature, expiry, and
   route scope. Map Cognito `sub` to an immutable internal candidate ID.
   Never derive tenant ownership from a request path alone. Candidate API
   handlers load records by the authenticated subject and recheck ownership.
   Keep access tokens short-lived and out of browser local storage; session
   renewal and logout need an explicit security-tested design.
2. **Billing.** Stripe Checkout success redirects are UI signals only. A
   separate raw-body signed webhook records an event ID idempotently and
   schedules reconciliation. Read current customer/subscription/invoice state
   from Stripe; atomically replace that candidate's paid entitlement set.
   Require settled invoice coverage, and keep revocable free grants separate.
   Check entitlement and consent before enqueue, at worker start, and inside
   the final-submit authorization transaction. Failed payment, refund,
   cancellation, and missed-webhook reconciliation must revoke access within
   a measured bound. Do not store card data.
3. **Uploads and facts.** Issue short-lived, single-candidate upload capability
   for one expected object; enforce type, size, and malware checks before
   parsing. Treat resume, transcript, job text, and LaTeX as untrusted data.
   Store source hashes and candidate-confirmed fact versions. A fact approval
   request identifies a pending server-side draft; the client cannot supply
   its own authoritative draft, evidence, or `verified` status. Exports and
   deletion require the same tenant authorization.
4. **Queue and worker.** SQS FIFO groups messages by candidate, allowing
   different candidates to progress independently. FIFO ordering and its
   short deduplication window are not a submission guarantee. A conditional
   DynamoDB lease and exact-job submit intent decide who may act. On crash
   after intent, reconcile with the employer; never blindly click Submit
   again. Dispatch a bounded Fargate batch when work exists rather than
   maintaining one idle browser per subscriber.
5. **Browser session.** The user signs into a dedicated cloud browser through
   an authenticated, private handoff. Do not expose CDP/VNC publicly, copy a
   daily Chrome profile, or transfer cookies without explicit user action.
   Store session state encrypted and tenant-bound outside the task's ephemeral
   disk. Resume attaches only to the saved candidate/job, takes a new DOM
   snapshot, and rechecks entitlement, consent, posting, and submit intent.
   CAPTCHA and MFA require a human. Browser tasks need a tested Chromium
   sandbox and either tenant-scoped AWS credentials or a narrow broker; a
   bucket-wide task role is insufficient.
6. **Deletion.** Tombstone the candidate first, fence new writes and runs,
   drain active writers, remove every version of candidate artifacts and
   session state, then verify deletion. Keep any legally required billing
   records under a distinct retention rule. Test deletion racing with a
   worker upload or paused handoff.

## Service responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Cloudflare site | Static UI and domain routing | Candidate documents, browser sessions, payment authority |
| Cognito | Sign-up, email verification, recovery, identity tokens | Application entitlement or job consent |
| API Gateway + Lambda | Verified routes, ownership, billing and run commands | Long browser tasks |
| DynamoDB | Tenant records, quotas, leases, submit intent, receipts, event ledger | Raw documents or browser files |
| SQS FIFO | Bounded candidate work and retry/DLQ routing | Exactly-once final submission |
| S3 + KMS | Encrypted candidate artifacts and session snapshots | Authorization without a tenant fence |
| Fargate | Isolated Chromium, PDF work, exact-job application batch | Permanent state or public browser endpoint |
| Stripe | Hosted payment processing | Candidate identity, job consent, final-submit authority |

## Operability and cost

Log IDs, stage, provider, duration, and failure class; omit resume contents,
answers, tokens, cookies, and full HTML. Set queue-age, DLQ, failed handoff,
uncertain submission, billing-reconcile, deletion, and tenant-denial alerts.
Measure discovery lag, time per application stage, confirmed applications,
handoff rate, and cost per confirmed application in the beta. Size batch length
and concurrency using those results before setting monthly or semester plan
limits. A Fargate task's local filesystem is ephemeral, so no candidate state
may depend on the same task restarting.

## Current evidence and gaps

- [#203](https://github.com/joshuaraja1/openapply-agent/pull/203) defines
  staging SQS, DynamoDB, and private S3; [#207](https://github.com/joshuaraja1/openapply-agent/pull/207)
  builds a non-root Chromium image; [#208](https://github.com/joshuaraja1/openapply-agent/pull/208)
  is a **submission-disabled** Fargate smoke task. These PRs are drafts.
- [#209](https://github.com/joshuaraja1/openapply-agent/pull/209)–[#213](https://github.com/joshuaraja1/openapply-agent/pull/213)
  stage a journal, encrypted vault, queue bridge, and code-level tenant wrapper.
  They do not supply a production account authorizer, scoped credential broker,
  deletion write fence, real browser connector, or receipt verifier.
- [#218](https://github.com/joshuaraja1/openapply-agent/pull/218) and
  [#222](https://github.com/joshuaraja1/openapply-agent/pull/222) stage
  entitlement and Stripe event functions. No account, live billing endpoint,
  or trusted provider reader exists. [#219](https://github.com/joshuaraja1/openapply-agent/pull/219)
  stages intake questions and fact review, without hosted UI/storage.
- There is no Cognito pool, API Gateway, hosted dashboard, installed cloud
  sign-in/handoff, deployed Fargate application worker, or consented real-site
  beta. Do not market unattended public use from these staging PRs.

## Implementation sequence and acceptance

1. Add Cognito/app-client and scoped API Gateway routes in a test account;
   test wrong issuer, audience, scope, expired token, and cross-tenant path.
2. Add tenant-bound candidate/billing stores and signed Stripe webhook endpoint;
   test duplicate/out-of-order events, unpaid `active` subscription, refunds,
   plan switch, and forged free grants.
3. Add private upload, extraction review, dashboard, export/deletion, and
   policy UI; test PII isolation and stale source-version approvals.
4. Add queue dispatcher and browser-session broker with no public CDP;
   prove live Fargate sandbox and credential scope, session restore, pause,
   crash recovery, and no duplicate final click.
5. Run a consented real-site beta, independent human security assessment,
   accessibility checks, and cost/performance review before public launch.

## Primary references

- [Cognito managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html),
  [authorization code with PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html),
  and [API Gateway JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).
- [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
  [SQS FIFO ordering/deduplication](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-key-terms.html),
  [Fargate storage](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html),
  and [ECS task IAM roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-iam-roles.html).
