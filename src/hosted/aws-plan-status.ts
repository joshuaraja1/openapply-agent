import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { hostedEntitlementSchema } from "./entitlement.js";

/** Narrow read of the reconciler's trusted entitlement table. */
export class DynamoCandidatePlanStatus {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string) {
    if (!tableName.trim()) throw new Error("Entitlement table is required");
  }

  async loadEntitlements(subjectId: string): Promise<readonly unknown[]> {
    const records: unknown[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(new QueryCommand({ TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `SUBJECT#${subjectId}`, ":prefix": "ENTITLEMENT#" },
        ConsistentRead: true, Limit: 50,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const item of page.Items ?? []) {
        if (item.pk !== `SUBJECT#${subjectId}` || typeof item.sk !== "string"
          || !item.sk.startsWith("ENTITLEMENT#")) throw new Error("Invalid entitlement row");
        const record = hostedEntitlementSchema.parse(item.record);
        if (record.subjectId !== subjectId) throw new Error("Entitlement subject mismatch");
        records.push(record);
        if (records.length > 200) throw new Error("Too many entitlement records");
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return records;
  }
}
