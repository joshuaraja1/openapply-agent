# Overleaf resume workflow

OpenApply uses Jake Gutierrez's MIT-licensed LaTeX resume as its default layout. Users provide facts and preferences through private copies of the Markdown templates; the agent supplies only verified, role-relevant content.

`createJakeResumeSource` now produces a separate LaTeX source and SHA-256
fingerprint per job from approved candidate claims. It preserves the template
preamble and layout, keeps experience chronology, orders supported bullets by
relevance, and escapes candidate text. If no supported claim matches the
posting, generation stops. It does not compile or verify a PDF yet; that
renderer boundary must be completed before any automatic upload.

## One-time setup

1. Create a blank Overleaf project.
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
