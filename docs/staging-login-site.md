# Controlled staging callback host

The site in `cloud/staging-login` is the private first-run sign-in page and
Cognito callback. It does not run applications. It is useful before Cognito exists:
without pool outputs, it displays “Sign-in is not configured yet.”

Build with `npm run staging:login:build`. This produces
`cloud/staging-login-dist`, including both `/` and `/auth/callback` routes. The
output is a Cloudflare Pages static directory. Deploy it to an OpenApply-only
Pages project, bind `staging.openapplyagent.xyz`, and verify both routes serve
HTTPS from that project before executing the Cognito CloudFormation change set.
The `_headers` file sets no-store, no-referrer, and a restrictive CSP. The
`_redirects` file rewrites the callback path without dropping its query string.

If Pages/domain permissions are unavailable, deploy the same assets as a
Worker at a controlled HTTPS `workers.dev` origin:

```sh
npm run staging:login:build
npx wrangler deploy --config cloud/staging-login/wrangler.jsonc
```

The Worker rewrites `/auth/callback` and sets security headers itself. Use its
returned origin for Cognito's `AppOrigin` parameter and the build variable
`OPENAPPLY_STAGING_ORIGIN`. Verify the exact callback over HTTPS first.

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

The Worker proxies billing Checkout and the candidate onboarding, plan, and
deletion routes to their configured AWS origins. It also has three separate,
**off-by-default** staging switches:

- `APPLICATION_RUN_CREATION_ENABLED=true` allows only
  `POST /api/applications/runs` to the billing API origin. The AWS run-creator
  route must also be deployed with `EnableApplicationRunCreation=true`.
- `APPLICATION_ENQUEUE_ENABLED=true` allows only
  `POST /api/applications/enqueue` to that origin. The AWS billing stack must
  have `EnableApplicationEnqueue=true` and a deployed exact-run Fargate launcher.
- `APPLICATION_REVIEWED_RETRY_ENABLED=true` allows only
  `POST /api/applications/reviewed-retry` to the run-creator origin. The signed-in
  job seeker must supply a new reviewed profile artifact and explicit consent.
  It creates one new exact-job run from a durable `needs_human` handoff; it does
  not restore unsent employer form fields. The normal enqueue route still
  starts the new run after its own payment and consent checks.

Keep the Worker switches unset until an official-source lead writer has
created a current `LEAD#<id>/VERIFIED` row, onboarding has written a reviewed
`applicationProfileReady=true` marker, and the hosted browser path is ready for
the intended provider. The page does not yet present a job list or a Start
Application action. These routes are an authenticated integration boundary,
not a public automation feature by themselves.

The trusted upstream origin comes from server configuration, never the
request. The Worker forwards only Authorization, Content-Type, Origin, and a
bounded body (2 KiB for run creation, 1 KiB for enqueue); it blocks redirects,
strips cookies, and returns no-store. AWS independently verifies the JWT,
current paid/free access, official lead, profile ownership and readiness,
per-run consent, and durable dispatch. The Worker grants no access. Unknown
`/api/*` paths return 404.
