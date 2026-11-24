# Job Search Preferences

## Target roles

Primary titles:

- `{{ROLE FAMILY}}`
- `{{ROLE FAMILY}}`

Accepted adjacent titles:

- `{{ADJACENT ROLE}}`

Excluded titles or seniority terms:

- Senior
- Staff
- Principal
- Lead
- Manager
- Director
- `{{OTHER EXCLUSIONS}}`

## Experience level

- Preferred: `{{INTERNSHIP / NEW GRAD / ENTRY LEVEL / JUNIOR}}`
- Accept roles requesting up to: `{{NUMBER}}` years
- Stretch roles requesting up to: `{{NUMBER}}` years when strongly matched

## Location and work arrangement

- Canonical application location: `{{CITY, STATE}}`
- Preferred: `{{REMOTE / HYBRID / ON-SITE}}`
- Accepted: `{{LIST}}`
- Relocation willingness: `{{LOCATIONS OR NO}}`
- Travel willingness: `{{DETAILS}}`

## Compensation

- Currency: `{{USD}}`
- Preferred base floor: `{{AMOUNT}}`
- Hard reject below floor: `{{YES/NO}}`
- Target point inside a published range: `{{EXAMPLE: 70%}}`
- Require review before answering compensation questions: `{{YES/NO}}`

## Freshness and volume

- Preferred posting age: `{{24–48 HOURS}}`
- Secondary window: `{{72 HOURS}}`
- Maximum routine window: `{{ONE WEEK}}`
- Daily target: `{{NUMBER}}`
- Daily hard cap: `{{NUMBER}}`
- Prevent duplicates: `{{YES}}`

## Sources

Use aggregators for discovery only. Validate on the official employer or ATS page before applying.

- LinkedIn Jobs: `{{YES/NO}}`
- Google Jobs: `{{YES/NO}}`
- Jobright: `{{YES/NO}}`
- Company career pages: `{{YES/NO}}`
- Greenhouse, Ashby, Workday, Lever, SmartRecruiters, iCIMS: `{{YES/NO}}`

## Submission policy

- Prepare only: `{{YES/NO}}`
- Final submission requires approval: `{{YES/NO}}`
- Authorized to submit supported applications automatically: `{{YES/NO}}`
- Always stop for: CAPTCHA, MFA, unknown sensitive answers, ambiguous compliance disclosures, unsupported claims, or unclear work authorization.

## Structured search preferences for OpenApply

Keep this block consistent with the choices above. The compiler reads it to
set the search and submission policy.

```openapply-search-json
{
  "version": 1,
  "targetRoles": ["{{ROLE_FAMILY}}"],
  "excludeSeniorityTerms": ["senior", "staff", "principal", "lead", "manager", "director"],
  "workArrangements": {
    "preferred": ["{{REMOTE_OR_OTHER}}"],
    "accepted": ["{{REMOTE_OR_HYBRID_OR_ONSITE}}"]
  },
  "compensation": { "preferredBaseFloor": 0, "targetRangePosition": 0.7 },
  "applicationPolicy": { "dailyTarget": 10, "dailyHardCap": 25, "requireFinalApproval": true }
}
```
