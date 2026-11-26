# Owned-browser receipt recovery design

Issue [#153](https://github.com/joshuaraja1/openapply-agent/issues/153) remains open. The current Playwright `launchPersistentContext` belongs to the application worker. Its `finally` closes the context, which destroys the live receipt tab even when the profile remains on disk. A worker crash also leaves no trustworthy tab identity to inspect. The candidate-assisted `application:verify-owned` path can check a fresh employer receipt, but it does not prove that a reopened tab is the tab that received the final click.

## Safety invariants

1. Persist the job ID, official application URL, package path and hash, verified résumé path and hash, expected confirmation, pre-submit URL, and a unique final-click claim before attempting Submit.
2. A final-click claim permits at most one click dispatch. A timeout, process crash, transport failure, or unknown response never authorizes a retry.
3. An automatic receipt check reads the *same live tab* controlled at the final click. A matching URL in a newly opened tab is insufficient.
4. Confirmation requires the approved HTTPS employer origin, stable requisition binding, exact company and role, and visible employer confirmation. Candidate attestation alone cannot mark a job submitted.
5. Missing browser process, changed process generation, missing tab, ambiguous receipt, or changed package/artifact leaves `submission-uncertain` intact. A separate candidate-assisted employer receipt or portal-status check remains available.

## Proposed process boundary

Run one local browser owner independently of the application worker. It owns the persistent Chromium context and its profile lock for its whole lifetime. Workers connect through a private local socket or Windows named pipe. The browser owner exposes narrow operations for a job's tab and final-click lifecycle; it does not expose an unauthenticated CDP port or a public HTTP endpoint.

The browser owner assigns each controlled tab a random opaque ID and each owner lifetime a random generation ID. A worker checkpoint stores both IDs and the profile identity with its final-click claim. On worker restart, reconnection succeeds only if the same owner generation still holds the same tab ID. An owner restart invalidates automatic tab recovery, even if Chromium happens to restore a similar page.

Authenticate every local connection with a random secret held in the user's OS secret store. Protect the socket/pipe and owner metadata with user-only permissions or Windows ACLs. Bind requests to the logged-in OS user, validate message size and schema, and never log credentials, cookies, page HTML, résumé content, or the token. The owner is the sole process allowed to launch the profile; normal workers must not bypass its lock.

## Final-click and recovery protocol

1. The worker creates the durable `submit-claimed` checkpoint under the workflow lease. The browser owner checks that claim and its package/artifact bindings before accepting a click request.
2. The owner durably records `click-intent` keyed by the claim ID **before** dispatching the click. It refuses any second dispatch for that claim, including after a worker reconnect. If the owner cannot record intent, it does not click.
3. The owner clicks once on the already-bound tab and records the resulting tab URL and receipt observation when available. A crash between intent and observation stays uncertain; neither worker nor owner retries the click.
4. The worker may mark `submitted` only after a same-generation, same-tab inspection passes the existing strict employer receipt checks and the saved claim, package, and artifact still match. It then records the employer confirmation in the application checkpoint.
5. On worker restart, a `submit-claimed` checkpoint becomes `submission-uncertain`. A read-only reconnect may inspect the saved live tab. It must not navigate or submit. If the owner or tab is gone, it leaves the checkpoint uncertain and sends a human handoff.

The owner journal and application checkpoint are separate durable records. Their writes cannot be made atomic as one transaction, so every disagreement fails closed. In particular, a persisted claim with no owner click record still cannot be retried automatically: the worker may have died before receiving the owner's response.

## Reviewable implementation sequence

1. Add a versioned authenticated local protocol and private owner lifecycle. Test single-owner profile locking, wrong token/user, stale socket, restart, and cleanup on macOS, Windows, and Linux.
2. Move owned browsing behind the owner without changing application decisions. Prove that killing only the worker leaves the same tab alive and reconnectable; killing the owner makes recovery fail closed.
3. Add durable click-intent and claim-bound `submitOnce`. Fault-inject death before intent, after intent, during click, and after a visible receipt. Assert exactly one click in every path.
4. Add read-only same-tab receipt reconciliation with wrong tab, wrong generation, wrong job, wrong host/requisition/company/role, changed résumé/package, generic thank-you page, and duplicate-tab negatives.
5. Run independent bug and security reviews of the process boundary and platform permissions. Then run consented provider tests for the exact adapters advertised as automatic.

Keep the owner-backed path disabled until every gate passes. The existing candidate-assisted verifier remains the safe fallback. No live employer submission was used to prepare this design.
