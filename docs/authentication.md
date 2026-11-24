# Authentication and session handling

OpenApply uses a dedicated persistent Chromium profile. The profile is local to
the user's machine and retains cookies, local storage, downloads, and successful
logins between runs.

The embedded runtime uses Playwright's Chromium binary. Install it with
`npx playwright install chromium` after `npm ci`. Pass a dedicated private
profile directory to `launchBrowser`. The runtime holds a process lock while
open, so a second process cannot launch against the same profile.
After a crash, inspect the process and profile before removing its empty
`.lock` directory. Automatic stale-lock recovery is deferred until an OS-backed
lock is available.

## First-run import

The onboarding flow may offer a one-time browser-native import from Chrome,
Edge, Brave, Firefox, or Safari. Import requires an explicit user action and any
operating-system consent required to decrypt protected browser data. OpenApply
does not read or copy raw cookie databases in the background.

After import, the user verifies important sessions such as LinkedIn, Jobright,
Handshake, Gmail or Microsoft, Overleaf, and commonly used ATS portals. A site
can still expire or revoke its session, in which case OpenApply pauses that
application and opens the relevant login page.

## Credentials

The private authentication policy maps domains to an account email and an
operating-system secret reference. The macOS secret-store implementation uses
the native Keychain API. Password values must be entered through a private
onboarding flow; that UI and Windows/Linux backends are still planned. Never
put passwords in Markdown, JSON, logs, command arguments, environment
variables, generated artifacts, or the repository.

When a portal requires a new account, OpenApply may create it only when the
selected account has `allowAccountCreation: true`. It uses the configured email
and the password retrieved from that account's secret reference. It must not
invent security-question answers or weaken an existing password policy.

## Email verification

With explicit OAuth consent, OpenApply can observe the selected Gmail or
Microsoft mailbox during an active application. It considers only recent
messages associated with the active portal and expected email address. A single
unambiguous email-address verification code may be entered automatically and is
discarded immediately afterward.

The workflow pauses for CAPTCHA, authenticator-app codes, security keys, account
recovery, unexpected sender domains, multiple plausible codes, or a code outside
the configured age window. OAuth refresh tokens remain in the operating-system
secret store.

## Application checkpoint encryption

The encrypted checkpoint store takes a 32-byte key from a trusted secret store.
The key must stay outside the repository, configuration files, and process
arguments. `getOrCreateStateKey` creates and retrieves it from Keychain under
a canonical private filesystem lock in `~/.openapply-agent/key-init/`. If
initialization crashes, inspect active OpenApply processes before removing
the empty lock directory. After a crash,
inspect active OpenApply processes before calling
`recoverLockAfterInspection(true)` on the checkpoint store. This explicit
recovery preserves the single-writer guarantee.
