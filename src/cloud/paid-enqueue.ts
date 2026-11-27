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
    /** Optional staging hook. Invoked only after SQS accepts the message. */
    launcher?: { launch(candidateId: string, runId: string): Promise<void> };
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
  await ports.queue.send(envelope);
  await ports.launcher?.launch(candidateId, runId);
}
