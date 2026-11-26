import type { CandidateProfile } from "../candidate/schema.js";

export interface HardRequirementResult { blockers: string[] }

function approvedEvidence(candidate: CandidateProfile): { claims: string[]; skills: string[] } {
  const approved = [...candidate.education, ...candidate.experience.flatMap((role) => role.claims),
    ...candidate.projects.flatMap((project) => project.claims)]
    .filter((claim) => (claim.status === "verified" || claim.status === "user-confirmed")
      && claim.allowedUses.includes("matching"));
  return { claims: approved.map((claim) => claim.claim), skills: approved.flatMap((claim) => claim.skills) };
}

/** Free-text claims do not prove completion, currency, or the exact scope of a credential. */
export function assessHardRequirements(description: string, candidate: CandidateProfile): HardRequirementResult {
  const evidence = approvedEvidence(candidate);
  const hasSkill = (name: string): boolean => evidence.skills.some((skill) =>
    skill.trim().toLowerCase() === name.trim().toLowerCase());
  const blockers = new Set<string>();
  let requiredSection = false;
  for (const line of description.replace(/\bU\.S\./gi, "US").replace(/\bPh\.D\./gi, "PhD")
    .split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    if (/^(?:(?:minimum|basic|required)\s+)?(?:qualifications?|requirements?|skills?)\s*:?$/i.test(line)) {
      requiredSection = true;
      continue;
    }
    if (/^(?:preferred|desired|nice.to.have)\s+(?:qualifications?|skills?)\s*:?$|^(?:benefits?|responsibilities|what you.ll do|about (?:the role|us)|compensation)\s*:?$/i.test(line)) {
      requiredSection = false;
      continue;
    }
    for (const part of line.split(/[.!?;](?=\s|$)/).map((item) => item.trim()).filter(Boolean)) {
      const mandatory = requiredSection || /\b(?:must|require(?:d|s|ments?)?|minimum|at least|need to have)\b/i.test(part);
      if (!mandatory) continue;
      // A compound statement cannot be proven from one matching skill or
      // free-text claim. Check before optional-language handling so a comma
      // cannot hide a second mandatory condition.
      if (/[(),/]|\b(?:and|or|but)\b/i.test(part)) {
        blockers.add(`Compound mandatory qualification needs review: ${part.slice(0, 120)}`);
        continue;
      }
      if (/\b(?:not required|no requirement|no\s+on[ -]?site\s+work\s+required)\b/i.test(part)) {
        continue;
      }
      if (/\b(?:preferred|nice to have|optional)\b/i.test(part)) {
        blockers.add(`Mixed mandatory and optional qualifications need review: ${part.slice(0, 120)}`);
        continue;
      }
      const statement = part.replace(/^[•*\-]\s*/, "").trim();
      if (/\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|doctorate|degree|diploma)\b/i.test(statement)) {
        blockers.add("Degree requirement needs structured completion and field evidence");
        continue;
      }
      if (/\b(?:clearance|secret|top secret|ts\/sci)\b/i.test(statement)) {
        blockers.add("Clearance requirement needs structured level and active-status evidence");
        continue;
      }
      if (/\b(?:license|licence|certification|certified|certificate)\b/i.test(statement)) {
        blockers.add("License or certification requirement needs structured currency evidence");
        continue;
      }
      if (/\b\d{1,2}\+?\s+years?\b/i.test(statement)) {
        blockers.add("Experience-years requirement needs structured duration evidence");
        continue;
      }
      if (/\b(?:itar|export.control|us person|u\.s\. person)\b/i.test(statement)) {
        blockers.add("Export-control eligibility needs candidate review");
        continue;
      }
      if (/\b(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(statement)) {
        if (!evidence.claims.some((claim) => /\b(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(claim)
          && !/\b(?:not|never|formerly)\b/i.test(claim))) {
          blockers.add("US citizenship requirement needs an approved matching claim");
        }
        continue;
      }
      if (/\b(?:work (?:authorization|authorisation|eligibility)|authorized to work|legally work|without (?:visa )?sponsorship|sponsorship (?:is )?not available)\b/i.test(statement)) {
        if (!/\b(?:us|united states)\b/i.test(statement)
          || !candidate.authorization.countries.some((country) => /^(?:us|u\.?s\.?a?\.?|united states)$/i.test(country))
          || candidate.authorization.sponsorshipRequiredNowOrFuture) {
          blockers.add("US work authorization without sponsorship needs candidate confirmation");
        }
        continue;
      }
      const tool = /^(?:must (?:have|know|use)|(?:experience|proficiency|knowledge) (?:with|in|of)|(?:required|minimum) (?:experience|proficiency) (?:with|in))\s+(.+?)(?:\s+(?:experience|skills?))?$/i.exec(statement);
      const name = (tool?.[1] ?? statement).replace(/\s+required\.?$/i, "").replace(/[.!]$/, "").trim();
      if (!hasSkill(name)) {
        blockers.add(`Mandatory qualification needs review: ${statement.slice(0, 120)}`);
      }
    }
  }
  return { blockers: [...blockers] };
}
