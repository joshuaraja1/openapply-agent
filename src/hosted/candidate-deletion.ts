import type { CandidateVault } from "../cloud/candidate-vault.js";

/** The onboarding Lambda has a 60-second hard timeout. The 180-second upload
 * lease and this additional minute keep a timed-out S3 PUT out of the purge. */
export const DELETE_HOLD_SECONDS = 240;

export interface DeletionRecord {
  state: "pending" | "complete";
  subjectId: string;
  notBeforeEpoch: number;
}

export interface CandidateDeletionStore {
  begin(candidateId: string, subjectId: string, notBeforeEpoch: number): Promise<DeletionRecord>;
  hasActiveWriters(candidateId: string, nowEpoch: number): Promise<boolean>;
  /** Delete candidate ledger rows in bounded batches, retaining DELETED. */
  purgeMetadata(candidateId: string): Promise<boolean>;
  markComplete(candidateId: string, subjectId: string): Promise<void>;
}

export interface CandidateDeletionDeps {
  store: CandidateDeletionStore;
  vault: Pick<CandidateVault, "deleteCandidate">;
  candidateIdForSubject(subjectId: string): string;
}

export async function deleteCandidateAccount(subjectId: string, deps: CandidateDeletionDeps,
  now = new Date()): Promise<{ state: "pending" | "complete" }> {
  const candidateId = deps.candidateIdForSubject(subjectId);
  const nowEpoch = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(nowEpoch)) throw new Error("Invalid deletion clock");
  const marker = await deps.store.begin(candidateId, subjectId, nowEpoch + DELETE_HOLD_SECONDS);
  if (marker.subjectId !== subjectId) throw new Error("Deletion ownership mismatch");
  if (marker.state === "complete") return { state: "complete" };
  if (nowEpoch < marker.notBeforeEpoch
    || await deps.store.hasActiveWriters(candidateId, nowEpoch)) return { state: "pending" };
  // The tombstone blocks new uploads, run creation, queue admission, and
  // journal writes before any object version is removed.
  await deps.vault.deleteCandidate(candidateId);
  if (!await deps.store.purgeMetadata(candidateId)) return { state: "pending" };
  await deps.store.markComplete(candidateId, subjectId);
  return { state: "complete" };
}
