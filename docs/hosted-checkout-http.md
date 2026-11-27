# Hosted Checkout HTTP boundary

`POST /api/billing/checkout` accepts exactly `{ "plan": "monthly" | "semester" }`. The browser must send an OIDC ID token in `Authorization: Bearer ...` and the exact configured app `Origin`. It cannot supply a candidate ID, Stripe Customer ID, Price ID, amount, or redirect URL. The handler returns a Stripe Checkout URL and expiry with `Cache-Control: no-store`; it never grants paid access.

The server must construct `createOidcSubjectVerifier` using its own HTTPS issuer, audience, and JWKS URL. The verifier accepts only signed RS256 tokens for that issuer and audience, with a usable subject, expiry, and at most one hour of token age. The handler derives the reservation's subject from the verified token. The OIDC provider and its login flow must be configured separately; do not expose this endpoint with a placeholder verifier.

Compose `handleCheckoutHttp` with a server-owned Stripe secret, `CheckoutConfig`, and durable `CheckoutPorts`. The ports must map the verified subject to a Stripe Customer, atomically reserve one attempt per subject and plan, reject active paid access, and atomically record the Checkout session. They must never trust a Customer ID supplied by the caller. The signed Stripe webhook and entitlement reconciler remain the only path to grant access after payment. No access is inferred from Checkout's success redirect.

No Stripe secret, OIDC signing key, or candidate record belongs in the browser bundle. Keep the endpoint on the same app origin; cross-origin CORS and cookie authentication are deliberately absent. Tests use locally signed JWTs and a Stripe stub, with separate sandbox smoke for real Stripe test sessions. A live charge requires a separately configured Stripe live account and explicit release gate.
