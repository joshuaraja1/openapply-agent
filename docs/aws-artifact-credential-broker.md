# Candidate-scoped artifact credentials

Status: draft code and CloudFormation contract. The broker stack is **not
deployed**, and no Fargate browser task has this permission. Real submissions
remain disabled.

## Boundary

The Fargate task role receives permission to invoke only the artifact broker
Lambda. It must not have direct S3 or KMS permissions. A trusted task launcher
checks the durable run, retrieves a 256-bit signing key from Secrets Manager,
and mints a random, HMAC-authenticated capability for one candidate and run.
It passes that capability privately in the ECS task override; SQS carries only
opaque candidate and run IDs. The signing key stays with the launcher and
broker, never in the task. The launcher and task override are still missing;
the broker must not be deployed for candidates until they exist and have been
reviewed.

The worker obtains the journal lease before requesting credentials. On each
request, it sends the lease token with the capability. The broker verifies the
capability and strongly consistent run identity, per-run consent, live lease
owner/run/expiry, and that the job is not confirmed or uncertain. It checks
paid/free access, repeats the lease/terminal-state check, then assumes a
dedicated data role for 900 seconds. The inline STS policy permits Get only
under that candidate's reviewed `artifacts/*` input prefix and Put only under
that exact run's `runs/<runId>/receipts/*` output prefix. KMS
GenerateDataKey/Decrypt requires the candidate's OpenApply encryption context.
The data role and its session policy intersect. The broker returns temporary
credentials through direct Lambda invocation. The runtime rejects another SQS
candidate/run before reading AWS state and requests credentials only after
lease acquisition. A receipt write obtains a fresh broker grant; a confirmed,
uncertain, expired, or released lease cannot obtain another grant.

Before STS, the broker transactionally checks that no deletion tombstone exists
and writes an immutable `GRANT#<uuid>` ledger row under the candidate partition,
with `expiresAt` set 960 seconds after reservation. The 60-second margin covers
the Lambda/STS interval and clock skew beyond the 900-second STS lifetime.
Deletion must inspect these rows with strongly consistent reads and stay pending
until every row has expired. A transaction failure means no STS call. This
closes the race between checking consent and recording the outstanding grant.

The template `deploy/aws/artifact-credential-broker.yaml` creates the broker
role/function, data role, and a managed policy allowing invocation of that
function. Attach that policy to the eventual Fargate task role **without**
attaching S3 or KMS policies. The KMS key policy must delegate use to IAM roles
in this account. Package `dist-hosted/aws-artifact-credential-lambda.cjs`
with `npm run build:artifact-broker-lambda`; pass only the signing-secret ARN
to CloudFormation. Its `SecretString` is a base64-encoded random 32-byte key.

## Threat model

- A compromised candidate browser task can use its own 15-minute grant to read
  that candidate's reviewed input artifacts and write output under its own
  run's receipt prefix. It cannot overwrite the verified profile or résumé,
  list/delete S3 objects, or operate KMS for another candidate. The task role
  itself has no direct artifact permission. A compromised task with an already
  issued grant can still replace receipt objects in its run's prefix while
  that grant is valid; the confirmation digest in the durable ledger detects
  this on later reads only if consumers verify it. The public deletion and
  receipt-integrity design in issue #250 must resolve this before enablement.
- A stolen capability can be replayed only for its encoded candidate and run,
  before its 30-minute expiry and while consent, access, and that run's exact
  fenced lease remain active. A capability alone cannot renew or acquire a
  lease; a stolen capability plus the live lease token can obtain a grant
  until the lease ends or the job becomes terminal.
  Treat it as a secret in ECS overrides and task memory. A task must not expose
  its metadata endpoint or environment to an untrusted browser page.
- A compromised trusted launcher or broker can mint or grant access across
  tenants. They are the high-trust boundary and require separate review,
  narrow IAM, monitored deployments, and key rotation. No public endpoint
  invokes the broker.
- Consent or payment can change between the final durable read and STS issuance.
  The broker checks consent twice, but cannot make Dynamo and STS one atomic
  transaction. Stop the task before deletion; wait out or otherwise revoke
  outstanding credentials before declaring a full purge complete.

## Revocation and recovery

An expired capability, expired/released lease, terminal submission, or revoked
consent/payment prevents a new STS grant.
Previously issued credentials remain usable until their 15-minute expiry;
deletion must stop and confirm every active ECS task stopped, wait until all
`GRANT#` rows expire, then purge every S3 version. The current PR does not yet
have the candidate-wide ECS task stop/ack integration, so deployment and a
public deletion guarantee remain blocked. The task must never log
capabilities, STS credentials, artifact bytes, or candidate facts. A broker
failure or expired grant aborts the task and leaves the durable submit journal
to decide whether reconciliation is needed. The current runtime requests a
grant for profile read and another for receipt write; it does not refresh a
grant during a long single S3/KMS operation. Previously issued grants remain
usable for up to 15 minutes after withdrawal, so the route stays disabled.

## Required staging proof

1. Deploy into a disposable staging stack and use IAM simulation to show the
   task role has no S3/KMS access, while the data role has only the intended
   bucket/key ceiling.
2. Mint two synthetic candidates and verify that one task's temporary
   credentials cannot Get the other's S3 input, Put to any input, Put to the
   other candidate/run's receipt prefix, or unwrap its KMS data key.
3. Confirm the synthetic run and try to obtain a new grant with the old
   capability and lease token; it must fail. Repeat after lease expiry and
   after a stale owner token. Revoke consent and payment, then show renewal
   fails. Verify a delete tombstone racing with grant reservation permits
   exactly one outcome: either no grant, or a durable `GRANT#` row that keeps
   deletion pending through its expiry. Stop and confirm the task has stopped,
   then complete the versioned-artifact deletion drill in issue #243.
4. Rotate the signing secret, ensure new capabilities use the new key, and
   invalidate old capabilities within their 30-minute maximum lifetime.

AWS documents that [STS session policies intersect role permissions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_sts-comparison.html)
and [KMS encryption context can constrain cryptographic permissions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html).
