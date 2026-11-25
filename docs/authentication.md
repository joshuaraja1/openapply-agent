# Authentication and session handling

Queued applications use the same persistent BrowserOS neo profile as signed-in
discovery and Overleaf. Sign in once in that profile; its cookies and local
storage remain in BrowserOS across runs.

The optional Playwright fallback profile is separate from BrowserOS neo.
BrowserOS cookies do not automatically transfer into it. Sign in inside that
fallback browser if you choose to use it.

The embedded runtime uses Playwright's Chromium binary. Install it with
`npm run browser:install` after `npm ci`, then verify it with
`npm run browser:doctor`. The doctor launches one blank page in the dedicated
profile, reports startup time and browser version, and prints no cookies or
account data. Pass a dedicated private
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
The private authentication policy now rejects `browserProfile.importPasswords:
true` for the future OpenApply-owned browser. This flag has no runtime consumer
yet, so it does not control BrowserOS neo's separate, user-driven import screen.
For that browser, decline saved-password import in its own consent UI. Enter
portal passwords through the OS secret store. A future opt-in migration needs
separate review and deletion of any browser-vault copy.

Existing private policy files containing `importPasswords: true` fail to load.
Before rerunning OpenApply, change that field to `false` or remove it, and make
sure each portal password is present under its configured OS secret reference.
The old flag did not import passwords at runtime, so no automatic credential
migration is performed.

After import, the user verifies important sessions such as LinkedIn, Jobright,
Handshake, Gmail or Microsoft, Overleaf, and commonly used ATS portals. A site
can still expire or revoke its session, in which case OpenApply pauses that
application and opens the relevant login page.

## Credentials

The private authentication policy maps domains to an account email and an
operating-system secret reference. macOS uses Keychain (`keychain://`); Linux
uses Secret Service (`secret-service://`), and Windows uses Credential Manager
(`credential-manager://`). Linux requires an unlocked Secret
Service provider. The implementation fails if Secret Service is unavailable,
without falling back to a nonpersistent kernel keyring. On macOS, store a
password from a hidden terminal prompt with:

```zsh
read -rs 'OPENAPPLY_PASSWORD?Portal password: '
printf '%s' "$OPENAPPLY_PASSWORD" | OPENAPPLY_SECRET_REF='keychain://openapply/job-search' npm run secret:put
unset OPENAPPLY_PASSWORD
```

On Linux, use a hidden Bash prompt and a `secret-service://` reference:

```bash
read -rsp 'Portal password: ' OPENAPPLY_PASSWORD; printf '\n'
printf '%s' "$OPENAPPLY_PASSWORD" | OPENAPPLY_SECRET_REF='secret-service://openapply/job-search' npm run secret:put
unset OPENAPPLY_PASSWORD
```

Use the same secret reference in the private authentication policy. The
onboarding UI and Windows private-file ACL checks are still planned. The Windows
secret backend can store credentials, but the full Windows runner remains blocked
until private input and output files have reviewed ACL handling. Never
put passwords in Markdown, JSON, logs, command arguments, environment
variables, generated artifacts, or the repository.
The `application-state/` namespace in each store is reserved for OpenApply's
encryption key and cannot be used for account credentials.

Set `authenticationPolicyPath` in the private queue configuration to enable
automatic sign-in when a supported same-host portal shows a login form. The
policy file must be owned by the current user and readable only by that user.
Automatic sign-in requires an exact host in the account's `domains` list and
a password already stored under its OS secret reference. BrowserOS fills the
credential without saving it in the browser profile. Ambiguous login controls,
identity-provider redirects, and failed sign-ins pause for human handling.
If sign-in lands on a different page, OpenApply continues only when the same
requisition identifier remains in the same URL path prefix and the returned
page visibly identifies the company and role. Otherwise it pauses
before filling or submitting the form.

The BrowserOS runner can create an account on a same-host registration form when
`allowAccountCreation` is true, the domain exactly matches the selected account,
the account email matches the candidate email, and the configured password is
present in the OS secret store. It accepts only one email,
password, password-confirmation, and Create account control; unknown required
fields, legal consent, CAPTCHA, or unsupported registration pages pause for human
review. Before clicking Create account, it saves the exact BrowserOS tab as a
recovery checkpoint. A crash cannot silently retry registration. The user must
inspect and resume that tab if registration success is uncertain. Windows
private-file handling and a full first-run onboarding UI remain planned.
After registration, the returned page must still identify the configured job
and company before application fields can be filled.

## Email verification

`npm run oauth:connect` performs explicit one-time consent in BrowserOS neo and
stores the token in macOS Keychain or Linux Secret Service. See [email verification](email-verification.md)
for setup. With `autoEnter` enabled, the workflow can observe the selected
Gmail or Microsoft mailbox during an active application. It considers only recent
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
arguments. `getOrCreateStateKey` creates and retrieves it from the OS store under
a canonical private filesystem lock in `~/.openapply-agent/key-init/`. If
initialization crashes, inspect active OpenApply processes before removing
the empty lock directory. After a crash,
inspect active OpenApply processes before calling
`recoverLockAfterInspection(true)` on the checkpoint store. This explicit
recovery preserves the single-writer guarantee.
