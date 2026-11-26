import { createHash, randomUUID } from "node:crypto";
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

  try {
    const record = await ports.runRecords.load(run.candidateId, run.runId);
    const status = await ports.journal.submissionStatus(run.candidateId, record.job);
    if (status === "confirmed") {
      await ports.queue.acknowledge(message.receiptHandle);
      return "already_confirmed";
    }
    if (status === "needs_reconciliation") return "needs_reconciliation";

    const profile = await ports.vault.restoreToPrivateTemp(run.candidateId, record.profileArtifactId);
    try {
      const prepared = await ports.application.prepare(profile.path, record.job);
      if (!await ports.journal.renewLease(run.candidateId, token)) return "retry";
      if (!await ports.journal.beginSubmission(run.candidateId, token, record.job)) {
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

      const artifactId = randomUUID();
      const sha256 = createHash("sha256").update(receipt.evidence).digest("hex");
      await ports.vault.put(run.candidateId, artifactId, receipt.evidence);
      if (!await ports.journal.confirmAfterVerification(run.candidateId, token, record.job,
        { artifactId, sha256 })) return "retry";
      await ports.queue.acknowledge(message.receiptHandle);
      return "confirmed";
    } finally {
      await profile.cleanup();
    }
  } finally {
    await ports.journal.releaseLease(run.candidateId, token);
  }
}
