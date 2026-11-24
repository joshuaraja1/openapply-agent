# Scheduled queue runner

The queue runner consumes a discovery queue, creates an evidence-backed Jake
résumé in a dedicated private Overleaf project, verifies the PDF, then opens
each official application in the persistent local browser. It processes jobs
sequentially. A Keychain-backed encrypted reservation file enforces the lower
of `dailyTarget` and `dailyHardCap` across restarts. Reservations remain spent
after failures or uncertain submissions so a crash cannot exceed the cap.
Each job is quarantined after three failed runs; inspect its private checkpoint
and source before retrying manually.

1. Copy `examples/queue-runner.example.json` outside the repository and set its
   paths, local BrowserOS endpoint, and private Overleaf project URL.
2. Put the completed candidate, preferences, and discovery JSON in private
   files. Configure official sources in discovery input and enable them.
   Set `allowedApplicationHosts` on each source to exact employer application
   hosts you trust. JSON-LD career pages may use their own HTTPS host by default;
   a different ATS host still needs an explicit entry.
3. Run discovery and the queue runner with the same output path:

```bash
OPENAPPLY_INPUT=/private/discovery-input.json \
OPENAPPLY_CANDIDATE=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES=/private/search-preferences.json \
OPENAPPLY_STATE=/private/discovery-state.json \
OPENAPPLY_OUTPUT=/private/application-queue.json npm start

OPENAPPLY_QUEUE_CONFIG=/private/queue-runner.json npm run queue:run
```

Run these two commands from the repository root on a schedule using the local
operating system scheduler. `npm run autopilot` runs both commands in order
when all five `OPENAPPLY_*` paths shown above plus `OPENAPPLY_QUEUE_CONFIG` are
set in the environment. BrowserOS neo and Overleaf must already be signed
in. The application browser uses a separate persistent Chromium profile; a
site account must already be signed in there as well. If a form asks an unknown
question, account creation, email code, CAPTCHA, or MFA, the application pauses
for human handling. The queue output reports a job as `processed` when the
application workflow ran; inspect its encrypted checkpoint to distinguish a
confirmed submission from a human handoff.

On macOS, build the project, copy `examples/schedule.example.json` to a private
path, set its paths and interval, then install a LaunchAgent. It runs at login
and each interval while the user session is active. The installer writes a
private plist and local logs; it does not store account passwords or cookies.

```bash
npm run build
OPENAPPLY_SCHEDULE_CONFIG=/private/schedule.json npm run schedule:install
npm run schedule:remove
```

Installing fails if an OpenApply LaunchAgent is already present. Remove it
before changing the schedule. BrowserOS and Overleaf sessions must remain
available for unattended runs; an unavailable session produces a failed job
and eventually quarantines it for review.

For unattended final submission, set `requireFinalApproval` to `false` in the
private preferences and provide an exact employer confirmation string in
`expectedConfirmationByDomain`. Missing confirmation text causes a safe pause.
Automated visual PDF inspection and provider-specific multi-page adapters are
still pending; use approval mode while those limits matter for your target
portals. Each private application package is retained in the artifact directory
for recovery and manual inspection.
