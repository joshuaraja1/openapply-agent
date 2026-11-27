# Trusted hosted run creation (staging)

`POST /api/applications/runs` is disabled by default. Enabling it requires a separate
Lambda package, the durable run ledger, the private encrypted artifact bucket,
and the onboarding KMS key ARN for decrypt-only access.
The route records consent and a pending run. It does not enqueue or execute it.

The browser sends only a UUID `runId` (idempotency key), a verified `leadId`, a
`profileArtifactId`, and explicit consent with `granted: true`, scope
`apply-one-job`, and policy version `v1`. The Cognito ID token supplies the subject.
The server derives the candidate UUID from the configured issuer and subject. It
loads current paid or approved free access from the entitlement table; a redirect,
client claim, or stale subscription status does not grant access.

Two trusted writers must be deployed before enabling this route:

* An official lead verifier writes `{pk: "LEAD#<uuid>", sk: "VERIFIED",
  status: "open", leadId, job: {provider, employerId, requisitionId},
  jobKey, canonicalUrl, expiresAt}` to the run ledger. `jobKey` is
  `officialJobKey(job)`. It must verify the requisition at the employer and
  invalidate or expire closed postings.
* Candidate onboarding writes an encrypted profile artifact to
  `artifactObjectKey(candidateId, artifactId)` with content type
  `application/vnd.openapply.encrypted+json`, then writes
  `{pk: "CANDIDATE#<uuid>", sk: "PROFILE#<uuid>", status: "verified",
  candidateId, artifactId, subjectId}`. The writer must check the candidate
  `DELETED` marker and bind the marker to the authenticated subject.

Creation decrypts the bounded profile artifact, checks its candidate ID and
candidate-reviewed consent, and checks the referenced résumé and optional
transcript under that same candidate's artifact prefix. Each document must
have the encrypted-object content type, fit the upload size bound, decrypt with
its artifact ID and candidate encryption context, and begin with a PDF header.
The browser cannot provide document IDs. Missing or malformed documents prevent
run creation. The run creator role gets `kms:Decrypt` for the onboarding key,
`s3:GetObject` for candidate artifacts, and no KMS data-key generation or S3
write access.

Creation then transactionally checks the deletion
marker and current lead/profile rows and writes `RUN#<runId>` plus
`CONSENT#<runId>`. Consent is per run so two queued jobs cannot invalidate each
other. A repeated ID succeeds only if the committed run and granted consent match;
otherwise it returns a conflict. Enqueue and browser execution must independently
check access, deletion, and consent again. A crash after submission intent still
requires receipt reconciliation before any further Submit click.

The HTTP Lambda has no Stripe secret or SQS permission. Its feature flag,
CloudFormation route, and role are absent unless `EnableApplicationRunCreation`
is explicitly set to `true`. Do not enable it until trusted lead and onboarding
writers, consent revocation, queue handoff, and deletion flow are integrated and
tested together.
