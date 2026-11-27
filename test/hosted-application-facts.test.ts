import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { applicationFactsSchema, approvedApplicationProfile,
  parseApprovedHostedProfile } from "../src/hosted/application-facts.js";
import { createJakeResumeSource } from "../src/resume/jake.js";
import type { DiscoveredJob } from "../src/types.js";

const id = "22222222-2222-4222-8222-222222222222";
const candidateId = "11111111-1111-4111-8111-111111111111";
const facts = {
  identity: { fullName: "Avery Example", location: "Chicago", email: "avery@example.test",
    phone: "555-0100", github: "https://github.com/avery" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: true },
  skills: ["TypeScript"], education: [{ claim: "BS in Computer Science, Example University", skills: ["Python"] }],
  experience: [{ employer: "Example Inc", title: "Intern", employmentType: "Internship",
    start: "May 2025", end: "August 2025", claims: [{ claim: "Built a test dashboard", skills: ["TypeScript"] }] }],
  projects: [{ name: "Sample project", claims: [{ claim: "Created a local search tool", skills: ["SQL"] }] }],
};

describe("hosted application facts", () => {
  it("constructs only candidate-entered, reviewed claims with stable provenance", () => {
    const profile = approvedApplicationProfile(id, facts);
    expect(profile.authorization.sponsorshipRequiredNowOrFuture).toBe(true);
    expect(profile.education[0]).toMatchObject({ status: "user-confirmed",
      evidence: [{ source: "candidate-reviewed-intake",
        uri: `urn:openapply:onboarding:${id}#education-0` }] });
    expect(profile.experience[0]?.claims[0]?.claim).toBe("Built a test dashboard");
    expect(profile.experience[0]?.claims[0]?.skills).toEqual(["TypeScript"]);
    expect(parseApprovedHostedProfile(Buffer.from(JSON.stringify({ version: 1, candidateId,
      provenance: "candidate-entered-and-reviewed", applicationProfile: profile })), candidateId)).toEqual(profile);
  });

  it("rejects demographic fields, unresolved placeholders, non-HTTPS URLs and empty claims", () => {
    expect(applicationFactsSchema.safeParse({ ...facts, ethnicity: "Asian" }).success).toBe(false);
    expect(applicationFactsSchema.safeParse({ ...facts,
      education: [{ claim: "{{degree}} at Example University", skills: ["Python"] }] }).success).toBe(false);
    expect(applicationFactsSchema.safeParse({ ...facts,
      experience: [{ ...facts.experience[0], claims: [{ claim: "Built a test dashboard", skills: [] }] }] }).success).toBe(false);
    expect(applicationFactsSchema.safeParse({ ...facts,
      identity: { ...facts.identity, github: "http://github.com/avery" } }).success).toBe(false);
    expect(applicationFactsSchema.safeParse({ ...facts,
      education: [], experience: [], projects: [] }).success).toBe(false);
  });

  it("rejects a legacy encrypted profile without approved application facts", () => {
    expect(() => parseApprovedHostedProfile(Buffer.from(JSON.stringify({ version: 1, candidateId,
      provenance: "candidate-entered-and-reviewed", targetRoles: ["Engineer"] })), candidateId)).toThrow();
  });

  it("refuses decrypted bytes for another job seeker even when claims are valid", () => {
    const profile = approvedApplicationProfile(id, facts);
    const stored = Buffer.from(JSON.stringify({ version: 1, candidateId,
      provenance: "candidate-entered-and-reviewed", applicationProfile: profile }));
    expect(() => parseApprovedHostedProfile(stored,
      "33333333-3333-4333-8333-333333333333")).toThrow("another account");
  });

  it("renders a hosted reviewed claim for a matching job without adding unrelated skill tags", async () => {
    const template = await readFile("templates/resume/main.tex", "utf8");
    const job = { id: "greenhouse:example:123", title: "Frontend Engineer", company: "Example Co",
      descriptionText: "Build TypeScript applications for customers." } as DiscoveredJob;
    const profile = approvedApplicationProfile(id, facts);
    const source = createJakeResumeSource(template, job, profile);
    expect(source.latex).toContain("Built a test dashboard");
    expect(source.latex).toContain("TypeScript");
    expect(source.latex).not.toContain("Created a local search tool");
    expect(source.latex).not.toContain("Relevant technical skills include SQL");
    expect(profile.projects[0]?.claims[0]?.skills).toEqual(["SQL"]);
    expect(source.claimIds).toContain(`${id}:experience-0:0`);
  });
});
