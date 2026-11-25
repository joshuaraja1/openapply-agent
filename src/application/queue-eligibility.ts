import type { CandidateProfile, SearchPreferences } from "../candidate/schema.js";
import { scoreJob } from "../matching/score.js";
import type { DiscoveredJob } from "../types.js";

/** Recheck a persisted queue against the profile used for this run. */
export function isEligibleQueuedJob(job: DiscoveredJob, candidate: CandidateProfile,
  preferences: SearchPreferences): boolean {
  return scoreJob(job, candidate, preferences).eligible;
}
