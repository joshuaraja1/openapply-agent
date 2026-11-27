import { randomUUID } from "node:crypto";
import {
  GetCommand, PutCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type Stripe from "stripe";
import type { CheckoutPorts, CheckoutReservation, CheckoutSessionRecord, HostedPlan } from "./stripe-checkout.js";

type Row = Record<string, unknown>;
const subjectKey = (subjectId: string) => `SUBJECT#${subjectId}`;
const customerKey = (customerId: string) => `CUSTOMER#${customerId}`;
const requestKey = (requestId: string) => `REQUEST#${requestId}`;
const checkoutKey = "CHECKOUT";

function validSubject(subjectId: string): void {
  if (!subjectId || subjectId.length > 160 || /[\u0000-\u001f\u007f]/.test(subjectId)) {
    throw new Error("Invalid authenticated subject");
  }
}

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && ["ConditionalCheckFailedException", "TransactionCanceledException"]
    .includes(error.name);
}

function reservation(row: Row | undefined): CheckoutReservation | undefined {
  if (!row || row.status !== "open") return undefined;
  if (typeof row.requestId !== "string" || typeof row.subjectId !== "string"
    || typeof row.customerId !== "string" || typeof row.createdAt !== "string"
    || (row.plan !== "monthly" && row.plan !== "semester")) {
    throw new Error("Checkout journal record is invalid");
  }
  return { requestId: row.requestId, subjectId: row.subjectId,
    customerId: row.customerId, createdAt: row.createdAt, plan: row.plan,
    ...(row.session ? { session: row.session as CheckoutSessionRecord } : {}) };
}

/** DynamoDB table must use String partition `pk` and sort `sk` keys.
 * Caller provides a verified subject. Never take a Customer ID from HTTP input. */
export class DynamoCheckoutJournal implements CheckoutPorts {
  constructor(
    private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
    private readonly stripe: Pick<Stripe, "customers" | "checkout">,
    private readonly assertNoPaidAccess: (subjectId: string) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!tableName) throw new Error("Checkout journal table is required");
  }

  private async get(pk: string, sk: string): Promise<Row | undefined> {
    const result = await this.db.send(new GetCommand({ TableName: this.tableName,
      Key: { pk, sk }, ConsistentRead: true }));
    return result.Item as Row | undefined;
  }

  async lookupSubjectByCustomer(customerId: string): Promise<string | undefined> {
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) throw new Error("Invalid Stripe Customer ID");
    const row = await this.get(customerKey(customerId), "SUBJECT");
    if (!row) return undefined;
    if (row.customerId !== customerId || typeof row.subjectId !== "string") {
      throw new Error("Stripe customer binding is invalid");
    }
    const forward = await this.get(subjectKey(row.subjectId), "CUSTOMER");
    if (forward?.customerId !== customerId || forward.subjectId !== row.subjectId) {
      throw new Error("Stripe customer reverse binding disagrees with subject binding");
    }
    return row.subjectId;
  }

  private async ensureCustomer(subjectId: string): Promise<string> {
    const pk = subjectKey(subjectId);
    const bound = await this.get(pk, "CUSTOMER");
    if (bound) {
      if (bound.subjectId !== subjectId || typeof bound.customerId !== "string"
        || !/^cus_[A-Za-z0-9]+$/.test(bound.customerId)) {
        throw new Error("Stripe customer binding is invalid");
      }
      return bound.customerId;
    }
    let claim = await this.get(pk, "CUSTOMER_CLAIM");
    if (!claim) {
      const candidate = { pk, sk: "CUSTOMER_CLAIM", subjectId,
        requestId: randomUUID(), createdAt: this.now().toISOString() };
      try {
        await this.db.send(new PutCommand({ TableName: this.tableName, Item: candidate,
          ConditionExpression: "attribute_not_exists(pk)" }));
        claim = candidate;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        claim = await this.get(pk, "CUSTOMER_CLAIM");
      }
    }
    if (claim?.subjectId !== subjectId || typeof claim.requestId !== "string"
      || !/^[A-Za-z0-9_-]{1,160}$/.test(claim.requestId)
      || typeof claim.createdAt !== "string") throw new Error("Customer claim is invalid");
    const age = this.now().getTime() - Date.parse(claim.createdAt);
    if (!Number.isFinite(age) || age < -5 * 60_000 || age >= 20 * 60 * 60_000) {
      throw new Error("Customer claim requires Stripe reconciliation before retry");
    }
    const customer = await this.stripe.customers.create({
      metadata: { subjectId, claimId: claim.requestId },
    },
      { idempotencyKey: `openapply-customer-${claim.requestId}` });
    if (!/^cus_[A-Za-z0-9]+$/.test(customer.id)) throw new Error("Stripe Customer ID is invalid");
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName,
          Item: { pk, sk: "CUSTOMER", subjectId, customerId: customer.id },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.tableName,
          Item: { pk: customerKey(customer.id), sk: "SUBJECT", subjectId,
            customerId: customer.id }, ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const winner = await this.get(pk, "CUSTOMER");
      if (winner?.customerId !== customer.id || winner.subjectId !== subjectId) throw error;
    }
    return customer.id;
  }

  async reserve(subjectId: string, plan: HostedPlan): Promise<CheckoutReservation> {
    validSubject(subjectId);
    if (plan !== "monthly" && plan !== "semester") throw new Error("Unsupported plan");
    await this.assertNoPaidAccess(subjectId);
    const customerId = await this.ensureCustomer(subjectId);
    const pk = subjectKey(subjectId);
    const sk = checkoutKey;
    const existing = await this.get(pk, sk);
    if (existing) {
      const open = reservation(existing);
      if (open) {
        if (open.customerId !== customerId || open.plan !== plan || open.subjectId !== subjectId) {
          throw new Error("Checkout reservation binding changed");
        }
        return open;
      }
      if (existing.status !== "closed") throw new Error("Checkout journal record is invalid");
    }
    const created: CheckoutReservation = { requestId: randomUUID(), subjectId,
      customerId, plan, createdAt: this.now().toISOString() };
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        existing ? { Update: { TableName: this.tableName, Key: { pk, sk },
          UpdateExpression: "SET requestId=:requestId, subjectId=:subjectId, customerId=:customerId, plan=:plan, createdAt=:createdAt, #status=:open REMOVE #session",
          ConditionExpression: "#status=:closed AND requestId=:oldRequestId",
          ExpressionAttributeNames: { "#status": "status", "#session": "session" },
          ExpressionAttributeValues: { ":requestId": created.requestId, ":subjectId": subjectId,
            ":customerId": customerId, ":plan": plan, ":createdAt": created.createdAt,
            ":open": "open", ":closed": "closed", ":oldRequestId": existing.requestId } } }
          : { Put: { TableName: this.tableName,
            Item: { pk, sk, ...created, status: "open" },
            ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.tableName,
          Item: { pk: requestKey(created.requestId), sk: "CHECKOUT", subjectId, plan },
          ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
      return created;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const winner = reservation(await this.get(pk, sk));
      if (!winner || winner.subjectId !== subjectId || winner.customerId !== customerId
        || winner.plan !== plan) throw error;
      return winner;
    }
  }

  async recordSession(requestId: string, session: CheckoutSessionRecord): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(requestId)) throw new Error("Invalid checkout request");
    let checkoutUrl: URL;
    try { checkoutUrl = new URL(session.url); }
    catch { throw new Error("Invalid Stripe checkout session"); }
    if (!/^cs_[A-Za-z0-9_]+$/.test(session.sessionId)
      || !/^price_[A-Za-z0-9]+$/.test(session.priceId)
      || checkoutUrl.origin !== "https://checkout.stripe.com"
      || !Number.isFinite(Date.parse(session.expiresAt))) {
      throw new Error("Invalid Stripe checkout session");
    }
    const map = await this.get(requestKey(requestId), "CHECKOUT");
    if (!map || typeof map.subjectId !== "string"
      || (map.plan !== "monthly" && map.plan !== "semester")) {
      throw new Error("Unknown checkout request");
    }
    const pk = subjectKey(map.subjectId);
    const sk = checkoutKey;
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tableName, Key: { pk, sk },
        UpdateExpression: "SET #session=:session",
        ConditionExpression: "requestId=:requestId AND #status=:open AND attribute_not_exists(#session)",
        ExpressionAttributeNames: { "#session": "session", "#status": "status" },
        ExpressionAttributeValues: { ":session": session, ":requestId": requestId, ":open": "open" } }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const current = reservation(await this.get(pk, sk));
      if (!current || current.requestId !== requestId
        || JSON.stringify(current.session) !== JSON.stringify(session)) throw error;
    }
  }

  /** Reopen only after Stripe says the exact previous session expired.
   * A lost Stripe response or a completed payment is not terminal evidence. */
  async closeReservation(subjectId: string, plan: HostedPlan, requestId: string): Promise<void> {
    validSubject(subjectId);
    const current = reservation(await this.get(subjectKey(subjectId), checkoutKey));
    if (!current || current.plan !== plan || current.requestId !== requestId || !current.session) {
      throw new Error("Recorded checkout session required for reconciliation");
    }
    const remote = await this.stripe.checkout.sessions.retrieve(current.session.sessionId);
    if (remote.id !== current.session.sessionId || remote.customer !== current.customerId
      || remote.metadata?.requestId !== requestId || remote.status !== "expired") {
      throw new Error("Stripe has not confirmed this checkout expired");
    }
    await this.db.send(new UpdateCommand({ TableName: this.tableName,
      Key: { pk: subjectKey(subjectId), sk: checkoutKey },
      UpdateExpression: "SET #status=:closed",
      ConditionExpression: "requestId=:requestId AND #status=:open",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":requestId": requestId, ":open": "open", ":closed": "closed" } }));
  }
}
