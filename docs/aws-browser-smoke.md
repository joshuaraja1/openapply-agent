# AWS browser staging task

`cloud/aws-browser-smoke.yaml` defines an **on-demand smoke task**, not a job
application worker. It has no ECS service, schedule, candidate-data permissions,
queue consumer, persisted candidate browser session, or exposed port. The
image command renders a local HTML page and exits. Its task role is absent; its
execution role can only pull the staging ECR image and write smoke logs.

The image comes from draft PR #207. Deploy this template first with only the
VPC ID; that creates the private ECR repository but **no task definition**.
Build and push the image, then update the stack with its **digest URI** (not a
mutable tag) as `BrowserImageUri`. For a candidate-data workload, use a private
subnet with NAT or the required VPC endpoints for ECR, S3, and CloudWatch Logs
and `AssignPublicIp: DISABLED`. The candidate-free staging smoke may use a
public subnet with `AssignPublicIp: ENABLED` when the VPC has no NAT; the
security group has no inbound rule and the container opens no listener. Run
the task manually with the stack's egress-only security group. Creating
the task definition does not start compute; running a Fargate task incurs usage
charges.

The task uses Fargate's default ephemeral storage allocation and drops Linux
capabilities. The candidate-free image ran in Fargate as described below.

## Staging evidence, November 26, 2026

The AWS `us-east-1` stack `openapply-staging-browser-smoke` created the ECR
repository, ECS cluster, 14-day log group, execution role, and egress-only
security group. The image from PR #207 was built as Linux amd64, passed the
non-root local container smoke, and was pushed to private ECR at digest
`sha256:cffffe2b26be1ccf77242791601d37d9c336e847543931b774aee46c0bb886fa`.
CloudFormation registered task definition `openapply-staging-browser-smoke:1`
using that digest. One manually started Fargate task
`72e21f028b904144b04ee9f078d534fc` exited with code 0, and its CloudWatch
log contains `Cloud browser smoke passed`. The task used a default-VPC public
subnet solely to reach ECR and Logs, with a temporary public IP, no inbound
security-group rule, no task IAM role, no candidate data, and submissions
disabled. It was not a production browser worker.

Do not use this task to apply to jobs. The Docker CI smoke used writable tmpfs
and a larger shared-memory mount. Fargate does not support those task settings;
the successful local-page render is a narrow runtime check. Real site
navigation, uploads, and checkpoint recovery still need Fargate tests before
browser jobs are allowed. The staging task's filesystem is writable for that reason;
it contains no candidate data. Its Linux capabilities are dropped, but this
does not establish a Chromium sandbox. A security review of the browser's
process boundary is required before any untrusted job page is visited.

The production task definition needs a durable single-candidate lease,
encrypted profile restore and checkpoint, an external exact-job submit journal,
tenant-scoped task IAM, cancellation and handoff, and crash/retry tests. Keep
submission disabled until those controls pass a live beta.
