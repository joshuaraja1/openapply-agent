import { z } from "zod";
import { officialJobKey } from "./durable-journal.js";
import { candidateIdForSubject, createTrustedApplicationRun,
  type VerifiedOfficialLead, type VerifiedCandidateProfile,
  type TrustedRunRecord } from "./hosted-run-creator.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
export const reviewedRetryInputSchema = z.strictObject({
  blockedRunId: uuid, newRunId: uuid, reviewedProfileArtifactId: uuid,
  acknowledgement: z.literal("I reviewed and updated my application facts"),
});

/** A stopped browser form cannot preserve unsent DOM edits. A reviewed retry
 * creates a fresh run from a different approved profile, for the same exact
 * official job. The old encrypted checkpoint stays for audit and deletion. */
export async function createReviewedApplicationRetry(issuer: string, subjectId: string,
  inputValue: unknown, ports: {
    loadBlockedRun(candidateId: string, runId: string): Promise<{
      subjectId: string; leadId: string; profileArtifactId: string;
      job: { provider: string; employerId: string; requisitionId: string };
    }>;
    readNeedsHumanPointer(candidateId: string, runId: string): Promise<{
      artifactId: string; sha256: string } | undefined>;
    readSubmission(candidateId: string, job: { provider: string; employerId: string;
      requisitionId: string }): Promise<{ status: string }>;
    hasCurrentConsent(candidateId: string, runId: string): Promise<boolean>;
    hasActiveTask(candidateId: string): Promise<boolean>;
    verifyLiveLead(leadId: string, job: { provider: string; employerId: string;
      requisitionId: string }, now: Date): Promise<VerifiedOfficialLead>;
    billing: { loadEntitlements(subjectId: string): Promise<readonly unknown[]> };
    loadProfile(candidateId: string, artifactId: string): Promise<VerifiedCandidateProfile | undefined>;
    profileObjectExists(candidateId: string, artifactId: string): Promise<boolean>;
    createOrGet(record: TrustedRunRecord, lead: VerifiedOfficialLead,
      nowEpoch: number): Promise<"created" | "existing">;
  }, now = new Date()) {
  const input = reviewedRetryInputSchema.parse(inputValue);
  if (input.newRunId === input.blockedRunId) throw new Error("Reviewed retry needs a new run");
  const candidateId = candidateIdForSubject(issuer, subjectId);
  const blocked = await ports.loadBlockedRun(candidateId, input.blockedRunId);
  if (blocked.subjectId !== subjectId
    || blocked.profileArtifactId === input.reviewedProfileArtifactId
    || !await ports.readNeedsHumanPointer(candidateId, input.blockedRunId)
    || !await ports.hasCurrentConsent(candidateId, input.blockedRunId)
    || (await ports.readSubmission(candidateId, blocked.job)).status !== "not_started"
    || await ports.hasActiveTask(candidateId)) {
    throw new Error("Reviewed retry is unavailable");
  }
  const lead = await ports.verifyLiveLead(blocked.leadId, blocked.job, now);
  if (lead.leadId !== blocked.leadId || officialJobKey(lead.job) !== officialJobKey(blocked.job)
    || lead.jobKey !== officialJobKey(blocked.job)) {
    throw new Error("Official job changed");
  }
  return createTrustedApplicationRun(issuer, subjectId, {
    runId: input.newRunId, leadId: blocked.leadId,
    profileArtifactId: input.reviewedProfileArtifactId,
    consent: { granted: true, scope: "apply-one-job", policyVersion: "v1" },
  }, { billing: ports.billing, loadLead: async () => lead,
    loadProfile: ports.loadProfile, profileObjectExists: ports.profileObjectExists,
    createOrGet: ports.createOrGet }, now);
}
