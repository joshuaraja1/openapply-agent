import { randomUUID } from "node:crypto";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

const uuid = z.uuid().refine(value => value === value.toLowerCase());

/** Reserve a conservative lifetime before STS is called. A deletion tombstone
 * and this row commit atomically, so a grant cannot escape the deletion wait. */
export class DynamoArtifactGrantFence {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string) {
    if (!tableName.trim()) throw new Error("Run ledger table is required");
  }

  async reserve(candidateId: string, runId: string, leaseToken: string,
    nowEpoch: number): Promise<void> {
    const pk = `CANDIDATE#${uuid.parse(candidateId)}`;
    const run = uuid.parse(runId);
    const owner = uuid.parse(leaseToken);
    if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) throw new Error("Invalid grant clock");
    const expiresAt = nowEpoch + 960; // STS 900s + Lambda/clock/propagation margin.
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName,
        Key: { pk, sk: "DELETED" }, ConditionExpression: "attribute_not_exists(pk)" } },
      { ConditionCheck: { TableName: this.tableName, Key: { pk, sk: "LEASE" },
        ConditionExpression: "ownerToken = :owner AND runId = :run AND expiresAt > :now",
        ExpressionAttributeValues: { ":owner": owner, ":run": run, ":now": nowEpoch } } },
      { Put: { TableName: this.tableName,
        Item: { pk, sk: `GRANT#${randomUUID()}`, expiresAt },
        ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  }
}
