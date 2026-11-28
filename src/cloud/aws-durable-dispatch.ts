import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { decodeCloudRunEnvelope, encodeCloudRunEnvelope } from "./run-envelope.js";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const rowSchema = z.object({ pk: z.string(), sk: z.string(),
  candidateId: uuid, runId: uuid,
  state: z.enum(["pending_queue", "queued", "launched", "preview_complete", "needs_human", "completed", "blocked", "needs_reconciliation"]),
  body: z.string().max(1024), groupId: uuid,
  deduplicationId: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
});
export type DurableDispatchRecord = z.infer<typeof rowSchema>;

function key(candidateId: string, runId: string) {
  return { pk: `CANDIDATE#${uuid.parse(candidateId)}`,
    sk: `DISPATCH#${uuid.parse(runId)}` };
}

function parseDispatchRow(value: unknown): DurableDispatchRecord {
  const row = rowSchema.parse(value);
  if (row.pk !== `CANDIDATE#${row.candidateId}` || row.sk !== `DISPATCH#${row.runId}`) {
    throw new Error("Dispatch key mismatch");
  }
  const envelope = decodeCloudRunEnvelope(row.body);
  const encoded = encodeCloudRunEnvelope(envelope);
  if (envelope.kind !== "apply" || envelope.candidateId !== row.candidateId
    || envelope.runId !== row.runId || row.groupId !== encoded.groupId
    || row.deduplicationId !== encoded.deduplicationId) {
    throw new Error("Dispatch envelope mismatch");
  }
  return row;
}

/** The dispatch row is the durable hosted queue. Exact key reads avoid
 * receiving another candidate's SQS message or incrementing its DLQ count. */
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
    const row = parseDispatchRow(item);
    if (row.pk !== expected.pk || row.sk !== expected.sk) throw new Error("Dispatch key mismatch");
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
    if (row?.state === "queued" || row?.state === "launched"
      || row?.state === "preview_complete" || row?.state === "completed") return;
    if (row?.state !== "pending_queue") throw new Error("Dispatch not pending");
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:queued",
      ConditionExpression: "#state=:pending",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":queued": "queued", ":pending": "pending_queue" } }));
  }

  async markLaunched(candidateId: string, runId: string): Promise<void> {
    const row = await this.read(candidateId, runId);
    if (row?.state === "launched" || row?.state === "preview_complete"
      || row?.state === "completed") return;
    if (row?.state !== "queued") throw new Error("Dispatch not queued");
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:launched REMOVE gsi1pk, gsi1sk",
      ConditionExpression: "#state=:queued",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":launched": "launched", ":queued": "queued" } }));
  }

  async markCompleted(candidateId: string, runId: string): Promise<void> {
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:completed REMOVE gsi1pk, gsi1sk",
      ConditionExpression: "#state IN (:queued, :launched)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":completed": "completed", ":queued": "queued",
        ":launched": "launched" } }));
  }

  /** A pre-submit preview is terminal for this task generation. It is not an
   * employer submission and must never become a confirmed receipt. */
  async markPreviewComplete(candidateId: string, runId: string, outcome: {
    status: "ready-for-review" | "needs-human"; blockerCount: number;
    resumeSha256: string; uploaded: boolean;
  }): Promise<void> {
    if (!Number.isSafeInteger(outcome.blockerCount) || outcome.blockerCount < 0
      || outcome.blockerCount > 100 || !/^[a-f0-9]{64}$/.test(outcome.resumeSha256)) {
      throw new Error("Invalid preview outcome");
    }
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: key(candidateId, runId),
      UpdateExpression: "SET #state=:preview, previewStatus=:status, previewBlockerCount=:count, previewResumeSha256=:sha, previewResumeUploaded=:uploaded REMOVE gsi1pk, gsi1sk",
      ConditionExpression: "#state=:launched",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":preview": "preview_complete", ":launched": "launched",
        ":status": outcome.status, ":count": outcome.blockerCount,
        ":sha": outcome.resumeSha256, ":uploaded": outcome.uploaded } }));
  }

  /** Link a ciphertext object only while this exact run owns a live lease and
   * no submit intent exists. Candidate deletion purges the entire object prefix. */
  async markHandoffPointer(candidateId: string, runId: string, leaseToken: string,
    job: OfficialJobIdentity, artifactId: string, sha256: string, nowEpoch: number): Promise<void> {
    const id = key(candidateId, runId);
    const token = uuid.parse(leaseToken);
    const artifact = uuid.parse(artifactId);
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
      throw new Error("Invalid handoff checkpoint");
    }
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.table, Key: { pk: id.pk, sk: "DELETED" },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { ConditionCheck: { TableName: this.table, Key: { pk: id.pk, sk: "LEASE" },
        ConditionExpression: "ownerToken=:token AND runId=:run AND expiresAt>:now",
        ExpressionAttributeValues: { ":token": token, ":run": runId, ":now": nowEpoch } } },
      { ConditionCheck: { TableName: this.table, Key: { pk: id.pk, sk: officialJobKey(job) },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: this.table, Key: id,
        UpdateExpression: "SET handoffArtifactId=:artifact, handoffSha256=:sha, handoffLeaseToken=:token",
        ConditionExpression: "#state=:launched",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":launched": "launched", ":artifact": artifact,
          ":sha": sha256, ":token": token } } },
    ] }));
  }

  /** Terminal pre-submit stop. The same transaction checks the exact saved
   * checkpoint, live owner lease, no submit intent, and no deletion marker. */
  async markNeedsHuman(candidateId: string, runId: string, leaseToken: string,
    job: OfficialJobIdentity, nowEpoch: number): Promise<void> {
    const id = key(candidateId, runId);
    const token = uuid.parse(leaseToken);
    if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) throw new Error("Invalid handoff stop");
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.table, Key: { pk: id.pk, sk: "DELETED" },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { ConditionCheck: { TableName: this.table, Key: { pk: id.pk, sk: "LEASE" },
        ConditionExpression: "ownerToken=:token AND runId=:run AND expiresAt>:now",
        ExpressionAttributeValues: { ":token": token, ":run": runId, ":now": nowEpoch } } },
      { ConditionCheck: { TableName: this.table, Key: { pk: id.pk, sk: officialJobKey(job) },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: this.table, Key: id,
        UpdateExpression: "SET #state=:human, handoffStatus=:status REMOVE gsi1pk, gsi1sk",
        ConditionExpression: "#state=:launched AND handoffLeaseToken=:token AND attribute_exists(handoffArtifactId) AND attribute_exists(handoffSha256)",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":human": "needs_human", ":status": "needs-human",
          ":launched": "launched", ":token": token } } },
    ] }));
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
      ConditionExpression: "#state IN (:pending, :queued, :launched)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":review": "needs_reconciliation", ":pending": "pending_queue", ":queued": "queued",
        ":launched": "launched" } }));
  }

  async listPending(limit = 25): Promise<DurableDispatchRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Invalid dispatch limit");
    const rows: DurableDispatchRecord[] = [];
    let cursor: QueryCommandInput["ExclusiveStartKey"];
    let invalid = 0;
    // Bounded pagination skips malformed/stale index rows without allowing
    // one damaged record to abort every scheduled dispatch tick.
    for (let page = 0; page < 4 && rows.length < limit; page++) {
      const result = await this.db.send(new QueryCommand({ TableName: this.table,
        IndexName: "gsi1", KeyConditionExpression: "gsi1pk=:pk",
        ExpressionAttributeValues: { ":pk": "APPLICATION_DISPATCH" },
        Limit: 25, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const item of result.Items ?? []) {
        try {
          const row = parseDispatchRow(item);
          if (row.state === "pending_queue" || row.state === "queued") rows.push(row);
        } catch { invalid++; }
        if (rows.length >= limit) break;
      }
      cursor = result.LastEvaluatedKey;
      if (!cursor) break;
    }
    if (invalid) console.warn(`OpenApply dispatch skipped ${invalid} malformed index row(s)`);
    return rows;
  }
}

/** One scheduler tick advances at most one browser launch. Querying Dynamo's
 * outbox never increments SQS receive counts. */
export async function dispatchOnePendingApplication(ports: {
  store: Pick<DynamoApplicationDispatchStore, "listPending" | "markQueued"
    | "markLaunched" | "markBlocked" | "markNeedsReconciliation">;
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
