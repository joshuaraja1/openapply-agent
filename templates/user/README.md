# User setup templates

Copy this directory to a private location before filling it in. Do not commit completed templates to a public repository.

Recommended order:

1. `01-candidate-profile.md` — contact, authorization, links, and education.
2. `02-work-history.md` — the complete source of truth for experience and projects.
3. `03-search-preferences.md` — role, location, salary, freshness, and volume preferences.
4. `04-source-policy.md` — which sources may support which claims.
5. `05-resume-tailoring.md` — formatting and truthfulness rules.
6. `06-application-answers.md` — reusable answers that the user has explicitly approved.
7. `07-run-config.md` — private paths, browser connection, submission policy, stop conditions, and logging.
8. `08-authentication.md` — browser-profile import, account selection, secret references, and email-code consent.

Replace every `{{PLACEHOLDER}}`. Delete examples that do not apply. Keep unsupported claims in the quarantine section instead of quietly promoting them to verified facts.

The compiler consumes the `openapply-identity-json`, `openapply-history-json`,
and `openapply-search-json` fenced blocks in templates 01–03. The surrounding
prose helps you collect facts but is not interpreted as résumé evidence. Keep
the JSON blocks consistent with it. Compile to private JSON files with:

```bash
OPENAPPLY_PROFILE_MD=/private/01-candidate-profile.md \
OPENAPPLY_WORK_MD=/private/02-work-history.md \
OPENAPPLY_SEARCH_MD=/private/03-search-preferences.md \
OPENAPPLY_PROFILE_OUTPUT=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES_OUTPUT=/private/search-preferences.json \
npm run profile:compile
```

The command refuses unresolved placeholders, unapproved résumé claims, and
world-readable inputs. It creates output files with user-only permissions and
will not overwrite different existing files. If interrupted between outputs,
rerun the same command to finish; move old outputs before changing source facts.
The compiler currently runs on macOS and Linux; Windows needs a reviewed
user-only ACL implementation before handling private candidate data.
