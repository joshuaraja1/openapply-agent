import type { CandidateProfile, SearchPreferences } from "../candidate/schema.js";
import { freshnessPriority, selectFreshnessTier } from "../discovery.js";
import { scoreJob, type JobMatch } from "../matching/score.js";
import type { DiscoveredJob, DiscoveryState } from "../types.js";

export interface RankedJob { job: DiscoveredJob; match: JobMatch }

/** Refresh pending entries from this run's official postings before ranking. */
export function selectRankedJobs(
  activeJobs: DiscoveredJob[], state: DiscoveryState, previouslyQueued: ReadonlySet<string>,
  candidate: CandidateProfile, preferences: SearchPreferences,
  preferredHours: number, maximumHours: number | null, now: Date,
): RankedJob[] {
  const candidates = activeJobs.filter((job) =>
    !state.jobs[job.id]?.reportedAt || previouslyQueued.has(job.id));
  const { jobs } = selectFreshnessTier(candidates, preferredHours, maximumHours, now);
  const ranked = jobs.map((job) => ({ job, match: scoreJob(job, candidate, preferences) }))
    .filter((entry) => entry.match.eligible)
    .sort((a, b) => freshnessPriority(a.job, preferredHours, now)
      - freshnessPriority(b.job, preferredHours, now)
      || b.match.score - a.match.score
      || Date.parse(b.job.sourcePublishedAt ?? b.job.firstSeenAt)
        - Date.parse(a.job.sourcePublishedAt ?? a.job.firstSeenAt)
      || a.job.id.localeCompare(b.job.id));
  const seen = new Set<string>();
  return ranked.filter(({ job }) => {
    if (seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
}
