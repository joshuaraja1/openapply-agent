# Architecture

OpenApply separates public discovery from private application execution.

```text
Official ATS feeds
      │
      ▼
Source adapters ──► normalized jobs ──► freshness and deduplication
                                             │
Private candidate facts ──► evidence matching│
                                             ▼
                                  ranked review queue
                                             │
                            tailoring brief + domain guard
                                             │
                                             ▼
                              local browser / human review
```

## Boundaries

- `src/sources`: provider-specific validation and normalization.
- `src/discovery.ts`: keyword policy and freshness tiers.
- `src/candidate`: evidence, allowed uses, and search preferences.
- `src/matching`: explainable, deterministic ranking.
- `src/resume`: a brief containing only supported claims.
- `src/application`: domain restrictions and mandatory stop conditions.
- `src/cli.ts`: local orchestration and auditable JSON output.

Discovery can run on a scheduler. Résumé files, browser sessions, MFA, and application answers stay local.
