import type { CandidateProfile, SearchPreferences } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import { assessHardRequirements } from "./hard-requirements.js";

export interface JobMatch {
  eligible: boolean;
  score: number;
  reasons: string[];
  matchedSkills: string[];
  salaryTarget: number | null;
  reviewFlags: string[];
}

function contains(value: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(value);
}

function approvedMatchingSkills(candidate: CandidateProfile): string[] {
  const claims = [...candidate.education, ...candidate.experience.flatMap((role) => role.claims),
    ...candidate.projects.flatMap((project) => project.claims)];
  const approved = claims.filter((claim) => (claim.status === "verified" || claim.status === "user-confirmed")
    && claim.allowedUses.includes("matching"));
  return [...new Map(approved.flatMap((claim) => claim.skills)
    .map((skill) => [skill.trim().toLowerCase(), skill.trim()] as const)
    .filter(([key]) => key.length > 0)).values()];
}

export function parseSalaryTarget(compensation: string | null, position: number): number | null {
  if (!compensation) return null;
  const values = [...compensation.matchAll(/\$?\s*(\d{2,3}(?:,\d{3})+|\d{2,3})\s*([kK])?/g)]
    .map((match) => Number(match[1]?.replaceAll(",", "")) * (match[2] ? 1_000 : 1))
    .filter((value) => value >= 20_000 && value <= 1_000_000);
  if (values.length === 0) return null;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return Math.round((minimum + (maximum - minimum) * position) / 1_000) * 1_000;
}

export function scoreJob(
  job: DiscoveredJob,
  candidate: CandidateProfile,
  preferences: SearchPreferences,
): JobMatch {
  const title = job.title.toLowerCase();
  const searchable = [job.title, job.descriptionText, job.location, job.workplaceType]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();
  const salaryTarget = parseSalaryTarget(job.compensation, preferences.compensation.targetRangePosition);
  const excluded = preferences.excludeSeniorityTerms.find((term) => contains(title, term));
  if (excluded) return {
    eligible: false,
    score: 0,
    reasons: [`Excluded seniority term: ${excluded}`],
    matchedSkills: [],
    salaryTarget,
    reviewFlags: [],
  };

  const roleMatch = preferences.targetRoles.some((role) => title.includes(role.toLowerCase()));
  if (!roleMatch) return {
    eligible: false,
    score: 0,
    reasons: ["Title is outside configured role families"],
    matchedSkills: [],
    salaryTarget,
    reviewFlags: [],
  };

  const skills = approvedMatchingSkills(candidate);
  const matchedSkills = skills.filter((skill) => contains(searchable, skill));
  if (!matchedSkills.length) return {
    eligible: false,
    score: 0,
    reasons: ["No job skill matches an approved candidate claim"],
    matchedSkills: [],
    salaryTarget,
    reviewFlags: ["Review candidate evidence or this role manually"],
  };
  const hardRequirements = assessHardRequirements(job.descriptionText, candidate);
  if (hardRequirements.blockers.length) return {
    eligible: false,
    score: 0,
    reasons: hardRequirements.blockers,
    matchedSkills: matchedSkills.sort(),
    salaryTarget,
    reviewFlags: ["Review mandatory qualifications before applying"],
  };
  const reasons = ["Target role family"];
  const reviewFlags: string[] = [];
  let score = 35 + Math.min(30, matchedSkills.length * 3);
  if (matchedSkills.length) reasons.push(`${matchedSkills.length} evidence-backed skill matches`);

  if (/new\s*grad|entry[ -]?level|early career|university|junior/.test(searchable)) {
    score += 15;
    reasons.push("Explicit early-career signal");
  }
  const arrangement = `${job.location ?? ""} ${job.workplaceType ?? ""}`.toLowerCase();
  if (arrangement.includes("remote")) score += 15;
  else if (arrangement.includes("hybrid")) score += 8;
  else reviewFlags.push("Work arrangement needs review");

  if (salaryTarget && salaryTarget >= preferences.compensation.preferredBaseFloor) score += 5;
  else if (!salaryTarget) reviewFlags.push("No parseable salary range");
  if (job.isFresh) score += 5;

  return {
    eligible: true,
    score: Math.min(100, score),
    reasons,
    matchedSkills: matchedSkills.sort(),
    salaryTarget,
    reviewFlags,
  };
}
