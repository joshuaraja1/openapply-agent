import type { JobSource } from "../config.js";
import type { NormalizedJob } from "../types.js";
import { fetchSource } from "./fetch.js";

export interface SourceFailure {
  source: JobSource;
  message: string;
}

export interface SourceBatchResult {
  jobs: NormalizedJob[];
  failures: SourceFailure[];
  incomplete: JobSource[];
}

type SourceFetcher = (source: JobSource, now: Date) => Promise<NormalizedJob[]>;

export async function fetchSourceBatch(
  sources: JobSource[],
  maxJobsPerSource: number,
  now = new Date(),
  fetcher: SourceFetcher = fetchSource,
): Promise<SourceBatchResult> {
  const enabledSources = sources.filter((source) => source.enabled);
  const settled = await Promise.allSettled(
    enabledSources.map(async (source) => {
      const fetched = await fetcher(source, now);
      return { source, jobs: fetched.slice(0, maxJobsPerSource),
        truncated: fetched.length > maxJobsPerSource };
    }),
  );
  const jobs: NormalizedJob[] = [];
  const failures: SourceFailure[] = [];
  const incomplete: JobSource[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      jobs.push(...result.value.jobs);
      if (result.value.truncated) incomplete.push(result.value.source);
      continue;
    }
    const index = settled.indexOf(result);
    const source = enabledSources[index];
    if (source) {
      failures.push({
        source,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return { jobs, failures, incomplete };
}
