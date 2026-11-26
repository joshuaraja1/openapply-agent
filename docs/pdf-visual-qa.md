# PDF visual QA fixture and timing evidence

The PDF verifier runs two deterministic, generated readable page layouts and
six damaged variants through PDF.js text extraction and the native page
rasterizer. Both readable layouts pass; the second models Jake's right-aligned
dates, a tiny bullet glyph, an uppercase company label, and skill rows. Tiny
body text, a cramped uppercase section heading,
pale text, fully and partly whitewashed body text, and a rule clipped at the
paper edge require human visual review. These are synthetic examples; they do
not prove that every résumé layout defect can be detected.

The new checks conservatively flag extractable body text under 7 points, an
uppercase section heading whose larger text nearly touches the line below,
and a long text item whose dark pixels disappear across much of its measured
width. Jake's isolated bullet glyph is excluded from the body-line contrast
floor; a disposable synthetic Overleaf PDF compiled from the Jake starter
template passed the updated text-layout and page-image checks on macOS. A
Poppler page render was also inspected for legibility and spacing. Its
job/source binding was not exercised, and the PDF is not checked in.
Uncertain results keep the PDF out of employer upload and enter the
existing résumé review handoff. These heuristics can also ask for review of a
legitimate unusual layout.

## Warm page-inspection benchmark

Run `npm run build` followed by `node scripts/benchmark-pdf-visual.mjs` to
repeat the benchmark. The script makes one synthetic US Letter PDF with 28
text lines, loads it once with PDF.js, warms the page three times, then records
30 sequential inspections of the same page. It includes text-region contrast
and coverage checks. `render` times PDF.js rasterization after canvas setup;
`inspect` times pixel extraction and all image checks; `total` adds the two
measurements from each sample. p95 uses the nearest-rank sample.

| Environment and run | Page raster | Samples | Render median / p95 | Inspect median / p95 | Total median / p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| macOS arm64, Apple M1 Pro, Node 22.20.0; earlier noisy development run after the full suite | 918 × 1188 px | 30 warm | 6.60 / 41.71 ms | 10.89 / 43.37 ms | 20.67 / 58.61 ms |
| Same machine, final code; immediately after the full suite | 918 × 1188 px | 30 warm | 6.11 / 8.01 ms | 10.49 / 11.12 ms | 16.62 / 18.44 ms |
| Same machine, final code; standalone repeat | 918 × 1188 px | 30 warm | 5.98 / 7.84 ms | 10.45 / 11.26 ms | 16.48 / 17.90 ms |

Measured 2026-11-26 on fixture SHA-256
`a81ca3b28def9ca96017e3103b3d9996d1e28b331cfc9dbdb4da050cd4e58a54`.
These values exclude PDF download, file reading, document parse, text
extraction, job/source checks, and upload. They do not measure Overleaf, a
real candidate résumé, Windows or Linux speed, or queue throughput. The noisy
development run's high p95 shows that local process contention can dominate a
short benchmark; the final-code repeats are not guaranteed production bounds.
Platform CI must run the fixture suite before this slice can be merged. Issue #57
remains open for real résumé fixtures, live workflow validation, and review of
PDF.js/native canvas failure handling on each supported OS.
