# Provider beta runbook and evidence matrix

This runbook implements the per-provider part of the [monitored beta protocol](monitored-beta-protocol.md). It is a plan, not evidence that any real employer application has been tested or that a provider is ready for unattended use. Use a consenting candidate's genuine application only; never submit a synthetic profile to a real employer.

## Current evidence and release state

| Provider | Controlled evidence | Missing before unattended beta |
| --- | --- | --- |
| Greenhouse | Two-step Chromium safety scenarios, 100 form-mapping contract cases, and 100 completed controlled Chromium applications in `test/provider-completion-matrix.e2e.test.ts` | Consented real-site smoke, independent review, provider-specific runtime enablement evidence |
| Ashby | Same shared Chromium safety scenarios, 100 form-mapping contract cases, and 100 completed controlled Chromium applications | Same gates as Greenhouse |
| Lever | Shared scenarios plus conditional, validation, identity drift, wrong receipt, and receipt URL drift in merged #165 | 100 complete runs, real-site smoke, provider-specific runtime enablement evidence |
| SmartRecruiters | Shared scenarios plus conditional, validation, identity drift, wrong receipt, and receipt URL drift in merged #168; BrowserOS conditional-upload and wrong-receipt checks | 100 complete runs, real-site smoke, provider-specific runtime enablement evidence |
| Workday | Shared scenarios plus three-step upload, step-two conditional and validation, wrong requisition, generic/wrong receipt, and receipt URL drift in merged #169; BrowserOS conditional-upload and wrong-receipt checks | 100 complete runs, real-site smoke, provider-specific runtime enablement evidence |

The 100 Greenhouse and Ashby form-mapping contract cases are distinct from their 100 completed controlled Chromium applications per provider. Those browser completions use local fixtures and synthetic receipts, not employer sites. None of these rows has a recorded consented real-site smoke. The runtime provider gate was added in merged #166, but an allowlisted provider still needs the entry evidence below before unattended beta. All providers remain **off for unattended beta** in this matrix.

## Per-provider entry decision

The release owner records one dated decision per provider, OS, and app commit. Do not start a real-site smoke until every item is true:

1. Required CI, controlled Chromium and BrowserOS cases, 100 complete controlled application runs, crash/retry stress, and independent bug and security findings have passed at the exact commit. Record links and counts; a passing form-mapping unit test is not a completed application.
2. An enforced runtime provider allowlist is active for queued jobs as well as new discoveries. The provider is disabled by default. The operator has tested disable and rollback with a pre-existing queued job.
3. Install, signed bundle verification, clean setup, browser session recovery, private export/deletion, and handoff have passed on the OS being enrolled. Record the installed package version and signing result.
4. The site's current terms, access controls, and privacy handling have been reviewed for the exact employer portal. Honor rate limits, robots/access restrictions, and any site-specific prohibition. Keep this decision in an owner-only record.
5. The candidate has completed the private [participation record](../templates/beta/participant-consent.md): approved role/employer scope, genuine account, daily cap, browser and optional mailbox access, final-submit policy, monitoring, withdrawal, and retention. The candidate has not already applied to the selected requisition.

If any item fails, record `no-go` and keep the provider disabled. A real-site smoke is not a way to compensate for a missing controlled or security gate.

## One low-volume real-site smoke

For each provider, use one active, directly verified employer posting that genuinely matches the candidate and the candidate's approved scope. Start with a daily cap of one and a human-observed first run. Do not use a fake job, test identity, or repeated applications to the same requisition.

1. Save the official posting identifier, provider, observed posting time, first-seen time, and match decision in the encrypted local state. Confirm the candidate's verified claims cover all hard requirements and that the job has no prior submitted or uncertain checkpoint.
2. Render the role-specific PDF from the approved history. Check every PDF page visually and confirm the artifact fingerprint before upload. Keep the PDF, source facts, and URL in owner-only storage.
3. Start the exact job package. Observe all steps: identity mapping, required/optional controls, conditional questions, file upload, validation messages, page transitions, login/MFA, and final-click count. Never answer an unknown legal, demographic, eligibility, or consent question by inference.
4. For the first smoke, pause before final submission and have the candidate inspect the completed form. If their recorded policy permits this exact application, resume once. CAPTCHA/MFA or a site block is a human handoff, never a bypass.
5. Record `submitted` only when the employer's receipt explicitly binds to the original company/title or requisition ID and the saved checkpoint agrees. A generic thank-you, changed job path, timeout, process crash, or uncertain click stays `submission-uncertain`; do not click Submit again automatically.
6. Recheck the employer account or confirmation email for this exact requisition. Record a sanitized outcome and failure category without copying private fields, cookies, codes, screenshots, raw HTML, or résumé bytes into GitHub or telemetry.

An application that legitimately pauses for a candidate answer is an expected handoff, not a provider completion. Resume after the approved answer and verify the exact same job. Stop the provider immediately if a wrong answer, cross-job navigation, duplicate click, unbound receipt, or private-data leak occurs.

## Evidence record and pass/fail

Keep the detailed ledger locally with owner-only permissions; publish only aggregate counts and sanitized categories. For each attempt record: run ID, pseudonymous participant ID, commit/package version, OS, provider, local requisition reference, consent record version, start/end timestamps, fresh/backfill tier, form-step count, upload verified (yes/no), conditional/validation/handoff category, final-click count, checkpoint stage, exact-job receipt present (yes/no), recovery time, and operator decision. Employer URL, résumé hash, account identity, and receipt text stay in encrypted local state.

**Pass for a provider on an OS:** all entry items pass; at least one consented smoke reaches an exact-job `submitted` checkpoint; no wrong answers or duplicate final clicks occur; and the two-week monitored beta meets the [release thresholds](monitored-beta-protocol.md) with counts and denominators. A correctly handled human handoff is a safety success, but the provider remains on hold until that application resumes to an exact-job submission or another consented application completes. A single smoke cannot establish the 99% crash-free or 100% verified-submission targets.

**Fail or hold:** a missing entry item, site rule conflict, false field answer, duplicate final click, unsafe upload, cross-job drift, unbound confirmation marked submitted, private data leak, or an unrecoverable checkpoint. Disable the provider gate, stop scheduled runs, preserve only the candidate-approved encrypted evidence, open a sanitized defect, add a controlled regression, and repeat review before re-enabling. Record the release owner, date, supported provider/OS scope, evidence links, residual risks, and go/no-go decision.
