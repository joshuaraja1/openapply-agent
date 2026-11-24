# Email verification foundation

OpenApply has Gmail and Microsoft Graph read-only mailbox clients and a
conservative code selector. The clients use fixed HTTPS API hosts, request a
maximum of ten recent messages, reject redirects, and never print tokens or
message bodies. The selector requires the configured recipient, approved sender
domain, company or portal host, a fresh message, and exactly one six-digit
verification code. Ambiguous or stale messages produce no automatic answer.

The one-time OAuth setup now opens Gmail or Microsoft consent in the configured
BrowserOS neo profile, receives a PKCE callback on a temporary loopback port,
checks the mailbox identity and read-only scopes, and saves the refresh token
in macOS Keychain. Configure `emailVerification` in a private authentication
policy, then run `OPENAPPLY_AUTH_POLICY=/absolute/private/auth.json
OPENAPPLY_BROWSER_ENDPOINT=http://127.0.0.1:... npm run oauth:connect` with
the endpoint shown by BrowserOS neo. The provider's registered OAuth client
must allow a loopback redirect for a desktop application. The callback page
only confirms consent receipt; the command reports success after token storage.

This module is not yet connected to application forms. Encrypted one-use
message tracking and browser form entry remain required before automatic
email codes can be enabled. The runner continues to pause for verification codes.

API contracts: [Gmail message search](https://developers.google.com/workspace/gmail/api/guides/filtering),
[Gmail message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
and [Microsoft Graph message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).
