# OpenApply Agent

OpenApply Agent is a privacy-first, human-in-the-loop workflow for discovering fresh jobs, ranking them against evidence-backed candidate facts, tailoring application materials, and preparing guarded browser handoffs.

It does not include anyone's résumé, address, credentials, application history, or generated documents.

When the repository is opened in a coding-agent workspace, [`AGENTS.md`](AGENTS.md) supplies the end-to-end operating contract: continue from discovery through per-role tailoring, PDF inspection, guarded BrowserOS form filling, explicit submission verification, and private outcome logging.

The default resume layout is the MIT-licensed [Jake Gutierrez LaTeX template](templates/resume/main.tex). New users complete the private Markdown templates; the agent then produces a separate, evidence-backed resume in that layout for every role, compiles it in Overleaf, downloads the PDF, and visually verifies it before upload. See the [Overleaf workflow](docs/overleaf.md).

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
3. Enable official ATS feeds or public career pages in your discovery input.
4. Run the workflow:

```bash
OPENAPPLY_INPUT=/private/discovery-input.json \
OPENAPPLY_CANDIDATE=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES=/private/search-preferences.json \
npm start
```

The output is a ranked local queue containing an evidence-filtered résumé brief and a guarded browser handoff. See [the workflow guide](docs/workflow.md), [architecture](docs/architecture.md), and [safety model](docs/safety.md).

For signed-in discovery on LinkedIn, Jobright, Handshake, or another job board, start BrowserOS neo, copy `examples/browser-searches.json`, enable the searches you want, and run:

```bash
OPENAPPLY_BROWSER_SEARCH=/private/browser-searches.json \
OPENAPPLY_BROWSER_OUTPUT=/private/browser-leads.json \
npm run browser:discover
```

This produces a deduplicated lead queue. It intentionally does not treat aggregator metadata as authoritative; validate each lead against the employer's official posting before tailoring or applying.

## Supported discovery sources

- Greenhouse public job-board API
- Ashby public posting API
- Workday public career-site endpoint
- Lever public postings API
- SmartRecruiters public postings API
- Public career pages that expose schema.org `JobPosting` JSON-LD

Authenticated aggregators such as LinkedIn, Jobright, and Handshake require a signed-in browser workflow. They are treated as lead sources: every lead must be validated on an official employer page before application data is prepared or submitted.

More adapters should follow the normalization contract and test requirements in [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project does not do

- It does not bypass CAPTCHA, MFA, rate limits, or access controls.
- It does not invent candidate claims or sensitive answers.
- It does not scrape private LinkedIn data.
- It does not submit by default; final approval is the default policy.

See the repository's merged pull requests for the staged implementation and review rationale.

## License

MIT
