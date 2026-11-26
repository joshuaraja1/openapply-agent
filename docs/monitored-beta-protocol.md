# Monitored beta protocol

This is the operating plan for the two-week release gate in
`autonomy-release-requirements.md`. It is not evidence that a beta has started or
passed. No synthetic identity is submitted to a real employer.

## Entry gate

The release owner records a dated go/no-go decision before enrolling anyone:

1. The exact commit, supported OS and provider list, required CI results, and
   independent bug and security review findings are linked.
2. The applicable site's terms, access rules, and privacy handling are reviewed
   for each real-site smoke. A provider is enabled only for the approved scope.
3. Clean install, browser installation, setup, handoff, export/delete, rollback,
   and uninstall have passed on every OS offered to beta users.
4. The candidate has read and completed the private consent record in
   `templates/beta/participant-consent.md`. The candidate chooses a daily cap,
   approved role scope, site accounts, and whether final submission is automatic.
5. A named operator owns daily monitoring and a stop channel. No password,
   mailbox token, résumé, application answer, or consent record is committed to
   GitHub or copied into telemetry.

If any entry item is open, the run remains a controlled local test rather than
a real-site beta run.

## Run sequence

- Start with one consented candidate and one provider at a low daily cap. Add
  providers and candidates only after reviewing the previous run's outcomes.
- Every lead is resolved to an active employer posting. Record source and
  verified posting time separately from first-seen time; prioritize fresh roles
  and backfill older active matches within the candidate's policy.
- Before each submission, record the matched evidence, hard-requirement result,
  job-bound résumé fingerprint, provider, requisition ID, and current checkpoint
  in the candidate's encrypted local state.
- Record `submitted` only after job-bound employer confirmation. CAPTCHA, MFA,
  unknown legal or sensitive questions, expired sessions, and uncertain clicks
  produce a human handoff. Do not retry an uncertain final click automatically.
- Monitor each day for two consecutive weeks. The operator reviews failures,
  handoffs, duplicates, provider drift, and candidate feedback before the next
  scheduled run.

## Minimal release evidence

Keep an owner-only evidence ledger with an internal candidate ID, run ID, OS,
provider, application/requisition ID, stage, outcome, confirmation present
(yes/no), retry count, crash count, and stage timing summaries. Store employer
URLs and résumé fingerprints only in encrypted local state. Publish aggregate
counts and sanitized failure categories; never publish raw pages or answers.
The local `beta:evidence` recorder and its limits are described in
`beta-evidence-cli.md`; it records operator-supplied observations against saved
application checkpoints and produces aggregate counts without candidate IDs.

The release report includes:

| Measure | Calculation | Required result |
| --- | --- | --- |
| Duration | First to last monitored day | At least 14 consecutive days |
| Controlled provider coverage | Synthetic completed applications per enabled provider | At least 100 each |
| Crash-free runs | Runs without process crash / all runs | At least 99% |
| Confirmed submissions | Submitted states with job-bound employer receipt / all submitted states | 100% |
| Duplicate final clicks | Repeated final clicks for one requisition in 1,000 controlled crash/retry runs | Zero |
| Browser overhead | Median and p95 snapshot/action on each supported OS | Contract targets met |
| Recovery | p95 time from restart to durable checkpoint recovery | Under 10 seconds |
| Private data leakage | Sensitive values found in telemetry or support bundles | Zero |

Record counts and denominators, not only percentages. A low-volume real-site
beta cannot replace the separate 100-case synthetic provider fixture gate.

## Stop and rollback

Disable the affected provider or automatic submission immediately if a wrong
answer, duplicate click, cross-job navigation, unbound confirmation, private
data leak, or unexpected account action is observed. Preserve encrypted local
state for incident review under the candidate's retention choice; do not
collect browser cookies or passwords. Reproduce with a sanitized fixture,
patch behind a gate, rerun the controlled suite, and obtain a new review before
re-enabling. The candidate may withdraw at any time; stop scheduled runs and
follow the tested export/deletion procedure.

The release owner signs the final decision with links to platform and provider
test evidence, the privacy and site-terms review, installer signing status,
independent review results, open defects, and the supported scope. Any unmet
target keeps general availability blocked.
