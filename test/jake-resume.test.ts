import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { createJakeResumeSource, escapeLatex } from "../src/resume/jake.js";
import type { DiscoveredJob } from "../src/types.js";

const template = await readFile("templates/resume/main.tex", "utf8");
const job: DiscoveredJob = {
  id: "greenhouse:example:123", provider: "greenhouse", company: "Example Co", title: "Backend Engineer",
  location: "Remote", department: null, employmentType: null, workplaceType: "remote", compensation: null,
  descriptionText: "Build services with Python, AWS, and SQL.", applicationUrl: "https://example.com/apply",
  sourceUrl: "https://example.com/job", sourcePublishedAt: null, sourceUpdatedAt: null,
  firstSeenAt: "2026-11-24T00:00:00Z", discoveredAt: "2026-11-24T00:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [],
};
const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test & Candidate", location: "Dallas, TX", email: "test@example.com",
    phone: "555-0100", github: "https://github.com/example" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { languages: ["Python", "SQL"] },
  education: [{ id: "degree", claim: "B.S. Computer Science", skills: [],
    evidence: [{ source: "transcript", uri: "private:transcript" }], status: "verified", allowedUses: ["resume"] }],
  experience: [{ employer: "Weboni", title: "Software Engineer", employmentType: "Full-time",
    start: "2024", end: "Present", claims: [
      { id: "aws", claim: "Built AWS services for 3 teams", skills: ["AWS", "Python"],
        evidence: [{ source: "work history", uri: "private:work" }], status: "verified", allowedUses: ["resume"] },
      { id: "unverified", claim: "Saved 90% with secret tool", skills: ["AWS"],
        evidence: [{ source: "draft", uri: "private:draft" }], status: "needs-confirmation", allowedUses: ["resume"] },
    ] }],
  projects: [{ name: "Data_Stack", claims: [
    { id: "sql", claim: "Processed 1M rows with SQL & Python", skills: ["SQL"],
      evidence: [{ source: "repository", uri: "https://github.com/example/project" }],
      status: "user-confirmed", allowedUses: ["resume"] },
  ] }],
});

describe("Jake résumé source generation", () => {
  it("retains the template and selects only supported, relevant claims", () => {
    const source = createJakeResumeSource(template, job, candidate);
    expect(source.latex).toContain("Original template author: Jake Gutierrez");
    expect(source.latex).toContain("Built AWS services for 3 teams");
    expect(source.latex).toContain("Processed 1M rows with SQL \\& Python");
    expect(source.latex).toContain("Test \\& Candidate");
    expect(source.latex).not.toContain("Saved 90%");
    expect(source.latex).not.toContain("FULL NAME");
    expect(source.claimIds).toEqual(["degree", "aws", "sql"]);
    expect(source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createJakeResumeSource(template, job, candidate).fingerprint).toBe(source.fingerprint);
  });

  it("blocks unsupported candidate content and unsafe template changes", () => {
    const empty = candidateProfileSchema.parse({ ...candidate, experience: [], projects: [] });
    expect(() => createJakeResumeSource(template, job, empty)).toThrow("No approved");
    expect(() => createJakeResumeSource("\\documentclass{article}", job, candidate)).toThrow("markers");
  });

  it("escapes TeX control characters in user facts", () => {
    expect(escapeLatex("100% $5 & _ \\input{bad}"))
      .toBe("100\\% \\$5 \\& \\_ \\textbackslash{}input\\{bad\\}");
  });
});
