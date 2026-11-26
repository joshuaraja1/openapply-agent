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
  const publishedAgeMs = job.sourcePublishedAt ? now.getTime() - Date.parse(job.sourcePublishedAt) : NaN;
  return {
    ...job,
    firstSeenAt,
    discoveredAt,
    isNew: !state.jobs[job.id],
    isFresh: Number.isFinite(publishedAgeMs) && publishedAgeMs >= 0
      && publishedAgeMs <= input.preferredFreshnessHours * 3_600_000,
    freshnessBasis: job.sourcePublishedAt ? "source-published" : "first-seen",
    matchedKeywords,
  };
}

export function selectFreshnessTier<T extends DiscoveredJob>(
  jobs: T[],
  preferredHours: number,
  maximumHours: number | null,
  now = new Date(),
): { tier: "preferred" | "observed" | "fallback" | "mixed" | "none"; jobs: T[] } {
  const withinLimit = jobs.filter((job) => maximumHours === null
    || jobAgeHours(job, now) <= maximumHours);
  const prioritized = withinLimit.sort((a, b) => freshnessPriority(a, preferredHours, now)
    - freshnessPriority(b, preferredHours, now) || jobAgeHours(a, now) - jobAgeHours(b, now));
  const hasVerifiedRecent = prioritized.some((job) => freshnessPriority(job, preferredHours, now) === 0);
  const hasObservedRecent = prioritized.some((job) => freshnessPriority(job, preferredHours, now) === 1);
  const hasOlder = prioritized.some((job) => freshnessPriority(job, preferredHours, now) >= 2);
  const categoryCount = Number(hasVerifiedRecent) + Number(hasObservedRecent) + Number(hasOlder);
  return { tier: categoryCount > 1 ? "mixed" : hasVerifiedRecent ? "preferred"
    : hasObservedRecent ? "observed" : hasOlder ? "fallback" : "none",
    jobs: prioritized };
}

function jobAgeHours(job: DiscoveredJob, now: Date): number {
  const age = (now.getTime() - Date.parse(job.sourcePublishedAt ?? job.firstSeenAt)) / 3_600_000;
  return Number.isFinite(age) && age >= 0
    ? Math.max(age, (job.sourceAgeLowerBoundDays ?? 0) * 24) : Number.POSITIVE_INFINITY;
}

/** Dated recent jobs lead; newly observed undated jobs follow, then older postings. */
export function freshnessPriority(job: DiscoveredJob, preferredHours: number, now = new Date()): number {
  const recent = jobAgeHours(job, now) <= preferredHours;
  return job.sourcePublishedAt ? recent ? 0 : 2 : recent ? 1 : 3;
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
