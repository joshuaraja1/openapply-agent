# Scheduled queue runner

The queue runner consumes a discovery queue, creates an evidence-backed Jake
résumé in a dedicated private Overleaf project, verifies the PDF, then opens
each official application in a persistent local browser. It processes jobs
sequentially. A Keychain-backed encrypted reservation file enforces the lower
of `dailyTarget` and `dailyHardCap` across restarts. Reservations remain spent
after failures or uncertain submissions so a crash cannot exceed the cap.
Each job is quarantined after three failed runs; inspect its private checkpoint
and source before retrying manually.

1. Copy `examples/queue-runner.example.json` outside the repository and set its
   paths, local BrowserOS endpoint, and private Overleaf project URL. Set
   `authenticationPolicyPath` only after creating a private policy and storing
   its account passwords in the operating-system secret store; otherwise remove
   that optional property.
   For the owned-browser preview, set `"browserRuntime": "owned"` and remove
   `browserEndpoint`. Sign in to Overleaf and any job boards with
   `npm run browser:open` first. The queue then uses the dedicated local profile
   for Overleaf and supported employer forms without a BrowserOS installation.
   Owned human-handoff recovery and account registration remain release gates;
   use the BrowserOS path for portals that need those flows.
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
operating system scheduler. `OPENAPPLY_QUEUE_CONFIG=/private/queue-runner.json npm run autopilot`
runs both commands in order, using the queue configuration as the only source
for discovery and candidate paths. BrowserOS neo and Overleaf must already be signed
in. Queued applications use that same BrowserOS profile and its existing site
sessions. Configured exact-domain account creation and email-code entry can
proceed when their safety checks pass. Unknown questions, unsupported account
forms or email codes, CAPTCHA, and MFA pause for human handling. The queue
output reports a job as `processed` when the
application workflow ran; inspect its encrypted checkpoint to distinguish a
confirmed submission from a human handoff.
On macOS, a paused application also triggers a generic desktop notification.
Use `OPENAPPLY_JOB_ID=<job-id> npm run application:status` to read the exact
blocker and private package path from encrypted local state. The BrowserOS tab
stays open for the user. After resolving an unknown field, run
`OPENAPPLY_PACKAGE=<package-path> OPENAPPLY_RESUME_JOB_ID=<job-id> OPENAPPLY_APPROVED_ANSWERS=<private-answers-file> npm run application:run`.
The answers file follows `examples/human-answer-approval.example.json`; its
job ID, BrowserOS page ID, field label, and value must match exactly. Put it
outside the repository with user-only permissions. Setting
`approveFinalSubmission: true` explicitly authorizes submission after these
exact answers are verified. For CAPTCHA or MFA, finish
the portal flow yourself. If you submit manually, run
`OPENAPPLY_PACKAGE=<package-path> OPENAPPLY_CONFIRM_JOB_ID=<job-id> OPENAPPLY_CONFIRMATION_ATTESTATION=<private-attestation-file> npm run application:run`
to verify the employer confirmation in that same tab before recording success.
The attestation follows `examples/manual-confirmation-attestation.example.json`
and is your explicit statement that the confirmation belongs to this job.

For an owned-browser handoff, set `browserPageId` to `0` in the approved answers
file. Resume with the same `OPENAPPLY_RESUME_JOB_ID` command. OpenApply reopens
the verified requisition in its private profile and refills the résumé and
approved plain-text answers. It cannot restore unsaved in-page challenge state;
if CAPTCHA or MFA completion was not saved to that profile, the run pauses again.

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
still pending. The generic runner can advance through up to five form steps
when each Continue control is explicitly a non-submit button. Ambiguous
navigation, a missing résumé upload, or a repeated step pauses the application.
Use approval mode while those limits matter for your target portals. Each
private application package is retained in the artifact directory for recovery
and manual inspection. Package creation and reading require an owner-only
file and parent directory on every OS, including Windows. A package created
before this ACL gate may be rejected; move it out of the private artifact
directory and regenerate it from the verified source rather than weakening
permissions in place.
