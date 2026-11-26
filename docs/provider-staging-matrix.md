# Greenhouse and Ashby controlled staging matrix

The `provider-form-matrix.test.ts` suite generates **100 distinct form-mapping
contracts per provider**: five name layouts × four field bundles × five safety
conditions. Of each provider's 100 cases, 20 are clean mapping paths and 80
deliberately stop before browser actions. It checks exact candidate-backed
identity values, résumé upload selection, the two explicit U.S.
work-authorization selects, and fail-closed
behavior for unknown required fields, duplicate email controls, CAPTCHA text,
and absent résumé controls. The candidate and job data are synthetic.

The separate `provider-portal.e2e.test.ts` suite uses a controlled Chromium
portal. For Greenhouse and Ashby, it exercises two-step navigation, an upload
control, a local job-bound thank-you paragraph, unknown required questions,
requisition switching,
conditional fields, validation errors, and identity-label drift. The same
suite also covers the other advertised providers at a smaller breadth.
The upload fixture is a fake `%PDF-1.4` byte string, and the PDF verifier is
injected with a synthetic success result. This does not validate a rendered
résumé or an employer-issued receipt.

Run the checks with:

```sh
npm run typecheck
npx vitest run test/provider-form-matrix.test.ts
OPENAPPLY_BROWSER_E2E=1 npx vitest run test/provider-portal.e2e.test.ts
```

These contracts are **not** 100 completed applications per provider and do not
establish a real-site success rate. No live employer form was filled or
submitted for this matrix. The release gate still requires consented,
low-volume real-site validation, measured recovery and confirmation outcomes,
and the monitored beta defined in `autonomy-release-requirements.md`.
