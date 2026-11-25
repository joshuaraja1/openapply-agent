import type { CandidateProfile } from "../candidate/schema.js";

export interface HardRequirementResult {
  blockers: string[];
}

function approvedClaims(candidate: CandidateProfile): string[] {
  return [...candidate.education, ...candidate.experience.flatMap((role) => role.claims),
    ...candidate.projects.flatMap((project) => project.claims)]
    .filter((claim) => (claim.status === "verified" || claim.status === "user-confirmed")
      && claim.allowedUses.includes("matching"))
    .map((claim) => claim.claim);
}

/** Only explicit mandatory statements are classified. Ambiguous claims need a human review. */
export function assessHardRequirements(description: string,
  candidate: CandidateProfile): HardRequirementResult {
  const approved = approvedClaims(candidate);
  const supported = (pattern: RegExp): boolean => approved.some((claim) =>
    pattern.test(claim) && !/\b(?:not|never|incomplete|expired|formerly)\b/i.test(claim));
  const blockers = new Set<string>();
  const statements = description.replace(/\bU\.S\./gi, "US").replace(/\bPh\.D\./gi, "PhD")
    .split(/(?:\r?\n|[.!?](?=\s|$))/)
    .map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    const mandatory = /\b(?:must|require(?:d|s)?|minimum|at least|need to have)\b/i.test(statement);
    if (!mandatory || /\b(?:not required|no requirement|preferred|nice to have|optional)\b/i.test(statement)) {
      continue;
    }
    if (/\b(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(statement)
      && !supported(/\b(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i)) {
      blockers.add("US citizenship requirement needs an approved matching claim");
    }
    if (/\b(?:active\s+)?(?:security\s+)?(?:secret|top secret|ts\/sci)\s+clearance\b/i.test(statement)
      && !supported(/\bactive\s+(?:security\s+)?(?:secret|top secret|ts\/sci)\s+clearance\b/i)) {
      blockers.add("Security clearance requirement needs an approved matching claim");
    }
    if (/\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|doctorate)\s+(?:degree|of\s+science|of\s+arts)\b/i.test(statement)
      && !supported(/\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|doctorate)\s+(?:degree|of\s+science|of\s+arts)\b/i)) {
      blockers.add("Degree requirement needs an approved matching claim");
    }
    const years = statement.match(/\b(\d{1,2})\+?\s+years?\s+(?:of\s+)?((?:(?:professional|relevant|software|engineering|development|industry)\s+){0,3})experience\b/i);
    if (years) {
      const required = Number(years[1]);
      const domain = years[2]!.trim().toLowerCase();
      const speciality = /\bexperience\s+(?:with|in|using)\s+([a-z+#./ -]+)/i.exec(statement)?.[1]?.trim();
      const documented = approved.some((text) =>
        [...text.matchAll(/\b(\d{1,2})\+?\s+years?\s+(?:of\s+)?((?:(?:professional|relevant|software|engineering|development|industry)\s+){0,3})experience\b/gi)]
          .some((claim) => Number(claim[1]) >= required
            && claim[2]!.trim().toLowerCase() === domain
            && (!speciality || text.toLowerCase().includes(speciality.toLowerCase()))));
      if (!documented) blockers.add(`${required} years of ${domain ? `${domain} ` : ""}experience needs an approved matching claim`);
    }
  }
  return { blockers: [...blockers] };
}
