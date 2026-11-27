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

On each credential request, the broker verifies the capability, checks the
current strongly consistent run and per-run consent, checks paid/free access
in the entitlement table, then assumes a dedicated data role for 900 seconds.
The inline STS session policy permits Get/Put only under that candidate's S3
artifact prefix and KMS GenerateDataKey/Decrypt only with matching OpenApply
encryption context. The data role and its session policy intersect. The broker
returns the temporary credentials through direct Lambda invocation. The
runtime refuses to use a grant for a different SQS candidate or run. It also
checks the candidate ID before any vault read or write.

The template `deploy/aws/artifact-credential-broker.yaml` creates the broker
role/function, data role, and a managed policy allowing invocation of that
function. Attach that policy to the eventual Fargate task role **without**
attaching S3 or KMS policies. The KMS key policy must delegate use to IAM roles
in this account. Package `dist-hosted/aws-artifact-credential-lambda.cjs`
with `npm run build:artifact-broker-lambda`; pass only the signing-secret ARN
to CloudFormation. Its `SecretString` is a base64-encoded random 32-byte key.

## Threat model

- A compromised candidate browser task can use its own 15-minute grant to read
  or write that candidate's artifacts. Its inline policy has no other S3
  prefix, no S3 listing/deletion, and no KMS operation without that candidate's
  encryption context. The task role itself has no direct artifact permission.
- A stolen capability can be replayed only for its encoded candidate and run,
  before its 30-minute expiry and while consent and access remain active.
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

An expired capability or revoked consent/payment prevents a new STS grant.
Previously issued credentials remain usable until their 15-minute expiry;
deletion must stop the task, wait for that maximum window or otherwise prove
the task cannot write, then purge every S3 version. The task must never log
capabilities, STS credentials, artifact bytes, or candidate facts. A broker
failure or expired grant aborts the task and leaves the durable submit journal
to decide whether reconciliation is needed. The current runtime does not
refresh grants during a long browser session; the task launcher must cap its
work below the credential lifetime or add reviewed renewal before enabling it.

## Required staging proof

1. Deploy into a disposable staging stack and use IAM simulation to show the
   task role has no S3/KMS access, while the data role has only the intended
   bucket/key ceiling.
2. Mint two synthetic candidates and verify that one task's temporary
   credentials cannot Get/Put the other's S3 key or unwrap its KMS data key.
3. Revoke consent and payment, then show renewal fails. Stop the task and
   complete the versioned-artifact deletion drill in issue #243.
4. Rotate the signing secret, ensure new capabilities use the new key, and
   invalidate old capabilities within their 30-minute maximum lifetime.

AWS documents that [STS session policies intersect role permissions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_sts-comparison.html)
and [KMS encryption context can constrain cryptographic permissions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html).
