# Separate Stripe credentials for staging billing

The hosted API and scheduled reconciler have different AWS IAM roles and now
accept different Secrets Manager ARNs. Set `StripeApiSecretArn` to a restricted
**test-mode** key for customer creation, price reads, Checkout Session creation
and retrieval, and the provider reads needed to resolve customerless refund
events. Set `StripeReplaySecretArn` to a separate **test-mode** key that can
read the current subscriptions, invoices, invoice payments, PaymentIntents,
charges, Checkout Sessions, and line items. Both Lambdas still need the
test-mode webhook signing secret because the composition root validates it at
startup. Neither function accepts a live-mode key.

Use two distinct restricted Stripe keys in the separate OpenApply account.
Store each key only in its corresponding AWS Secrets Manager secret, and pass
only secret ARNs to CloudFormation. Verify the API role cannot read the replay
secret and the replay role cannot read the API secret with IAM simulation or
an equivalent denied-access test. Confirm Checkout creation and scheduled
reconciliation with test-mode events before enabling candidate payments.
When the webhook signing secret rotates, set `WebhookSecretVersion` to the
new Secrets Manager version ID in the CloudFormation update. This nonsecret
environment marker refreshes both warm Lambda runtimes so they reload the
new signing secret; changing a secret value alone does not refresh cached
configuration.

This split does **not** by itself prevent a compromised API from inducing an
indirect grant. The API still controls customer bindings and reads provider
charge state. Public launch requires narrowing the API key's Stripe scopes
and verifying a paid Checkout Session is bound to the candidate through a
provider-origin value the API credential cannot alter. Keep live billing off
until that threat is addressed and independently reviewed.
