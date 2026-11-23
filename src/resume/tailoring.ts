import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";

export interface TailoringBrief {
  targetTitle: string;
  company: string;
  supportedKeywords: string[];
  experienceClaims: string[];
  projectClaims: string[];
  hardRequirementGaps: string[];
  instructions: string[];
}

function usableForResume(status: string, allowedUses: string[]): boolean {
  return (status === "verified" || status === "user-confirmed") && allowedUses.includes("resume");
}

function mentioned(description: string, term: string): boolean {
  return description.toLowerCase().includes(term.toLowerCase());
}

export function createTailoringBrief(
  job: DiscoveredJob,
  candidate: CandidateProfile,
): TailoringBrief {
  const skills = [...new Set(Object.values(candidate.skills).flat())];
  const supportedKeywords = skills.filter((skill) => mentioned(job.descriptionText, skill)).sort();
  const experienceClaims = candidate.experience.flatMap((experience) =>
    experience.claims
      .filter((claim) => usableForResume(claim.status, claim.allowedUses))
      .filter((claim) => claim.skills.some((skill) => supportedKeywords.includes(skill)))
      .map((claim) => `${experience.title} at ${experience.employer}: ${claim.claim}`),
  );
  const projectClaims = candidate.projects.flatMap((project) =>
    project.claims
      .filter((claim) => usableForResume(claim.status, claim.allowedUses))
      .filter((claim) => claim.skills.some((skill) => supportedKeywords.includes(skill)))
      .map((claim) => `${project.name}: ${claim.claim}`),
  );

  const hardRequirementGaps: string[] = [];
  if (/security clearance/i.test(job.descriptionText)) hardRequirementGaps.push("Security clearance requires user confirmation");
  if (/\b(gpa|sat|act)\b/i.test(job.descriptionText)) hardRequirementGaps.push("Academic scores require explicit source data");

  return {
    targetTitle: job.title,
    company: job.company,
    supportedKeywords,
    experienceClaims,
    projectClaims,
    hardRequirementGaps,
    instructions: [
      "Use the user's approved template without redesigning it.",
      "Preserve chronology and employment type.",
      "Write one-sentence, result-first bullets.",
      "Use numbers only when the selected claim provides evidence.",
      "Render every PDF page and visually inspect it before upload.",
    ],
  };
}
