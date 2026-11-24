# Email verification foundation

OpenApply has Gmail and Microsoft Graph read-only mailbox clients and a
conservative code selector. The clients use fixed HTTPS API hosts, request a
maximum of ten recent messages, reject redirects, and never print tokens or
message bodies. The selector requires the configured recipient, approved sender
domain, company or portal host, a fresh message, and exactly one six-digit
verification code. Ambiguous or stale messages produce no automatic answer.

This module is not yet connected to application forms. Keychain-backed OAuth
refresh and mailbox-identity verification are available, but OAuth onboarding,
encrypted one-use message tracking, and browser form
entry are required before automatic email codes can be enabled. The current
runner continues to pause for verification codes.

API contracts: [Gmail message search](https://developers.google.com/workspace/gmail/api/guides/filtering),
[Gmail message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
and [Microsoft Graph message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).
