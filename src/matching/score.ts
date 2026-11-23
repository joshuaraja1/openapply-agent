import type { CandidateProfile, SearchPreferences } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";

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
  return new RegExp(`\\b${escaped}\\b`, "i").test(value);
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

  const skills = [...new Set(Object.values(candidate.skills).flat())];
  const matchedSkills = skills.filter((skill) => contains(searchable, skill));
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
