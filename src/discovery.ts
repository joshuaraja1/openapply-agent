import type { DiscoveryInput } from "./config.js";
import type { DiscoveredJob, DiscoveryState, NormalizedJob } from "./types.js";

function normalized(values: string[]): string[] {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export function evaluateJob(
  job: NormalizedJob,
  input: DiscoveryInput,
  state: DiscoveryState,
  now = new Date(),
): DiscoveredJob | null {
  const searchable = [job.title, job.company, job.location, job.department, job.descriptionText]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();
  const included = normalized(input.includeKeywords);
  const excluded = normalized(input.excludeKeywords);
  const matchedKeywords = included.filter((keyword) => searchable.includes(keyword));
  if (included.length > 0 && matchedKeywords.length === 0) return null;
  if (excluded.some((keyword) => searchable.includes(keyword))) return null;

  const discoveredAt = now.toISOString();
  const firstSeenAt = state.jobs[job.id]?.firstSeenAt ?? discoveredAt;
  const reference = job.sourcePublishedAt ?? firstSeenAt;
  const ageMs = now.getTime() - Date.parse(reference);
  return {
    ...job,
    firstSeenAt,
    discoveredAt,
    isNew: !state.jobs[job.id],
    isFresh: ageMs <= input.maximumFreshnessHours * 3_600_000,
    freshnessBasis: job.sourcePublishedAt ? "source-published" : "first-seen",
    matchedKeywords,
  };
}

export function selectFreshnessTier<T extends DiscoveredJob>(
  jobs: T[],
  preferredHours: number,
  maximumHours: number,
  now = new Date(),
): { tier: "preferred" | "fallback" | "none"; jobs: T[] } {
  const age = (job: T) => (now.getTime() - Date.parse(job.sourcePublishedAt ?? job.firstSeenAt)) / 3_600_000;
  const preferred = jobs.filter((job) => age(job) <= preferredHours);
  if (preferred.length > 0) return { tier: "preferred", jobs: preferred };
  const fallback = jobs.filter((job) => age(job) > preferredHours && age(job) <= maximumHours);
  return fallback.length > 0 ? { tier: "fallback", jobs: fallback } : { tier: "none", jobs: [] };
}

export function markJobsReported(
  state: DiscoveryState,
  jobIds: string[],
  reportedAt = new Date(),
): void {
  const timestamp = reportedAt.toISOString();
  for (const id of jobIds) {
    const job = state.jobs[id];
    if (job) job.reportedAt = timestamp;
  }
}
