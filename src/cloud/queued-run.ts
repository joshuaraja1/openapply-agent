import { createHash } from "node:crypto";
import { decodeCloudRunEnvelope } from "./run-envelope.js";
import { officialJobKey, type OfficialJobIdentity, type SubmissionStatus } from "./durable-journal.js";

export interface CloudRunRecord {
  profileArtifactId: string;
  job: OfficialJobIdentity;
}

export interface VerifiedReceipt {
  /** Raw confirmation evidence, never included in a queue message or log. */
  evidence: Uint8Array;
  job: OfficialJobIdentity;
}

export interface PreparedApplication {
  /** The only final Submit action; the handler calls this only after durable intent. */
  submitOnce(): Promise<VerifiedReceipt | null>;
}

export interface CloudRunPorts {
  authorization: {
    /** Verify this run belongs to this candidate and has current application consent. */
    authorize(candidateId: string, runId: string): Promise<boolean>;
  };
  journal: {
    acquireLease(candidateId: string, runId: string): Promise<string | null>;
    renewLease(candidateId: string, token: string): Promise<boolean>;
    releaseLease(candidateId: string, token: string): Promise<void>;
    submissionStatus(candidateId: string, job: OfficialJobIdentity): Promise<SubmissionStatus>;
    beginSubmission(candidateId: string, token: string, job: OfficialJobIdentity): Promise<boolean>;
    markUncertain(candidateId: string, token: string, job: OfficialJobIdentity): Promise<void>;
    confirmAfterVerification(candidateId: string, token: string, job: OfficialJobIdentity,
      receipt: { artifactId: string; sha256: string }): Promise<boolean>;
  };
  runRecords: {
    /** Must authorize both IDs and return a verified official requisition. */
    load(candidateId: string, runId: string): Promise<CloudRunRecord>;
  };
  vault: {
    restoreToPrivateTemp(candidateId: string, artifactId: string): Promise<{
      path: string; cleanup(): Promise<void>;
    }>;
    /** The production vault must reject a duplicate artifact ID. */
    put(candidateId: string, artifactId: string, bytes: Uint8Array): Promise<void>;
  };
  application: {
    /** No real browser implementation is registered by this staging module. */
    prepare(profilePath: string, job: OfficialJobIdentity): Promise<PreparedApplication>;
  };
  receiptVerifier: {
    /** Verify explicit employer confirmation for this exact requisition. */
    verify(receipt: VerifiedReceipt, job: OfficialJobIdentity): Promise<boolean>;
  };
  queue: {
    /** Delete the SQS receipt only after the durable confirmed state exists. */
    acknowledge(receiptHandle: string): Promise<void>;
  };
}

export type CloudRunOutcome = "confirmed" | "already_confirmed" | "lease_busy" | "unauthorized"
  | "needs_reconciliation" | "retry";

const MAX_RECEIPT_BYTES = 1024 * 1024;

/** Stable lookup even when the worker dies after storing evidence but before journal confirmation. */
export function receiptArtifactId(candidateId: string, job: OfficialJobIdentity): string {
  const bytes = createHash("sha256")
    .update(`openapply-receipt-v1:${candidateId}:${officialJobKey(job)}`)
    .digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Fail-closed bridge between a received SQS message and durable application state.
 * No production browser adapter or queue poller is included in this staging slice.
 */
export async function handleQueuedApplication(
  message: { body: string; receiptHandle: string }, ports: CloudRunPorts,
): Promise<CloudRunOutcome> {
  if (!message.receiptHandle) throw new Error("SQS receipt handle is required");
  const run = decodeCloudRunEnvelope(message.body);
  if (run.kind !== "apply") throw new Error("Discovery messages cannot enter the application handler");
  if (!await ports.authorization.authorize(run.candidateId, run.runId)) return "unauthorized";
  const token = await ports.journal.acquireLease(run.candidateId, run.runId);
  if (!token) return "lease_busy";

  let shouldAck = false;
  let cleanupComplete = true;

  try {
    const record = await ports.runRecords.load(run.candidateId, run.runId);
    const status = await ports.journal.submissionStatus(run.candidateId, record.job);
    if (status === "confirmed") {
      shouldAck = true;
      return "already_confirmed";
    }
    if (status === "needs_reconciliation") return "needs_reconciliation";

    const profile = await ports.vault.restoreToPrivateTemp(run.candidateId, record.profileArtifactId);
    cleanupComplete = false;
    try {
      const prepared = await ports.application.prepare(profile.path, record.job);
      if (!await ports.journal.renewLease(run.candidateId, token)) return "retry";
      if (!await ports.journal.beginSubmission(run.candidateId, token, record.job)) {
        const afterConflict = await ports.journal.submissionStatus(run.candidateId, record.job);
        if (afterConflict === "not_started") return "retry";
        if (afterConflict === "confirmed") {
          shouldAck = true;
          return "already_confirmed";
        }
        return "needs_reconciliation";
      }

      let receipt: VerifiedReceipt | null;
      try {
        receipt = await prepared.submitOnce();
      } catch {
        await ports.journal.markUncertain(run.candidateId, token, record.job);
        return "needs_reconciliation";
      }
      if (!receipt || receipt.evidence.byteLength === 0
        || receipt.evidence.byteLength > MAX_RECEIPT_BYTES
        || officialJobKey(receipt.job) !== officialJobKey(record.job)
        || !await ports.receiptVerifier.verify(receipt, record.job)) {
        await ports.journal.markUncertain(run.candidateId, token, record.job);
        return "needs_reconciliation";
      }

      const artifactId = receiptArtifactId(run.candidateId, record.job);
      const sha256 = createHash("sha256").update(receipt.evidence).digest("hex");
      await ports.vault.put(run.candidateId, artifactId, receipt.evidence);
      if (!await ports.journal.confirmAfterVerification(run.candidateId, token, record.job,
        { artifactId, sha256 })) return "needs_reconciliation";
      shouldAck = true;
      return "confirmed";
    } finally {
      await profile.cleanup();
      cleanupComplete = true;
    }
  } finally {
    await ports.journal.releaseLease(run.candidateId, token);
    if (shouldAck && cleanupComplete) await ports.queue.acknowledge(message.receiptHandle);
  }
}
