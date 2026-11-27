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
          deletionIndexPk: "PENDING", deletionDue: notBeforeEpoch,
          requestedAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)" }));
      return { state: "pending", subjectId, notBeforeEpoch };
    } catch (error) { if (!conditional(error)) throw error; }
    const existing = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: marker, ConsistentRead: true }));
    let row = existing.Item;
    // The earlier durable journal wrote a minimal DELETED marker. The
    // authenticated route derives this candidate key from the verified subject,
    // so it can safely adopt that marker without clearing the deletion barrier.
    if (row?.pk === marker.pk && row.sk === marker.sk
      && !Object.hasOwn(row, "subjectId") && !Object.hasOwn(row, "state")
      && typeof row.deletedAt === "string"
      && !Number.isNaN(Date.parse(row.deletedAt))) {
      try {
        await this.db.send(new UpdateCommand({ TableName: this.tableName, Key: marker,
          UpdateExpression: "SET candidateId = :candidate, subjectId = :subject, #state = :pending, notBeforeEpoch = :notBefore, deletionIndexPk = :indexPk, deletionDue = :notBefore, requestedAt = :requestedAt",
          ConditionExpression: "attribute_exists(pk) AND attribute_exists(deletedAt) AND attribute_not_exists(subjectId) AND attribute_not_exists(#state)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":candidate": candidateId, ":subject": subjectId,
            ":pending": "pending", ":notBefore": notBeforeEpoch, ":indexPk": "PENDING",
            ":requestedAt": new Date().toISOString() } }));
        return { state: "pending", subjectId, notBeforeEpoch };
      } catch (error) {
        if (!conditional(error)) throw error;
        // Another request may have adopted it first. Read its owner/state.
        row = (await this.db.send(new GetCommand({ TableName: this.tableName,
          Key: marker, ConsistentRead: true }))).Item;
      }
    }
    if (!row || row.pk !== marker.pk || row.sk !== marker.sk || row.candidateId !== candidateId
      || row.subjectId !== subjectId || (row.state !== "pending" && row.state !== "complete")
      || !Number.isSafeInteger(row.notBeforeEpoch)) throw new Error("Invalid deletion marker");
    return { state: row.state, subjectId, notBeforeEpoch: row.notBeforeEpoch };
  }

  async status(candidateId: string, subjectId: string): Promise<"none" | "pending" | "complete"> {
    const row = (await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: key(candidateId), ConsistentRead: true }))).Item;
    if (!row) return "none";
    if (row.pk !== key(candidateId).pk || row.sk !== "DELETED"
      || row.subjectId !== subjectId || (row.state !== "pending" && row.state !== "complete")) {
      // A legacy or malformed tombstone remains a write barrier, but cannot
      // be described to the candidate as a completed purge.
      return "pending";
    }
    return row.state;
  }

  async due(nowEpoch: number, limit: number): Promise<{
    rows: Array<{ candidateId: string; subjectId: string }>; malformed: number;
  }> {
    const rows: Array<{ candidateId: string; subjectId: string }> = [];
    const malformedKeys: Array<{ pk: string; sk: string }> = [];
    let cursor: Record<string, unknown> | undefined;
    const pageSize = Math.min(Math.max(limit, 1), 25);
    for (let page = 0; page < 4 && rows.length < pageSize; page++) {
      const result = await this.db.send(new QueryCommand({ TableName: this.tableName,
        IndexName: "DeletionDueIndex",
        KeyConditionExpression: "deletionIndexPk = :pending AND deletionDue <= :now",
        ExpressionAttributeValues: { ":pending": "PENDING", ":now": nowEpoch },
        Limit: pageSize, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const row of result.Items ?? []) {
        if (row.sk === "DELETED" && typeof row.candidateId === "string"
          && typeof row.subjectId === "string" && row.subjectId.length > 0
          && row.pk === `CANDIDATE#${row.candidateId}` && row.state === "pending") {
          if (rows.length < pageSize) rows.push({ candidateId: row.candidateId, subjectId: row.subjectId });
        } else if (typeof row.pk === "string" && typeof row.sk === "string") {
          malformedKeys.push({ pk: row.pk, sk: row.sk });
        } else {
          // DynamoDB always projects base-table keys into a GSI. If that
          // invariant fails, surface an error rather than silently skipping.
          throw new Error("Deletion retry index row has no table key");
        }
      }
      if (!result.LastEvaluatedKey) break;
      cursor = result.LastEvaluatedKey;
    }
    // Preserve malformed rows for repair, but move them out of the immediate
    // due window. A finite corrupt backlog cannot starve valid deletions.
    for (const marker of malformedKeys) {
      try {
        await this.db.send(new UpdateCommand({ TableName: this.tableName, Key: marker,
          UpdateExpression: "SET deletionDue = :later, deletionRetryError = :reason",
          ConditionExpression: "deletionIndexPk = :pending AND deletionDue <= :now",
          ExpressionAttributeValues: { ":later": nowEpoch + 3600, ":reason": "invalid-marker",
            ":pending": "PENDING", ":now": nowEpoch } }));
      } catch (error) { if (!conditional(error)) throw error; }
    }
    return { rows, malformed: malformedKeys.length };
  }

  async defer(candidateId: string, subjectId: string, nextEpoch: number): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tableName, Key: key(candidateId),
        UpdateExpression: "SET deletionDue = :next",
        ConditionExpression: "#state = :pending AND subjectId = :subject AND deletionIndexPk = :indexPk AND deletionDue < :next",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":pending": "pending", ":subject": subjectId,
          ":indexPk": "PENDING", ":next": nextEpoch } }));
    } catch (error) { if (!conditional(error)) throw error; }
  }

  async hasActiveWriters(candidateId: string, nowEpoch: number): Promise<boolean> {
    const pk = key(candidateId).pk;
    const worker = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk, sk: "LEASE" }, ConsistentRead: true }));
    if (worker.Item && (!Number.isSafeInteger(worker.Item.expiresAt)
      || worker.Item.expiresAt >= nowEpoch)) return true;
    for (const prefix of ["UPLOAD#", "GRANT#"]) {
      let cursor: Record<string, unknown> | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await this.db.send(new QueryCommand({ TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ConsistentRead: true, Limit: 100,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        if ((result.Items ?? []).some(item => !Number.isSafeInteger(item.expiresAt)
          || item.expiresAt >= nowEpoch)) return true;
        if (!result.LastEvaluatedKey) break;
        cursor = result.LastEvaluatedKey;
        if (page === 99) return true; // Cannot prove all credentials expired.
      }
    }
    return false;
  }

  async hasUnstoppedTasks(candidateId: string): Promise<boolean> {
    const pk = key(candidateId).pk;
    let cursor: Record<string, unknown> | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.db.send(new QueryCommand({ TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "TASK#" },
        ConsistentRead: true, Limit: 100,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      if ((result.Items ?? []).some(row => row.state !== "stopped")) return true;
      if (!result.LastEvaluatedKey) return false;
      cursor = result.LastEvaluatedKey;
    }
    return true; // An unbounded registry cannot prove every task has stopped.
  }

  async claimPurge(candidateId: string, subjectId: string, nowEpoch: number,
    owner: string): Promise<boolean> {
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tableName,
        Key: key(candidateId),
        UpdateExpression: "SET purgeOwner = :owner, purgeLeaseUntil = :until",
        ConditionExpression: "#state = :pending AND subjectId = :subject AND (attribute_not_exists(purgeLeaseUntil) OR purgeLeaseUntil < :now)",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":pending": "pending", ":subject": subjectId,
          ":owner": owner, ":until": nowEpoch + 120, ":now": nowEpoch } }));
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }

  async releasePurge(candidateId: string, subjectId: string, owner: string): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tableName,
        Key: key(candidateId),
        UpdateExpression: "REMOVE purgeOwner, purgeLeaseUntil",
        ConditionExpression: "subjectId = :subject AND purgeOwner = :owner",
        ExpressionAttributeValues: { ":subject": subjectId, ":owner": owner } }));
    } catch (error) {
      if (!conditional(error)) throw error;
    }
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
      UpdateExpression: "SET #state = :complete, completedAt = :completedAt REMOVE deletionIndexPk, deletionDue",
      ConditionExpression: "#state = :pending AND subjectId = :subjectId",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":pending": "pending", ":complete": "complete",
        ":subjectId": subjectId, ":completedAt": new Date().toISOString() } }));
  }
}
