# Greenhouse and Ashby controlled completion gate

`provider-completion-matrix.e2e.test.ts` runs **100 completed controlled
browser applications per provider** when `OPENAPPLY_BROWSER_E2E=1`. The
Cartesian matrix has five distinct name layouts, four contact-field bundles,
and five step layouts for both Greenhouse and Ashby. Every case has a unique
synthetic requisition URL. The test launches Chromium, fills actual controls,
uploads a valid PDF fixture, traverses two or three steps, clicks Submit once,
and asserts the local job-bound checkpoint and visible thank-you paragraph.
The optional-reveal layout checks a field revealed after filling; the separate
`provider-portal.e2e.test.ts` checks that required conditional questions and
validation errors pause instead of counting as completions.

Run locally with:

```sh
OPENAPPLY_BROWSER_E2E=1 npx vitest run test/provider-completion-matrix.e2e.test.ts
```

The owned-browser CI job runs the same suite. The 200 cases take roughly two
minutes on a local Mac. The PDF is structurally valid, but this test injects a
verifier result and does **not** establish résumé visual QA. The provider
labels and pages are synthetic; the thank-you paragraph is local fixture
content, not an employer-issued receipt. This gate does not prove live
Greenhouse or Ashby compatibility, site terms compliance, real-site completion
rate, or monitored beta results. Those release gates remain separate.
