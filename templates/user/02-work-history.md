# Work History — Source of Truth

Everything used in a résumé or application must come from this file or another source explicitly permitted in `04-source-policy.md`.

## Experience summary

Describe total experience precisely. Distinguish full-time, part-time, internships, contract work, volunteering, and projects.

`{{EXAMPLE: Work history spanning MONTH YEAR to present across part-time engineering, internships, and contract engagements. Do not represent the entire period as full-time employment.}}`

## Professional experience

Repeat this section for every role in reverse chronological order.

### `{{JOB TITLE}}` — `{{EMPLOYER}}`

- Employment type: `{{FULL-TIME / PART-TIME / INTERN / CONTRACT}}`
- Dates: `{{MONTH YEAR}}` – `{{MONTH YEAR OR PRESENT}}`
- Location: `{{LOCATION OR NOT PROVIDED}}`
- Engagement or product: `{{GENERIC DESCRIPTION; DO NOT NAME CONFIDENTIAL CLIENTS}}`
- Tools used: `{{TOOLS ACTUALLY USED}}`

Verified accomplishments:

- `{{RESULT}}` by `{{ACTION}}` using `{{TOOLS OR METHODS}}`.
- `{{RESULT WITH VERIFIED NUMBER}}` by `{{ACTION}}`.
- `{{SCOPE OR SCALE WHEN NO NUMBER EXISTS}}` by `{{ACTION}}`.

Evidence:

- Source: `{{MASTER RESUME / PORTFOLIO / REPOSITORY / USER CONFIRMATION}}`
- Location: `{{FILE PATH OR URL}}`
- Restrictions: `{{CONFIDENTIALITY OR NAMING LIMITS}}`

## Projects

Repeat for each project.

### `{{PROJECT NAME}}`

- Dates: `{{MONTH YEAR}}`
- URL: `{{REPOSITORY OR DEMO URL}}`
- Tools: `{{TOOLS ACTUALLY USED}}`
- Problem: `{{WHAT THE PROJECT SOLVES}}`
- Scope: `{{USERS, RECORDS, SYSTEMS, OR OTHER VERIFIED SCALE}}`
- Contribution: `{{WHAT YOU PERSONALLY DID}}`
- Outcome: `{{VERIFIED RESULT}}`
- Testing or validation: `{{HOW IT WAS VERIFIED}}`

## Skills inventory

- Languages: `{{LIST}}`
- Frontend: `{{LIST}}`
- Backend and APIs: `{{LIST}}`
- Databases and data engineering: `{{LIST}}`
- Cloud and infrastructure: `{{LIST}}`
- AI and machine learning: `{{LIST}}`
- Testing and observability: `{{LIST}}`
- Other domain tools: `{{LIST}}`

## Quarantined claims

Put conflicting, outdated, unverified, or disallowed claims here. The workflow must not use them until the user verifies and promotes them.

- Claim: `{{CLAIM}}`
  - Reason quarantined: `{{CONFLICT / NO EVIDENCE / OUTDATED / CONFIDENTIAL}}`
  - Required resolution: `{{USER CONFIRMATION OR SOURCE}}`

## Structured work history for OpenApply

Put every résumé fact you authorize in this JSON block. Each claim needs a
source, an evidence location, a status, and allowed uses. Keep unsupported
claims in `quarantinedClaims` instead of promoting them.

```openapply-history-json
{
  "version": 1,
  "skills": { "languages": ["{{VERIFIED_SKILL}}"] },
  "experience": [{
    "employer": "{{EMPLOYER}}",
    "title": "{{JOB_TITLE}}",
    "employmentType": "{{FULL-TIME_OR_PART-TIME_OR_CONTRACT_OR_INTERN}}",
    "start": "{{MONTH_YEAR}}",
    "end": "{{MONTH_YEAR_OR_PRESENT}}",
    "claims": [{
      "id": "{{UNIQUE_CLAIM_ID}}",
      "claim": "{{VERIFIED_RESULT_AND_ACTION}}",
      "skills": ["{{VERIFIED_SKILL}}"],
      "metrics": [],
      "evidence": [{ "source": "{{SOURCE_NAME}}", "uri": "{{PRIVATE_FILE_PATH_OR_URL}}" }],
      "status": "user-confirmed",
      "allowedUses": ["matching", "resume", "application"]
    }]
  }],
  "projects": [],
  "quarantinedClaims": []
}
```
