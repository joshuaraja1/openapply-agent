# OpenApply Agent

OpenApply Agent is a privacy-first, human-in-the-loop workflow for discovering fresh jobs, ranking them against evidence-backed candidate facts, tailoring application materials, and preparing guarded browser handoffs.

It does not include anyone's résumé, address, credentials, application history, or generated documents.

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
npm ci
npm run check
```

## Quick start

1. Copy `templates/user/` to a private directory and complete the Markdown files.
2. Copy the JSON files in `examples/` and replace the examples with private, verified data.
3. Enable official Greenhouse, Ashby, or Workday sources.
4. Run the workflow:

```bash
OPENAPPLY_INPUT=/private/discovery-input.json \
OPENAPPLY_CANDIDATE=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES=/private/search-preferences.json \
npm start
```

The output is a ranked local queue containing an evidence-filtered résumé brief and a guarded browser handoff. See [the workflow guide](docs/workflow.md), [architecture](docs/architecture.md), and [safety model](docs/safety.md).

## Supported discovery sources

- Greenhouse public job-board API
- Ashby public posting API
- Workday public career-site endpoint

More adapters should follow the normalization contract and test requirements in [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project does not do

- It does not bypass CAPTCHA, MFA, rate limits, or access controls.
- It does not invent candidate claims or sensitive answers.
- It does not scrape private LinkedIn data.
- It does not submit by default; final approval is the default policy.

See the repository's merged pull requests for the staged implementation and review rationale.

## License

MIT
