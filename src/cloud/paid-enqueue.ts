import { requireHostedAccess } from "../hosted/entitlement.js";
import { encodeCloudRunEnvelope } from "./run-envelope.js";
import type { CloudRunRecord } from "./queued-run.js";

/** Called only after HTTP authentication; never accept the subject from a browser body. */
export async function enqueueHostedApplication(
  authenticatedSubjectId: string,
  candidateId: string,
  runId: string,
  ports: {
    runRecords: { loadIdentity(candidateId: string, runId: string): Promise<CloudRunRecord> };
    authorization: {
      ownsRun(candidateId: string, runId: string): Promise<boolean>;
      hasCurrentConsent(candidateId: string, runId: string): Promise<boolean>;
    };
    billing: { loadEntitlements(subjectId: string): Promise<readonly unknown[]> };
    queue: { send(message: { body: string; groupId: string;
      deduplicationId: string }): Promise<void> };
    dispatch?: {
      ensurePending(candidateId: string, runId: string,
        envelope: ReturnType<typeof encodeCloudRunEnvelope>): Promise<{
        state: "pending_queue" | "queued" | "launched" | "preview_complete" | "needs_human" | "completed" | "blocked" | "needs_reconciliation";
        body: string; groupId: string; deduplicationId: string;
      }>;
      markQueued(candidateId: string, runId: string): Promise<void>;
      markLaunched(candidateId: string, runId: string): Promise<void>;
      markNeedsReconciliation(candidateId: string, runId: string): Promise<void>;
    };
    /** Optional staging hook. A scheduled dispatcher retries after failure. */
    launcher?: { launch(candidateId: string, runId: string): Promise<"started" | "capacity_busy" | "already_stopped"> };
  },
  now = new Date(),
): Promise<void> {
  // Validate opaque identifiers before any account or queue access.
  const envelope = encodeCloudRunEnvelope({ version: 1, candidateId, runId,
    kind: "apply", scheduledAt: now.toISOString() });
  if (!authenticatedSubjectId.trim()) throw new Error("Authenticated candidate required");
  if (!await ports.authorization.ownsRun(candidateId, runId)
    || !await ports.authorization.hasCurrentConsent(candidateId, runId)) {
    throw new Error("Application run is not authorized");
  }
  const record = await ports.runRecords.loadIdentity(candidateId, runId);
  if (record.subjectId !== authenticatedSubjectId) {
    throw new Error("Application run is not bound to this candidate");
  }
  requireHostedAccess(authenticatedSubjectId,
    await ports.billing.loadEntitlements(authenticatedSubjectId), now);
  if (ports.launcher && !ports.dispatch) throw new Error("Durable dispatch required for launcher");
  if (!ports.dispatch) {
    await ports.queue.send(envelope);
    return;
  }
  const pending = await ports.dispatch.ensurePending(candidateId, runId, envelope);
  if (pending.state === "blocked") throw new Error("Application run is not authorized");
  if (pending.state === "needs_reconciliation") throw new Error("Application run needs reconciliation");
  if (pending.state === "launched" || pending.state === "preview_complete"
    || pending.state === "needs_human"
    || pending.state === "completed") return;
  if (pending.state === "pending_queue") {
    // The durable dispatch row is the hosted queue. A run-scoped task must
    // never poll a shared SQS queue, where another candidate may be received.
    await ports.dispatch.markQueued(candidateId, runId);
  }
  // The outbox is durable now. A busy slot or transient Lambda error is picked
  // up by the scheduled dispatcher, so the HTTP request can return queued.
  let launchOutcome: "started" | "capacity_busy" | "already_stopped" | undefined;
  try { launchOutcome = await ports.launcher?.launch(candidateId, runId); }
  catch { return; /* scheduled retry owns the durable pending record */ }
  if (launchOutcome === "started") {
    await ports.dispatch.markLaunched(candidateId, runId);
  } else if (launchOutcome === "already_stopped") {
    await ports.dispatch.markNeedsReconciliation(candidateId, runId);
    throw new Error("Application run needs reconciliation");
  }
}
