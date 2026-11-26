# Local Jake resume compilation benchmark

This is a **synthetic prototype**, not a change to the application renderer.
The current private Overleaf path remains the default. Issue #217 tracks a
production compiler decision.

## Reproduce

Install Tectonic 0.17 and cache the standard LaTeX packages used by
`templates/resume/main.tex`. Then run:

```bash
npm ci
npm run benchmark:resume-local -- 10
```

The script builds a job-specific source with `createJakeResumeSource` from a
fixed synthetic candidate and job. Each sample starts a new Tectonic process,
compiles in a private temporary directory using `--only-cached --untrusted`,
then runs the existing `verifyResumePdf` checks on the resulting PDF. It never
uses a real candidate file, an Overleaf account, or a network fetch from
Tectonic. The optional `OPENAPPLY_KEEP_SYNTHETIC_BENCH=1` retains synthetic
output for visual inspection; the default deletes it. No PDF is committed.

## Observed result

Measured November 26, 2026 on macOS arm64 with Tectonic 0.17.0, Node 25.5.0,
and warm cached TeX packages. Times are wall-clock milliseconds. p95 is the
nearest-rank sample; these tiny runs are **not** a production latency bound.

| Run | Samples | Compile median / p95 | PDF verify median / p95 | Result |
| --- | ---: | ---: | ---: | --- |
| First | 5 | 471 / 500 ms | 27 / 381 ms | 5 PDFs verified |
| Repeat | 10 | 421 / 476 ms | 22 / 358 ms | 10 PDFs verified |

The output was a 21,641-byte, one-page US Letter PDF. Its subject held the
exact job/source render token, text was selectable, and the existing verifier
accepted every copy. I also rendered and inspected the first page with Poppler:
the sparse synthetic example had legible text, intact links, and no visible
clipping or overlap. It does not exercise a dense two-page candidate resume.

The benchmark excludes container startup, installing or warming TeX packages,
candidate extraction, tailoring, browser work, upload, cloud storage, and
submission. No equivalent Overleaf timing was collected, so this result does
**not** establish that local compilation is faster or more reliable than
Overleaf for the product.

## Production decision gates

1. Pin a complete local TeX bundle in the browser/renderer image and test a
   cold container with network disabled. `--only-cached` fails without those
   resources; a developer's warm cache is not a deployable bundle.
2. Run the compiler in a separate process/container with no network, no AWS
   or browser credentials, a single candidate/job input, owner-only output,
   bounded CPU, memory, process count, time, and filesystem access. Tectonic's
   `--untrusted` flag is useful but is not an OS security boundary.
3. Compare local and Overleaf outputs from the same approved synthetic and
   consented real resumes: page count, layout, text, links, source token,
   compile failures, median/p95 latency, and cost. Include one- and two-page
   examples and uncommon Unicode characters.
4. Only switch the hosted default after visual parity and security review.
   Keep the selected Jake template and existing source/PDF checks. Overleaf
   may remain an optional authoring or fallback route under the user's policy.
