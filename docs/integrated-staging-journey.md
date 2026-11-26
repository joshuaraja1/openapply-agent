# Controlled application journey

`test/queue-handoff-integration.test.ts` now runs one synthetic candidate and
Greenhouse-shaped job through the private Markdown compiler, evidence-backed
matching, Jake-template source generation, job-bound PDF verification, queue
quota, simulated form upload, unknown-question handoff, generic email alert,
encrypted checkpoint restart, approved answer, exact-job confirmation, and
duplicate-submit refusal. The PDF is a controlled fixture carrying the source
token; it is **not** an Overleaf render. The browser and Resend sender are local
fakes, and no employer site is opened.

Run it with `npm test -- test/queue-handoff-integration.test.ts`. The separate
`test/first-run-browser-flow.e2e.test.ts` covers the interactive setup screen;
`test/live-overleaf.stage.test.ts` covers an opt-in synthetic Overleaf render.
These tests do not form one live, installed product journey. A clean-machine
setup, real posting, actual browser form, delivered alert, candidate handoff,
and employer-bound receipt still require consented beta evidence on each
supported OS and provider.
