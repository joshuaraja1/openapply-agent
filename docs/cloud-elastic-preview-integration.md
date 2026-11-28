# Elastic cloud browser preview integration

OpenApply uses Cloudflare for signed-in web requests and AWS for each private
Chromium task. The browser is not a long-running Cloudflare Worker. An
authenticated job seeker creates an exact-job run, and the durable dispatch
row waits for the Fargate launcher. The launcher reserves one DynamoDB slot
and one active-task lock for that job seeker, then starts a container for the
run. A one-minute sweep fills free slots from queued runs and reconciles
stopped tasks. With no queued runs, there are no running browser containers.
The staging NAT Gateway remains provisioned and billed while idle, so this is
browser-compute scale-to-zero rather than zero total cloud cost.

The staging ceiling is one task by default and can be raised to 32 after load,
cost, and failure tests. A lower ceiling blocks new reservations without
abandoning tasks already running above it. The ceiling limits spend; it does
not promise that AWS can launch 32 tasks under the account's current quotas.
The queue age, task start failures, and stopped-task reconciliation outcomes
must be monitored before increasing it.

One deployed synthetic fixture on November 27 took about 105 seconds from ECS
task creation to container start, including about 91 seconds of image pull;
the container then ran for about 25 seconds and exited zero. This is one
staging observation, not a production latency estimate. Reuse a browser
container for a bounded job-seeker batch rather than paying this startup cost
for each application.

The preview image includes Chromium and a pinned offline PDF renderer. Its
task definition forces preview mode and disables final submission. It fills
supported fields and records a bounded preview result, then closes the
browser. User-visible pause and resume needs encrypted browser state outside
the container. Real submission also needs an exact employer confirmation
receipt and a crash test that proves a restarted task never clicks Submit
twice. These are gates before autonomous public use, not settings to enable
for a staging capacity test.

Staging evidence on November 27:

- The combined image was built by the staging CodeBuild project and pushed to
  ECR by immutable digest
  `sha256:60440be30b97e86b30a60ed01babb255e17dab44271de0bcf7f11cb1357830e0`.
- The preview task definition is `openapply-staging-browser-preview:1`. A
  private-subnet fixture task exited zero after starting Chromium. A separate
  network probe reached HTTPS and the private artifact broker, which rejected
  an invalid capability.
- A disposable active task reached `RUNNING`. The candidate-wide stop function
  requested ECS stop, then reported `stopped` only after ECS reported `STOPPED`;
  its durable slot was cleared. This exercised the stop function, not the
  authenticated deletion API.
- Two disposable run identities passed live broker checks: each capability
  read only its own run identity, a cross-subject entitlement read was denied,
  and a deletion tombstone revoked one run without revoking the other. All
  disposable ledger rows were removed.
- The staging Cloudflare Worker now routes the signed-in deletion control to
  the separate AWS onboarding API. A disposable Cognito account requested
  deletion while its Fargate fixture task was `RUNNING`: the UI reported
  `pending`, and ECS then reached `STOPPED`. After the 240-second safety hold,
  the one-minute retry marked storage cleanup `complete`, removed the task row,
  and freed the capacity slot. The authenticated UI reported completion.
- No launcher Lambda is deployed. There is no running browser task or live
  queue-to-Fargate dispatch. The test did not submit an application.

Deployment order:

1. Build the combined browser image and publish it to ECR by immutable digest.
2. Deploy the exact-run broker and verify cross-tenant denial with two test
   identities. Confirm the hosted deletion stop gate waits for ECS `STOPPED`.
3. Deploy the preview task definition with that image and broker ARN.
4. Deploy the launcher with a ceiling of one. Run a consented, synthetic
   two-job-seeker backlog and crash drill. Then raise the ceiling gradually.

See [preview task](cloud-preview-task.md) and
[launcher](aws-fargate-launcher-staging.md) for the detailed contracts.
