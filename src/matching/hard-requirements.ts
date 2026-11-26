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
  const skills = [...candidate.education, ...candidate.experience.flatMap((role) => role.claims),
    ...candidate.projects.flatMap((project) => project.claims)]
    .filter((claim) => (claim.status === "verified" || claim.status === "user-confirmed")
      && claim.allowedUses.includes("matching"))
    .flatMap((claim) => claim.skills);
  const supported = (pattern: RegExp): boolean => approved.some((claim) =>
    pattern.test(claim) && !/\b(?:not|never|incomplete|expired|formerly)\b/i.test(claim));
  const hasSkill = (skill: string): boolean => skills.some((approvedSkill) =>
    approvedSkill.toLowerCase() === skill.trim().toLowerCase());
  const blockers = new Set<string>();
  const lines = description.replace(/\bU\.S\./gi, "US").replace(/\bPh\.D\./gi, "PhD")
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let requiredSection = false;
  for (const line of lines) {
    if (/^(?:(?:minimum|basic|required)\s+)?(?:qualifications?|requirements?|skills?)\s*:?$/i.test(line)) {
      requiredSection = true;
      continue;
    }
    if (/^(?:preferred|desired|nice.to.have)\s+(?:qualifications?|skills?)\s*:?$|^(?:benefits?|responsibilities|what you.ll do|about (?:the role|us)|compensation)\s*:?$/i.test(line)) {
      requiredSection = false;
      continue;
    }
    for (const fragment of line.split(/[.!?](?=\s|$)/).flatMap((part) => part.split(/\s+but\s+/i))) {
      const statement = fragment.replace(/^[•*\-]\s*/, "").trim();
      const mandatory = requiredSection || /\b(?:must|require(?:d|s|ments?)?|minimum|at least|need to have)\b/i.test(statement);
      if (!mandatory || /\b(?:not required|no requirement|preferred|nice to have|optional)\b/i.test(statement)) {
        continue;
      }
      let classified = false;
      if (/\b(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(statement)) {
        classified = true;
        if (!supported(/\b(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i)) {
          blockers.add("US citizenship requirement needs an approved matching claim");
        }
      }
      if (/\b(?:work (?:authorization|authorisation|eligibility)|authorized to work|legally work|without (?:visa )?sponsorship|sponsorship (?:is )?not available)\b/i.test(statement)) {
        classified = true;
        if (!/\b(?:us|united states)\b/i.test(statement)
          || !candidate.authorization.countries.some((country) => /^(?:us|u\.?s\.?a?\.?|united states)$/i.test(country))
          || candidate.authorization.sponsorshipRequiredNowOrFuture) {
          blockers.add("US work authorization without sponsorship needs candidate confirmation");
        }
      }
      if (/\b(?:itar|export.control|us person|u\.s\. person)\b/i.test(statement)) {
        classified = true;
        if (!supported(/\b(?:itar|export.control|us person|u\.s\. person)\s+eligib(?:le|ility)\b/i)) {
          blockers.add("Export-control eligibility needs candidate review");
        }
      }
      if (/\b(?:active\s+)?(?:security\s+)?(?:secret|top secret|ts\/sci)\s+clearance\b/i.test(statement)) {
        classified = true;
        if (!supported(/\bactive\s+(?:security\s+)?(?:secret|top secret|ts\/sci)\s+clearance\b/i)) {
          blockers.add("Security clearance requirement needs an approved matching claim");
        }
      }
      if (/\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|doctorate)\s+(?:degree|of\s+science|of\s+arts)\b/i.test(statement)) {
        classified = true;
        if (!supported(/\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|doctorate)\s+(?:degree|of\s+science|of\s+arts)\b/i)) {
          blockers.add("Degree requirement needs an approved matching claim");
        }
      }
      if (/\b(?:license|licence|certification|certified|certificate)\b/i.test(statement)) {
        classified = true;
        const named = /\b([\w+./-]+(?:\s+[\w+./-]+){0,3})\s+(?:license|licence|certification|certificate)\b/i.exec(statement)?.[1];
        if (!named || !approved.some((claim) => new RegExp(`${named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:license|licence|certification|certificate)`, "i").test(claim))) {
          blockers.add(`Mandatory license or certification needs review: ${statement.slice(0, 120)}`);
        }
      }
      const years = statement.match(/\b(\d{1,2})\+?\s+years?\s+(?:of\s+)?((?:(?:professional|relevant|software|engineering|development|industry)\s+){0,3})experience\b/i);
      if (years) {
        classified = true;
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
      // A mandatory line with an unrecognized qualification is unsafe to auto-accept.
      // Exact approved skills may satisfy a simple tool requirement; compound or
      // ambiguous statements still need a person to confirm every part.
      const tool = /^(?:must (?:have|know|use)|(?:experience|proficiency|knowledge) (?:with|in|of)|(?:required|minimum) (?:experience|proficiency) (?:with|in))\s+(.+?)(?:\s+(?:experience|skills?))?$/i.exec(statement);
      if (tool && !classified) {
        classified = true;
        const requested = tool[1]!.replace(/[.!]$/, "").split(/\s*(?:,|\band\b|\bor\b|\/)\s*/i)
          .map((part) => part.trim()).filter(Boolean);
        if (!requested.length || !requested.every(hasSkill)) {
          blockers.add(`Mandatory qualification needs review: ${statement.slice(0, 120)}`);
        }
      }
      if (classified && /\band\b/i.test(statement)
        && /\b(?:degree|clearance|license|licence|certification|certified|certificate|experience|citizenship|work authorization|sponsorship|itar)\b/i.test(statement)
        && /\band\b.{0,100}\b(?:degree|clearance|license|licence|certification|certified|certificate|experience|citizenship|work authorization|sponsorship|itar|[A-Z][a-z]+)\b/.test(statement)) {
        blockers.add(`Compound mandatory qualification needs review: ${statement.slice(0, 120)}`);
      }
      if (!classified && !hasSkill(statement.replace(/\s+required\.?$/i, "").trim())) {
        blockers.add(`Mandatory qualification needs review: ${statement.slice(0, 120)}`);
      }
    }
  }
  return { blockers: [...blockers] };
}
