# Contributing

## Development setup

```bash
npm ci
npm run check
```

Use sanitized fixtures. Never commit a real résumé, address, email, phone number, credential, application response, browser profile, or application log.

## Pull requests

- One logical change per PR.
- Prefer 100–400 changed source lines; split larger work into dependent PRs.
- Separate refactors from behavior changes.
- Keep every merge deployable and reversible.
- Add happy-path and edge-case tests.
- Explain why, trade-offs, verification, and rollback in the PR description.
- Self-review the complete diff before requesting review.

Generated lockfile changes do not count toward the source-line guideline, but they must still be reviewed.

## Commit style

Use a short conventional prefix such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`. A commit should be safe to revert without undoing unrelated work.

## Adding an ATS adapter

1. Add a parser in `src/sources/` with schema validation.
2. Normalize into `NormalizedJob` without provider-specific fields leaking outward.
3. Add sanitized fixtures for missing and malformed optional data.
4. Wire the source into `fetchSource`.
5. Document rate limits and source terms.
