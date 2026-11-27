import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CandidateDeletionStore, DeletionRecord } from "./candidate-deletion.js";

function conditional(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";
}

function key(candidateId: string) { return { pk: `CANDIDATE#${candidateId}`, sk: "DELETED" }; }

/** A tombstone is retained after purge so stale tokens and messages cannot
 * recreate private state. Every read used for deletion is strongly consistent. */
export class DynamoCandidateDeletionStore implements CandidateDeletionStore {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string) {
    if (!tableName.trim()) throw new Error("Run ledger table is required");
  }

  async begin(candidateId: string, subjectId: string, notBeforeEpoch: number): Promise<DeletionRecord> {
    const marker = key(candidateId);
    try {
      await this.db.send(new PutCommand({ TableName: this.tableName,
        Item: { ...marker, candidateId, subjectId, state: "pending", notBeforeEpoch,
          requestedAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)" }));
      return { state: "pending", subjectId, notBeforeEpoch };
    } catch (error) { if (!conditional(error)) throw error; }
    const existing = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: marker, ConsistentRead: true }));
    const row = existing.Item;
    if (!row || row.pk !== marker.pk || row.sk !== marker.sk || row.candidateId !== candidateId
      || row.subjectId !== subjectId || (row.state !== "pending" && row.state !== "complete")
      || !Number.isSafeInteger(row.notBeforeEpoch)) throw new Error("Invalid deletion marker");
    return { state: row.state, subjectId, notBeforeEpoch: row.notBeforeEpoch };
  }

  async hasActiveWriters(candidateId: string, nowEpoch: number): Promise<boolean> {
    const pk = key(candidateId).pk;
    const worker = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk, sk: "LEASE" }, ConsistentRead: true }));
    if (worker.Item && (!Number.isSafeInteger(worker.Item.expiresAt)
      || worker.Item.expiresAt >= nowEpoch)) return true;
    let cursor: Record<string, unknown> | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.db.send(new QueryCommand({ TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "UPLOAD#" },
        ConsistentRead: true, Limit: 100,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      if ((result.Items ?? []).some(item => !Number.isSafeInteger(item.expiresAt)
        || item.expiresAt >= nowEpoch)) return true;
      if (!result.LastEvaluatedKey) return false;
      cursor = result.LastEvaluatedKey;
    }
    return true; // Bounded scan cannot prove all writers stopped.
  }

  async purgeMetadata(candidateId: string): Promise<boolean> {
    const pk = key(candidateId).pk;
    for (let batch = 0; batch < 20; batch++) {
      const result = await this.db.send(new QueryCommand({ TableName: this.tableName,
        KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
        ConsistentRead: true, Limit: 100 }));
      const rows = result.Items ?? [];
      const removable = rows.filter(row => row.sk !== "DELETED");
      if (removable.length === 0 && !result.LastEvaluatedKey) return true;
      if (removable.length === 0) throw new Error("Candidate ledger purge made no progress");
      for (const row of removable) {
        if (row.pk !== pk || typeof row.sk !== "string" || !row.sk) {
          throw new Error("Invalid candidate ledger key");
        }
        await this.db.send(new DeleteCommand({ TableName: this.tableName,
          Key: { pk, sk: row.sk } }));
      }
    }
    return false;
  }

  async markComplete(candidateId: string, subjectId: string): Promise<void> {
    await this.db.send(new UpdateCommand({ TableName: this.tableName, Key: key(candidateId),
      UpdateExpression: "SET #state = :complete, completedAt = :completedAt",
      ConditionExpression: "#state = :pending AND subjectId = :subjectId",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":pending": "pending", ":complete": "complete",
        ":subjectId": subjectId, ":completedAt": new Date().toISOString() } }));
  }
}
