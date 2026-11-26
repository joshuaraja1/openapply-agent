# Owned browser benchmark

Run `openapply browser:benchmark 30` after installing Chromium with
`openapply browser:install`. From a source checkout, run
`npm run browser:benchmark -- 30`.

The `owned-browser-synthetic-v1` fixture uses a new temporary private browser
profile and a single intercepted HTTPS page. It does not read candidate data,
cookies, or employer sites. It records one browser startup and one navigation,
then 30 warm samples each for a structured DOM snapshot and a field fill plus
the resulting snapshot. Browser context is reused for all warm samples.

The JSON report includes hardware, Node and Chromium versions, sample counts,
failures, median, nearest-rank p95, and peak process RSS. A failed sample makes
the command exit nonzero. Keep the raw JSON with the release evidence; run on
macOS, Windows, and Linux under comparable conditions.

This measures local browser overhead only. It does not establish job discovery,
résumé rendering, employer network wait, crash recovery, or end-to-end
application latency. Those need separate fixed fixtures and stage reports before
the speed gate in `autonomy-release-requirements.md` can pass.
