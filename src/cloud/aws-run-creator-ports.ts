import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { artifactObjectKey, type CandidateVault } from "./candidate-vault.js";
import { officialJobKey, runConsentKey } from "./durable-journal.js";
import { RunConflictError, RunInputsUnavailableError,
  type TrustedRunRecord, type VerifiedCandidateProfile, type VerifiedOfficialLead } from "./hosted-run-creator.js";

const uuid = z.uuid();
const jobPart = z.string().trim().min(1).max(200);
const leadSchema = z.object({ pk: z.string(), sk: z.literal("VERIFIED"),
  status: z.literal("open"), leadId: uuid,
  job: z.object({ provider: jobPart, employerId: jobPart, requisitionId: jobPart }),
  jobKey: z.string().regex(/^JOB#[a-f0-9]{64}$/), canonicalUrl: z.url(),
  expiresAt: z.number().int().positive() });
const profileSchema = z.object({ pk: z.string(), sk: z.string().startsWith("PROFILE#"),
  status: z.literal("verified"), candidateId: uuid, artifactId: uuid,
  subjectId: z.string().min(1).max(160) });
const runSchema = z.object({ pk: z.string(), sk: z.string().startsWith("RUN#"),
  candidateId: uuid, runId: uuid, subjectId: z.string(), leadId: uuid,
  job: leadSchema.shape.job, jobKey: z.string(), profileArtifactId: uuid,
  consentVersion: z.literal(1), policyVersion: z.literal("v1"), createdAt: z.string() });
const consentSchema = z.object({ pk: z.string(), sk: z.string().startsWith("CONSENT#"),
  runId: uuid, version: z.literal(1), state: z.literal("granted"),
  scope: z.literal("apply-one-job"), policyVersion: z.literal("v1") });
const lowerUuid = uuid.refine(value => value === value.toLowerCase());
const documentSchema = z.object({ artifactId: lowerUuid,
  name: z.string().min(1).max(120).regex(/\.pdf$/i), mimeType: z.literal("application/pdf") });
const candidateProfileSchema = z.object({
  version: z.literal(1), provenance: z.literal("candidate-entered-and-reviewed"),
  candidateId: lowerUuid, masterResume: documentSchema,
  transcript: documentSchema.optional(),
  consent: z.object({ storage: z.literal(true), automation: z.literal(true),
    reviewed: z.literal(true) }),
});
const ENCRYPTED_CONTENT_TYPE = "application/vnd.openapply.encrypted+json";
const MAX_PROFILE_OBJECT_BYTES = 64 * 1024;
const MAX_PDF_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 5 * 1024 * 1024;

function conditional(error: unknown): boolean {
  const value = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
  return value?.name === "ConditionalCheckFailedException"
    || (value?.name === "TransactionCanceledException"
      && value.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed") === true);
}

/** Trusted writers must first create VERIFIED lead and PROFILE marker rows.
 * This service does not infer either from the browser's request. */
export class DynamoTrustedRunCreator {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly s3: Pick<S3Client, "send">,
    private readonly vault: Pick<CandidateVault, "read">,
    private readonly table: string, private readonly bucket: string) {
    if (!table || !bucket) throw new Error("Run creator storage is required");
  }

  async loadLead(leadId: string): Promise<VerifiedOfficialLead | undefined> {
    const id = uuid.parse(leadId).toLowerCase();
    const key = { pk: `LEAD#${id}`, sk: "VERIFIED" };
    const result = await this.db.send(new GetCommand({ TableName: this.table,
      Key: key, ConsistentRead: true }));
    if (!result.Item) return undefined;
    const parsed = leadSchema.safeParse(result.Item);
    if (!parsed.success) return undefined;
    const row = parsed.data;
    if (row.pk !== key.pk || row.leadId !== id || row.jobKey !== officialJobKey(row.job)) return undefined;
    return row;
  }

  async loadProfile(candidateId: string, artifactId: string): Promise<VerifiedCandidateProfile | undefined> {
    const key = { pk: `CANDIDATE#${uuid.parse(candidateId).toLowerCase()}`,
      sk: `PROFILE#${uuid.parse(artifactId).toLowerCase()}` };
    const result = await this.db.send(new GetCommand({ TableName: this.table,
      Key: key, ConsistentRead: true }));
    if (!result.Item) return undefined;
    const parsed = profileSchema.safeParse(result.Item);
    if (!parsed.success) return undefined;
    const row = parsed.data;
    if (row.pk !== key.pk || row.sk !== key.sk) return undefined;
    return row;
  }

  private async artifactExists(candidateId: string, artifactId: string,
    maxBytes: number): Promise<boolean> {
    try {
      const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket,
        Key: artifactObjectKey(candidateId, artifactId) }));
      return result.ContentType === ENCRYPTED_CONTENT_TYPE
        && Number.isSafeInteger(result.ContentLength)
        && result.ContentLength! > 0 && result.ContentLength! <= maxBytes;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw error;
    }
  }

  /** The verified marker is only eligible when its encrypted profile and every
   * referenced PDF still exist under the same candidate and decrypt correctly. */
  async profileArtifactsAvailable(candidateId: string, artifactId: string): Promise<boolean> {
    if (!await this.artifactExists(candidateId, artifactId, MAX_PROFILE_OBJECT_BYTES)) return false;
    let plaintext: Buffer;
    try { plaintext = await this.vault.read(candidateId, artifactId); }
    catch { return false; }
    let profile: z.infer<typeof candidateProfileSchema>;
    try {
      if (plaintext.byteLength > MAX_PROFILE_OBJECT_BYTES) return false;
      const parsed = candidateProfileSchema.safeParse(JSON.parse(plaintext.toString("utf8")));
      if (!parsed.success) return false;
      profile = parsed.data;
    } catch { return false; }
    finally { plaintext.fill(0); }
    if (profile.candidateId !== candidateId
      || profile.masterResume.artifactId === artifactId
      || profile.transcript?.artifactId === artifactId
      || profile.masterResume.artifactId === profile.transcript?.artifactId) return false;
    const documents = [profile.masterResume, ...(profile.transcript ? [profile.transcript] : [])];
    for (const document of documents) {
      if (!await this.artifactExists(candidateId, document.artifactId, MAX_PDF_OBJECT_BYTES)) return false;
      let pdf: Buffer;
      try { pdf = await this.vault.read(candidateId, document.artifactId); }
      catch { return false; }
      try {
        if (pdf.byteLength < 8 || pdf.byteLength > MAX_PDF_BYTES
          || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") return false;
      } finally { pdf.fill(0); }
    }
    return true;
  }

  async createOrGet(record: TrustedRunRecord, lead: VerifiedOfficialLead,
    nowEpoch: number): Promise<"created" | "existing"> {
    const pk = `CANDIDATE#${uuid.parse(record.candidateId).toLowerCase()}`;
    const runKey = { pk, sk: `RUN#${record.runId}` };
    const consentKey = { pk, sk: runConsentKey(record.runId) };
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.table, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { ConditionCheck: { TableName: this.table,
          Key: { pk: `LEAD#${lead.leadId}`, sk: "VERIFIED" },
          ConditionExpression: "#status = :open AND expiresAt > :now AND jobKey = :jobKey",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":open": "open", ":now": nowEpoch,
            ":jobKey": record.jobKey } } },
        { ConditionCheck: { TableName: this.table,
          Key: { pk, sk: `PROFILE#${record.profileArtifactId}` },
          ConditionExpression: "#status = :verified AND subjectId = :subject AND candidateId = :candidate AND artifactId = :artifact",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":verified": "verified", ":subject": record.subjectId,
            ":candidate": record.candidateId, ":artifact": record.profileArtifactId } } },
        { Put: { TableName: this.table, Item: { ...runKey, ...record },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.table,
          Item: { ...consentKey, runId: record.runId, version: 1, state: "granted",
            scope: "apply-one-job", policyVersion: record.policyVersion,
            grantedAt: record.createdAt, subjectId: record.subjectId,
            leadId: record.leadId },
          ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
      return "created";
    } catch (error) {
      if (!conditional(error)) throw error;
      // A concurrent request may have committed. Confirm both immutable rows
      // before treating this as a safe idempotent retry.
      const [run, consent, deleted] = await Promise.all([
        this.db.send(new GetCommand({ TableName: this.table, Key: runKey, ConsistentRead: true })),
        this.db.send(new GetCommand({ TableName: this.table, Key: consentKey, ConsistentRead: true })),
        this.db.send(new GetCommand({ TableName: this.table,
          Key: { pk, sk: "DELETED" }, ConsistentRead: true })),
      ]);
      if (deleted.Item) throw new RunInputsUnavailableError("Candidate deleted");
      const existing = runSchema.safeParse(run.Item);
      const grant = consentSchema.safeParse(consent.Item);
      const same = existing.success && grant.success
        && existing.data.pk === runKey.pk && existing.data.sk === runKey.sk
        && grant.data.pk === consentKey.pk && grant.data.sk === consentKey.sk
        && grant.data.runId === record.runId
        && ["candidateId", "runId", "subjectId", "leadId", "jobKey", "profileArtifactId",
          "consentVersion", "policyVersion"].every(key =>
          (existing.data as Record<string, unknown>)[key] === (record as unknown as Record<string, unknown>)[key])
        && existing.data.job.provider === record.job.provider
        && existing.data.job.employerId === record.job.employerId
        && existing.data.job.requisitionId === record.job.requisitionId
        && grant.data.policyVersion === record.policyVersion;
      if (same) return "existing";
      if (run.Item || consent.Item) throw new RunConflictError("Run ID already used");
      throw new RunInputsUnavailableError("Verified application inputs unavailable");
    }
  }
}
