import { createHash } from "node:crypto";
import { z } from "zod";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";
import { requireHostedAccess } from "../hosted/entitlement.js";

const uuid = z.uuid();
export const runCreationInputSchema = z.strictObject({
  runId: uuid,
  leadId: uuid,
  profileArtifactId: uuid,
  consent: z.strictObject({ granted: z.literal(true),
    scope: z.literal("apply-one-job"), policyVersion: z.literal("v1") }),
});
export type RunCreationInput = z.infer<typeof runCreationInputSchema>;

export interface VerifiedOfficialLead {
  leadId: string;
  job: OfficialJobIdentity;
  canonicalUrl: string;
  expiresAt: number;
  jobKey: string;
}
export interface VerifiedCandidateProfile {
  candidateId: string;
  artifactId: string;
  subjectId: string;
}
export interface TrustedRunRecord {
  candidateId: string;
  runId: string;
  subjectId: string;
  leadId: string;
  job: OfficialJobIdentity;
  jobKey: string;
  profileArtifactId: string;
  consentVersion: 1;
  policyVersion: "v1";
  createdAt: string;
}

export class RunConflictError extends Error {}
export class RunInputsUnavailableError extends Error {}

/** Stable opaque tenant ID; a browser cannot choose another candidate's ID. */
export function candidateIdForSubject(issuer: string, subjectId: string): string {
  if (!issuer || !subjectId.trim() || subjectId.length > 160) {
    throw new Error("Invalid authenticated subject");
  }
  const bytes = createHash("sha256").update(issuer).update("\0")
    .update(subjectId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createTrustedApplicationRun(
  issuer: string,
  subjectId: string,
  inputValue: unknown,
  ports: {
    billing: { loadEntitlements(subjectId: string): Promise<readonly unknown[]> };
    loadLead(leadId: string): Promise<VerifiedOfficialLead | undefined>;
    loadProfile(candidateId: string, artifactId: string): Promise<VerifiedCandidateProfile | undefined>;
    profileArtifactsAvailable(candidateId: string, artifactId: string): Promise<boolean>;
    createOrGet(record: TrustedRunRecord, lead: VerifiedOfficialLead,
      nowEpoch: number): Promise<"created" | "existing">;
  },
  now = new Date(),
): Promise<{ record: TrustedRunRecord; created: boolean }> {
  const input = runCreationInputSchema.parse(inputValue);
  const candidateId = candidateIdForSubject(issuer, subjectId);
  requireHostedAccess(subjectId, await ports.billing.loadEntitlements(subjectId), now);
  const [lead, profile, artifactsAvailable] = await Promise.all([
    ports.loadLead(input.leadId),
    ports.loadProfile(candidateId, input.profileArtifactId),
    ports.profileArtifactsAvailable(candidateId, input.profileArtifactId),
  ]);
  const nowEpoch = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(nowEpoch) || !lead || !profile || !artifactsAvailable
    || lead.leadId !== input.leadId || lead.expiresAt <= nowEpoch
    || lead.jobKey !== officialJobKey(lead.job)
    || profile.candidateId !== candidateId
    || profile.artifactId !== input.profileArtifactId
    || profile.subjectId !== subjectId) {
    throw new RunInputsUnavailableError("Verified application inputs unavailable");
  }
  let url: URL;
  try {
    url = new URL(lead.canonicalUrl);
  } catch {
    throw new RunInputsUnavailableError("Verified application inputs unavailable");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || !url.hostname || url.hostname === "localhost") {
    throw new RunInputsUnavailableError("Verified application inputs unavailable");
  }
  const record: TrustedRunRecord = {
    candidateId, runId: input.runId.toLowerCase(), subjectId,
    leadId: input.leadId.toLowerCase(), job: lead.job, jobKey: lead.jobKey,
    profileArtifactId: input.profileArtifactId.toLowerCase(),
    consentVersion: 1, policyVersion: input.consent.policyVersion,
    createdAt: now.toISOString(),
  };
  const result = await ports.createOrGet(record, lead, nowEpoch);
  return { record, created: result === "created" };
}
