export function mergePendingQueue<T extends { job: { id: string } }>(
  previous: T[], current: T[], maximum = 500,
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const entry of [...current, ...previous]) {
    if (!entry.job.id || seen.has(entry.job.id)) continue;
    seen.add(entry.job.id);
    merged.push(entry);
    if (merged.length === maximum) break;
  }
  return merged;
}
