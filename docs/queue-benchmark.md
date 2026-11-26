# Synthetic queue and recovery benchmark

Run `npm run build` followed by `npm run queue:benchmark`. CI runs the same fixed
fixture on macOS, Windows, and Linux and uploads a JSON report for each system.
The report records the median and p95 elapsed time for five runs of 100 distinct
synthetic jobs. These runs exercise quota reservations, retry checks, canonical
claim callbacks, and queue outcomes using in-memory stores and no network.

The recovery measurement starts a child process, writes an encrypted durable
`submit-claimed` checkpoint and one **simulated** final-click marker. A second
process is refused while the first holds the workflow lease. The fixture then
kills the first process, confirms it exited, clears only its synthetic stale
lock, and starts a separate process. That process invokes the production
recovery helper to record `submission-uncertain` without another marker. Its
time includes process startup and checkpoint recovery. Production requires
operator inspection before clearing a stale lock; this fixture can prove its
own child exited. Temporary state and its synthetic key are removed afterward.

These timings do **not** measure discovery fetch, ranking, résumé tailoring,
Overleaf PDF rendering, browser actions, employer portal waits, real final
clicks, notification delivery, or full application latency. A successful run
does not prove recovery at every application boundary. The public release gate
in [the release requirements](autonomy-release-requirements.md) still requires
controlled provider runs and a monitored beta.
