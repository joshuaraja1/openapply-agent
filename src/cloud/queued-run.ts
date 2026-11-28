import { createHash } from "node:crypto";
import { decodeCloudRunEnvelope } from "./run-envelope.js";
import { officialJobKey, type OfficialJobIdentity, type SubmissionStatus } from "./durable-journal.js";
import { HostedAccessDeniedError, requireHostedAccess } from "../hosted/entitlement.js";
import { HostedSubmissionBlocked } from "./hosted-submission-blocked.js";
import type { HostedHandoffState } from "./hosted-handoff-state.js";

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
  /** The only final Submit action. Call beforeClick as the last awaited step
   * before the irreversible click, after any adapter-side preparation. */
  submitOnce(beforeClick: () => Promise<boolean>): Promise<VerifiedReceipt | null>;
  /** Release the private browser profile on every terminal or retry path. */
  close?(): Promise<void>;
}

export type SyntheticCheckpoint = "after_intent" | "after_confirmation";

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
    prepare(profilePath: string, job: OfficialJobIdentity, candidateId: string,
      context?: { runId: string; leaseToken: string }): Promise<PreparedApplication>;
  };
  /** A blocked pre-submit form is encrypted and made terminal in the durable
   * dispatch ledger before the queue message can be acknowledged. */
  handoff?: {
    save(leaseToken: string, state: HostedHandoffState): Promise<void>;
  };
  dispatch: { readStatus(): Promise<"pending_queue" | "queued" | "launched"
    | "preview_complete" | "needs_human" | "completed" | "blocked" | "needs_reconciliation"> };
  /** Only wired by the .invalid synthetic staging task. */
  syntheticProbe?: { checkpoint(stage: SyntheticCheckpoint, job: OfficialJobIdentity): void };
  receiptVerifier: {
    /** Verify explicit employer confirmation for this exact requisition. */
    verify(receipt: VerifiedReceipt, job: OfficialJobIdentity): Promise<boolean>;
  };
  queue: {
    /** Delete the SQS receipt only after the durable confirmed state exists. */
    acknowledge(receiptHandle: string): Promise<void>;
    acknowledgeHandoff?(receiptHandle: string): Promise<void>;
  };
}

export type CloudRunOutcome = "confirmed" | "already_confirmed" | "lease_busy" | "unauthorized"
  | "needs_reconciliation" | "retry" | "payment_required" | "needs_human";

const MAX_RECEIPT_BYTES = 1024 * 1024;

async function hasHostedAccess(subjectId: string, billing: CloudRunPorts["billing"]): Promise<boolean> {
  const records = await billing.loadEntitlements(subjectId);
  try { requireHostedAccess(subjectId, records); return true; }
  catch (error) {
    if (error instanceof HostedAccessDeniedError) return false;
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
  if (await ports.dispatch.readStatus() === "needs_human") {
    if (!ports.queue.acknowledgeHandoff) throw new Error("Handoff acknowledgment unavailable");
    await ports.queue.acknowledgeHandoff(message.receiptHandle);
    return "needs_human";
  }
  const token = await ports.journal.acquireLease(run.candidateId, run.runId);
  if (!token) return "lease_busy";

  // Employer forms can take longer than the journal's 120-second lease. Keep
  // ownership alive while preparing and waiting for an exact-job receipt.
  // A lost lease before intent permits a retry; after intent it must remain
  // uncertain so a restarted task cannot click Submit a second time.
  let leaseLost = false;
  let renewal = Promise.resolve();
  const renewLease = () => {
    renewal = renewal.then(async () => {
      if (!leaseLost && !await ports.journal.renewLease(run.candidateId, token)) leaseLost = true;
    }).catch(() => { leaseLost = true; });
    return renewal;
  };
  const timer = setInterval(() => { void renewLease(); }, 30_000);
  timer.unref();

  let shouldAck = false;
  let shouldAckHandoff = false;
  let cleanupComplete = true;

  try {
    // The pre-lease read avoids needless work for terminal redelivery. Check
    // again after acquiring ownership so a racing handoff cannot slip through.
    const currentDispatch = await ports.dispatch.readStatus();
    if (currentDispatch === "needs_human") {
      if (!ports.queue.acknowledgeHandoff) throw new Error("Handoff acknowledgment unavailable");
      shouldAckHandoff = true;
      return "needs_human";
    }
    if (currentDispatch !== "queued" && currentDispatch !== "launched") {
      return "needs_reconciliation";
    }
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
    let browserCleanupComplete = false;
    try {
      let prepared: PreparedApplication;
      try {
        prepared = await ports.application.prepare(profile.path, record.job, run.candidateId,
          { runId: run.runId, leaseToken: token });
      } catch (error) {
        if (!(error instanceof HostedSubmissionBlocked)) throw error;
        try {
          if (!ports.handoff || !ports.queue.acknowledgeHandoff
            || officialJobKey(error.job) !== officialJobKey(record.job)) return "retry";
          await renewLease();
          if (leaseLost || !await ports.authorization.hasCurrentConsent(run.candidateId, run.runId)) {
            return "retry";
          }
          try { if (!await hasHostedAccess(record.subjectId, ports.billing)) return "retry"; }
          catch { return "retry"; }
          const browserState = JSON.parse(new TextDecoder("utf-8", { fatal: true })
            .decode(error.browserState)) as HostedHandoffState["browserState"];
          const state: HostedHandoffState = {
            version: 1, candidateId: run.candidateId, runId: run.runId, job: record.job,
            formUrl: error.formUrl, resumeSha256: error.resumeSha256,
            capturedAt: new Date().toISOString(), blockerCodes: [...error.blockerCodes],
            browserState,
          };
          await ports.handoff.save(token, state);
          browserCleanupComplete = true;
          shouldAckHandoff = true;
          return "needs_human";
        } finally { error.browserState.fill(0); }
      }
      try {
        await renewLease();
        if (leaseLost) return "retry";
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
        ports.syntheticProbe?.checkpoint("after_intent", record.job);

        await renewal;
        if (leaseLost) {
          await ports.journal.markUncertain(run.candidateId, token, record.job);
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

        // The final authorization lookup can itself outlast a renewal. Do not
        // enter the irreversible browser action after ownership was lost.
        await renewal;
        if (leaseLost) {
          await ports.journal.markUncertain(run.candidateId, token, record.job);
          return "needs_reconciliation";
        }

        let receipt: VerifiedReceipt | null;
        let finalGuardPassed = false;
        const beforeClick = async (): Promise<boolean> => {
          finalGuardPassed = false;
          await renewLease();
          if (leaseLost) return false;
          try {
            if (!await ports.authorization.hasCurrentConsent(run.candidateId, run.runId)
              || !await hasHostedAccess(record.subjectId, ports.billing)) return false;
            const current = await ports.journal.readSubmission(run.candidateId, record.job);
            finalGuardPassed = current.status === "needs_reconciliation";
            return finalGuardPassed;
          } catch { return false; }
        };
        try {
          receipt = await prepared.submitOnce(beforeClick);
        } catch {
          await ports.journal.markUncertain(run.candidateId, token, record.job);
          return "needs_reconciliation";
        }
        if (!finalGuardPassed || !receipt || receipt.evidence.byteLength === 0
          || receipt.evidence.byteLength > MAX_RECEIPT_BYTES
          || officialJobKey(receipt.job) !== officialJobKey(record.job)
          || !await ports.receiptVerifier.verify(receipt, record.job)) {
          await ports.journal.markUncertain(run.candidateId, token, record.job);
          return "needs_reconciliation";
        }

        await renewal;
        if (leaseLost) {
          await ports.journal.markUncertain(run.candidateId, token, record.job);
          return "needs_reconciliation";
        }

        const sha256 = createHash("sha256").update(receipt.evidence).digest("hex");
        await ports.vault.put(run.candidateId, run.runId, token, artifactId, receipt.evidence);
        if (!await ports.journal.confirmAfterVerification(run.candidateId, token, record.job,
          { artifactId, sha256 })) return "needs_reconciliation";
        ports.syntheticProbe?.checkpoint("after_confirmation", record.job);
        shouldAck = true;
        return "confirmed";
      } finally {
        await prepared.close?.();
        browserCleanupComplete = true;
      }
    } finally {
      await profile.cleanup();
      cleanupComplete = browserCleanupComplete;
    }
  } finally {
    clearInterval(timer);
    await renewal;
    await ports.journal.releaseLease(run.candidateId, token);
    if (cleanupComplete) {
      if (shouldAck) await ports.queue.acknowledge(message.receiptHandle);
      else if (shouldAckHandoff) await ports.queue.acknowledgeHandoff?.(message.receiptHandle);
    }
  }
}
