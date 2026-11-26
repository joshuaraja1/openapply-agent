# Self-hosting with your own accounts

OpenApply runs locally. It has no shared OpenApply API key or hosted account.
The deterministic discovery, matching, and résumé code needs no LLM API key.
Each user supplies their own candidate facts, search preferences, browser
sessions, Overleaf project, and any employer-portal credentials they choose to
store. Mailbox verification is optional and requires that user's Google or
Microsoft desktop OAuth client ID and consent. Passwords and OAuth tokens go
to the operating-system secret store, never to this repository or JSON files.

## First run

1. Install Node 22.13+ and run `npm ci`, `npm run browser:install`, and
   `npm run browser:doctor` from the repository root.
2. Run `npm run setup:ui` and open the local URL it prints. The editor creates
   private copies of templates 01–08 in `~/.openapply-agent/onboarding`, saves
   with conflict detection, and preserves completed answers. `npm run setup:init`
   remains available for users who prefer editing the files directly.
3. Complete the structured blocks in templates 01–03, then click **Compile
   profile** in the local editor or run [`profile:compile`](../templates/user/README.md)
   with paths to those private files. Each usable matching skill needs an
   approved work-history claim. Changed source facts require moving the old
   compiled outputs before compiling again. **Check readiness** reports whether
   those three templates validate and whether both compiled files still match
   the saved sources. It does not check browser sessions, account consent, or
   the remaining setup steps.
4. Configure your own target roles, official source list, daily cap, Overleaf
   project, and browser-search URLs. Sign in through your dedicated local
   browser profile. A company portal may require its own account. Set
   `OPENAPPLY_QUEUE_CONFIG` to your private queue configuration before launching
   `setup:ui`, then use **Check runtime setup**. It validates the queue file,
   compiled candidate file and profile paths, effective daily cap, browser mode, direct Overleaf
   project URL, optional mailbox client ID, and handoff notification file. The
   screen returns only statuses and the daily limit; it does not reveal account
   addresses or secret references. **Check browser installation** runs the
   owned Chromium doctor in a disposable private profile without opening saved
   sessions, or indicates that BrowserOS must be checked separately.
   These checks do not verify sign-ins, stored sending keys, OAuth consent,
   actual email delivery, or a real application.
5. If using automatic site login, create a private authentication policy with
   exact domains and OS secret references. Enter each password through
   `npm run secret:put` using stdin. If enabling email-code entry, register your
   own OAuth desktop client, add its client ID to the policy, and run the
   consent flow. Do not put passwords or client secrets in environment variables.
6. Run discovery and a prepare-only application first. Enable automatic final
   submission only after reviewing the candidate's policy and testing the
   target portals.

### Scheduled provider policy upgrade

The scheduled `queue:run` command defaults to **no enabled providers**, including
for existing queue files. An entry paused before dispatch stays queued, consumes
no daily application slot or posting claim, and appears as `provider-paused`
with a reason in the local run output. If the policy changes after an attempt
is claimed but before browser activity, the daily slot and a newly created
canonical claim are released so a rediscovered source ID can retry. A claim
that existed before the run is preserved. If browser
activity has begun, OpenApply pauses before the final click as `waiting-human` and keeps
the existing quota reservation and checkpoint for safe recovery. A revocation
detected after the durable final-click claim stays `submission-uncertain` with
an explicit no-click blocker; it cannot be retried automatically.
`source.enabled` controls discovery only; it
does not authorize applications. After a provider passes the controlled and
consented real-site gates in the [beta protocol](monitored-beta-protocol.md),
add its exact name to `queueProviderAllowlist` in the private queue-runner JSON,
for example `"queueProviderAllowlist": ["greenhouse"]`. Restart the scheduled
runner after editing the policy. A policy change detected during a run pauses
remaining queued jobs until restart. Removing a provider from the list pauses
its already queued jobs as well. Direct `application:run` remains a separate
manual path governed by its job-bound handoff and final-approval controls.

The scheduled queue's established path uses BrowserOS neo. An owned-browser
queue preview is tracked in the release PR stack; recovery from human handoffs
still needs validation. The local setup editor covers private templates; account
consent, source configuration, dry-run preview, and installation are still CLI
steps. OpenApply cannot promise
every job on the internet or bypass CAPTCHA, MFA, legal questions, or site
access controls. See the [release requirements](autonomy-release-requirements.md)
for the remaining public-product gates.
