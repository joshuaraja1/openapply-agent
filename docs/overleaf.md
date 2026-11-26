# Overleaf resume workflow

OpenApply uses Jake Gutierrez's MIT-licensed LaTeX resume as its default layout. Users provide facts and preferences through private copies of the Markdown templates; the agent supplies only verified, role-relevant content.

`createJakeResumeSource` now produces a separate LaTeX source and SHA-256
fingerprint per job from approved candidate claims. It preserves the template
preamble and layout, keeps experience chronology, orders supported bullets by
relevance, and escapes candidate text. If no supported claim matches the
posting, generation stops.

`verifyResumePdf` accepts a downloaded PDF only when its source fingerprint,
embedded render token, approved claim text, candidate name, company, role title,
active email link, page size, text extraction, page bounds, and significant text
overlap checks pass. It also rasterizes every page and rejects blank output,
excessive ink, and content within five points of the paper edge. It also rejects
a second page with ink on fewer than 12% of its raster rows, which catches a
short overflow page after tailoring. It records the exact PDF hash for the
application checkpoint. The embedded browser uploads
the verified bytes only after checking that hash again. `resume:render` now
fills the source editor in a private Overleaf project through BrowserOS neo,
recompiles, downloads the PDF, and verifies it before writing a private
application package. The raster gate catches visual defects missed by text
extraction. It now rejects a page with fewer than 100 pixels whose contrast
against white paper reaches 4.5:1, and runs the real PDF fixture on Linux,
Windows, and the owned-browser smoke job. This is a whole-page floor: one dark
heading can coexist with unreadable pale body text, so the check does not yet
judge contrast per text region, typography, or section spacing.
Visually review those qualities before enabling unattended submission.

## One-time setup

1. Create a dedicated private Overleaf project for OpenApply. The renderer replaces its `main.tex` on every run.
2. Upload `templates/resume/main.tex` as the project's `main.tex`.
3. Select pdfLaTeX as the compiler.
4. Store the private project URL in `07-run-config.md`.

The user may instead ask the agent to create a fresh private Overleaf project for each role. Never publish or commit an Overleaf project containing personal information.

## Per-role tailoring

1. Read the complete official job description and the completed private templates.
2. Copy the default `main.tex` into a role-specific private Overleaf project or private working copy.
3. Replace placeholders with supported contact details, education, experience, projects, and skills.
4. Tailor wording and ordering for the role without changing chronology or inventing claims.
5. Keep Jake's layout and attribution header. Do not paste another candidate's example content.
6. Compile in Overleaf and resolve every LaTeX error or warning that affects output.
7. Download the role-specific PDF with a company-and-role filename.
8. Render every page to an image and verify spacing, clipping, overlap, page count, selectable text, hyperlinks, chronology, and claim support.
9. Upload only the verified role-specific PDF to the application.

If Overleaf is unavailable, stop and report the blocker unless the private run policy explicitly permits a local LaTeX fallback.
