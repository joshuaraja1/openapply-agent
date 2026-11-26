# Synthetic queue and recovery benchmark

Run `npm run build` followed by `npm run queue:benchmark`. CI runs the same fixed
fixture on macOS, Windows, and Linux and uploads a JSON report for each system.
The report records the median and p95 elapsed time for five runs of 100 distinct
synthetic jobs. These runs exercise quota reservations, retry checks, canonical
claim callbacks, and queue outcomes using in-memory stores and no network.

The same CI job runs `npm run application:benchmark` and uploads
`application-benchmark.json`. It measures 30 in-memory queue-to-job-bound-confirmation
fixtures through the production queue, checkpoint, and submission functions.
It then simulates 1,000 distinct ambiguous post-click outcomes and verifies
that each stays `submission-uncertain` and a retry never repeats its final click.
The report includes sample counts, failures, median, p95, and click counts.
This is a **synthetic in-process safety and overhead measurement**. It excludes
real discovery, browser, PDF, employer network, and process startup.

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

The 1,000 new fixtures simulate an ambiguous renderer result; they do not kill
1,000 operating-system processes. The separate-process fixture above tests
one actual worker termination.
