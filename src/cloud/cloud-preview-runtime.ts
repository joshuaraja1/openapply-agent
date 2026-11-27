import { readFile, stat } from "node:fs/promises";
import { requireHostedAccess } from "../hosted/entitlement.js";
import { decodeCloudRunEnvelope } from "./run-envelope.js";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";
import type { HostedPreviewInput, HostedPreviewOutcome } from "./hosted-pre-submit-preview.js";
import type { OfficialLeadRow } from "./official-lead-sync.js";

const MAX_PROFILE_BYTES = 512_000;

export interface CloudPreviewPorts {
  dispatch: { read(): Promise<{ body: string; state: "queued" | "launched" }> };
  runRecords: { loadIdentity(candidateId: string, runId: string): Promise<{
    subjectId: string; job: OfficialJobIdentity;
  }> };
  authorization: {
    ownsRun(candidateId: string, runId: string): Promise<boolean>;
    hasCurrentConsent(candidateId: string, runId: string): Promise<boolean>;
  };
  billing: { loadEntitlements(subjectId: string): Promise<readonly unknown[]> };
  journal: {
    acquireLease(candidateId: string, runId: string): Promise<string | null>;
    releaseLease(candidateId: string, leaseToken: string): Promise<void>;
    readSubmission(candidateId: string, job: OfficialJobIdentity): Promise<{ status: string }>;
  };
  preview: { loadBinding(leaseToken: string): Promise<{
    profileArtifactId: string; lead: OfficialLeadRow;
  }>; recordOutcome(leaseToken: string, job: OfficialJobIdentity, outcome: {
    status: "ready-for-review" | "needs-human"; blockerCount: number;
    resumeSha256: string; uploaded: boolean;
  }): Promise<void> };
  vault: { restoreToPrivateTemp(candidateId: string, runId: string,
    leaseToken: string, artifactId: string): Promise<{ path: string; cleanup(): Promise<void> }> };
}

/** A separate cloud entry point: it does not call beginSubmission, submitOnce,
 * or markDispatchCompleted. A preview is never an application receipt. */
export async function runCloudPreSubmitPreview(scope: {
  candidateId: string; runId: string;
}, directories: { work: string; browser: string }, ports: CloudPreviewPorts,
  preview: (input: HostedPreviewInput) => Promise<HostedPreviewOutcome>): Promise<HostedPreviewOutcome> {
  const dispatch = await ports.dispatch.read();
  const envelope = decodeCloudRunEnvelope(dispatch.body);
  if (dispatch.state !== "launched" || envelope.kind !== "apply"
    || envelope.candidateId !== scope.candidateId || envelope.runId !== scope.runId) {
    throw new Error("Preview dispatch does not match the launched task");
  }
  if (!await ports.authorization.ownsRun(scope.candidateId, scope.runId)
    || !await ports.authorization.hasCurrentConsent(scope.candidateId, scope.runId)) {
    throw new Error("Preview run is not authorized");
  }
  const run = await ports.runRecords.loadIdentity(scope.candidateId, scope.runId);
  requireHostedAccess(run.subjectId, await ports.billing.loadEntitlements(run.subjectId));
  if ((await ports.journal.readSubmission(scope.candidateId, run.job)).status !== "not_started") {
    throw new Error("Preview cannot run after submission intent");
  }
  const lease = await ports.journal.acquireLease(scope.candidateId, scope.runId);
  if (!lease) throw new Error("Preview lease is busy");
  try {
    // The broker revalidates the official posting, profile marker, consent,
    // entitlement, lease, and absence of a submit intent on this call.
    const binding = await ports.preview.loadBinding(lease);
    if (officialJobKey(binding.lead.job) !== officialJobKey(run.job)) {
      throw new Error("Preview posting changed after authorization");
    }
    const restored = await ports.vault.restoreToPrivateTemp(scope.candidateId,
      scope.runId, lease, binding.profileArtifactId);
    try {
      const file = await stat(restored.path);
      if (!file.isFile() || file.size < 1 || file.size > MAX_PROFILE_BYTES) {
        throw new Error("Approved profile artifact is unavailable");
      }
      const bytes = await readFile(restored.path);
      try {
        const outcome = await preview({ candidateId: scope.candidateId, runJob: run.job,
          lead: binding.lead, profileBytes: bytes,
          privateWorkDirectory: directories.work,
          privateBrowserDirectory: directories.browser });
        if (officialJobKey(outcome.job) !== officialJobKey(run.job)) {
          throw new Error("Preview outcome belongs to another job");
        }
        await ports.preview.recordOutcome(lease, run.job, {
          status: outcome.status, blockerCount: outcome.blockers.length,
          resumeSha256: outcome.resumeSha256, uploaded: outcome.uploaded,
        });
        return outcome;
      } finally { bytes.fill(0); }
    } finally { await restored.cleanup(); }
  } finally { await ports.journal.releaseLease(scope.candidateId, lease); }
}
