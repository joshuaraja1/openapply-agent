import { GetCommand, TransactWriteCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { OnboardingMarkerStore } from "./candidate-onboarding.js";

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

  async markVerified(candidateId: string, artifactId: string, subjectId: string): Promise<void> {
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName,
        Key: { pk: `CANDIDATE#${candidateId}`, sk: "DELETED" },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: this.tableName,
        Key: { pk: `CANDIDATE#${candidateId}`, sk: `PROFILE#${artifactId}` },
        UpdateExpression: "SET #status = :verified",
        ConditionExpression: "#status = :pending AND subjectId = :subjectId AND candidateId = :candidateId AND artifactId = :artifactId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":verified": "verified", ":pending": "pending",
          ":subjectId": subjectId, ":candidateId": candidateId, ":artifactId": artifactId } } },
    ] }));
  }
}
