# Candidate Profile

## Contact

- Full legal name: `{{FULL_NAME}}`
- Preferred first name: `{{PREFERRED_NAME}}`
- Application location: `{{CITY, STATE, COUNTRY}}`
- Street address: `{{PRIVATE_ADDRESS — KEEP OUT OF GIT}}`
- Email: `{{EMAIL}}`
- Phone: `{{PHONE}}`
- LinkedIn URL: `{{LINKEDIN_URL}}`
- GitHub URL: `{{GITHUB_URL}}`
- Portfolio URL: `{{PORTFOLIO_URL}}`

## Work authorization

- Country or countries of citizenship: `{{COUNTRIES}}`
- Authorized to work in target country: `{{YES/NO}}`
- Sponsorship required now: `{{YES/NO}}`
- Sponsorship required in the future: `{{YES/NO}}`
- Other passports or citizenships: `{{LIST OR NONE}}`

## Education

Repeat this section for each degree.

- Institution: `{{SCHOOL}}`
- Degree and major: `{{DEGREE}}`
- Graduation month and year: `{{MONTH YEAR}}`
- GPA: `{{VALUE OR NOT PROVIDED}}`
- Evidence source: `{{TRANSCRIPT, DIPLOMA, MASTER RESUME, OR USER CONFIRMATION}}`

## Certifications

- Certification: `{{NAME}}`
- Issuer: `{{ISSUER}}`
- Date earned: `{{DATE OR NOT PROVIDED}}`
- Verification URL or source: `{{URL OR FILE}}`

## Sensitive-answer defaults

These values are optional. `Decline to self-identify` is the recommended default unless the user explicitly chooses otherwise.

- Gender: `{{DECLINE OR USER-PROVIDED VALUE}}`
- Race or ethnicity: `{{DECLINE OR USER-PROVIDED VALUE}}`
- Veteran status: `{{DECLINE OR USER-PROVIDED VALUE}}`
- Disability status: `{{DECLINE OR USER-PROVIDED VALUE}}`

## Structured identity for OpenApply

Fill this block with the same verified facts above. The compiler reads only
this block; keep the completed file private. Add education claims with evidence
and approved uses if you want them on a résumé. Remove optional portfolio,
GitHub, or LinkedIn keys when you have no URL. Replace sponsorship with the
JSON boolean `true` or `false`.

```openapply-identity-json
{
  "version": 1,
  "identity": {
    "fullName": "{{FULL_NAME}}",
    "location": "{{CITY, STATE}}",
    "email": "{{EMAIL}}",
    "phone": "{{PHONE}}",
    "portfolio": "{{PORTFOLIO_URL}}",
    "github": "{{GITHUB_URL}}",
    "linkedin": "{{LINKEDIN_URL}}"
  },
  "authorization": {
    "countries": ["{{COUNTRY}}"],
    "sponsorshipRequiredNowOrFuture": "{{TRUE_OR_FALSE}}"
  },
  "education": []
}
```
