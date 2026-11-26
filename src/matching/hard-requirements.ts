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
    for (const part of line.split(/[.!?;](?=\s|$)/).flatMap((text) => text.split(/\s+but\s+/i))) {
      const partMandatory = requiredSection || /\b(?:must|require(?:d|s|ments?)?|minimum|at least|need to have)\b/i.test(part);
      for (const fragment of part.split(/\s+and\s+/i)) {
        const statement = fragment.replace(/^[•*\-]\s*/, "").trim();
        if (!partMandatory || /\b(?:not required|no requirement|preferred|nice to have|optional|no\s+on[ -]?site\s+work\s+required)\b/i.test(statement)) {
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
        const clearance = /\b(?:active\s+)?(?:security\s+)?(top secret|ts\/sci|secret)\s+clearance\b/i.exec(statement);
        if (clearance) {
          classified = true;
          const level = clearance[1]!.toLowerCase();
          if (!approved.some((claim) => {
            const documented = /\bactive\s+(?:security\s+)?(top secret|ts\/sci|secret)\s+clearance\b/i.exec(claim);
            return documented?.[1]?.toLowerCase() === level;
          })) {
            blockers.add("Security clearance requirement needs an approved matching claim");
          }
        }
        const degree = /\b(bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|doctorate)\s+(?:degree|of\s+science|of\s+arts)(?:\s+in\s+([a-z ]+?))?(?=\s+(?:required|and|or|with|for)\b|[.!?;]|$)/i.exec(statement);
        if (degree) {
          classified = true;
          const requiredLevel = degree[1]!.toLowerCase().replace(/'s$/, "");
          const requiredMajor = degree[2]?.trim().toLowerCase();
          if (!approved.some((claim) => {
            const documented = /\b(bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|doctorate)\s+(?:degree|of\s+science|of\s+arts)(?:\s+in\s+([a-z ]+))?/i.exec(claim);
            return documented?.[1]?.toLowerCase().replace(/'s$/, "") === requiredLevel
              && (!requiredMajor || documented?.[2]?.trim().toLowerCase() === requiredMajor);
          })) {
            blockers.add("Degree requirement needs an approved matching claim");
          }
        }
        if (/\b(?:license|licence|certification|certified|certificate)\b/i.test(statement)) {
          classified = true;
          const named = /\b([\w+./-]+(?:\s+[\w+./-]+){0,3})\s+(?:license|licence|certification|certificate)\b/i.exec(statement)?.[1];
          if (!named || !approved.some((claim) => !/\b(?:expired|revoked|inactive|suspended|not|never)\b/i.test(claim)
            && new RegExp(`${named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:license|licence|certification|certificate)`, "i").test(claim))) {
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
          const alternatives = tool[1]!.replace(/[.!]$/, "").split(/\s+or\s+/i)
            .map((option) => option.split(/\s*,\s*|\s*\/\s*/).map((part) => part.trim()).filter(Boolean));
          if (!alternatives.length || !alternatives.some((option) => option.length > 0 && option.every(hasSkill))) {
            blockers.add(`Mandatory qualification needs review: ${statement.slice(0, 120)}`);
          }
        }
        if (!classified && !hasSkill(statement.replace(/\s+required\.?$/i, "").trim())) {
          blockers.add(`Mandatory qualification needs review: ${statement.slice(0, 120)}`);
        }
      }
    }
  }
  return { blockers: [...blockers] };
}
