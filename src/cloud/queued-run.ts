import { createHash } from "node:crypto";
import { decodeCloudRunEnvelope } from "./run-envelope.js";
import { officialJobKey, type OfficialJobIdentity, type SubmissionStatus } from "./durable-journal.js";
import { requireHostedAccess } from "../hosted/entitlement.js";

export interface CloudRunRecord {
  /** Trusted billing subject bound to this candidate when the run was created. */
  subjectId: string;
  /** Version of the candidate's durable, server-side consent grant for this run. */
  consentVersion: number;
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
  billing: {
    /** Read current durable entitlements on each call; never trust the SQS body. */
    loadEntitlements(subjectId: string): Promise<readonly unknown[]>;
  };
  authorization: {
    /** Ownership remains checkable after consent is revoked, for safe queue cleanup. */
    ownsRun(candidateId: string, runId: string): Promise<boolean>;
    /** Consent is required for a new attempt; journal also checks it atomically at intent. */
    hasCurrentConsent(candidateId: string, runId: string): Promise<boolean>;
  };
  journal: {
    acquireLease(candidateId: string, runId: string): Promise<string | null>;
    renewLease(candidateId: string, token: string): Promise<boolean>;
    releaseLease(candidateId: string, token: string): Promise<void>;
    readSubmission(candidateId: string, job: OfficialJobIdentity): Promise<{
      status: SubmissionStatus; receiptArtifactId?: string;
    }>;
    /** Atomically checks the consent version and reserves the receipt ID. */
    beginSubmission(candidateId: string, token: string, runId: string, consentVersion: number,
      job: OfficialJobIdentity): Promise<string | null>;
    markUncertain(candidateId: string, token: string, job: OfficialJobIdentity): Promise<void>;
    confirmAfterVerification(candidateId: string, token: string, job: OfficialJobIdentity,
      receipt: { artifactId: string; sha256: string }): Promise<boolean>;
  };
  runRecords: {
    /** Metadata only: no candidate profile bytes or artifact ID for confirmed redelivery. */
    loadIdentity(candidateId: string, runId: string): Promise<CloudRunRecord>;
    loadProfileArtifactId(candidateId: string, runId: string): Promise<string>;
  };
  vault: {
    restoreToPrivateTemp(candidateId: string, runId: string, leaseToken: string,
      artifactId: string): Promise<{
      path: string; cleanup(): Promise<void>;
    }>;
    /** The production vault must reject a duplicate artifact ID. */
    put(candidateId: string, runId: string, leaseToken: string, artifactId: string,
      bytes: Uint8Array): Promise<void>;
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
  | "needs_reconciliation" | "retry" | "payment_required";

const MAX_RECEIPT_BYTES = 1024 * 1024;

async function hasHostedAccess(subjectId: string, billing: CloudRunPorts["billing"]): Promise<boolean> {
  const records = await billing.loadEntitlements(subjectId);
  try { requireHostedAccess(subjectId, records); return true; }
  catch (error) {
    if (error instanceof Error && error.message === "Hosted access unavailable") return false;
    throw error; // Malformed durable state is an infrastructure failure, not a paywall.
  }
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
  if (!await ports.authorization.ownsRun(run.candidateId, run.runId)) return "unauthorized";
  const token = await ports.journal.acquireLease(run.candidateId, run.runId);
  if (!token) return "lease_busy";

  let shouldAck = false;
  let cleanupComplete = true;

  try {
    const record = await ports.runRecords.loadIdentity(run.candidateId, run.runId);
    const { status } = await ports.journal.readSubmission(run.candidateId, record.job);
    if (status === "confirmed") {
      shouldAck = true;
      return "already_confirmed";
    }
    if (status === "needs_reconciliation") return "needs_reconciliation";
    if (!await ports.authorization.hasCurrentConsent(run.candidateId, run.runId)) return "unauthorized";
    if (!record.subjectId.trim()) throw new Error("Run has no bound billing subject");
    try { if (!await hasHostedAccess(record.subjectId, ports.billing)) return "payment_required"; }
    catch { return "retry"; }
    if (!Number.isSafeInteger(record.consentVersion) || record.consentVersion < 1) {
      throw new Error("Run has no valid durable consent version");
    }

    const profileArtifactId = await ports.runRecords.loadProfileArtifactId(run.candidateId, run.runId);
    const profile = await ports.vault.restoreToPrivateTemp(run.candidateId, run.runId,
      token, profileArtifactId);
    cleanupComplete = false;
    try {
      const prepared = await ports.application.prepare(profile.path, record.job);
      if (!await ports.journal.renewLease(run.candidateId, token)) return "retry";
      if (!await ports.authorization.hasCurrentConsent(run.candidateId, run.runId)) return "unauthorized";
      try { if (!await hasHostedAccess(record.subjectId, ports.billing)) return "payment_required"; }
      catch { return "retry"; }
      const artifactId = await ports.journal.beginSubmission(
        run.candidateId, token, run.runId, record.consentVersion, record.job);
      if (!artifactId) {
        const { status: afterConflict } = await ports.journal.readSubmission(run.candidateId, record.job);
        if (afterConflict === "not_started") return "retry";
        if (afterConflict === "confirmed") {
          shouldAck = true;
          return "already_confirmed";
        }
        return "needs_reconciliation";
      }

      // One final read after the durable intent narrows the window in which a
      // payment or consent revocation could race with the external Submit.
      // If it changed, keep the intent uncertain; never try this job again
      // automatically because a browser click may already be in flight.
      let stillAuthorized = false;
      try {
        stillAuthorized = await ports.authorization.hasCurrentConsent(run.candidateId, run.runId);
        if (stillAuthorized) {
          stillAuthorized = await hasHostedAccess(record.subjectId, ports.billing);
        }
      } catch { stillAuthorized = false; }
      if (!stillAuthorized) {
        await ports.journal.markUncertain(run.candidateId, token, record.job);
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

      const sha256 = createHash("sha256").update(receipt.evidence).digest("hex");
      await ports.vault.put(run.candidateId, run.runId, token, artifactId, receipt.evidence);
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
