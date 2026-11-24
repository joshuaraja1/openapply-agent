# Run Configuration

Keep the completed copy private. Use absolute paths where possible.

## Private files and output

- Candidate profile: `{{ABSOLUTE PATH}}`
- Work-history source of truth: `{{ABSOLUTE PATH}}`
- Search preferences: `{{ABSOLUTE PATH}}`
- Claim-source policy: `{{ABSOLUTE PATH}}`
- Resume-tailoring rules: `{{ABSOLUTE PATH}}`
- Approved application answers: `{{ABSOLUTE PATH}}`
- Authentication policy: `{{ABSOLUTE PATH TO PRIVATE AUTHENTICATION JSON}}`
- Master resume template: `{{ABSOLUTE PATH TO LATEX OR DOCX}}`
- Resume template choice: `{{DEFAULT JAKE GUTIERREZ TEMPLATE / USER-APPROVED CUSTOM TEMPLATE}}`
- Private Overleaf project URL: `{{URL}}`
- Overleaf project strategy: `{{REUSE ONE PRIVATE PROJECT / CREATE ONE PRIVATE PROJECT PER ROLE}}`
- Local LaTeX fallback when Overleaf is unavailable: `{{ALLOWED / NOT ALLOWED}}`
- Generated resume directory: `{{ABSOLUTE PRIVATE DIRECTORY}}`
- Application log: `{{ABSOLUTE PATH TO CSV OR JSON}}`

## Discovery

- Official-source configuration: `{{ABSOLUTE PATH TO DISCOVERY JSON}}`
- Browser-search configuration: `{{ABSOLUTE PATH TO BROWSER SEARCH JSON}}`
- Persistent discovery state: `{{ABSOLUTE PATH}}`
- BrowserOS endpoint: `{{EXAMPLE: http://127.0.0.1:9010/mcp}}`
- Browser profile: `{{DEDICATED PERSISTENT PROFILE NAME}}`
- Search frequency: `{{EXAMPLE: HOURLY}}`
- Time zone: `{{IANA TIME ZONE}}`

## Application policy

- Daily target: `{{NUMBER}}`
- Daily hard cap: `{{NUMBER}}`
- Final submission: `{{AUTOMATIC WHEN ALL ANSWERS ARE APPROVED / REQUIRE APPROVAL}}`
- Prefer official employer application over aggregator easy apply: `{{YES/NO}}`
- Cover letter: `{{WHEN REQUESTED / ALWAYS / NEVER}}`
- Default optional demographics: `{{DECLINE / LEAVE BLANK / USER-PROVIDED VALUES}}`

## Mandatory stops

Confirm whether each item must stop for the user:

- CAPTCHA: `{{YES}}`
- Email-address verification code: `{{AUTOMATIC WHEN UNAMBIGUOUS / STOP}}`
- Authenticator app, security key, recovery flow, or other MFA: `{{YES}}`
- Missing required fact: `{{YES}}`
- Legal or compliance attestation not already approved: `{{YES}}`
- Compensation without a published range: `{{YES/NO}}`
- Relocation not covered by preferences: `{{YES}}`
- Final submit: `{{FOLLOW FINAL-SUBMISSION POLICY ABOVE}}`

## Verification requirements

- Resume PDF visually inspected: `{{YES}}`
- Selectable text checked: `{{YES}}`
- Official posting active immediately before submission: `{{YES}}`
- Explicit submission confirmation required: `{{YES}}`
- Email confirmation required in addition to portal confirmation: `{{YES/NO}}`
