# Live handoff email staging check

Run this check only with a verified sender domain and a private notification
config addressed to an inbox you control. It creates a synthetic queue item and
an encrypted, temporary `waiting-human` checkpoint. It opens no employer site,
uploads no résumé, and submits no application. The email contains only the
standard generic OpenApply reminder.

1. Store a domain-scoped Resend key in the operating-system secret store and
   point a private `handoff-notification.json` at its reference. Keep that file
   outside this repository with user-only permissions.
2. Compute the lowercase recipient's SHA-256 hash locally. Supply it as
   `OPENAPPLY_LIVE_HANDOFF_RECIPIENT_SHA256`; the test refuses to send unless it
   matches the recipient in the private config.
3. Run `npm run build`, then set `OPENAPPLY_NOTIFICATION_CONFIG` to the absolute
   private config path and `OPENAPPLY_LIVE_HANDOFF_EMAIL=send-once`. Run
   `npm test -- test/live-handoff-email.stage.test.ts`.
4. Confirm that the message reached the intended inbox. Record only the run
   time, delivery outcome, and issue link in the staging report. Do not save the
   key, email address, or message metadata in the repository.

The test checks one accepted Resend request, a durable email marker, and no
second request after reopening encrypted state. Resend acceptance alone does
not prove inbox delivery. Without the explicit opt-in, this test is skipped in
ordinary CI. The separately tested production queue CLI and browser runner are
not exercised by this check.
