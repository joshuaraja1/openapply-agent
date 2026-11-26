export interface TimingSummary {
  count: number;
  failures: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/** Nearest-rank p95 keeps small samples conservative and is stable across platforms. */
export function summarizeTimings(samples: number[], failures = 0): TimingSummary {
  if (!Number.isSafeInteger(failures) || failures < 0
    || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Timing samples and failure count must be nonnegative finite values");
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const count = ordered.length;
  if (!count) return { count: 0, failures, medianMs: null, p95Ms: null };
  const middle = Math.floor(count / 2);
  const median = count % 2 ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
  return { count, failures, medianMs: Math.round(median * 100) / 100,
    p95Ms: Math.round(ordered[Math.ceil(count * 0.95) - 1]! * 100) / 100 };
}
