# Synthetic queue and recovery benchmark

Run `npm run build` followed by `npm run queue:benchmark`. CI runs the same fixed
fixture on macOS, Windows, and Linux and uploads a JSON report for each system.
The report records the median and p95 elapsed time for five runs of 100 distinct
synthetic jobs. These runs exercise quota reservations, retry checks, canonical
claim callbacks, and queue outcomes using in-memory stores and no network.

The recovery measurement starts a child process, writes an encrypted durable
`submit-claimed` checkpoint and one **simulated** final-click marker, kills that
process, then starts a separate process. The second process reads the checkpoint
and records `submission-uncertain` without another marker. Its time includes
process startup and checkpoint recovery. Temporary state and its synthetic key
are removed at the end of the run.

These timings do **not** measure discovery fetch, ranking, résumé tailoring,
Overleaf PDF rendering, browser actions, employer portal waits, real final
clicks, notification delivery, or full application latency. A successful run
does not prove recovery at every application boundary. The public release gate
in [the release requirements](autonomy-release-requirements.md) still requires
controlled provider runs and a monitored beta.
