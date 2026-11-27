import { createHash, randomUUID } from "node:crypto";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand,
  TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

const uuid = z.uuid();
const jobPart = z.string().trim().min(1).max(200);
const officialJobSchema = z.strictObject({
  provider: jobPart,
  employerId: jobPart,
  requisitionId: jobPart,
});

export type OfficialJobIdentity = z.input<typeof officialJobSchema>;
export type SubmissionStatus = "not_started" | "needs_reconciliation" | "confirmed";
export type SubmissionRecord = { status: SubmissionStatus; receiptArtifactId?: string };

function consentEpoch(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Consent version must be a positive integer");
  return version;
}

/** Each application run keeps its own revocable consent. */
export function runConsentKey(runId: string): string {
  return `CONSENT#${uuid.parse(runId).toLowerCase()}`;
}

/** Call only after the posting and requisition have been verified at the employer. */
export function officialJobKey(identity: OfficialJobIdentity): string {
  const value = officialJobSchema.parse(identity);
  return `JOB#${createHash("sha256").update(JSON.stringify([
    value.provider.toLowerCase(), value.employerId.toLowerCase(), value.requisitionId.toLowerCase(),
  ])).digest("hex")}`;
}

function conditionalFailure(error: unknown): boolean {
  const value = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
  if (value?.name === "ConditionalCheckFailedException") return true;
  if (value?.name !== "TransactionCanceledException" || !Array.isArray(value.CancellationReasons)) return false;
  const codes = value.CancellationReasons.map((reason) => reason.Code);
  return codes.includes("ConditionalCheckFailed")
    && codes.every((code) => code === "ConditionalCheckFailed" || code === "None");
}

/**
 * DynamoDB's lease TTL is advisory; every mutation checks expiry synchronously.
 * Submission records deliberately have no TTL. A crash after intent is written
 * must go to receipt reconciliation, never to another automatic Submit click.
 */
export class DurableApplicationJournal {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!tableName.trim()) throw new Error("Run ledger table is required");
  }

  private candidateKey(candidateId: string): string {
    return `CANDIDATE#${uuid.parse(candidateId).toLowerCase()}`;
  }

  /** The authenticated consent service alone should call this after recording a user's grant. */
  async grantConsent(candidateId: string, runId: string, version: number): Promise<boolean> {
    const pk = this.candidateKey(candidateId);
    const canonicalRunId = uuid.parse(runId).toLowerCase();
    const epoch = consentEpoch(version);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: {
          TableName: this.tableName, Key: { pk, sk: runConsentKey(canonicalRunId) },
          UpdateExpression: "SET runId = :runId, version = :version, #state = :granted, updatedAt = :time",
          ConditionExpression: "attribute_not_exists(version) OR version < :version",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":runId": canonicalRunId, ":version": epoch,
            ":granted": "granted", ":time": new Date(this.now()).toISOString() },
        } },
      ] }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async revokeConsent(candidateId: string, runId: string, version: number): Promise<boolean> {
    const pk = this.candidateKey(candidateId);
    const canonicalRunId = uuid.parse(runId).toLowerCase();
    const epoch = consentEpoch(version);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: {
          TableName: this.tableName, Key: { pk, sk: runConsentKey(canonicalRunId) },
          UpdateExpression: "SET #state = :revoked, updatedAt = :time",
          ConditionExpression: "version = :version AND #state = :granted",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":version": epoch, ":granted": "granted",
            ":revoked": "revoked", ":time": new Date(this.now()).toISOString() },
        } },
      ] }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async acquireLease(candidateId: string, runId: string, leaseSeconds = 120): Promise<string | null> {
    const pk = this.candidateKey(candidateId);
    const canonicalRunId = uuid.parse(runId).toLowerCase();
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw new Error("Lease must last 30 to 900 seconds");
    }
    const now = Math.floor(this.now() / 1000);
    const token = randomUUID();
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: {
          TableName: this.tableName,
          Item: { pk, sk: "LEASE", ownerToken: token, runId: canonicalRunId, expiresAt: now + leaseSeconds },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
          ExpressionAttributeValues: { ":now": now },
        } },
      ] }));
      return token;
    } catch (error) {
      if (conditionalFailure(error)) return null;
      throw error;
    }
  }

  async renewLease(candidateId: string, token: string, leaseSeconds = 120): Promise<boolean> {
    const pk = this.candidateKey(candidateId);
    uuid.parse(token);
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw new Error("Lease must last 30 to 900 seconds");
    }
    const now = Math.floor(this.now() / 1000);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: {
          TableName: this.tableName, Key: { pk, sk: "LEASE" },
          UpdateExpression: "SET expiresAt = :expiresAt",
          ConditionExpression: "ownerToken = :token AND expiresAt > :now",
          ExpressionAttributeValues: { ":expiresAt": now + leaseSeconds, ":token": token, ":now": now },
        } },
      ] }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async releaseLease(candidateId: string, token: string): Promise<void> {
    const pk = this.candidateKey(candidateId);
    uuid.parse(token);
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName, Key: { pk, sk: "LEASE" },
        ConditionExpression: "ownerToken = :token",
        ExpressionAttributeValues: { ":token": token },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  /** The returned artifact ID reserves exactly one final-click attempt and receipt slot. */
  async beginSubmission(candidateId: string, token: string, runId: string, consentVersion: number,
    job: OfficialJobIdentity): Promise<string | null> {
    const pk = this.candidateKey(candidateId);
    uuid.parse(token);
    const canonicalRunId = uuid.parse(runId).toLowerCase();
    const epoch = consentEpoch(consentVersion);
    const now = Math.floor(this.now() / 1000);
    const receiptArtifactId = randomUUID();
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { ConditionCheck: {
          TableName: this.tableName, Key: { pk, sk: runConsentKey(canonicalRunId) },
          ConditionExpression: "runId = :runId AND version = :version AND #state = :granted",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":runId": canonicalRunId, ":version": epoch, ":granted": "granted" },
        } },
        { ConditionCheck: {
          TableName: this.tableName, Key: { pk, sk: "LEASE" },
          ConditionExpression: "ownerToken = :token AND runId = :runId AND expiresAt > :now",
          ExpressionAttributeValues: { ":token": token, ":runId": canonicalRunId, ":now": now },
        } },
        { Put: {
          TableName: this.tableName,
          Item: { pk, sk: officialJobKey(job), state: "submit_intent", ownerToken: token,
            runId: canonicalRunId, consentVersion: epoch, receiptArtifactId,
            createdAt: new Date(this.now()).toISOString() },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
      ] }));
      return receiptArtifactId;
    } catch (error) {
      if (conditionalFailure(error)) return null;
      throw error;
    }
  }

  /** Use after a click failed ambiguously; no future worker may retry the click. */
  async markUncertain(candidateId: string, token: string, job: OfficialJobIdentity): Promise<void> {
    const pk = this.candidateKey(candidateId);
    uuid.parse(token);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: {
          TableName: this.tableName, Key: { pk, sk: officialJobKey(job) },
          UpdateExpression: "SET #state = :uncertain",
          ConditionExpression: "#state = :intent AND ownerToken = :token",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":uncertain": "uncertain", ":intent": "submit_intent", ":token": token },
        } },
      ] }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  /** Requires a fresh lease and an independently verified exact-job receipt. */
  async confirmAfterVerification(candidateId: string, token: string, job: OfficialJobIdentity,
    receipt: { artifactId: string; sha256: string }): Promise<boolean> {
    const pk = this.candidateKey(candidateId);
    uuid.parse(token);
    uuid.parse(receipt.artifactId);
    if (!/^[a-f0-9]{64}$/i.test(receipt.sha256)) throw new Error("Receipt digest must be SHA-256");
    const now = Math.floor(this.now() / 1000);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { ConditionCheck: {
          TableName: this.tableName, Key: { pk, sk: "LEASE" },
          ConditionExpression: "ownerToken = :token AND expiresAt > :now",
          ExpressionAttributeValues: { ":token": token, ":now": now },
        } },
        { Update: {
          TableName: this.tableName, Key: { pk, sk: officialJobKey(job) },
          UpdateExpression: "SET #state = :confirmed, receiptArtifactId = :artifact, receiptSha256 = :digest, confirmedAt = :time",
          ConditionExpression: "(#state = :intent OR #state = :uncertain) AND receiptArtifactId = :artifact AND attribute_not_exists(receiptSha256)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":confirmed": "confirmed", ":intent": "submit_intent",
            ":uncertain": "uncertain", ":artifact": receipt.artifactId, ":digest": receipt.sha256.toLowerCase(),
            ":time": new Date(this.now()).toISOString() },
        } },
      ] }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async readSubmission(candidateId: string, job: OfficialJobIdentity): Promise<SubmissionRecord> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { pk: this.candidateKey(candidateId), sk: officialJobKey(job) },
      ConsistentRead: true,
    }));
    if (!result.Item) return { status: "not_started" };
    const artifactId = uuid.parse(result.Item.receiptArtifactId);
    return { status: result.Item.state === "confirmed" ? "confirmed" : "needs_reconciliation",
      receiptArtifactId: artifactId };
  }

  async submissionStatus(candidateId: string, job: OfficialJobIdentity): Promise<SubmissionStatus> {
    return (await this.readSubmission(candidateId, job)).status;
  }

  /** Write before deleting candidate records; old SQS messages can no longer obtain a lease. */
  async tombstoneCandidate(candidateId: string): Promise<void> {
    const pk = this.candidateKey(candidateId);
    await this.client.send(new PutCommand({
      TableName: this.tableName, Item: { pk, sk: "DELETED", deletedAt: new Date(this.now()).toISOString() },
      ConditionExpression: "attribute_not_exists(pk)",
    })).catch((error: unknown) => {
      if (!conditionalFailure(error)) throw error;
    });
  }
}
