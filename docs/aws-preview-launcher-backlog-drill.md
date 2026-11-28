# Preview launcher backlog drill

This proposed drill validates the deployed Fargate preview launcher with two
disposable job seeker identities. It must never contact an employer or enable
final Submit. **It is blocked on an isolated preview fixture mode:** the
current preview task accepts only verified official provider URLs and performs
real GET requests, so a `.invalid` synthetic posting cannot pass `boundJob`.
Do not seed a fake `VERIFIED` lead for a real employer URL to work around this.
The retired `openapply-staging-synthetic-queue` stack is not a prerequisite.

## Read-only preflight

Run `node scripts/aws-preview-launcher-preflight.mjs --account-id 205064803661`.
The script checks the live account, current preview task, immutable image,
submissions-disabled mode, exact stack links, Cognito issuer, run-ledger indexes,
and bounded launcher ceiling. A pass establishes structure only. Also confirm
the ECS cluster has no running disposable tasks and `SLOT#0` is clear before
changing the ceiling.

## Deployment and drill sequence

1. Add and review an isolated synthetic preview fixture in the task image and
   task definition. It must intercept only a locally served `.invalid` host,
   preserve the real preview's broker/lease/dispatch path, block every external
   request, and keep `OPENAPPLY_SUBMISSION_MODE=disabled`. Verify it cannot be
   selected through a customer request. Deploy that immutable fixture image
   to a separate disposable task revision, then point the staging launcher at
   that exact revision only for this drill.
2. Merge and deploy the reviewed lease guard, busy-seeker skip, and persisted
   cursor changes. Update only the launcher Lambda code artifact and its
   CloudFormation `CodeKey`; retain the task definition's
   `OPENAPPLY_SUBMISSION_MODE=disabled` environment. Keep the ceiling
   at one through an empty-queue sweep and a disposable one-seeker preview.
3. Confirm the launcher is on the reviewed code SHA and the preflight passes.
   Raise `MaxConcurrentBrowserTasks` from **1 to 2** in the launcher stack.
   No standing ECS task is created by this parameter change.
4. Create two short-lived, distinct staging Cognito identities and reviewed
   synthetic profiles, with exact `.invalid` fixture postings, explicit consent,
   and approved short-lived free grants. Do not use real résumés, payment cards,
   or employer URLs. Enqueue A1, A2, and B1 in that order. Require A1 and B1
   to occupy the two slots while A2 remains indexed behind A's active-task
   lock. Each task may produce only a pre-submit preview result.
5. Stop A1 before any submit intent. Require ECS `STOPPED`, a bounded fresh-token
   retry for A1, and eventual A2 progress without displacing B1. Repeat with
   B1 stopped while A remains active. Capture only opaque task/run IDs, sanitized
   dispatch and journal states, slot occupancy, queue age, and CloudWatch
   errors. The post-intent duplicate-click drill needs a separate synthetic
   task mode; preview mode cannot create submit intent.
6. Withdraw consent and request deletion for both disposable identities.
   Wait for ECS stop acknowledgement and scheduled storage cleanup. Remove
   fixture lead and entitlement rows. Restore the ceiling to one if any
   invariant fails or after the bounded drill, pending broader load testing.

At every step, stop on a cross-tenant read, an unexpected HTTP write, a task
outside the two slots, or a deletion that proceeds before ECS `STOPPED`.
Keep public admission and real submissions disabled.

## Cost envelope

The temporary second slot has no standing Fargate charge. Each running preview
task requests 1 vCPU and 4 GB RAM; two 15-minute tasks are about **$0.03** in
us-east-1 on-demand compute at AWS's published Linux/x86 rates, before image
transfer, NAT processing, CloudWatch logs, and storage. The existing NAT Gateway
continues its fixed hourly charge independently of this ceiling. Limit the
   drill to a few disposable tasks and inspect AWS billing afterward. Restore
   the launcher to the normal immutable preview task revision after cleanup.

Source: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/).
