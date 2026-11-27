# Browser task state boundary

The synthetic Fargate task role can invoke only the private artifact broker
Lambda. It has no direct DynamoDB, SQS, S3, KMS, or STS permissions. In
particular, a browser task cannot read another candidate's `TASK#` capability
or lease, remove `DELETED` tombstones, or delete the global launcher slot.

The broker uses the launcher's HMAC capability to derive the exact candidate
and run. It checks that the same capability remains in the active `TASK#` row
and that no deletion tombstone exists before each state operation. Requests
name one of the supported journal, admission, billing, or exact-dispatch
methods; arbitrary Dynamo commands and caller-supplied partition keys are
rejected. Billing reads must match the run's stored subject. Submission state
operations must match its stored official job. `beginSubmission` checks current
hosted access again, and dispatch completion requires a confirmed journal row.

This is an isolation boundary for the disabled-by-default **synthetic** cloud
task. It does not prove the authenticity of a browser-supplied employer receipt
or real-site application reliability. Keep real-site mode and multi-candidate
admission disabled until the deployed two-candidate IAM denial drill, crash
recovery, deletion drill, and independent security review are complete. This
change tracks [issue #258](https://github.com/joshuaraja1/openapply-agent/issues/258).

For the deployed drill, run `aws iam simulate-principal-policy` against the task
role for another candidate's ledger row and the global slot, then verify
actual calls from a disposable task are denied. Exercise the broker with a
second candidate's subject and official job, a stopped task, and a deleted
candidate. The trusted Lambda role retains table access and must be reviewed
separately; the browser task must never receive that role or its credentials.
