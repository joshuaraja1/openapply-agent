import { randomUUID } from "node:crypto";
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
  status(candidateId: string, subjectId: string): Promise<"none" | "pending" | "complete">;
  due(nowEpoch: number, limit: number): Promise<Array<{ candidateId: string; subjectId: string }>>;
  defer(candidateId: string, subjectId: string, nextEpoch: number): Promise<void>;
  hasActiveWriters(candidateId: string, nowEpoch: number): Promise<boolean>;
  claimPurge(candidateId: string, subjectId: string, nowEpoch: number, owner: string): Promise<boolean>;
  releasePurge(candidateId: string, subjectId: string, owner: string): Promise<void>;
  /** Delete candidate ledger rows in bounded batches, retaining DELETED. */
  purgeMetadata(candidateId: string): Promise<boolean>;
  markComplete(candidateId: string, subjectId: string): Promise<void>;
}

/** A bounded scheduled tick. Due rows are durable, so an interrupted tick is
 * retried by the next invocation. A failed purge never becomes complete. */
export async function retryCandidateDeletions(deps: CandidateDeletionDeps, now = new Date()) {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(nowEpoch)) throw new Error("Invalid deletion clock");
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  for (const row of await deps.store.due(nowEpoch, 25)) {
    attempted++;
    try {
      if (deps.candidateIdForSubject(row.subjectId) !== row.candidateId) {
        throw new Error("Deletion candidate mismatch");
      }
      const result = await deleteCandidateAccount(row.subjectId, deps, now);
      if (result.state === "complete") completed++;
    } catch { failed++; }
    // Move still-pending rows to the next minute so one blocked candidate
    // cannot starve other due deletions. Completion removes the index keys.
    try { await deps.store.defer(row.candidateId, row.subjectId, nowEpoch + 60); }
    catch { failed++; }
  }
  return { attempted, completed, failed };
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
  const owner = randomUUID();
  if (!await deps.store.claimPurge(candidateId, subjectId, nowEpoch, owner)) {
    return { state: "pending" };
  }
  // The tombstone blocks new uploads, run creation, queue admission, and
  // journal writes before any object version is removed.
  try {
    if (await deps.store.hasActiveWriters(candidateId, nowEpoch)) return { state: "pending" };
    await deps.vault.deleteCandidate(candidateId);
    if (!await deps.store.purgeMetadata(candidateId)) return { state: "pending" };
    await deps.store.markComplete(candidateId, subjectId);
    return { state: "complete" };
  } finally {
    await deps.store.releasePurge(candidateId, subjectId, owner);
  }
}
