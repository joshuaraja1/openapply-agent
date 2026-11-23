import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("default resume template", () => {
  it("preserves Jake Gutierrez attribution and ATS-readable layout commands", async () => {
    const template = await readFile("templates/resume/main.tex", "utf8");
    expect(template).toContain("Original template author: Jake Gutierrez");
    expect(template).toContain("License: MIT");
    expect(template).toContain("\\pdfgentounicode=1");
    expect(template).toContain("\\newcommand{\\resumeSubheading}");
    expect(template).toContain("FULL NAME");
    expect(template).not.toContain("Jake Ryan");
    expect(template).not.toContain("jake@su.edu");
  });
});
