# Private beta evidence recorder

This CLI supports the monitored beta protocol. It does not run a beta, prove a
real-site submission, or replace the candidate's completed consent form. Keep
that signed form privately. The JSON inputs below must be private files (mode
`0600` on macOS/Linux, private ACL on Windows); set their absolute path in
`OPENAPPLY_BETA_INPUT`. The recorder uses the existing OS-held state key and
writes `~/.openapply-agent/beta-evidence.enc.json`. It does not create a key.

Record explicit consent before collecting an observation:

```json
{"kind":"consent","participantId":"candidate-1","approvedProviders":["greenhouse"],"dailyCap":2,"automaticSubmission":true,"monitoringAccepted":true,"browserSessionApproved":true,"candidateAcknowledged":true,"retentionDays":30}
```

Run `openapply beta:evidence consent`. The recorder assigns its own timestamp;
the input cannot backdate consent. To withdraw, provide a private input
`{"participantId":"candidate-1"}` and run `openapply beta:evidence withdraw`.
Withdrawal removes that participant's observations from the ledger, but the
operator must also stop scheduled runs. Re-enrollment requires a new private
signed form and a new participant alias. A minimal revocation marker containing
the old internal alias and withdrawal time remains in encrypted local state so
the old alias cannot be reused after retention cleanup. The marker is removed
only by the explicit local state deletion procedure.

After a controlled run, record a job observation with the exact saved job ID:

```json
{"kind":"observation","participantId":"candidate-1","runId":"run-1","jobId":"greenhouse:example:123","provider":"greenhouse","os":"macos","outcome":"submitted","failureCategory":"none","retryCount":0,"crashCount":0,"stageLatencyMs":{"application":2450}}
```

Run `openapply beta:evidence observe`. The recorder reads the existing
application checkpoint, stamps the observation with local system time, checks that the
checkpoint was created after consent, verifies the
provider against the official URL and source ID, derives the URL SHA-256 and
confirmation-present flag, and refuses an unconfirmed `submitted` claim.
Older checkpoints without a locally recorded creation timestamp cannot count toward beta
evidence. A participant/run/job pair is immutable to prevent quiet replacement.
Local timestamps and encrypted checkpoints are operational evidence from this
device; they are not independent or tamper-proof proof of consent or submission.
The signed form and employer confirmation must be checked during the monitored
beta review.
Stage timings are measured by the operator; they are not automatic telemetry.
Never put names, email addresses, URLs, receipts, answers, or résumé text into
an input. The strict schema rejects extra fields.

`openapply beta:evidence summary` sweeps expired observations and consent records and emits provider
counts only. It omits aliases, job IDs, URLs, and receipt text. `retentionDays`
controls this local sweep when the beta evidence CLI runs; it does not schedule
background deletion, and the operator must run the command within the agreed
retention period. The encrypted ledger is included in local state export,
quarantine, restore, and permanent deletion. Private export files contain
plaintext records; protect and delete them with the existing state-control
process. The signed consent form is outside this ledger and needs its own
retention and deletion handling.
