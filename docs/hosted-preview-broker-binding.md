# Scoped hosted preview input binding

The `loadPreviewBinding` run-state broker operation accepts only the launch
capability and the active lease token. It derives candidate, run, job, lead ID,
and profile artifact ID from the trusted run ledger. The caller cannot select a
different lead or profile. The broker checks the task reservation, account
deletion marker, lease, current consent, paid or approved free access, absence
of a submission intent, the exact `VERIFIED` lead row, and the approved profile
marker. It reads the lead and profile marker consistently before and after
the provider request.

The cached lead row is a locator. At task execution time the broker queries the
fixed official ATS API again and rejects a missing, duplicate, expired, closed,
or changed posting, including a changed application URL or description. The
response contains only fresh lead metadata and the run-bound profile artifact
ID. Profile bytes remain in the encrypted candidate vault and require the
existing scoped STS grant to restore.

This operation does not start Chromium, render a PDF, persist a handoff, write a
submit intent, or mark a dispatch completed. The separate preview task path
must acquire its own lease, call `loadPreviewBinding`, restore the approved
profile through `CandidateVault`, render the generated Jake source in an
isolated PDF process, call `runHostedPreSubmitPreview`, and persist a durable
review or handoff checkpoint. It must not call `handleQueuedApplication`, which
always proceeds to `beginSubmission` and `submitOnce` after `prepare`. Real
submission remains disabled.
