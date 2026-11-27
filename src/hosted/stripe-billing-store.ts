import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
  UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { hostedEntitlementSchema, type HostedEntitlement } from "./entitlement.js";
import type { BillingReconcileRequest, UnresolvedChargeRequest } from "./stripe-webhook.js";

type Database = Pick<DynamoDBDocumentClient, "send">;
type Row = Record<string, unknown>;
const subjectKey = (subjectId: string) => `SUBJECT#${subjectId}`;
const customerKey = (customerId: string) => `CUSTOMER#${customerId}`;
const eventKey = (eventId: string) => `BILLING_EVENT#${eventId}`;
const entitlementKey = (record: HostedEntitlement) => `ENTITLEMENT#${record.kind}#${
  record.kind === "subscription" ? record.subscriptionId
    : record.kind === "semester" ? record.checkoutSessionId : record.grantId}`;
const ENTITLEMENT_PREFIX = "ENTITLEMENT#";
const MAX_REPLACEMENT = 40;

function validId(value: string, prefix: string): void {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value)) throw new Error(`Invalid ${prefix} ID`);
}
function validSubject(value: string): void {
  if (!/^[A-Za-z0-9_:\-|.]{1,160}$/.test(value)) throw new Error("Invalid subject ID");
}
function conditionFailed(error: unknown): boolean {
  return error instanceof Error && ["ConditionalCheckFailedException", "TransactionCanceledException"]
    .includes(error.name);
}

/** Shared hosted table: pk/sk strings, gsi1 on gsi1pk/gsi1sk strings. */
export class DynamoBillingStore {
  constructor(private readonly db: Database, private readonly tableName: string,
    private readonly now: () => Date = () => new Date()) {
    if (!tableName) throw new Error("Hosted billing table is required");
  }

  private async get(pk: string, sk: string): Promise<Row | undefined> {
    const value = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk, sk }, ConsistentRead: true }));
    return value.Item as Row | undefined;
  }

  async loadBinding(customerId: string): Promise<{ subjectId: string; customerId: string } | undefined> {
    validId(customerId, "cus");
    const row = await this.get(customerKey(customerId), "SUBJECT");
    if (!row) return undefined;
    if (row.customerId !== customerId || typeof row.subjectId !== "string") {
      throw new Error("Stripe customer binding is invalid");
    }
    validSubject(row.subjectId);
    return { subjectId: row.subjectId, customerId };
  }

  async enqueueOnce(request: BillingReconcileRequest): Promise<"queued" | "duplicate"> {
    validId(request.eventId, "evt");
    validId(request.customerId, "cus");
    const now = this.now().toISOString();
    const item = { pk: eventKey(request.eventId), sk: "RECONCILE",
      eventId: request.eventId, customerId: request.customerId, status: "pending",
      createdAt: now, nextAttemptAt: now,
      gsi1pk: "BILLING_PENDING", gsi1sk: `${now}#${request.eventId}` };
    try {
      await this.db.send(new PutCommand({ TableName: this.tableName, Item: item,
        ConditionExpression: "attribute_not_exists(pk)" }));
      return "queued";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const stored = await this.get(item.pk, item.sk);
      if (stored?.eventId !== request.eventId || stored.customerId !== request.customerId) {
        throw new Error("Stripe event identity conflict");
      }
      return "duplicate";
    }
  }

  async recordGuestRefund(request: UnresolvedChargeRequest): Promise<void> {
    validId(request.eventId, "evt");
    validId(request.chargeId, "ch");
    try {
      await this.db.send(new PutCommand({ TableName: this.tableName,
        Item: { pk: eventKey(request.eventId), sk: "GUEST_REFUND", ...request,
          status: "audited", createdAt: this.now().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const existing = await this.get(eventKey(request.eventId), "GUEST_REFUND");
      if (existing?.chargeId !== request.chargeId) throw new Error("Guest refund identity conflict");
    }
  }

  /** GSI may lag; a scheduled worker retries on the next tick. No table Scan. */
  async listReady(limit = 25): Promise<BillingReconcileRequest[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid batch limit");
    const now = this.now().toISOString();
    const response = await this.db.send(new QueryCommand({ TableName: this.tableName,
      IndexName: "gsi1", KeyConditionExpression: "gsi1pk=:pk AND gsi1sk<=:end",
      ExpressionAttributeValues: { ":pk": "BILLING_PENDING", ":end": `${now}#~` },
      Limit: limit }));
    return (response.Items ?? []).map((row) => {
      if (typeof row.eventId !== "string" || typeof row.customerId !== "string") {
        throw new Error("Invalid queued Stripe event");
      }
      validId(row.eventId, "evt"); validId(row.customerId, "cus");
      return { eventId: row.eventId, customerId: row.customerId };
    });
  }

  async claim(request: BillingReconcileRequest, leaseMs = 120_000): Promise<string | undefined> {
    if (!Number.isInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 600_000) {
      throw new Error("Invalid billing lease");
    }
    const now = this.now();
    const token = randomUUID();
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tableName,
        Key: { pk: eventKey(request.eventId), sk: "RECONCILE" },
        UpdateExpression: "SET #status=:processing, leaseToken=:token, leaseUntil=:leaseUntil",
        ConditionExpression: "customerId=:customerId AND ((#status=:pending AND nextAttemptAt<=:now) OR (#status=:processing AND leaseUntil<:now))",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":customerId": request.customerId,
          ":processing": "processing", ":pending": "pending", ":now": now.toISOString(),
          ":token": token, ":leaseUntil": new Date(now.getTime() + leaseMs).toISOString() } }));
      return token;
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
  }

  async complete(eventId: string, token: string): Promise<void> {
    validId(eventId, "evt");
    await this.db.send(new UpdateCommand({ TableName: this.tableName,
      Key: { pk: eventKey(eventId), sk: "RECONCILE" },
      UpdateExpression: "SET #status=:done, processedAt=:now REMOVE gsi1pk, gsi1sk, leaseToken, leaseUntil",
      ConditionExpression: "leaseToken=:token AND #status=:processing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":done": "processed", ":processing": "processing",
        ":now": this.now().toISOString(), ":token": token } }));
  }

  async retry(eventId: string, token: string, delayMs = 60_000): Promise<void> {
    validId(eventId, "evt");
    const due = new Date(this.now().getTime() + delayMs).toISOString();
    await this.db.send(new UpdateCommand({ TableName: this.tableName,
      Key: { pk: eventKey(eventId), sk: "RECONCILE" },
      UpdateExpression: "SET #status=:pending, nextAttemptAt=:due, gsi1sk=:sort REMOVE leaseToken, leaseUntil",
      ConditionExpression: "leaseToken=:token AND #status=:processing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "pending", ":processing": "processing",
        ":due": due, ":sort": `${due}#${eventId}`, ":token": token } }));
  }

  /** Serialize all provider reads and entitlement writes for one Customer. */
  async claimCustomer(customerId: string, leaseMs = 600_000): Promise<string | undefined> {
    validId(customerId, "cus");
    if (!Number.isInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 600_000) {
      throw new Error("Invalid customer lease");
    }
    const now = this.now();
    const token = randomUUID();
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tableName,
        Key: { pk: customerKey(customerId), sk: "RECONCILE_LOCK" },
        UpdateExpression: "SET leaseToken=:token, leaseUntil=:until",
        ConditionExpression: "attribute_not_exists(pk) OR leaseUntil<:now",
        ExpressionAttributeValues: { ":token": token, ":now": now.toISOString(),
          ":until": new Date(now.getTime() + leaseMs).toISOString() } }));
      return token;
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
  }

  async releaseCustomer(customerId: string, token: string): Promise<void> {
    validId(customerId, "cus");
    await this.db.send(new DeleteCommand({ TableName: this.tableName,
      Key: { pk: customerKey(customerId), sk: "RECONCILE_LOCK" },
      ConditionExpression: "leaseToken=:token",
      ExpressionAttributeValues: { ":token": token } }));
  }

  async loadEntitlements(subjectId: string): Promise<HostedEntitlement[]> {
    validSubject(subjectId);
    const records: HostedEntitlement[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(new QueryCommand({ TableName: this.tableName,
        KeyConditionExpression: "pk=:pk AND begins_with(sk,:prefix)",
        ExpressionAttributeValues: { ":pk": subjectKey(subjectId),
          ":prefix": ENTITLEMENT_PREFIX }, ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const item of page.Items ?? []) {
        const parsed = hostedEntitlementSchema.parse(item.record);
        if (parsed.subjectId !== subjectId || item.sk !== entitlementKey(parsed)) {
          throw new Error("Stored entitlement key does not match candidate");
        }
        records.push(parsed);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return records;
  }

  async replaceKind<K extends HostedEntitlement["kind"]>(subjectId: string, kind: K,
    records: readonly Extract<HostedEntitlement, { kind: K }>[],
    guard: { customerId: string; token: string }): Promise<void> {
    validSubject(subjectId);
    validId(guard.customerId, "cus");
    if (kind === "free-grant") throw new Error("Billing cannot replace free grants");
    const current = (await this.loadEntitlements(subjectId)).filter(r => r.kind === kind);
    const checked = records.map(r => hostedEntitlementSchema.parse(r));
    if (checked.some(r => r.subjectId !== subjectId || r.kind !== kind)) {
      throw new Error("Entitlement replacement is not bound to candidate");
    }
    const unique = new Set(checked.map(entitlementKey));
    if (unique.size !== checked.length || current.length + checked.length > MAX_REPLACEMENT) {
      throw new Error("Entitlement replacement exceeds atomic limit or contains duplicates");
    }
    const ops = [
      ...current.filter(r => !unique.has(entitlementKey(r))).map(r => ({ Delete: { TableName: this.tableName,
        Key: { pk: subjectKey(subjectId), sk: entitlementKey(r) } } })),
      ...checked.map(r => ({ Put: { TableName: this.tableName,
        Item: { pk: subjectKey(subjectId), sk: entitlementKey(r), record: r } } })),
    ];
    // The lock check and replacement are one transaction; an expired worker
    // cannot overwrite a newer provider snapshot after its lease is lost.
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName,
        Key: { pk: customerKey(guard.customerId), sk: "RECONCILE_LOCK" },
        ConditionExpression: "leaseToken=:token AND leaseUntil>:now",
        ExpressionAttributeValues: { ":token": guard.token,
          ":now": this.now().toISOString() } } },
      ...ops,
    ] }));
  }

  async replaceSubscriptions(subjectId: string,
    records: readonly Extract<HostedEntitlement, { kind: "subscription" }>[],
    guard: { customerId: string; token: string }): Promise<void> {
    return this.replaceKind(subjectId, "subscription", records, guard);
  }

  async replaceSemesters(subjectId: string,
    records: readonly Extract<HostedEntitlement, { kind: "semester" }>[],
    guard: { customerId: string; token: string }): Promise<void> {
    return this.replaceKind(subjectId, "semester", records, guard);
  }
}
