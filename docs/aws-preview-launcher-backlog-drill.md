# Preview launcher backlog drill

This proposed drill validates the deployed Fargate launcher with two
disposable job seeker identities. It must never contact an employer or enable
real-site final Submit. The current preview task accepts only verified
official provider URLs and performs real GET requests, so a `.invalid`
synthetic posting cannot pass `boundJob`. Use the existing isolated
`SyntheticBrowserApplication` and `deploy/aws/synthetic-queue-task.yaml` for
this drill. It intercepts the exact `.invalid` fixture URL in Chromium, closes
WebSockets, and aborts every other request, while
uses the same exact-run broker, lease, dispatch, and launcher paths. The old
synthetic stack is absent today and must be redeployed from the reviewed image;
its prior evidence is not evidence of the current launcher.

## Read-only preflight

Run `node scripts/aws-preview-launcher-preflight.mjs --account-id 205064803661`.
The script checks the live account, current preview task, immutable image,
submissions-disabled mode, exact stack links, Cognito issuer, run-ledger indexes,
and bounded launcher ceiling. A pass establishes structure only. Also confirm
the ECS cluster has no running disposable tasks and both `SLOT#0` and
`SLOT#1` are clear before changing the ceiling.

## Deployment and drill sequence

1. Merge and deploy the reviewed lease guard, busy-seeker skip, and persisted
   cursor changes. Update the launcher Lambda code artifact and CloudFormation
   `CodeKey` while keeping the normal preview task and ceiling at one. Run an
   empty-queue sweep and the preview preflight again.
2. Build an immutable image from the reviewed merged tree and deploy the
   disabled-by-default `synthetic-queue-task.yaml` stack with
   `EnableSyntheticQueueTask=true`, the exact image digest, existing broker,
   private bucket, and KMS key. Verify its task role can invoke only the named
   broker and has no direct DynamoDB, SQS, S3, or KMS grants. Verify the task
   has `OPENAPPLY_CLOUD_TASK_MODE=synthetic`, the two synthetic-only flags,
   `OPENAPPLY_SUBMISSION_MODE=disabled`, and no crash stage for the backlog
   baseline. Point the launcher at this exact task revision only for the drill.
   Keep the ceiling at one through a disposable one-seeker fixture run.
3. Confirm the launcher is on the reviewed code SHA. Run the existing
   `aws-synthetic-drill-preflight.mjs` against the newly deployed synthetic
   task stack and require it to pass before any fixture is enqueued. The
   preview preflight is the before/after baseline and must pass again after
   restoring the normal task revision.
   Raise `MaxConcurrentBrowserTasks` from **1 to 2** in the launcher stack.
   No standing ECS task is created by this parameter change.
4. Create two short-lived, distinct staging Cognito identities and reviewed
   synthetic profiles, with exact `.invalid` fixture postings, explicit consent,
   and approved short-lived free grants. Do not use real résumés, payment cards,
   or employer URLs. Enqueue A1, A2, and B1 in that order. Require A1 and B1
   to occupy the two slots while A2 remains indexed behind A's active-task
   lock. Each task may click only the intercepted `.invalid` synthetic form;
   synthetic confirmations must never be presented as employer receipts.
5. Stop A1 before any submit intent. Require ECS `STOPPED`, a bounded fresh-token
   retry for A1, and eventual A2 progress without displacing B1. Repeat with
   B1 stopped while A remains active. Capture only opaque task/run IDs, sanitized
   dispatch and journal states, slot occupancy, queue age, and CloudWatch
   errors. Wait for both slots to clear before each task-definition switch.
   For post-intent and post-click crashes, set the one-off
   `SyntheticCrashAt` task parameter to `after_intent` or `after_click`, update
   the launcher's exact task revision, and rerun the synthetic preflight before
   each disposable run. Require `syntheticClickAttempts <= 1` and
   `needs_reconciliation` after either uncertain crash. Restore the no-crash
   task revision before cleanup.
6. Withdraw consent and request deletion for both disposable identities.
   Wait for ECS stop acknowledgement and scheduled storage cleanup. Remove
   fixture lead and entitlement rows. Restore the normal preview task revision
   and ceiling one, then require the preview preflight to pass. Stop the drill
   early and restore both settings if any invariant fails.

At every step, stop on a cross-tenant read, an unexpected HTTP write, a task
outside the two slots, or a deletion that proceeds before ECS `STOPPED`.
Keep public admission and real submissions disabled.

## Cost envelope

The temporary second slot has no standing Fargate charge. Each running synthetic
task requests 1 vCPU and 4 GB RAM; two 15-minute tasks are about **$0.03** in
us-east-1 on-demand compute at AWS's published Linux/x86 rates, before image
transfer, NAT processing, CloudWatch logs, and storage. The existing NAT Gateway
continues its fixed hourly charge independently of this ceiling. Limit the
drill to a few disposable tasks and inspect AWS billing afterward.

Source: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/).
