# Synthetic queue CLI staging check

Run `npm test -- test/queue-cli.stage.test.ts` to exercise the production
`queue-cli.ts` entrypoint with an isolated synthetic user root. The test loads
private-shaped queue, candidate, preferences, and notification files; checks
evidence-backed matching and package creation; writes an encrypted
`waiting-human` checkpoint; and intercepts one generic Resend request. It
then simulates a restart: an uncleared workflow lease blocks the second run,
and an explicitly cleared lease permits replay without a duplicate email or
application attempt.

The fixture uses `example.invalid` and a fake candidate. The Overleaf renderer,
application browser runner, OS secret store, and network request are replaced
with test doubles. No employer page opens, no email is delivered, and no
application is submitted. This check proves CLI orchestration and recovery
at the synthetic boundary; it does not replace the separate live Overleaf,
operator inbox, provider form, or consented beta checks.
