# Candidate identity staging

`cloud/aws-cognito-staging.yaml` prepares a separate Cognito user pool, a public web client, and an AWS-managed sign-in domain for OpenApply. It does not create candidate accounts or modify another product's identity pool. Deploy only to the intended OpenApply AWS account and region after reviewing the CloudFormation change set.

Pass `AppOrigin` explicitly as a controlled HTTPS site that already serves `/auth/callback`; there is no default. The callback is `${AppOrigin}/auth/callback` and logout URL is the origin root. Never use a parked domain. Use authorization-code flow with PKCE and `openid email profile` scopes. The browser client has no client secret. Keep the short-lived ID token in memory and send it as a Bearer token to the same-origin Checkout API; do not store tokens in localStorage or pass them in application queue messages.

For a staged hostname switch, `PreviousAppOrigin` temporarily retains the old
callback and logout URL. Both origins must be controlled HTTPS hosts. Update
the Worker build's `OPENAPPLY_STAGING_ORIGIN` to the new `AppOrigin`, verify a
fresh sign-in, then remove the previous origin from Cognito.

The template outputs the user pool ID, app client ID, issuer, JWKS URL, login domain, and callback URL. Configure `createOidcSubjectVerifier` with the issuer, JWKS URL, and app client ID as audience. The server should derive `subjectId` from the validated ID token `sub`; email is not an account key and may change. Paid entitlement, candidate data, and the application queue must all use that same subject ID.

The pool requires verified email, uses a 12-character minimum password with character classes, allows software-token MFA, rotates refresh tokens, and retains the pool with deletion protection. It uses the Essentials feature plan because AWS limits refresh-token rotation to Essentials and Plus; the initial login domain serves the classic hosted UI until managed-login branding is configured. Deletion of a user pool or account data needs a separate reviewed process. For production, review MFA enrollment UX, email delivery capacity, abuse protection, account deletion, and the OAuth callback session design. The staging template is intentionally separate from live billing and does not grant paid access.

Validation: `aws cloudformation validate-template --template-body file://cloud/aws-cognito-staging.yaml --region us-east-1`. This checks template syntax only. The OpenApply staging stack is deployed in `us-east-1`; disposable candidate sign-in was verified on the old `workers.dev` callback. Normal first-run email confirmation is still a separate release test.
