export function mergePendingQueue<T extends { job: { id: string } }>(
  previous: T[], current: T[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const entry of [...current, ...previous]) {
    if (!entry.job.id || seen.has(entry.job.id)) continue;
    seen.add(entry.job.id);
    merged.push(entry);
  }
  return merged;
}
