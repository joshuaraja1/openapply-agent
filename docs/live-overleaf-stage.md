# Live Overleaf staging check

This opt-in check uses a disposable, private Overleaf project. It generates only
synthetic résumé facts, fills the editor through BrowserOS neo, recompiles,
downloads the PDF, and runs the job-bound verifier. It never opens an employer
site or submits an application.

1. Create a fresh blank Overleaf project dedicated to this check. Keep the
   project private; the test replaces its `main.tex`. Do not use a candidate's
   active résumé project.
2. Make sure BrowserOS neo is running and signed into Overleaf. Set
   `OPENAPPLY_OVERLEAF_STAGE_PROJECT_URL` to the direct project URL and
   `OPENAPPLY_BROWSEROS_ENDPOINT` to its loopback MCP endpoint.
3. Set `OPENAPPLY_LIVE_OVERLEAF_STAGE=run-once`, then run
   `npm test -- test/live-overleaf.stage.test.ts` from the repository root.
4. Render the resulting PDF page to an image and inspect legibility, spacing,
   clipping, overlap, section order, and broken characters. Remove the test
   project when finished.

Without the explicit opt-in, CI skips this test. A successful automated check
proves this one synthetic render and the verifier's current checks. It does not
establish visual quality for arbitrary candidate content, browser recovery,
provider form behavior, or unattended public readiness.
