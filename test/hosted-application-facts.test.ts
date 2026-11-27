import { describe, expect, it } from "vitest";
import { applicationFactsSchema, approvedApplicationProfile,
  parseApprovedHostedProfile } from "../src/hosted/application-facts.js";

const id = "22222222-2222-4222-8222-222222222222";
const facts = {
  identity: { fullName: "Avery Example", location: "Chicago", email: "avery@example.test",
    phone: "555-0100", github: "https://github.com/avery" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: true },
  skills: ["TypeScript"], education: ["BS in Computer Science, Example University"],
  experience: [{ employer: "Example Inc", title: "Intern", employmentType: "Internship",
    start: "May 2025", end: "August 2025", claims: ["Built a test dashboard"] }],
  projects: [{ name: "Sample project", claims: ["Created a local search tool"] }],
};

describe("hosted application facts", () => {
  it("constructs only candidate-entered, reviewed claims with stable provenance", () => {
    const profile = approvedApplicationProfile(id, facts);
    expect(profile.authorization.sponsorshipRequiredNowOrFuture).toBe(true);
    expect(profile.education[0]).toMatchObject({ status: "user-confirmed",
      evidence: [{ source: "candidate-reviewed-intake",
        uri: `urn:openapply:onboarding:${id}#education-0` }] });
    expect(profile.experience[0]?.claims[0]?.claim).toBe("Built a test dashboard");
    expect(parseApprovedHostedProfile(Buffer.from(JSON.stringify({ version: 1,
      provenance: "candidate-entered-and-reviewed", applicationProfile: profile })))).toEqual(profile);
  });

  it("rejects demographic fields, unresolved placeholders, non-HTTPS URLs and empty claims", () => {
    expect(applicationFactsSchema.safeParse({ ...facts, ethnicity: "Asian" }).success).toBe(false);
    expect(applicationFactsSchema.safeParse({ ...facts,
      education: ["{{degree}} at Example University"] }).success).toBe(false);
    expect(applicationFactsSchema.safeParse({ ...facts,
      identity: { ...facts.identity, github: "http://github.com/avery" } }).success).toBe(false);
    expect(applicationFactsSchema.safeParse({ ...facts,
      education: [], experience: [], projects: [] }).success).toBe(false);
  });

  it("rejects a legacy encrypted profile without approved application facts", () => {
    expect(() => parseApprovedHostedProfile(Buffer.from(JSON.stringify({ version: 1,
      provenance: "candidate-entered-and-reviewed", targetRoles: ["Engineer"] })))).toThrow();
  });
});
