import { z } from "zod";
import { candidateProfileSchema, type CandidateProfile } from "../candidate/schema.js";

const fact = z.string().trim().min(1).max(300).refine(value => !/\{\{[^{}]*\}\}/.test(value),
  "Resolve placeholders before approving a fact");
const httpsUrl = z.url().refine(value => new URL(value).protocol === "https:", "Use an HTTPS URL");

/** Exact facts entered by the job seeker. PDF text is never promoted into this schema. */
export const applicationFactsSchema = z.strictObject({
  identity: z.strictObject({
    fullName: fact, location: fact, email: z.email(), phone: fact,
    portfolio: httpsUrl.optional(), github: httpsUrl.optional(), linkedin: httpsUrl.optional(),
  }),
  authorization: z.strictObject({
    countries: z.array(fact).min(1).max(12),
    sponsorshipRequiredNowOrFuture: z.boolean(),
  }),
  skills: z.array(fact).max(80),
  education: z.array(fact).max(12),
  experience: z.array(z.strictObject({
    employer: fact, title: fact, employmentType: fact, start: fact, end: fact,
    claims: z.array(fact).min(1).max(12),
  })).max(12),
  projects: z.array(z.strictObject({
    name: fact, url: httpsUrl.optional(), claims: z.array(fact).min(1).max(12),
  })).max(12),
}).superRefine((input, context) => {
  const count = input.education.length + input.experience.reduce((n, item) => n + item.claims.length, 0)
    + input.projects.reduce((n, item) => n + item.claims.length, 0);
  if (!count) context.addIssue({ code: "custom", message: "At least one reviewed education, experience, or project fact is required" });
});

export type ApplicationFacts = z.infer<typeof applicationFactsSchema>;

/** Candidate-reviewed assertions are usable for matching and writing, never treated as third-party verification. */
export function approvedApplicationProfile(submissionId: string, input: ApplicationFacts): CandidateProfile {
  const facts = applicationFactsSchema.parse(input);
  const claim = (category: string, index: number, text: string) => ({
    id: `${submissionId}:${category}:${index}`, claim: text, skills: [], metrics: [],
    evidence: [{ source: "candidate-reviewed-intake",
      uri: `urn:openapply:onboarding:${submissionId}#${category}-${index}` }],
    status: "user-confirmed" as const,
    allowedUses: ["matching", "resume", "application"] as const,
  });
  return candidateProfileSchema.parse({
    version: 1, identity: facts.identity, authorization: facts.authorization,
    skills: { general: facts.skills },
    education: facts.education.map((text, index) => claim("education", index, text)),
    experience: facts.experience.map((item, index) => ({
      employer: item.employer, title: item.title, employmentType: item.employmentType,
      start: item.start, end: item.end,
      claims: item.claims.map((text, claimIndex) => claim(`experience-${index}`, claimIndex, text)),
    })),
    projects: facts.projects.map((item, index) => ({ name: item.name, url: item.url,
      claims: item.claims.map((text, claimIndex) => claim(`project-${index}`, claimIndex, text)) })),
    quarantinedClaims: [],
  });
}

/** The hosted runner can use this only after the trusted PROFILE marker is ready.
 * Bind decrypted bytes to the tenant derived from the authenticated subject. */
export function parseApprovedHostedProfile(bytes: Uint8Array, expectedCandidateId: string): CandidateProfile {
  const candidateId = z.uuid().parse(expectedCandidateId);
  const stored = z.strictObject({ version: z.literal(1),
    provenance: z.literal("candidate-entered-and-reviewed"),
    candidateId: z.uuid(),
    applicationProfile: candidateProfileSchema,
  }).passthrough().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (stored.candidateId !== candidateId) throw new Error("Stored application profile belongs to another account");
  return stored.applicationProfile;
}
