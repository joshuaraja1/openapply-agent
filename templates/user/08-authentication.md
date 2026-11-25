# Authentication and Browser Profile

Keep the completed copy private. Do not put passwords, cookies, OAuth tokens,
MFA secrets, or recovery codes in this file.

## Browser profile import

- Source browser: `{{CHROME / EDGE / BRAVE / FIREFOX / SAFARI / NONE}}`
- Source profile name: `{{EXAMPLE: DEFAULT}}`
- Import cookies and signed-in sessions: `{{YES/NO}}`
- Import saved passwords: `NO` (unsupported until OS-store migration is reviewed)
- Keep a dedicated persistent OpenApply profile: `{{YES}}`

Profile import must be initiated by the user and approved through the browser or
operating-system consent prompt. OpenApply must not silently copy another
browser's encrypted profile files or retain a second browser password vault.

## Application accounts

Repeat this section for each account the agent may use.

- Account label: `{{EXAMPLE: JOB SEARCH}}`
- Email: `{{EMAIL}}`
- Username when different from email: `{{USERNAME OR NOT APPLICABLE}}`
- Sites or domains: `{{EXAMPLE: linkedin.com, myworkdayjobs.com}}`
- Password secret reference: `{{EXAMPLE: keychain://openapply/job-search}}`
- May create a new employer-portal account with this identity: `{{YES/NO}}`

Enter the actual password only in OpenApply's onboarding password field. The app
stores it in macOS Keychain, Windows Credential Manager, or Linux Secret Service
and writes only the secret reference above to configuration.

## Email verification codes

- Automatically read job-application verification emails: `{{YES/NO}}`
- Provider: `{{GMAIL / MICROSOFT}}`
- Account label: `{{ACCOUNT LABEL FROM ABOVE}}`
- Automatically enter a single unambiguous code: `{{YES/NO}}`
- Maximum email age: `{{EXAMPLE: 5 MINUTES}}`
- Allowed sender domains (required for automatic entry): `{{DOMAINS}}`

This permission covers short-lived email-address verification codes for the
active job application only. CAPTCHA, authenticator-app codes, security keys,
recovery flows, and ambiguous messages always require the user.
