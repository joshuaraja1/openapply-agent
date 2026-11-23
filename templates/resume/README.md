# Default resume template

`main.tex` is the Jake Gutierrez LaTeX resume template, based on the `sb2nov/resume` project and distributed under the MIT License. The attribution header must remain in derivative copies.

The checked-in file contains placeholders only. A run should:

1. Read the user's completed private Markdown templates.
2. Copy `main.tex` into a private, role-specific working directory or Overleaf project.
3. Replace placeholder content with verified candidate facts and role-specific wording.
4. Preserve Jake's layout commands, margins, typography, section styling, and ATS Unicode configuration unless the user explicitly chooses a different template. The small engine guard keeps the original `pdfLaTeX` Unicode behavior while allowing local XeTeX validation.
5. Compile in Overleaf, download the PDF, render every page, and complete the visual and claim QA checklist before upload.

Never write a user's contact information, work history, or generated PDF back into this public directory.
