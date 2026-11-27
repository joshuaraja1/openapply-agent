# AWS hosted billing API staging slice

`src/hosted/aws-billing-lambda.ts` makes the hosted billing runtime deployable
behind an AWS HTTP API. It accepts only Stripe **test-mode** credentials from
AWS Secrets Manager, uses the isolated OpenApply DynamoDB table, and never
contains a card form. The two API Gateway routes are Checkout and the signed
Stripe webhook. Application enqueue is deliberately **not routed** here until
the candidate run ledger, consent records, and FIFO queue ports are deployed.

`deploy/aws/hosted-billing-api.yaml` defines the HTTP API, two Lambda
functions, an EventBridge replay schedule, and a role limited to the existing
billing-table policy and the two named secrets. The replay function runs every
minute. A webhook response acknowledges only a durable pending-event write;
the replay function fetches current Stripe state and updates entitlements.

Build the self-contained Node 22 Lambda bundle with
`npm run build:hosted-lambda`, zip `dist-hosted/aws-billing-lambda.mjs` at the root of a
ZIP archive, upload it to a private OpenApply staging S3 bucket, and pass that
bucket and object key to the CloudFormation template. Provide the **ARNs** of
the separate test key and webhook signing secret, the staging site origin,
Stripe test price IDs, Cognito issuer/JWKS/client ID, and the billing table's
scoped policy ARN. Never pass key values as CloudFormation parameters.

The staging site must control its `/auth/callback` route before Cognito is
activated. Its same-origin `/api/billing/checkout` path should proxy to the
HTTP API while preserving `Origin` and `Authorization`. Stripe can deliver its
webhook directly to the HTTP API's HTTPS webhook route; configure the exact
endpoint in the separate OpenApply Stripe **test** account and store its
`whsec_` secret in Secrets Manager. This API has no CORS grant for direct
cross-origin browser calls.

Release proof still required: real Cognito ID-token verification, a paid
test Checkout followed by signed delivery and scheduled entitlement grant,
duplicate delivery, cancellation and refund revocation, and a candidate run
that remains blocked when access or consent is missing. The API is not yet
deployed; no live charges or applications are enabled by this PR.
