# Security and privacy

## Supported versions

Security fixes target the latest `main` branch.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, candidate data, browser session details, or an exploitable target.

## Data handling

- Keep candidate files and generated documents outside version control.
- Use environment variables or a local secret store for credentials.
- Treat browser profiles as sensitive assets.
- Restrict application handoffs to the official employer or ATS domain.
- Stop for CAPTCHA, MFA, sensitive unknowns, unsupported claims, and ambiguous legal attestations.
- Do not bypass a site's access controls or terms.

If personal data is committed, rotate exposed credentials where relevant, remove the data from Git history, and notify affected people.
