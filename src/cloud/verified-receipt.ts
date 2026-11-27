import type { OfficialJobIdentity, SubmissionRecord } from "./durable-journal.js";
import type { CandidateVault } from "./candidate-vault.js";

/** Trusted candidate-facing readers must use the confirmed journal digest.
 * There is no worker receipt-read permission in the scoped STS role. */
export async function readConfirmedReceipt(candidateId: string, job: OfficialJobIdentity,
  journal: { readSubmission(candidateId: string, job: OfficialJobIdentity): Promise<SubmissionRecord> },
  vault: Pick<CandidateVault, "readReceiptVerified">): Promise<Buffer> {
  const record = await journal.readSubmission(candidateId, job);
  if (record.status !== "confirmed" || !record.runId || !record.receiptArtifactId
    || !record.receiptSha256) throw new Error("Confirmed receipt unavailable");
  return vault.readReceiptVerified(candidateId, record.runId,
    record.receiptArtifactId, record.receiptSha256);
}
