# Safety model

## Default posture

OpenApply prepares, explains, and audits. It does not assume that every visible field is safe to answer or that every application should be submitted.

## Mandatory stops

- CAPTCHA or anti-bot challenge.
- Authenticator-app MFA, security keys, login recovery, or any ambiguous verification message.
- Email verification when OAuth consent is absent, the sender or application does not match, the code is stale, or more than one code is plausible.
- Missing work-authorization, demographic, legal, clearance, GPA, SAT, or ACT facts.
- A claim not supported by an allowed source.
- A privacy, AI-use, conflict-of-interest, export-control, or criminal-history attestation that has not been reviewed.
- Final submission when the user's policy requires approval.
- A later form step that cannot be tied to the original requisition. A receipt
  that leaves the original job path remains `submission-uncertain` and must be
  inspected before any retry.

## Responsible use

- Respect employer and ATS terms, rate limits, and access controls.
- Prefer public APIs and official feeds for discovery.
- Avoid duplicate applications and application spam.
- Keep answers accurate and role-specific.
- Make automation visible to the user through logs and review queues.
- Do not use interview-assistance tools where an employer prohibits them.
