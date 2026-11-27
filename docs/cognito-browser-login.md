# Staging browser sign-in

`src/hosted/cognito-browser-auth.ts` supplies the browser half of the Cognito
public-client authorization-code flow. It is stacked on the Cognito user-pool
template in PR #229. This is a reusable controller, not a deployed account UI.

Wire it into a same-origin frontend at `https://openapplyagent.xyz`:

1. Construct `createCognitoBrowserAuth` with the Cognito stack outputs
   (`Issuer`, `UserPoolClientId`, `LoginDomain`), `appOrigin`, and the browser's
   `crypto`, `sessionStorage`, and `fetch`.
2. On Sign in, navigate to `await auth.beginLogin()`.
3. At `/auth/callback`, call `await auth.completeCallback(location.href)`, then
   immediately replace the URL with a path without the code. Show a new Sign in
   button if the callback fails; do not put its code or tokens in logs.
4. Send `auth.getIdToken()` as the Bearer token only to same-origin protected
   API calls such as `POST /api/billing/checkout`. If absent or expired, start
   a new login. Do not cache it in local or session storage.
5. On Sign out, navigate to `auth.logout()` and clear all application state.

The controller generates a fresh state, nonce, and S256 PKCE verifier for each
login. Callback state expires after five minutes and is consumed before the
code exchange. It checks the returned token's issuer, audience, nonce, use,
subject, and expiry. These browser checks are for flow integrity and UI state;
the hosted API **must independently verify the token signature and claims**
with the Cognito JWKS as the checkout endpoint in PR #227 does. The controller
deliberately discards the returned refresh token and holds the ID token only in
memory. Reloading requires another hosted login.

Before a candidate can use this, deploy the Cognito stack, mount the frontend
routes, provision the hosted API and durable billing store, and test a real
sign-in, logout, expired session, and checkout on the chosen staging domain.
No production customer, AWS user pool, or live payment is created by this PR.

AWS documents that Cognito's public-client token endpoint accepts browser
cross-origin code + PKCE requests: <https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html>.
