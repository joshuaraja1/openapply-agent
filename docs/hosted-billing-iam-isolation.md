# Hosted billing entitlement isolation

The public billing HTTP Lambda handles authenticated Checkout creation and
Stripe webhooks. Its IAM role may write only the billing journal table and may
query the separate entitlement table. The scheduled reconciler has a distinct
role that may replace paid entitlements in that table after a fresh Stripe read.
The application queue must receive **read-only** access to this entitlement
table and must fail closed if its read fails. No public HTTP route may invoke
the replay Lambda or assume its role.

The two tables share `pk` and `sk` key names, but have separate DynamoDB ARNs.
`ENTITLEMENT_TABLE_NAME` is mandatory and must differ from `BILLING_TABLE_NAME`.
Both paid replacement methods issue a DynamoDB transaction: a conditional
check of the current Customer lease in the journal table and all entitlement
puts/deletes in the entitlement table. Transaction authorization uses the
underlying `ConditionCheckItem`, `PutItem`, and `DeleteItem` permissions on the
respective table ARNs. The API role has none of those entitlement writes.

## Reviewed staging cutover

1. Review a CloudFormation change set for the new retained, encrypted,
   point-in-time recoverable entitlement table and the two IAM roles. Keep the
   existing journal table and API deployment unchanged while doing this.
2. Stop Checkout intake and replay briefly. Inspect old journal rows whose
   sort key begins `ENTITLEMENT#`. Export them and validate each `record`
   against the hosted entitlement schema and its subject/key pair. Count rows
   per subject; resolve invalid or duplicate rows before proceeding. Take a
   point-in-time backup of the old table.
3. Copy validated entitlement rows to the new table using conditional puts
   (`attribute_not_exists(pk)`) so a retry never overwrites a newer result.
   Compare counts and exact row contents for every subject. Do not copy
   Customer bindings, Checkout records, webhook events, or lease rows.
4. Deploy the API and replay Lambdas together with distinct table names and
   roles. Verify a read of every migrated subject, a paid test-mode Checkout,
   signed webhook delivery, scheduled grant, duplicate delivery, cancellation,
   and refund revocation. Verify the API role receives `AccessDenied` for
   entitlement `PutItem`, `DeleteItem`, and transaction writes.
5. Re-enable intake only after all checks pass. Keep the old rows for audit;
   remove them in a later, separately reviewed cleanup after the migration
   window and backups are verified.

The staging billing table has so far been smoke-test only, so zero old
entitlement rows is expected but must be **measured**, not assumed. If there
are zero, the copy step is an explicit zero-row verification. An old API
version that reads only the journal table cannot see new entitlements.
Rollback after new entitlements have been written therefore requires stopping
intake and replay, exporting and reconciling the new rows back to the old
schema, and rechecking subject parity before switching configuration. Do not
silently fall back to the old table or perform a rollback while both writers
are active. This PR does not execute the cutover or change staging resources.

## Remaining public-release boundary

The current HTTP Lambda still needs the Stripe test secret for Checkout and
some webhook charge resolution. A compromise of that Lambda could alter
Stripe state or journal Customer bindings and attempt an *indirect* grant
through the reconciler. The reconciler checks that subscription subject
metadata matches the durable binding and requires a settled invoice, but
metadata can be modified with sufficiently privileged Stripe credentials.
Before public launch, give the HTTP service a restricted Stripe credential
limited to its exact Checkout operations, keep the reconciliation credential
in the replay role only, and verify provider-origin subject linkage using a
completed paid Checkout Session or another binding the HTTP credential cannot
rewrite. Until that is tested, this is a direct DynamoDB mutation boundary,
not proof that a compromised HTTP service cannot induce a fraudulent grant.
