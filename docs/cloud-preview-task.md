# Cloud employer-form preview task

This is a separate, disabled-by-default Fargate task mode for a **job seeker**.
The Cloudflare Worker is the signed-in front door; Chromium runs in the private
Fargate container. `OPENAPPLY_CLOUD_TASK_MODE=preview`,
`OPENAPPLY_CLOUD_PREVIEW_ONLY=1`, and `OPENAPPLY_SUBMISSION_MODE=disabled` are
required to enter this mode. The existing synthetic task definition does not
set these values and remains synthetic-only.

The task reads one launched dispatch by its signed run capability, rechecks
consent and paid or approved free access, rejects a prior submit intent, and
acquires the run lease. The broker then revalidates the exact official ATS
posting and the reviewed profile marker. Only after that does the task request
short-lived, job seeker scoped artifact credentials and decrypt the approved
profile in private task storage. A trusted offline renderer generates and
verifies the role-specific Jake PDF before Playwright opens the employer form.

The preview fills only known fields. It blocks HTTP writes and WebSockets,
never clicks final Submit, and closes Chromium after inspection. The task
records a bounded `preview_complete` result in the durable dispatch row:
status, blocker count, PDF digest, and upload flag. Question text, profile
facts, credentials, and page content are not stored in that row or task logs.
The stopped-task reconciler treats `preview_complete` as terminal for that
task generation, so it cannot silently relaunch a completed preview.

This code is **not yet a deployable real-application service**. The browser
image now pins a static Linux Tectonic binary by SHA-256, warms the Jake cache
at build time, and runs the real offline renderer test. A separate disabled
preview task definition is in `deploy/aws/preview-task-staging.yaml`. The
image must pass its GitHub build, be published to ECR by immutable digest, and
complete a deployed staging run. The current preview closes the
browser and does not persist its page state or exact unknown question; a
resumeable encrypted handoff is required before final submission can be
enabled. Provider-specific confirmation checks and consented real-site tests
remain necessary. No result from this mode is a submitted application.
