# Authentication and session handling

Queued applications use the same persistent BrowserOS neo profile as signed-in
discovery and Overleaf. Sign in once in that profile; its cookies and local
storage remain in BrowserOS across runs.

The optional Playwright fallback profile is separate from BrowserOS neo.
BrowserOS cookies do not automatically transfer into it. Sign in inside that
fallback browser if you choose to use it.

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
the native Keychain API. Store a password from a hidden terminal prompt with:

```zsh
read -rs 'OPENAPPLY_PASSWORD?Portal password: '
printf '%s' "$OPENAPPLY_PASSWORD" | OPENAPPLY_SECRET_REF='keychain://openapply/job-search' npm run secret:put
unset OPENAPPLY_PASSWORD
```

Use the same secret reference in the private authentication policy. The
onboarding UI and Windows/Linux backends are still planned. Never
put passwords in Markdown, JSON, logs, command arguments, environment
variables, generated artifacts, or the repository.
The `keychain://application-state/` namespace is reserved for OpenApply's
encryption key and cannot be used for account credentials.

Set `authenticationPolicyPath` in the private queue configuration to enable
automatic sign-in when a supported same-host portal shows a login form. The
policy file must be owned by the current user and readable only by that user.
Automatic sign-in requires an exact host in the account's `domains` list and
a password already stored under its Keychain reference. BrowserOS fills the
credential without saving it in the browser profile. Ambiguous login controls,
identity-provider redirects, and failed sign-ins pause for human handling.
If sign-in lands on a different page, OpenApply continues only when the same
requisition identifier remains in the same URL path prefix and the returned
page visibly identifies the company and role. Otherwise it pauses
before filling or submitting the form.

New-account creation is still planned. The current runner pauses at registration
forms, even when `allowAccountCreation` is true. A future implementation may
create accounts only with that policy enabled, using the configured email and
Keychain password; it must not invent security answers.

## Email verification

Email-code automation is still planned and currently pauses the application.
`npm run oauth:connect` performs explicit one-time consent in BrowserOS neo and
stores the token in macOS Keychain. See [email verification](email-verification.md)
for setup. After form integration, the workflow can observe the selected
Gmail or Microsoft mailbox during an active application. It would consider only recent
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
