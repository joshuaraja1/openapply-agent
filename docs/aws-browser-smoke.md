# AWS browser staging task

`cloud/aws-browser-smoke.yaml` defines an **on-demand smoke task**, not a job
application worker. It has no ECS service, schedule, candidate-data permissions,
queue consumer, persisted candidate browser session, exposed port, or public IP configuration. The
image command renders a local HTML page and exits. Its task role is absent; its
execution role can only pull the staging ECR image and write smoke logs.

The image comes from draft PR #207. Deploy this template first with only the
VPC ID; that creates the private ECR repository but **no task definition**.
Build and push the image, then update the stack with its **digest URI** (not a
mutable tag) as `BrowserImageUri`. Use a private subnet with NAT or the required
VPC endpoints for ECR, S3, and CloudWatch Logs. Run the task manually using
`AssignPublicIp: DISABLED` and the stack's egress-only security group. Creating
the task definition does not start compute; running a Fargate task incurs usage
charges.

The task uses Fargate's default ephemeral storage allocation. AWS documents
`capabilities.drop` with `ALL` as supported for Fargate task definitions, but
this exact image and task combination has not yet been run in Fargate.

Do not use this task to apply to jobs. The Docker CI smoke used writable tmpfs
and a larger shared-memory mount. Fargate does not support those task settings,
so Chromium must be measured in the real Fargate environment before browser
jobs are allowed. The staging task's filesystem is writable for that reason;
it contains no candidate data. Its Linux capabilities are dropped, but this
does not establish a Chromium sandbox. A security review of the browser's
process boundary is required before any untrusted job page is visited.

The production task definition needs a durable single-candidate lease,
encrypted profile restore and checkpoint, an external exact-job submit journal,
tenant-scoped task IAM, cancellation and handoff, and crash/retry tests. Keep
submission disabled until those controls pass a live beta.
