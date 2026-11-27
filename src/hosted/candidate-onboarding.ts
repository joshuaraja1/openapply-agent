import { createHash } from "node:crypto";
import { z } from "zod";
import { careerStageSchema } from "../candidate/intake.js";
import type { CandidateVault } from "../cloud/candidate-vault.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase(),
  "Use a lowercase submission ID");
const shortText = z.string().trim().min(1).max(300);
const pdf = z.strictObject({
  name: z.string().trim().min(1).max(120).regex(/\.pdf$/i),
  base64: z.string().min(1).max(7_000_000),
});

/** All facts here are entered and reviewed by the candidate. Uploads are evidence, not inferred facts. */
export const onboardingSubmissionSchema = z.strictObject({
  version: z.literal(1),
  submissionId: uuid,
  careerStage: careerStageSchema,
  targetRoles: z.array(shortText).min(1).max(12),
  locations: z.array(shortText).min(1).max(12),
  schoolOrEmployer: shortText,
  graduationOrExperience: shortText,
  workAuthorization: shortText,
  sponsorshipRequiredNowOrFuture: z.boolean(),
  masterResume: pdf,
  transcript: pdf.optional(),
  reviewConfirmed: z.literal(true),
  storageConsent: z.literal(true),
  automationConsent: z.literal(true),
});

export type OnboardingSubmission = z.infer<typeof onboardingSubmissionSchema>;

export interface OnboardingMarkerStore {
  isDeleted(candidateId: string): Promise<boolean>;
  /** Atomically reserve a bounded in-flight write while DELETED is absent. */
  beginUpload(candidateId: string, artifactId: string, subjectId: string): Promise<string>;
  endUpload(candidateId: string, artifactId: string, leaseId: string): Promise<void>;
  /** Existing marker must belong to this subject. */
  get(candidateId: string, artifactId: string): Promise<{ status: string; subjectId: string; digest: string } | null>;
  /** Conditional create. A pending marker is never eligible to create a run. */
  createPending(candidateId: string, artifactId: string, subjectId: string, digest: string): Promise<void>;
  /** Conditional update from pending to verified for the same subject and artifact. */
  markVerified(candidateId: string, artifactId: string, subjectId: string): Promise<void>;
}

export interface OnboardingDeps {
  vault: Pick<CandidateVault, "put" | "read">;
  markers: OnboardingMarkerStore;
  candidateIdForSubject(subjectId: string): string;
}

function derivedId(submissionId: string, kind: string): string {
  const bytes = createHash("sha256").update(`openapply:onboarding:${submissionId}:${kind}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodePdf(document: z.infer<typeof pdf>): Buffer {
  const bytes = Buffer.from(document.base64, "base64");
  if (bytes.length < 8 || bytes.length > 5 * 1024 * 1024
    || bytes.toString("base64") !== document.base64
    || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    bytes.fill(0);
    throw new Error("Invalid PDF upload");
  }
  return bytes;
}

async function putOrVerify(vault: OnboardingDeps["vault"], candidateId: string,
  artifactId: string, plaintext: Buffer): Promise<void> {
  try {
    await vault.put(candidateId, artifactId, plaintext);
  } catch (error) {
    // A retry may encounter an earlier successful write. It must contain exactly
    // the same bytes; never overwrite an artifact under another request's ID.
    let existing: Buffer;
    try { existing = await vault.read(candidateId, artifactId); }
    catch { throw error; }
    try {
      if (existing.length !== plaintext.length || !existing.equals(plaintext)) {
        throw new Error("Submission ID was already used for different content");
      }
    } finally { existing.fill(0); }
  }
}

export async function saveCandidateOnboarding(subjectId: string,
  input: unknown, deps: OnboardingDeps): Promise<{ candidateId: string; artifactId: string }> {
  const submission = onboardingSubmissionSchema.parse(input);
  const candidateId = deps.candidateIdForSubject(subjectId);
  const artifactId = submission.submissionId;
  if (await deps.markers.isDeleted(candidateId)) throw new Error("Candidate account unavailable");
  const digest = createHash("sha256").update(JSON.stringify(submission)).digest("hex");
  const prior = await deps.markers.get(candidateId, artifactId);
  if (prior && prior.subjectId !== subjectId) throw new Error("Candidate account unavailable");
  if (prior && prior.digest !== digest) throw new Error("Submission ID was already used for different content");
  if (prior?.status === "verified") return { candidateId, artifactId };
  const resumeId = derivedId(artifactId, "master-resume");
  const transcriptId = submission.transcript ? derivedId(artifactId, "transcript") : undefined;
  const resume = decodePdf(submission.masterResume);
  let transcript: Buffer | undefined;
  try { transcript = submission.transcript ? decodePdf(submission.transcript) : undefined; }
  catch (error) { resume.fill(0); throw error; }
  if (resume.length + (transcript?.length ?? 0) > 5 * 1024 * 1024) {
    resume.fill(0); transcript?.fill(0);
    throw new Error("PDF uploads exceed the combined size limit");
  }
  const profile = Buffer.from(JSON.stringify({
    version: 1, provenance: "candidate-entered-and-reviewed", candidateId,
    careerStage: submission.careerStage, targetRoles: submission.targetRoles,
    locations: submission.locations, schoolOrEmployer: submission.schoolOrEmployer,
    graduationOrExperience: submission.graduationOrExperience,
    workAuthorization: submission.workAuthorization,
    sponsorshipRequiredNowOrFuture: submission.sponsorshipRequiredNowOrFuture,
    masterResume: { artifactId: resumeId, name: submission.masterResume.name, mimeType: "application/pdf" },
    ...(transcriptId ? { transcript: { artifactId: transcriptId,
      name: submission.transcript!.name, mimeType: "application/pdf" } } : {}),
    consent: { storage: true, automation: true, reviewed: true },
  }), "utf8");
  let leaseId: string | undefined;
  try {
    leaseId = await deps.markers.beginUpload(candidateId, artifactId, subjectId);
    if (!prior) await deps.markers.createPending(candidateId, artifactId, subjectId, digest);
    await putOrVerify(deps.vault, candidateId, resumeId, resume);
    if (transcript && transcriptId) await putOrVerify(deps.vault, candidateId, transcriptId, transcript);
    await putOrVerify(deps.vault, candidateId, artifactId, profile);
    // Run creation trusts only this verified marker, never a partial upload.
    if (await deps.markers.isDeleted(candidateId)) throw new Error("Candidate account unavailable");
    await deps.markers.markVerified(candidateId, artifactId, subjectId);
    return { candidateId, artifactId };
  } finally {
    resume.fill(0); transcript?.fill(0); profile.fill(0);
    if (leaseId) await deps.markers.endUpload(candidateId, artifactId, leaseId);
  }
}
