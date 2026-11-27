# Controlled staging callback host

The site in `cloud/staging-login` is the private first-run sign-in page and
Cognito callback. It does not run applications. It is useful before Cognito exists:
without pool outputs, it displays “Sign-in is not configured yet.”

Build with `npm run staging:login:build`. This produces
`cloud/staging-login-dist`, including both `/` and `/auth/callback` routes.
The staging deployment uses the `openapply-staging-login` Worker, with
`staging.openapplyagent.xyz` declared as its custom domain in Wrangler. Verify
HTTPS and the callback path on that hostname before changing Cognito.
The `_headers` file sets no-store, no-referrer, and a restrictive CSP for
static hosting; the Worker sets those headers and rewrites the callback path.

Deploy the Worker with the project's pinned Wrangler version. Keep the
dashboard-managed `AWS_API_ORIGIN` variable when deploying:

```sh
npm run staging:login:build
npx wrangler deploy --config cloud/staging-login/wrangler.jsonc --keep-vars
```

The Worker also has a `workers.dev` URL for rollback. Set Cognito's `AppOrigin`
and the build variable `OPENAPPLY_STAGING_ORIGIN` to the same verified custom
hostname. During a callback migration, set `PreviousAppOrigin` to the old
`workers.dev` origin so in-flight sign-ins can finish; remove it after the
custom-host flow is verified. Do not change only the Worker config or only
Cognito: those must agree on the exact callback URL.

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

The two Stripe **test-mode** checkout buttons appear only if
`OPENAPPLY_STAGING_CHECKOUT_ENABLED=true` is set during the build. They call
same-origin `/api/billing/checkout` with the in-memory ID token, then navigate
only to a `checkout.stripe.com` URL containing a `cs_test_` session ID; a live
session URL is rejected. This page has no card fields and persists
no payment credentials. Enable the buttons only after the hosted AWS API and
Worker proxy are tested.

This staging page is not a complete consumer account/dashboard. Do not point
the Cognito callback at a parked domain or enable public signup until the
controlled HTTPS route is live and tested.

## Same-origin API contract

The Worker proxies `POST /api/billing/checkout` and
`GET /api/billing/status` when `AWS_API_ORIGIN` is
configured; otherwise it returns 503. The trusted upstream origin comes from
server configuration, never the request. It preserves only Authorization,
Content-Type, Origin, and a body bounded to 1 KiB; uses a 10-second timeout;
blocks redirects; strips cookies; and returns no-store. The AWS API verifies
the JWT and applies billing and candidate authorization; the Worker grants no
access. Other `/api/*` paths return 404 until separately implemented.
The AWS billing stack's `AppOrigin` must equal the public Worker hostname; a
callback migration that updates only Cognito and the Worker will leave billing
status and Checkout unavailable.
