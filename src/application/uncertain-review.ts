import type { ApplicationCheckpoint } from "./state-machine.js";
import { readApplicationPackage } from "./package-file.js";

export interface UncertainReviewItem {
  jobId: string;
  jobLabel: string;
  officialUrl: string;
  blocker: string;
  packagePath: string | null;
  browserPageUrl: string | null;
  updatedAt: string;
}

/** Build a read-only view from encrypted state; never infer that a click succeeded. */
export async function uncertainReviewItems(
  records: Array<{ id: string; state?: ApplicationCheckpoint }>,
  readPackage = readApplicationPackage,
): Promise<UncertainReviewItem[]> {
  const items: UncertainReviewItem[] = [];
  for (const { id, state } of records) {
    if (!state || state.stage !== "submission-uncertain") continue;
    if (state.jobId !== id || !state.blocker) {
      throw new Error("Uncertain application record is incomplete or has a mismatched identity");
    }
    let jobLabel = state.jobId;
    if (state.packagePath) {
      try {
        const pkg = await readPackage(state.packagePath);
        if (pkg.job.id === id && pkg.job.applicationUrl === state.officialUrl) {
          jobLabel = `${pkg.job.company} — ${pkg.job.title}`;
        }
      } catch {
        // A missing or unreadable package must not hide an uncertain submission.
      }
    }
    items.push({ jobId: id, jobLabel, officialUrl: state.officialUrl,
      blocker: state.blocker, packagePath: state.packagePath ?? null,
      browserPageUrl: state.browserPageUrl ?? null, updatedAt: state.updatedAt });
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)
    || a.jobId.localeCompare(b.jobId));
}
