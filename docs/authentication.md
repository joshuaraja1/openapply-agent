# Authentication and session handling

OpenApply uses a dedicated persistent Chromium profile. The profile is local to
the user's machine and retains cookies, local storage, downloads, and successful
logins between runs.

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
operating-system secret reference. Password values are collected through the
local onboarding UI and stored in macOS Keychain, Windows Credential Manager,
or Linux Secret Service. They are never stored in Markdown, JSON, logs, command
arguments, environment variables, generated artifacts, or the repository.

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
