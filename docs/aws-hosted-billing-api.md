# AWS hosted billing API staging slice

`src/hosted/aws-billing-lambda.ts` makes the hosted billing runtime deployable
behind an AWS HTTP API. It accepts only Stripe **test-mode** credentials from
AWS Secrets Manager, uses the isolated OpenApply DynamoDB table, and never
contains a card form. The two API Gateway routes are Checkout and the signed
Stripe webhook. Application enqueue is deliberately **not routed** here until
the candidate run ledger, consent records, and FIFO queue ports are deployed.

`deploy/aws/hosted-billing-api.yaml` defines the HTTP API, two Lambda
functions, an EventBridge replay schedule, and separate IAM roles. The HTTP
role can write the Checkout and webhook journal but can only read the separate
entitlement table. The scheduled replay role can write entitlements after
reading current Stripe state. The replay function runs every
minute. A webhook response acknowledges only a durable pending-event write;
the replay function fetches current Stripe state and updates entitlements.

Build the self-contained Node 22 Lambda bundle with
`npm run build:hosted-lambda`, zip `dist-hosted/aws-billing-lambda.cjs` at the root of a
ZIP archive, upload it to the private S3 bucket created by
`deploy/aws/staging-code-bucket.yaml`, and pass that
bucket and object key to the CloudFormation template. Provide the **ARNs** of
distinct API and replay test keys and the webhook signing secret, the staging site origin,
Stripe test price IDs, Cognito issuer/JWKS/client ID, and both billing journal
and entitlement table names. Never pass key values as CloudFormation parameters.

The tables and IAM change require the staged cutover described in
`docs/hosted-billing-iam-isolation.md`. Do not point the API at an empty
entitlement table while paid records remain only in the old billing table.

The staging site must control its `/auth/callback` route before Cognito is
activated. The Checkout HTTP API permits only that exact configured staging
origin through a bounded `OPTIONS` preflight; it does not use cookies or a
wildcard CORS grant. The site may call the API directly with its Bearer token
or use a same-origin proxy. Stripe can deliver its
webhook directly to the HTTP API's HTTPS webhook route; configure the exact
endpoint in the separate OpenApply Stripe **test** account and store its
`whsec_` secret in Secrets Manager.

The OpenApply staging stack was deployed in AWS `us-east-1` at
`https://f2wcpcwqch.execute-api.us-east-1.amazonaws.com`. Its first smoke
test exposed an ES module packaging failure in the bundled AWS SDK. The
CommonJS bundle now loads under Lambda Node 22; live HTTP checks confirmed
unauthenticated Checkout returns 401, an unapproved origin returns 403,
approved preflight returns 204 with the exact staging origin, an invalid
webhook signature returns 400, and a correctly signed but irrelevant test
event returns 204. Scheduled replay subsequently ran without an error. These
tests did not create a paid entitlement or charge a card. The separate
OpenApply Stripe sandbox now has an active endpoint for all 13 handled billing
events. Its actual signing secret is in the existing AWS Secrets Manager
secret. Stripe delivered `customer.subscription.created` and `invoice.paid`
test fixtures to the API with HTTP 204; each produced one durable journal
row. After the five-minute binding grace period, both unbound fixtures were
quarantined and no entitlement was created. These fixtures do not prove a
paid candidate flow.

The later staging test signed in with a Cognito test identity, completed a
monthly $39 and a four-month $129 Checkout in Stripe **test mode**, and
processed their candidate-bound signed events into the separate entitlement
table. Resending the paid monthly event returned HTTP 204 without adding a
second journal row or entitlement. Immediate cancellation and full sandbox
refund of that monthly subscription produced signed events; the replay Lambda
removed its entitlement. The semester test grant remains isolated to its
candidate. The test identities were administratively confirmed because the
normal email-code flow has not yet been tested end to end. No live charge or
job application was made.

The API and scheduled replay Lambda were subsequently updated to use distinct
Stripe test-key Secrets Manager ARNs. IAM simulation reports `implicitDeny`
when the API role requests the replay secret and when the replay role requests
the API secret. The API-key split smoke, authenticated billing status page,
trusted queue admission, and candidate run remain separate release checks.
