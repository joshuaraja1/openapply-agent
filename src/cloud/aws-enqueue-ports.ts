import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { decodeCloudRunEnvelope, encodeCloudRunEnvelope } from "./run-envelope.js";
import type { CloudRunRecord } from "./queued-run.js";
import { officialJobKey, runConsentKey } from "./durable-journal.js";

const uuid = z.uuid();
const jobPart = z.string().trim().min(1).max(200);
const runRow = z.object({
  pk: z.string(), sk: z.string(), candidateId: uuid, runId: uuid,
  subjectId: z.string().trim().min(1).max(128),
  consentVersion: z.number().int().positive(),
  profileArtifactId: uuid,
  job: z.object({ provider: jobPart, employerId: jobPart,
    requisitionId: jobPart }),
});
const consentRow = z.object({
  pk: z.string(), sk: z.string().startsWith("CONSENT#"), runId: uuid,
  version: z.number().int().positive(), state: z.literal("granted"),
});
const leaseRow = z.object({ pk: z.string(), sk: z.literal("LEASE"),
  ownerToken: uuid, runId: uuid, expiresAt: z.number().int().positive() });
const submissionRow = z.object({ pk: z.string(), sk: z.string(),
  state: z.literal("submit_intent"), ownerToken: uuid, runId: uuid });

function keys(candidateId: string, runId: string) {
  return { pk: `CANDIDATE#${uuid.parse(candidateId).toLowerCase()}`,
    sk: `RUN#${uuid.parse(runId).toLowerCase()}` };
}

/** Reads metadata written by the trusted run creator, never browser-supplied
 * claims. A missing or malformed row cannot authorize a queue message. */
export class DynamoHostedRunAdmission {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string) {
    if (!tableName.trim()) throw new Error("Run ledger table is required");
  }

  private async readRun(candidateId: string, runId: string) {
    const key = keys(candidateId, runId);
    const result = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: key, ConsistentRead: true }));
    if (!result.Item) return undefined;
    const parsed = runRow.parse(result.Item);
    if (parsed.pk !== key.pk || parsed.sk !== key.sk
      || parsed.candidateId !== uuid.parse(candidateId).toLowerCase()
      || parsed.runId !== uuid.parse(runId).toLowerCase()) throw new Error("Run key mismatch");
    return parsed;
  }

  async ownsRun(candidateId: string, runId: string): Promise<boolean> {
    return (await this.readRun(candidateId, runId)) !== undefined;
  }

  async loadIdentity(candidateId: string, runId: string): Promise<CloudRunRecord> {
    const row = await this.readRun(candidateId, runId);
    if (!row) throw new Error("Run unavailable");
    return { subjectId: row.subjectId, consentVersion: row.consentVersion,
      job: row.job };
  }

  async loadProfileArtifactId(candidateId: string, runId: string): Promise<string> {
    const row = await this.readRun(candidateId, runId);
    if (!row) throw new Error("Run unavailable");
    return row.profileArtifactId;
  }

  async hasCurrentConsent(candidateId: string, runId: string): Promise<boolean> {
    const key = keys(candidateId, runId);
    const deleted = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk: key.pk, sk: "DELETED" }, ConsistentRead: true }));
    if (deleted.Item) return false;
    const run = await this.readRun(candidateId, runId);
    if (!run) return false;
    const consent = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk: key.pk, sk: runConsentKey(runId) }, ConsistentRead: true }));
    if (!consent.Item) return false;
    const parsed = consentRow.safeParse(consent.Item);
    return parsed.success && parsed.data.pk === key.pk
      && parsed.data.sk === runConsentKey(runId)
      && parsed.data.runId.toLowerCase() === uuid.parse(runId).toLowerCase()
      && parsed.data.version === run.consentVersion;
  }

  /** Strongly consistent lease and terminal-state fence. This is checked again
   * immediately before STS issuance; expiry/release/confirmed/uncertain fail closed. */
  async hasArtifactGrantEligibility(candidateId: string, runId: string,
    leaseToken: string, nowEpoch: number): Promise<boolean> {
    const key = keys(candidateId, runId);
    const token = uuid.parse(leaseToken).toLowerCase();
    if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0
      || !await this.hasCurrentConsent(candidateId, runId)) return false;
    const run = await this.readRun(candidateId, runId);
    if (!run) return false;
    const [leaseResult, submissionResult] = await Promise.all([
      this.db.send(new GetCommand({ TableName: this.tableName,
        Key: { pk: key.pk, sk: "LEASE" }, ConsistentRead: true })),
      this.db.send(new GetCommand({ TableName: this.tableName,
        Key: { pk: key.pk, sk: officialJobKey(run.job) }, ConsistentRead: true })),
    ]);
    const lease = leaseRow.safeParse(leaseResult.Item);
    if (!lease.success || lease.data.pk !== key.pk || lease.data.ownerToken !== token
      || lease.data.runId !== uuid.parse(runId).toLowerCase()
      || lease.data.expiresAt <= nowEpoch) return false;
    if (!submissionResult.Item) return true;
    const submission = submissionRow.safeParse(submissionResult.Item);
    return submission.success && submission.data.pk === key.pk
      && submission.data.sk === officialJobKey(run.job)
      && submission.data.ownerToken === token
      && submission.data.runId === uuid.parse(runId).toLowerCase();
  }
}

/** SQS FIFO carries opaque IDs only. The durable journal handles redelivery
 * after the FIFO five-minute deduplication window. */
export class SqsApplicationQueueSender {
  constructor(private readonly sqs: Pick<SQSClient, "send">,
    private readonly queueUrl: string) {
    const url = new URL(queueUrl);
    if (url.protocol !== "https:" || !/^sqs\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
      || !/^\/\d{12}\/openapply-[a-z0-9-]+-application\.fifo$/.test(url.pathname)
      || url.search || url.hash) throw new Error("Invalid application queue URL");
  }

  async send(message: { body: string; groupId: string; deduplicationId: string }) {
    let expected: ReturnType<typeof encodeCloudRunEnvelope>;
    try {
      const decoded = decodeCloudRunEnvelope(message.body);
      if (decoded.kind !== "apply") throw new Error("Not an application run");
      expected = encodeCloudRunEnvelope(decoded);
    } catch {
      throw new Error("Invalid application queue envelope");
    }
    if (message.body !== expected.body || message.groupId !== expected.groupId
      || message.deduplicationId !== expected.deduplicationId) {
      throw new Error("Invalid application queue envelope");
    }
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl,
      MessageBody: message.body, MessageGroupId: message.groupId,
      MessageDeduplicationId: message.deduplicationId }));
  }
}
