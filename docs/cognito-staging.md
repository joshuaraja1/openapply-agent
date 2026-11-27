# Candidate identity staging

`cloud/aws-cognito-staging.yaml` prepares a separate Cognito user pool, a public web client, and an AWS-managed sign-in domain for OpenApply. It does not create candidate accounts or modify another product's identity pool. Deploy only to the intended OpenApply AWS account and region after reviewing the CloudFormation change set.

The app origin defaults to `https://openapplyagent.xyz`; the OAuth callback is `https://openapplyagent.xyz/auth/callback` and logout URL is the origin root. The app must serve that callback before a candidate can finish login. Use authorization-code flow with PKCE and `openid email profile` scopes. The browser client has no client secret. Keep the short-lived ID token in memory and send it as a Bearer token to the same-origin Checkout API; do not store tokens in localStorage or pass them in application queue messages.

The template outputs the user pool ID, app client ID, issuer, JWKS URL, login domain, and callback URL. Configure `createOidcSubjectVerifier` with the issuer, JWKS URL, and app client ID as audience. The server should derive `subjectId` from the validated ID token `sub`; email is not an account key and may change. Paid entitlement, candidate data, and the application queue must all use that same subject ID.

The pool requires verified email, uses a 12-character minimum password with character classes, allows software-token MFA, rotates refresh tokens, and retains the pool with deletion protection. Deletion of a user pool or account data needs a separate reviewed process. For production, review MFA enrollment UX, email delivery capacity, abuse protection, account deletion, and the OAuth callback session design. The staging template is intentionally separate from live billing and does not grant paid access.

Validation: `aws cloudformation validate-template --template-body file://cloud/aws-cognito-staging.yaml --region us-east-1`. This checks template syntax only; it is not a deployed login or a completed sign-in test.
