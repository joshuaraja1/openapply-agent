# Email verification foundation

OpenApply has Gmail and Microsoft Graph read-only mailbox clients and a
conservative code selector. The clients use fixed HTTPS API hosts, request a
maximum of ten recent messages, reject redirects, and never print tokens or
message bodies. The selector requires the configured recipient, approved sender
domain, company or portal host, a fresh message, and exactly one six-digit
verification code. Ambiguous or stale messages produce no automatic answer.

The one-time OAuth setup opens Gmail or Microsoft consent in the owned browser
profile by default, receives a PKCE callback on a temporary loopback port,
checks the mailbox identity and read-only scopes, and saves the refresh token
in the operating-system secret store. Configure `emailVerification` in a private authentication
policy, then run `OPENAPPLY_AUTH_POLICY=/absolute/private/auth.json npm run oauth:connect`.
To use the existing BrowserOS neo profile instead, also set
`OPENAPPLY_BROWSER_ENDPOINT` to its local MCP endpoint. The provider's registered OAuth client
must allow a loopback redirect for a desktop application. The callback page
only confirms consent receipt; the command reports success after token storage.

For a self-hosted installation, create your own Google or Microsoft **desktop/public**
OAuth client and put only its client ID in the private authentication policy.
After `oauth:connect`, run `OPENAPPLY_AUTH_POLICY=/absolute/private/auth.json
npm run oauth:doctor`. The doctor checks the saved grant's provider, client ID,
read-only scopes, and exact mailbox identity; it refreshes an expired grant if
needed. Its output is only `verified`, `consent-required`, `verification-failed`,
or `disabled`, with no token or mailbox contents. A failed check requires
reconnecting or reviewing the private policy before enabling automatic code
entry. The setup screen reports only that a client ID is configured; it does
not claim consent was verified.

Product-owned one-click consent remains gated on registering desktop clients
with Google and Microsoft, completing each provider's consent/publisher review,
and validating grant, refresh, revoke, duplicate and stale callbacks, account
mismatch, and log redaction against controlled real accounts. Self-hosters use
their own client ID until that external registration is complete. See
[issue #71](https://github.com/joshuaraja1/openapply-agent/issues/71).

When `autoEnter` is enabled, the queue and single-application runners can fill
one clearly labeled **email** code field. The message must match the configured
account, approved sender domain, company or portal host, and the active browser
step that produced the code field. It checks for up to 30 seconds. Overlapping
challenges for the same account and employer pause for ten minutes rather than
compete for a code.
A selected message is claimed in encrypted local state before browser entry, so
a crash or a second run cannot use that message again. Missing, ambiguous,
stale, or unretained codes pause for human review. Other MFA and
security challenges remain human handoffs. This path has synthetic tests; live
Gmail and Microsoft consent plus employer-portal flows require beta validation.
Generic employer emails may lack a unique challenge identifier, so the workflow
cannot prove exact form linkage if the user independently requests another code
from the same employer during that window. Pause or disable `autoEnter` for that
employer when this could happen.

API contracts: [Gmail message search](https://developers.google.com/workspace/gmail/api/guides/filtering),
[Gmail message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
and [Microsoft Graph message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).
