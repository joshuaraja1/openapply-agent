# Hosted synthetic application staging drill

Status: **blocked on missing AWS resources**. This is a runbook for disposable
test identities only. It does not authorize real job submissions or establish
public release readiness. The executable preflight is read-only and must pass
before any candidate browser task is launched:

```bash
node scripts/aws-synthetic-drill-preflight.mjs --account-id 205064803661
```

The `--json` option emits machine-readable gate results without secret values.
The preflight exits 2 while a required gate is missing and exits 1 on an AWS
read error. It is a **prerequisite inventory**, not proof of tenant IAM safety
or a completed browser application. It checks the account, control plane, billing store, browser
cluster, code bucket, Cognito, onboarding/deletion, artifact and run-state
broker, synthetic task definition, launcher, and private egress. It also checks
that the task definition keeps synthetic-only mode and real submission disabled,
and that the deployed stack parameters reference the exact reviewed task,
broker, KMS key, bucket, cluster, and private subnet.
Do not bypass a failed gate by invoking ECS directly.

As of November 27, the control plane, billing, browser smoke, code bucket, and
Cognito stacks are present. The onboarding/KMS, broker, synthetic task,
launcher, and private egress stacks are absent. The no-candidate-data Chromium
image passed a temporary private-subnet Fargate smoke, and the NAT stack was
deleted after the test. That result does not exercise application state.

## Preparation and containment

1. Use the reviewed heads of the exact-routing, tenant-broker, and private
   egress PRs. Build and push one immutable browser image digest from that
   combined tree. Record the digest, task definition revision, and Git SHA.
2. Deploy candidate onboarding with a dedicated staging KMS key, deletion,
   deletion retry, and ECS stop gate enabled. The KMS key is retained by its
   template on stack deletion; plan its explicit retirement and cost before
   deploying it. Configure only a test-mode/free-grant entitlement.
3. Deploy the signed-capability broker and synthetic task role. The task role
   may invoke the named broker and must have no direct DynamoDB, SQS, S3, KMS,
   or STS permissions. Before launching a browser, use IAM policy simulation
   for those denied actions against the actual shared ledger, queue, bucket,
   and key, and confirm `lambda:InvokeFunction` is allowed only for the named
   broker. The preflight cannot establish this policy boundary. Verify its task definition has
   `OPENAPPLY_CLOUD_SYNTHETIC_ONLY=1` and
   `OPENAPPLY_SUBMISSION_MODE=disabled`.
4. Provision the private egress stack only for the test window. Record its
   subnet ID and use `AssignPublicIp=DISABLED`, the no-ingress security group,
   and an exact image digest. Add a cost alarm before recurring launches.
5. Run the local deletion stop/ack, journal recovery, and broker boundary tests
   against the exact deployment commit. Confirm the onboarding stack invokes
   candidate-wide ECS stop and its retry worker is enabled. Then enable the
   **single-slot synthetic launcher** for one controlled fixture run; this is
   the first deployed stop/ack test, so keep public candidate admission and
   real provider adapters disabled. Run preflight again and retain its
   sanitized output. If deployed deletion fails, disable new launches, stop
   the fixture task, and keep public admission closed.

## Disposable fixture seeding

Use a separate `synthetic-drill-<random>` billing subject for A and B and
derive each opaque candidate ID with `candidateIdForSubject` using the same
Cognito issuer as the staging run creator. Seed a short-lived `free-grant`
record for each subject in the **staging entitlement table**. The Dynamo item
shape is `{ pk: 'SUBJECT#<subject>', sk: 'ENTITLEMENT#<grant-id>', record:
{ kind: 'free-grant', subjectId: '<subject>', grantId: '<grant-id>',
approvedBy: 'staging-drill', startsAt: '<ISO instant>', endsAt: '<ISO instant>',
revokedAt: null } }`. Both instants must bound the short test window.
`DynamoCandidatePlanStatus.loadEntitlements(subject)` must return exactly the
seeded grant before launch; it parses the nested `record` field. Do not create
Stripe customers or payments.
Delete both grant rows during cleanup; the entitlement table has no TTL.

For each candidate, call `saveCandidateOnboarding` with a distinct submission
UUID, a minimal valid **synthetic** PDF, `careerStage=new-graduate`, one
synthetic target role and location, explicit work-authorization and sponsorship
answers, `reviewConfirmed=true`, and both consent flags true. Back it with
`CandidateVault` using the staging KMS key/private versioned bucket and
`DynamoOnboardingMarkers`. This writes the encrypted profile, checks the
upload lease and deletion fence, then verifies `PROFILE#<artifact>` only after
every encrypted object exists. The fixture must contain no real person's
résumé, transcript, email, or contact information.

Create two distinct `LEAD#<uuid>/VERIFIED` rows with
`provider=synthetic`, `employerId=fixture`, distinct alphanumeric
`requisitionId` values, `status=open`, `jobKey=officialJobKey(job)`, future
expiry, and canonical URLs under `https://fixture.openapply.invalid/apply/`.
The browser adapter intercepts that host locally and aborts every other URL.
Call `createTrustedApplicationRun` through `DynamoTrustedRunCreator` for each
subject, profile, and lead. That writes the exact `RUN#` and `CONSENT#` rows
transactionally. Then call `enqueueHostedApplication` with the same trusted
subject and durable dispatch/launcher ports. Record only opaque IDs in the
drill manifest and remove fixture leads and entitlement rows afterward.

This direct synthetic seeding proves the queue, broker, browser, and deletion
paths. It does **not** prove customer signup, Cognito login, or the hosted
onboarding UI; those need separate end-to-end evidence.

## Required scenarios

Use two disposable candidate IDs, A and B, with separate reviewed synthetic
profiles and one distinct `.invalid` requisition each. Capture sanitized
CloudWatch task IDs, dispatch states, journal states, ECS status, and broker
decision codes; never record profile bytes, credentials, capabilities, or
lease tokens.

| Scenario | Required observation |
| --- | --- |
| Two-candidate backlog | The single launcher slot starts A, leaves B queued, and starts B only after A stops. Neither task reads or alters the other's dispatch. |
| Tenant IAM denial | From A's task role, direct DynamoDB, SQS, S3, KMS, and STS calls fail. A broker request naming B's subject or job fails. |
| Pre-intent stop | Stop A before `beginSubmission`; the controller atomically marks its old task stopped, releases the slot, and queues a bounded retry with a new ECS client token. B can still progress. |
| Post-intent stop | Stop A after durable submit intent. The run enters `needs_reconciliation` and no restart clicks Submit again. |
| Confirmed crash | Stop A after exact-job receipt confirmation but before dispatch completion. The controller repairs dispatch to completed without another Submit. |
| Revocation and deletion | Withdraw A's consent while B remains active. A receives no new broker grants; its task reaches ECS `STOPPED`, active grants expire, and deletion removes all versions of A's artifacts without touching B. |
| Retry exhaustion and outage | Exhaust the two pre-intent retries and simulate a transient Dynamo read failure. Exhaustion needs operator reconciliation; the transient error retains a retryable state and never creates a second final click. |

Do not count a synthetic browser confirmation as a real employer receipt. For
every scenario, compare the durable exact-job journal with the browser's final
click count and confirm zero duplicate clicks. A failed or missing observation
keeps the launcher and public admission disabled.

## Cleanup

Stop all disposable ECS tasks, verify `STOPPED`, and complete candidate
deletion before removing temporary infrastructure. Delete the private egress
stack and confirm the NAT gateway and subnet are gone. Revoke or rotate the
test signing secret. The onboarding KMS key has `DeletionPolicy: Retain`; do
not assume stack deletion erases it. Keep the synthetic task, launcher, and
broker disabled or remove their stacks after evidence capture. Review AWS
costs and CloudWatch logs for unexpected ongoing activity.
