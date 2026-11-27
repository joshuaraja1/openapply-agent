import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { decodeCloudRunEnvelope, encodeCloudRunEnvelope } from "./run-envelope.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const rowSchema = z.object({ pk: z.string(), sk: z.string(),
  candidateId: uuid, runId: uuid,
  state: z.enum(["pending_queue", "queued", "launched", "blocked", "needs_reconciliation"]),
  body: z.string().max(1024), groupId: uuid,
  deduplicationId: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
});
export type DurableDispatchRecord = z.infer<typeof rowSchema>;

function key(candidateId: string, runId: string) {
  return { pk: `CANDIDATE#${uuid.parse(candidateId)}`,
    sk: `DISPATCH#${uuid.parse(runId)}` };
}

/** An outbox written before SQS send closes the send-to-launch crash gap.
 * The scheduler may resend the same FIFO envelope after its deduplication
 * window; the durable submission journal still prevents another Submit. */
export class DynamoApplicationDispatchStore {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string) {
    if (table !== "openapply-staging-run-ledger") throw new Error("Invalid dispatch ledger");
  }

  async read(candidateId: string, runId: string): Promise<DurableDispatchRecord | undefined> {
    const expected = key(candidateId, runId);
    const item = (await this.db.send(new GetCommand({ TableName: this.table,
      Key: expected, ConsistentRead: true }))).Item;
    if (!item) return undefined;
    const row = rowSchema.parse(item);
    if (row.pk !== expected.pk || row.sk !== expected.sk) throw new Error("Dispatch key mismatch");
    const envelope = decodeCloudRunEnvelope(row.body);
    const encoded = encodeCloudRunEnvelope(envelope);
    if (envelope.kind !== "apply" || envelope.candidateId !== candidateId
      || envelope.runId !== runId || row.groupId !== encoded.groupId
      || row.deduplicationId !== encoded.deduplicationId) {
      throw new Error("Dispatch envelope mismatch");
    }
    return row;
  }

  async ensurePending(candidateId: string, runId: string,
    envelope: ReturnType<typeof encodeCloudRunEnvelope>): Promise<DurableDispatchRecord> {
    const id = key(candidateId, runId);
    const parsed = decodeCloudRunEnvelope(envelope.body);
    if (parsed.kind !== "apply" || parsed.candidateId !== candidateId
      || parsed.runId !== runId || envelope.groupId !== candidateId
      || envelope.deduplicationId !== encodeCloudRunEnvelope(parsed).deduplicationId) {
      throw new Error("Invalid dispatch envelope");
    }
    const row = rowSchema.parse({ ...id, candidateId, runId,
      state: "pending_queue", body: envelope.body, groupId: envelope.groupId,
      deduplicationId: envelope.deduplicationId, createdAt: parsed.scheduledAt });
    const existing = await this.read(candidateId, runId);
    if (existing) return existing;
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.table, Key: { pk: id.pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.table, Item: { ...row,
          gsi1pk: "APPLICATION_DISPATCH", gsi1sk: `${row.createdAt}#${candidateId}#${runId}` },
          ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
      return row;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name !== "TransactionCanceledException" && name !== "ConditionalCheckFailedException") throw error;
      const raced = await this.read(candidateId, runId);
      if (!raced) throw new Error("Dispatch unavailable or candidate deleted");
      return raced;
    }
  }

  async markQueued(candidateId: string, runId: string): Promise<void> {
    const row = await this.read(candidateId, runId);
    if (row?.state === "queued" || row?.state === "launched") return;
    if (row?.state !== "pending_queue") throw new Error("Dispatch not pending");
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:queued",
      ConditionExpression: "#state=:pending",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":queued": "queued", ":pending": "pending_queue" } }));
  }

  async markLaunched(candidateId: string, runId: string): Promise<void> {
    const row = await this.read(candidateId, runId);
    if (row?.state === "launched") return;
    if (row?.state !== "queued") throw new Error("Dispatch not queued");
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:launched REMOVE gsi1pk, gsi1sk",
      ConditionExpression: "#state=:queued",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":launched": "launched", ":queued": "queued" } }));
  }

  async markBlocked(candidateId: string, runId: string): Promise<void> {
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:blocked REMOVE gsi1pk, gsi1sk",
      ConditionExpression: "#state IN (:pending, :queued)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":blocked": "blocked", ":pending": "pending_queue",
        ":queued": "queued" } }));
  }

  async markNeedsReconciliation(candidateId: string, runId: string): Promise<void> {
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:review REMOVE gsi1pk, gsi1sk",
      ConditionExpression: "#state=:queued",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":review": "needs_reconciliation", ":queued": "queued" } }));
  }

  async listPending(limit = 25): Promise<DurableDispatchRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Invalid dispatch limit");
    const result = await this.db.send(new QueryCommand({ TableName: this.table,
      IndexName: "gsi1", KeyConditionExpression: "gsi1pk=:pk",
      ExpressionAttributeValues: { ":pk": "APPLICATION_DISPATCH" },
      Limit: limit }));
    return (result.Items ?? []).map(item => rowSchema.parse(item));
  }
}

/** One scheduler tick advances at most one browser launch. Querying Dynamo's
 * outbox never increments SQS receive counts. A pending_queue record repairs
 * a crash between durable intent and SendMessage by replaying the same IDs. */
export async function dispatchOnePendingApplication(ports: {
  store: Pick<DynamoApplicationDispatchStore, "listPending" | "markQueued"
    | "markLaunched" | "markBlocked" | "markNeedsReconciliation">;
  queue: { send(message: { body: string; groupId: string;
    deduplicationId: string }): Promise<void> };
  authorize(candidateId: string, runId: string): Promise<boolean>;
  launch(candidateId: string, runId: string): Promise<"started" | "capacity_busy" | "already_stopped">;
}): Promise<"empty" | "started" | "capacity_busy" | "blocked" | "needs_reconciliation"> {
  const pending = await ports.store.listPending(25);
  for (const row of pending) {
    // The GSI is eventually consistent; a stale row is harmless to skip.
    if (row.state !== "pending_queue" && row.state !== "queued") continue;
    if (!await ports.authorize(row.candidateId, row.runId)) {
      await ports.store.markBlocked(row.candidateId, row.runId);
      return "blocked";
    }
    if (row.state === "pending_queue") {
      await ports.queue.send({ body: row.body, groupId: row.groupId,
        deduplicationId: row.deduplicationId });
      await ports.store.markQueued(row.candidateId, row.runId);
    }
    const outcome = await ports.launch(row.candidateId, row.runId);
    if (outcome === "started") {
      await ports.store.markLaunched(row.candidateId, row.runId);
      return "started";
    }
    if (outcome === "already_stopped") {
      await ports.store.markNeedsReconciliation(row.candidateId, row.runId);
      return "needs_reconciliation";
    }
    return "capacity_busy";
  }
  return "empty";
}
