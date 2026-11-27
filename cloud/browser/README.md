# Browser container staging check

The default command runs a local HTML smoke test through the existing owned
Chromium runtime. It neither processes a candidate nor submits an application.
CI builds it and starts it as a non-root user with a read-only image filesystem
and temporary writable directories. Nothing in this check needs a candidate
key, site session, or AWS credential.
CI also runs `OPENAPPLY_CLOUD_TASK_MODE=fixture` in the same isolated image.
That diagnostic exercises the synthetic browser form and receipt verifier
with disposable hardcoded data, still without AWS or employer traffic.

There is an opt-in **synthetic-only** queue mode for a disposable staging
candidate. Set `OPENAPPLY_CLOUD_TASK_MODE=synthetic`,
`OPENAPPLY_CLOUD_SYNTHETIC_ONLY=1`, and
`OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK=1`, plus `AWS_REGION`,
`OPENAPPLY_RUN_LEDGER_TABLE`, `OPENAPPLY_ENTITLEMENT_TABLE`,
`OPENAPPLY_ARTIFACT_BUCKET`, `OPENAPPLY_ARTIFACT_KMS_KEY_ARN`, and
`OPENAPPLY_APPLICATION_QUEUE_URL`. The task receives at most one message and
exits. It accepts only the `synthetic` / `fixture` job identity; the browser
intercepts the `.invalid` fixture host and blocks every other request. The
reviewed profile must belong to the run's candidate and contain explicit
automation consent. The existing queue handler checks current billing and
consent, writes the durable submit intent before the one final click, verifies
an exact requisition receipt, then acknowledges SQS. Browser and plaintext
profile temporary files are closed/removed on every return path.

The image is **not a production application worker**. The AWS runtime here
still uses the broad staging artifact ports from its base PR. Restack on the
tenant-scoped credential broker (#248) and trusted receipt writer (#252), wire
the reviewed on-demand launcher (#251), and prove an actual Fargate kill/retry
and deletion drill before enabling synthetic queue mode in AWS. No real-site
mode exists in this image. A later provider adapter needs a reviewed official
lead URL, a login handoff, long-run lease/SQS visibility renewal, provider
receipt proof, and a separate security review.
