# End-to-end workflow

## 1. Prepare private inputs

Copy `templates/user/` outside the repository, complete every relevant placeholder, and convert the approved facts into a private candidate JSON file matching `candidateProfileSchema`.

## 2. Configure sources

Copy the files in `examples/`, enable official ATS sources, and set include and exclude keywords. Aggregators may help humans discover companies, but the automated source must be the employer's official ATS or career page.

## 3. Discover and rank

```bash
OPENAPPLY_INPUT=/private/discovery-input.json \
OPENAPPLY_CANDIDATE=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES=/private/search-preferences.json \
npm start
```

The queue prioritizes the configured freshness window and falls back only when it is empty. Persistent first-seen state prevents old Greenhouse roles from being misrepresented as newly published.

## 4. Tailor and verify

For each queue item:

1. Re-open the official job posting and confirm it is active.
2. Use the generated tailoring brief with the approved résumé template.
3. Compile to PDF and render every page to an image.
4. Check clipping, spacing, page count, selectable text, chronology, and claim evidence.

The included LaTeX file is a starter template. Replace placeholders locally; do not commit completed résumés.

## 5. Browser handoff

The queue contains the only allowed application domain and mandatory stop conditions. A browser worker may prepare supported fields. It must stop for CAPTCHA, MFA, unknown sensitive questions, unsupported claims, ambiguous compliance disclosures, or final submission when approval is required.

## 6. Record the outcome

Log the company, title, canonical URL, timestamp, tailored artifact path, answers supplied, and one of: submitted, skipped, blocked, or withdrawn. Keep the log private.

## Scheduling

Run the discovery command hourly with a scheduler such as cron, systemd, GitHub Actions with encrypted private inputs, or an agent automation. Do not place candidate data in a public CI repository.
