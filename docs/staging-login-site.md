# Controlled staging callback host

The static site in `cloud/staging-login` is the private first-run sign-in page
and Cognito callback for `https://staging.openapplyagent.xyz`. It does not offer
payments or run applications. It is intentionally useful before Cognito exists:
without pool outputs, it displays “Sign-in is not configured yet.”

Build with `npm run staging:login:build`. This produces
`cloud/staging-login-dist`, including both `/` and `/auth/callback` routes. The
output is a Cloudflare Pages static directory. Deploy it to an OpenApply-only
Pages project, bind `staging.openapplyagent.xyz`, and verify both routes serve
HTTPS from that project before executing the Cognito CloudFormation change set.
The `_headers` file sets no-store, no-referrer, and a restrictive CSP. The
`_redirects` file rewrites the callback path without dropping its query string.

After Cognito deploys, rebuild with its public outputs in these environment
variables and redeploy the same directory:

```sh
OPENAPPLY_COGNITO_ISSUER='<Issuer output>' \
OPENAPPLY_COGNITO_CLIENT_ID='<ClientId output>' \
OPENAPPLY_COGNITO_LOGIN_DOMAIN='<HostedLoginDomain output>' \
OPENAPPLY_STAGING_ORIGIN='https://staging.openapplyagent.xyz' \
npm run staging:login:build
```

No credential or token belongs in these variables. The only browser storage is
the short-lived PKCE verifier, state, and nonce in sessionStorage; the ID token
is held in memory and lost on reload. The callback removes the authorization
code from the address bar before exchange. The hosted API must independently
verify the token signature and current entitlement.

This staging page is not a complete consumer account/dashboard. Do not point
the Cognito callback at a parked domain or enable public signup until the
controlled HTTPS route is live and tested.

## Future same-origin API contract

The staging frontend will call `/api/*` on its own origin with a Bearer ID
token. A later Cloudflare Worker or Pages Function may reverse-proxy that path
to the AWS hosted API. Its upstream origin must come from server configuration,
never a request parameter or Host header. The proxy must preserve the
Authorization and Content-Type headers, stream bounded request bodies, set a
strict timeout, remove `Cookie` and other browser-specific headers, and return
`Cache-Control: no-store`. The AWS API still verifies the JWT and enforces the
candidate-to-run binding and billing entitlement; the proxy does not grant
access. No `/api/*` route is enabled by this static-site PR while the upstream
endpoint and its security policy are unresolved.
