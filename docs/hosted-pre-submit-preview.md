# Hosted pre-submit browser preview

`runHostedPreSubmitPreview` is an executable staging boundary for one trusted
official employer lead. It runs Chromium headlessly, generates and verifies a
job-bound résumé PDF, fills known fields, and returns either `ready-for-review`
or `needs-human`. It blocks all HTTP methods except GET and HEAD, restricts
every request to the verified employer host, refuses HTTP redirects before the
browser follows them, denies WebSockets, and always closes the browser without
clicking final Submit.

The caller supplies the durable run's `OfficialJobIdentity`, the matching
`VERIFIED` and unexpired `OfficialLeadRow`, decrypted bytes of that candidate's
approved hosted profile, and private work and browser directories. The preview
checks the lead's exact job key and official URL provider, employer, and
requisition before rendering or launching Chromium. It also checks the profile
candidate ID, the PDF's exact job and source fingerprint, and the current form's
requisition before filling. A terminal `/apply` or `/application` is removed
only while checking the official posting identity; navigation keeps the exact
verified URL. Unknown required fields and attempted HTTP writes are returned
as blockers for human handoff; unknown answers are never guessed.

The `renderResume` port must compile the generated Jake LaTeX source into a PDF
in the private work directory. The preview verifies that PDF with the existing
`verifyResumePdf` gate and deletes it before returning. The caller must store
any desired handoff artifact separately under a scoped, encrypted grant.

The controlled fixture in `test/hosted-pre-submit-preview.e2e.test.ts` serves a
Greenhouse-shaped form entirely within Playwright's route handler. It proves
known fields can be filled without an HTTP POST, unknown required fields cause
handoff, an on-change POST and WebSocket cannot reach their fixture server
handlers, and a cross-host redirect cannot reach its destination. A mismatched
requisition or employer host is rejected before Chromium or the renderer
starts. Both common terminal form paths are exercised. Run it with:

```sh
OPENAPPLY_RUN_BROWSER_E2E=1 npx vitest run test/hosted-pre-submit-preview.e2e.test.ts
```

The browser image build runs this fixture test before removing test dependencies.

## Integration boundary

This module is not connected to `CloudRunPorts.application.prepare` or enabled
for a queued cloud run. That port currently receives a run job identity and a
local profile path, but no trusted lead description or canonical application
URL. The queue integration must recheck that the exact posting is still open
in the official provider API at task execution time, then fetch the resulting
fresh verified lead row with a candidate/run-scoped capability. Checking the
row only when the run is created, or trusting a cached TTL alone, is
insufficient. It must also read the approved profile through its broker grant
and provide a production PDF renderer. The profile's confirmed claims must
retain explicit skill tags so the Jake source can select only relevant claims.
A future provider adapter needs persistent pause/resume state, exact job receipt
capture, and the existing durable submit-intent/receipt workflow before final
submission is enabled. This preview deliberately writes no submit intent
because it never reaches Submit.
