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

   Queue and discovery-state files contain job and candidate-derived data.
   Their parent directories and existing files must be owner-only on every OS.
   Move older shared files into a private directory before running; the writer
   rejects them rather than silently changing permissions.

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
sessions. BrowserOS neo pauses for human sign-in or account creation because
its snapshots do not prove where credentials would be submitted. The owned
browser can use configured exact-domain credentials only for a verified
same-origin POST form. Scoped email-code entry can proceed when its safety
checks pass. Unknown questions, unsupported account forms or email codes,
CAPTCHA, and MFA pause for human handling. Queue output reports `submitted`,
`waiting-human`, `submission-uncertain`, `blocked`, or `skipped` when the
application workflow reaches one of those stages. `processed` remains the
fallback for generic queue callers that do not return an application stage.
The encrypted checkpoint holds the confirmation or exact handoff reason.
On macOS, a paused application also triggers a generic desktop notification.
Optional email alerts use a private
[`handoff-notification.json`](../examples/handoff-notification.example.json) with
the candidate's recipient address, a verified sender address, and a Resend API
key reference. Store the key in the operating-system secret store with
`OPENAPPLY_SECRET_REF=<apiKeySecretRef> npm run secret:put` and pipe its value
through stdin. Use a `keychain://`, `credential-manager://`, or
`secret-service://` reference for macOS, Windows, or Linux respectively. Set
`notificationConfigPath` in the private queue config; for a
single package run set `OPENAPPLY_NOTIFICATION_CONFIG` to the same absolute path.
Queue-created private application packages retain this path so a later resume
from the local handoff screen can send another alert if the application pauses again.
The email contains only a generic reminder to open OpenApply. An email failure
never changes the application checkpoint or marks a submission complete. The
notification path has synthetic tests; live delivery requires the user's own
verified sender domain and API key.
An unattended queue with `requireFinalApproval: false` requires this configured
email channel and a stored sending key before it starts. A manual-approval queue
can run without email.
The next scheduled run replays an alert still pending in encrypted application
state even if the job is absent from today's queue. Delivery is recorded only
after the provider accepts the request. A crash between acceptance and that
record can cause a duplicate reminder after the provider's 24-hour idempotency
window; it cannot cause another application submission.
If a run ends after claiming the final submission click, the next queue run
first acquires the exclusive workflow lease, then marks that exact job
`submission-uncertain` and attempts the configured generic attention alert. It never retries
the click. A killed process may leave `workflow.lock`; follow the inactive-worker
inspection in [the state guide](sqlite-state.md) before manually removing that
lock and restarting. Check the employer confirmation before recording success.
An owned-browser submission can be reconciled only while its exact employer
confirmation tab is still open in the saved private browser profile. The
candidate must attest to the saved job, official and pre-submit URLs, verified
résumé digest, profile path, confirmation URL, and expected confirmation text.
Use `examples/owned-confirmation-attestation.example.json` as the private file
template. The browser inspection never navigates or clicks Submit. It requires
the exact confirmation URL on the approved employer host, a visible confirmation
heading or status, and the original requisition, company, and role on that page.
If the tab or profile is missing after a restart, or the receipt omits those
identifiers, leave the application `submission-uncertain` and inspect the
employer portal manually. Claims made before the owned-profile binding was
introduced cannot use this reconciliation path.
Use `OPENAPPLY_JOB_ID=<job-id> npm run application:status` to read the exact
blocker and private package path from encrypted local state. The BrowserOS tab
stays open for the user. After resolving an unknown field, run
`OPENAPPLY_JOB_ID=<job-id> openapply handoff` to open the private local handoff
screen. It shows the exact blocker and lets the candidate enter up to ten
answers, explicitly authorize continuation, and resume this application's
saved browser context. It accepts an empty answer list when a CAPTCHA or MFA
was completed directly in the application browser. The screen reads the
encrypted checkpoint and rejects stale or concurrent resume requests.
For manual CLI recovery, run
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
for BrowserOS, or `examples/owned-confirmation-attestation.example.json` for
the owned browser. It is your explicit statement that the confirmation belongs
to this job; the live employer receipt is also required.

For an owned-browser handoff, set `browserPageId` to `0` in the approved answers
file. Resume with the same `OPENAPPLY_RESUME_JOB_ID` command. OpenApply reopens
the verified requisition in its private profile and refills the résumé and
approved plain-text answers. It cannot restore unsaved in-page challenge state;
if CAPTCHA or MFA completion was not saved to that profile, the run pauses again.

The queue saves a private encrypted claim for each canonical official application
URL before reserving the daily slot. Referral parameters do not make a second
board lead eligible; requisition parameters remain part of the identity. A claim
survives a crash, date rollover, and uncertain submission. On an existing
installation, prior submissions predate this ledger and need a one-time review
before unattended use. A reused employer URL also needs manual review rather
than automatic resubmission.

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
