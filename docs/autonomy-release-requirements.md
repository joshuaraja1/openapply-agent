# Autonomous product release requirements

This is the implementation contract for the remaining product work. The current
CLI is a useful beta foundation, not an unattended consumer release. A supported
run discovers official postings, creates a job-bound résumé, completes known
application fields, and records `submitted` only after employer confirmation.
Unknown legal answers, CAPTCHA, authenticator MFA, and access controls produce
an actionable handoff. No application is silently abandoned or reported as
submitted from a click alone.

## Product requirements

1. **Owned browser:** one dedicated, persistent local Chromium profile serves
   signed-in discovery, Overleaf, and applications. A user explicitly signs in
   or approves a browser-native profile import. Password import is disabled by
   default; an opt-in migration must move passwords into the OS secret store
   and remove any browser-vault copy before the owned path is enabled.
   OpenApply never copies raw cookie databases or exposes cookie values in logs. BrowserOS remains an
   optional adapter during migration, not a prerequisite for the owned path.
2. **Private state:** OS-backed secrets and authenticated encrypted state work
   on macOS, Linux, and Windows. All private input, output, profile, and lock
   paths have owner-only access checks appropriate to that OS. Migration fails
   closed and is reversible.
3. **Application coverage:** deterministic provider adapters handle common
   Greenhouse, Ashby, Lever, SmartRecruiters, and Workday fields and multi-step
   flows. A bounded generic fallback can fill only evidence-backed answers.
   Unknown required, legal, compliance, and identity questions pause. A board
   lead must resolve to an active employer posting before application.
4. **Résumé QA:** every application uses a distinct Jake-template LaTeX source
   and job-bound PDF. The renderer checks text, links, page geometry, page
   images, and artifact fingerprint before upload. An uncertain visual result
   pauses for review; it never becomes an automatic pass.
5. **Recovery:** crashes, timeouts, browser restarts, expired sessions, and
   duplicate events resume from durable checkpoints. The submit claim is saved
   before clicking, and uncertain submissions never auto-click again. Handoffs
   show the blocker, exact page, and safe resume action. Every form step remains
   bound to the original requisition; a generic same-domain thank-you message
   alone is insufficient to confirm that job's submission.
6. **Consumer setup:** first-run UI collects the completed user templates,
   checks evidence and source precedence, configures preferences, accounts,
   Overleaf, mailbox consent, and daily limits, then runs a dry-run preview.
   Product-owned Google and Microsoft desktop OAuth clients must be registered
   and verified for the published redirect URIs and least-privilege scopes;
   until then, onboarding explicitly requires a user-supplied client ID.
   Passwords go directly to OS secret storage, never into JSON or telemetry.
7. **Distribution:** signed, updateable builds include the browser runtime or
   a verified browser installation step, platform permissions, rollback,
   export/delete controls, and an uninstall path. The updater never migrates
   state irreversibly without a backup.

## PR stack

Each PR has one behavior change, tests, migration and rollback notes, threat
model impact, a self-review, Bugbot review, and security review where it touches
auth, storage, browser, email, or submission. `main` remains runnable after
every merge. A PR is opened as a draft until its controlled tests pass.

| PR | Scope | Depends on | Exit test |
| --- | --- | --- | --- |
| 47 | Requirements and performance measurement plan | none | Review the contract and measurement protocol |
| 48 | Disable password import by default | 47 | Policy test rejects implicit password import |
| 49 | Job-bound multistep submission and confirmation | 47 | Wrong-requisition synthetic portal cannot be recorded as submitted |
| 50 | Owned browser lifecycle and profile lock | 48 | Restart preserves a synthetic session; concurrent launch fails safely |
| 51 | Owned-browser signed-in discovery | 50 | Local profile collects bounded leads; BrowserOS remains a rollback option |
| 51b | Owned-browser application and Overleaf adapters | 51 | Synthetic application and render flows work through local and BrowserOS adapters |
| 52 | Runtime selection, scheduler, and crash recovery | 49, 51b | Kill at each checkpoint; no duplicate final click |
| 53 | Windows private-file ACL enforcement | 47 | Real Windows CI rejects shared input/output/profile paths |
| 54 | Greenhouse and Ashby application adapters | 49, 51b | Sanitized multi-step fixtures and synthetic portal E2E |
| 55 | Lever, SmartRecruiters, and Workday adapters | 54 | Provider fixtures, drift cases, and conditional question handoffs |
| 56 | Page-image PDF QA and render policy | 47 | Golden PDFs catch clipping/overlap; uncertain images pause |
| 57 | Local first-run and handoff UI | 52, 53, 56 | Keyboard-only setup, user-supplied OAuth client fallback, dry run, and resume E2E |
| 58 | Signed installer, updater, export, and deletion | 57 | Clean install, upgrade, rollback, uninstall on supported OSes |
| 59 | Private beta, real-site smoke tests, and release decision | 54–58 | Monitored beta gates below hold; independent security assessment |

PRs 48, 49, 53, and 56 can proceed independently after 47. PR 55 can be split by
provider if a sanitized fixture exceeds the review-size target. A provider is
enabled for unattended use only after its controlled E2E tests and a low-volume
real-site smoke test pass. Before any real-site test, confirm candidate consent,
the site's terms and access rules, and the permitted test scope. Controlled CI
uses only synthetic portals; real employer submissions require an authorized
real candidate application. BrowserOS remains available until the owned runtime
passes the same contract tests.

Product-owned Google and Microsoft OAuth registrations are an external release
prerequisite, tracked separately from PR 57. Their registered redirect URIs,
consent-screen verification, and scopes must be checked before a consumer build
offers one-click mailbox setup. Signing/notarization credentials and beta
candidate consent are also external prerequisites, never CI secrets in a PR.

## Required test matrix

- **Unit and contract:** identity mapping, required/optional fields, conditional
  questions, validation errors, two-page flows, upload, confirmation, and
  provider markup drift. Fixtures use synthetic identities and sanitized HTML.
- **Browser integration:** persistent cookies across restart, expired login,
  popup, iframe, download, upload, navigation escape, profile corruption,
  renderer crash, and a second process attempting the same profile.
- **Recovery E2E:** kill the process before and after every durable transition,
  including immediately before and after the final click. Verify exactly one
  click or an explicit `submission-uncertain` handoff. Switch to a different
  same-host requisition after Continue and verify it cannot submit or confirm.
- **Security:** malicious job text, malicious email, hostile PDFs, path traversal,
  cross-account session reuse, log/telemetry leakage, and secret-store lockout.
- **Platform:** macOS Keychain, Linux Secret Service, and Windows Credential
  Manager with real OS-backed smoke tests; private-file permissions on all three.
- **Visual/accessibility:** every rendered page, long content, hyperlinks,
  selectable text, contrast, keyboard-only onboarding, and handoff navigation.
- **Performance:** measure source fetch, ranking, tailoring, PDF render, browser
  snapshot/action, portal wait, and recovery separately. Record median and p95.

## Speed and reliability gates

These are proposed targets, not current performance claims. PR 50 records the
first owned-browser baseline and PRs 51–52 compare it with BrowserOS. Use a
versioned synthetic portal and a fixed 100-job discovery fixture. On each
supported OS, record hardware, browser/Node versions, warm and cold starts,
network conditions, and 30 warm-run samples per stage. Time with a monotonic
clock from operation entry to verified outcome; report median, p95, failures,
and sample count. Keep employer network waits as a separate measurement. API
discovery and tailoring may run concurrently; final submissions are serialized
per user and employer domain. Reuse the signed-in browser and structured DOM
snapshots rather than reopening a profile or taking screenshots for every field.

- Median local snapshot/action overhead below 1 second and p95 below 3 seconds,
  excluding employer network waits; no unbounded retry loop.
- p95 checkpoint recovery below 10 seconds after browser and keychain are ready.
- No duplicate submission in 1,000 controlled crash/retry runs.
- 100% of recorded `submitted` outcomes have a job-bound employer confirmation.
- Zero private candidate facts, cookies, passwords, codes, or résumé bytes in
  telemetry and support bundles.
- Beta targets: at least 100 controlled applications per supported provider,
  two weeks of monitored real-site low-volume runs, at least 99% crash-free
  runs, and no unconfirmed submission reported as complete.

Real-site beta begins only after privacy and site-terms review, explicit
candidate consent, and an approved application policy. The beta does not
authorize bulk testing with synthetic identities on real employers.

## Training decision

No model training is required for the deterministic first release. Measure
failure categories first. If the generic fallback still needs learned form
classification, collect only consented, sanitized fixture data; keep a held-out
employer set; compare the trained model with the deterministic baseline on
accuracy, latency, and unsupported-answer rate. Never train on private résumés,
credentials, emails, or application answers by default. A model suggestion
cannot override evidence gates, domain checks, or human handoff conditions.

## Release decision

The release owner records the test evidence, CI links, supported OS/provider
matrix, completed privacy and terms review, OAuth registration status,
installer signing status, and independent
security findings. General availability waits for every requirement above or
an explicitly documented reduction in the product promise.
