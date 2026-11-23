# OpenApply Agent

OpenApply Agent is a privacy-first, human-in-the-loop workflow for discovering fresh jobs, ranking them against evidence-backed candidate facts, tailoring application materials, and preparing guarded browser handoffs.

The project is being built in small, reviewable slices. It does not include anyone's résumé, address, credentials, application history, or generated documents.

## Principles

- Public ATS feeds for discovery; official employer pages for validation.
- Candidate claims require explicit evidence and allowed-use scopes.
- No invented metrics, experience, qualifications, or demographic answers.
- CAPTCHA, MFA, ambiguous compliance questions, and sensitive unknowns stop for a person.
- Final submission is configurable and defaults to human approval.
- Every application attempt is auditable and deduplicated.

## Development

Requires Node.js 22 or later.

```bash
npm install
npm run check
```

See the repository history and pull requests for the staged implementation.

## License

MIT
