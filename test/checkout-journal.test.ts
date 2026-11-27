import { describe, expect, it, vi } from "vitest";
import {
  GetCommand, PutCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type Stripe from "stripe";
import { DynamoCheckoutJournal } from "../src/hosted/checkout-journal.js";
import type { CheckoutSessionRecord } from "../src/hosted/stripe-checkout.js";

function conditionalError(): Error {
  return Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
}

function fakeDynamo() {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (pk: string, sk: string) => `${pk}\0${sk}`;
  const get = (pk: string, sk: string) => rows.get(key(pk, sk));
  const send = vi.fn(async (command: unknown): Promise<Record<string, unknown>> => {
    if (command instanceof GetCommand) {
      const input = command.input;
      return { Item: get(String(input.Key?.pk), String(input.Key?.sk)) };
    }
    if (command instanceof PutCommand) {
      const input = command.input;
      const item = input.Item as Record<string, unknown>;
      const k = key(String(item.pk), String(item.sk));
      if (input.ConditionExpression && rows.has(k)) throw conditionalError();
      rows.set(k, structuredClone(item));
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const actions = command.input.TransactItems ?? [];
      // Validate every condition before committing anything.
      for (const action of actions) {
        if (action.Put) {
          const item = action.Put.Item as Record<string, unknown>;
          if (rows.has(key(String(item.pk), String(item.sk)))) throw conditionalError();
        }
        if (action.Update) {
          const row = get(String(action.Update.Key?.pk), String(action.Update.Key?.sk));
          const v = action.Update.ExpressionAttributeValues as Record<string, unknown>;
          if (!row || row.status !== v[":closed"] || row.requestId !== v[":oldRequestId"])
            throw conditionalError();
        }
      }
      for (const action of actions) {
        if (action.Put) {
          const item = action.Put.Item as Record<string, unknown>;
          rows.set(key(String(item.pk), String(item.sk)), structuredClone(item));
        }
        if (action.Update) {
          const k = key(String(action.Update.Key?.pk), String(action.Update.Key?.sk));
          const v = action.Update.ExpressionAttributeValues as Record<string, unknown>;
          rows.set(k, { pk: action.Update.Key?.pk, sk: action.Update.Key?.sk,
            requestId: v[":requestId"], subjectId: v[":subjectId"],
            customerId: v[":customerId"], plan: v[":plan"],
            createdAt: v[":createdAt"], status: "open" });
        }
      }
      return {};
    }
    if (command instanceof UpdateCommand) {
      const input = command.input;
      const k = key(String(input.Key?.pk), String(input.Key?.sk));
      const row = rows.get(k);
      const v = input.ExpressionAttributeValues as Record<string, unknown>;
      if (!row || row.requestId !== v[":requestId"] || row.status !== v[":open"])
        throw conditionalError();
      if (input.UpdateExpression?.includes("#session")) {
        if (row.session) throw conditionalError();
        rows.set(k, { ...row, session: structuredClone(v[":session"]) });
      } else rows.set(k, { ...row, status: "closed" });
      return {};
    }
    throw new Error("Unexpected DynamoDB operation");
  });
  return { db: { send } as unknown as Pick<DynamoDBDocumentClient, "send">, rows, send };
}

const session: CheckoutSessionRecord = { sessionId: "cs_test_123", priceId: "price_123",
  url: "https://checkout.stripe.com/c/pay/cs_test_123", expiresAt: "2026-12-01T00:00:00Z" };

function fixture() {
  const { db, rows } = fakeDynamo();
  const create = vi.fn(async (_params: unknown, _options: unknown) => ({ id: "cus_123" }));
  const retrieve = vi.fn(async () => ({ id: "cs_test_123", customer: "cus_123",
    metadata: { requestId: "" }, status: "expired" }));
  const stripe = { customers: { create }, checkout: { sessions: { retrieve } } } as unknown as
    Pick<Stripe, "customers" | "checkout">;
  const paidCheck = vi.fn(async () => {});
  const journal = () => new DynamoCheckoutJournal(db, "hosted-state", stripe, paidCheck,
    () => new Date("2026-11-26T10:00:00Z"));
  return { journal, create, retrieve, rows, paidCheck };
}

describe("durable checkout journal", () => {
  it("binds one Customer and one attempt across concurrent requests and process restart", async () => {
    const { journal, create, rows } = fixture();
    const [first, second] = await Promise.all([
      journal().reserve("candidate-1", "monthly"), journal().reserve("candidate-1", "monthly"),
    ]);
    expect(second.requestId).toBe(first.requestId);
    expect(first.customerId).toBe("cus_123");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[1]).toEqual(create.mock.calls[1]?.[1]);
    expect(await journal().lookupSubjectByCustomer("cus_123")).toBe("candidate-1");
    expect(rows.has(`REQUEST#${first.requestId}\0CHECKOUT`)).toBe(true);
    await journal().recordSession(first.requestId, session);
    expect((await journal().reserve("candidate-1", "monthly")).session).toEqual(session);
  });

  it("rejects a different session on the same request and an old request after close", async () => {
    const { journal, retrieve } = fixture();
    const first = await journal().reserve("candidate-1", "semester");
    await journal().recordSession(first.requestId, session);
    await journal().recordSession(first.requestId, session);
    await expect(journal().recordSession(first.requestId, { ...session, sessionId: "cs_test_other" }))
      .rejects.toThrow();
    retrieve.mockResolvedValueOnce({ id: session.sessionId, customer: first.customerId,
      metadata: { requestId: first.requestId }, status: "expired" });
    await journal().closeReservation("candidate-1", "semester", first.requestId);
    const next = await journal().reserve("candidate-1", "semester");
    expect(next.requestId).not.toBe(first.requestId);
    await expect(journal().recordSession(first.requestId, session)).rejects.toThrow();
  });

  it("requires the trusted paid-access check before creating Stripe state", async () => {
    const { journal, create, paidCheck } = fixture();
    paidCheck.mockRejectedValueOnce(new Error("already paid"));
    await expect(journal().reserve("candidate-1", "monthly")).rejects.toThrow("already paid");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not close a completed or unrecorded checkout", async () => {
    const { journal, retrieve } = fixture();
    const first = await journal().reserve("candidate-1", "monthly");
    await expect(journal().closeReservation("candidate-1", "monthly", first.requestId))
      .rejects.toThrow("Recorded checkout session required");
    await journal().recordSession(first.requestId, session);
    retrieve.mockResolvedValueOnce({ id: session.sessionId, customer: first.customerId,
      metadata: { requestId: first.requestId }, status: "complete" });
    await expect(journal().closeReservation("candidate-1", "monthly", first.requestId))
      .rejects.toThrow("has not confirmed");
  });
});
