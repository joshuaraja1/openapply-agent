import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, TransactWriteCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { OnboardingMarkerStore } from "./candidate-onboarding.js";

export const UPLOAD_LEASE_SECONDS = 180;

/** A candidate's profile is usable only after all encrypted objects exist. */
export class DynamoOnboardingMarkers implements OnboardingMarkerStore {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string) {
    if (!tableName.trim()) throw new Error("Run ledger table is required");
  }

  async isDeleted(candidateId: string): Promise<boolean> {
    const result = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk: `CANDIDATE#${candidateId}`, sk: "DELETED" }, ConsistentRead: true }));
    return Boolean(result.Item);
  }

  async beginUpload(candidateId: string, artifactId: string, subjectId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const leaseId = randomUUID();
    const pk = `CANDIDATE#${candidateId}`;
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "DELETED" },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: this.tableName,
        Item: { pk, sk: `UPLOAD#${artifactId}`, artifactId, subjectId, leaseId,
          expiresAt: now + UPLOAD_LEASE_SECONDS },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": now } } },
    ] }));
    return leaseId;
  }

  async endUpload(candidateId: string, artifactId: string, leaseId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.tableName,
      Key: { pk: `CANDIDATE#${candidateId}`, sk: `UPLOAD#${artifactId}` },
      ConditionExpression: "leaseId = :leaseId",
      ExpressionAttributeValues: { ":leaseId": leaseId } }));
  }

  async get(candidateId: string, artifactId: string): Promise<{
    status: string; subjectId: string; digest: string } | null> {
    const result = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk: `CANDIDATE#${candidateId}`, sk: `PROFILE#${artifactId}` },
      ConsistentRead: true }));
    const item = result.Item;
    if (!item) return null;
    if ((item.status !== "pending" && item.status !== "verified")
      || typeof item.subjectId !== "string" || !/^[a-f0-9]{64}$/.test(item.digest)
      || item.candidateId !== candidateId
      || item.artifactId !== artifactId) throw new Error("Invalid profile marker");
    return { status: item.status, subjectId: item.subjectId, digest: item.digest };
  }

  async createPending(candidateId: string, artifactId: string, subjectId: string, digest: string): Promise<void> {
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName,
        Key: { pk: `CANDIDATE#${candidateId}`, sk: "DELETED" },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: this.tableName,
        Item: { pk: `CANDIDATE#${candidateId}`, sk: `PROFILE#${artifactId}`,
          status: "pending", candidateId, artifactId, subjectId, digest },
        ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  }

  async markVerified(candidateId: string, artifactId: string, subjectId: string,
    applicationProfileReady: boolean): Promise<void> {
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName,
        Key: { pk: `CANDIDATE#${candidateId}`, sk: "DELETED" },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: this.tableName,
        Key: { pk: `CANDIDATE#${candidateId}`, sk: `PROFILE#${artifactId}` },
        UpdateExpression: "SET #status = :verified, applicationProfileReady = :ready",
        ConditionExpression: "#status = :pending AND subjectId = :subjectId AND candidateId = :candidateId AND artifactId = :artifactId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":verified": "verified", ":pending": "pending",
          ":ready": applicationProfileReady,
          ":subjectId": subjectId, ":candidateId": candidateId, ":artifactId": artifactId } } },
    ] }));
  }
}
