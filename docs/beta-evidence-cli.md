# Private beta evidence recorder

This CLI supports the monitored beta protocol. It does not run a beta, prove a
real-site submission, or replace the candidate's completed consent form. Keep
that signed form privately. The JSON inputs below must be private files (mode
`0600` on macOS/Linux, private ACL on Windows); set their absolute path in
`OPENAPPLY_BETA_INPUT`. The recorder uses the existing OS-held state key and
writes `~/.openapply-agent/beta-evidence.enc.json`. It does not create a key.

Record explicit consent before collecting an observation:

```json
{"kind":"consent","participantId":"candidate-1","recordedAt":"2026-11-26T12:00:00.000Z","approvedProviders":["greenhouse"],"dailyCap":2,"automaticSubmission":true,"monitoringAccepted":true,"browserSessionApproved":true,"candidateAcknowledged":true,"retentionDays":30}
```

Run `openapply beta:evidence consent`. Set `withdrawnAt` to record a withdrawal;
withdrawn consent cannot be reactivated by overwriting it. Stop scheduled runs
as well. A new consent after withdrawal requires a new participant alias and
new private signed form.

After a controlled run, record a job observation with the exact saved job ID:

```json
{"kind":"observation","participantId":"candidate-1","runId":"run-1","jobId":"gh:123","provider":"greenhouse","os":"macos","recordedAt":"2026-11-26T12:01:00.000Z","outcome":"submitted","failureCategory":"none","retryCount":0,"crashCount":0,"stageLatencyMs":{"application":2450}}
```

Run `openapply beta:evidence observe`. The recorder reads the existing
application checkpoint, checks consent and exact job identity, derives the URL
SHA-256 and confirmation-present flag, and refuses an unconfirmed `submitted`
claim. A run/job pair is immutable to prevent quiet evidence replacement.
Stage timings are measured by the operator; they are not automatic telemetry.
Never put names, email addresses, URLs, receipts, answers, or résumé text into
an input. The strict schema rejects extra fields.

`openapply beta:evidence summary` emits provider counts only. It omits aliases,
job IDs, URLs, and receipt text. The encrypted ledger is included in local
state export, quarantine, restore, and permanent deletion. Private export files
contain plaintext records; protect them with the existing state-control process.
