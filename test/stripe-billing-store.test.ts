import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoBillingStore } from "../src/hosted/stripe-billing-store.js";

const now = () => new Date("2026-11-26T20:00:00Z");
const semester = { kind: "semester", subjectId: "candidate-a",
  checkoutSessionId: "cs_test_1", paymentIntentId: "pi_1",
  startsAt: "2026-11-01T00:00:00Z", endsAt: "2027-03-01T00:00:00Z",
  revokedAt: null } as const;
const grant = { kind: "free-grant", subjectId: "candidate-a", grantId: "grant-a",
  approvedBy: "admin", startsAt: "2026-11-01T00:00:00Z",
  endsAt: "2027-01-01T00:00:00Z", revokedAt: null } as const;

function storeWith(send: (command: unknown) => Promise<unknown>) {
  return new DynamoBillingStore({ send } as unknown as Pick<DynamoDBDocumentClient, "send">,
    "test-billing", "test-entitlements", now);
}

describe("DynamoDB billing state", () => {
  it("writes event ID once and treats an identical replay as duplicate", async () => {
    const seen = new Map<string, Record<string, unknown>>();
    const store = storeWith(async command => {
      if (command instanceof PutCommand) {
        const item = command.input.Item!;
        if (seen.has(String(item.pk))) {
          const error = new Error("already exists"); error.name = "ConditionalCheckFailedException";
          throw error;
        }
        seen.set(String(item.pk), item);
        return {};
      }
      if (command instanceof GetCommand) return { Item: seen.get(String(command.input.Key?.pk)) };
      throw new Error("unexpected command");
    });
    const request = { eventId: "evt_1", customerId: "cus_1" };
    expect(await store.enqueueOnce(request)).toBe("queued");
    expect(await store.enqueueOnce(request)).toBe("duplicate");
    expect(seen.get("BILLING_EVENT#evt_1")).toMatchObject({
      gsi1pk: "BILLING_PENDING", gsi1sk: "2026-11-26T20:00:00.000Z#evt_1",
    });
  });

  it("queries due events through the pending GSI", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof QueryCommand)) throw new Error("expected Query");
      expect(command.input.IndexName).toBe("gsi1");
      expect(command.input.KeyConditionExpression).toContain("gsi1sk<=:end");
      return { Items: [{ eventId: "evt_1", customerId: "cus_1" }] };
    });
    expect(await storeWith(send).listReady()).toEqual([{ eventId: "evt_1", customerId: "cus_1" }]);
  });

  it("moves a claimed event's GSI due time to its lease expiry", async () => {
    let command: UpdateCommand | undefined;
    const store = storeWith(async input => {
      if (!(input instanceof UpdateCommand)) throw new Error("expected Update");
      command = input;
      return {};
    });
    expect(await store.claim({ eventId: "evt_1", customerId: "cus_1" })).toBeTruthy();
    expect(command?.input.ExpressionAttributeValues?.[":leaseSort"])
      .toBe("2026-11-26T20:02:00.000Z#evt_1");
  });

  it("quarantines a poison event under its lease and removes it from pending GSI", async () => {
    const commands: UpdateCommand[] = [];
    const store = storeWith(async command => {
      if (command instanceof GetCommand) return { Item: { status: "processing",
        leaseToken: "lease", customerId: "cus_unbound",
        createdAt: "2026-11-26T19:00:00.000Z" } };
      if (command instanceof UpdateCommand) { commands.push(command); return {}; }
      throw new Error("unexpected command");
    });
    expect(await store.claimedEventCreatedAt("evt_poison", "lease", "cus_unbound"))
      .toBe("2026-11-26T19:00:00.000Z");
    await store.quarantineUnbound("evt_poison", "lease", "cus_unbound");
    expect(commands[0]?.input.UpdateExpression).toContain("REMOVE gsi1pk, gsi1sk");
    expect(commands[0]?.input.ConditionExpression)
      .toContain("leaseToken=:token AND customerId=:customerId");
    expect(commands[0]?.input.ExpressionAttributeValues?.[":reason"])
      .toBe("customer-binding-unavailable");
  });

  it("accepts an opaque OIDC subject only when both customer bindings agree", async () => {
    const subjectId = "auth0|user@example.com";
    const store = storeWith(async command => {
      if (!(command instanceof GetCommand)) throw new Error("expected Get");
      return command.input.Key?.pk === "CUSTOMER#cus_1"
        ? { Item: { subjectId, customerId: "cus_1" } }
        : { Item: { subjectId, customerId: "cus_1" } };
    });
    expect(await store.loadBinding("cus_1")).toEqual({ subjectId, customerId: "cus_1" });
    const stale = storeWith(async command => command instanceof GetCommand
      ? { Item: command.input.Key?.pk === "CUSTOMER#cus_1"
        ? { subjectId, customerId: "cus_1" } : { subjectId, customerId: "cus_other" } }
      : {});
    await expect(stale.loadBinding("cus_1")).rejects.toThrow("reverse binding disagrees");
  });

  it("reads all entitlement pages and fails closed on a damaged record", async () => {
    let page = 0;
    const store = storeWith(async command => {
      if (!(command instanceof QueryCommand)) throw new Error("expected Query");
      return ++page === 1
        ? { Items: [{ sk: "ENTITLEMENT#free-grant#grant-a", record: grant }],
          LastEvaluatedKey: { pk: "SUBJECT#candidate-a", sk: "ENTITLEMENT#free-grant#grant-a" } }
        : { Items: [{ sk: "ENTITLEMENT#semester#cs_test_1", record: semester }] };
    });
    expect(await store.loadEntitlements("candidate-a")).toHaveLength(2);
    expect(await store.hasPaidAccess("candidate-a")).toBe(true);
    const broken = storeWith(async () => ({ Items: [{ sk: "wrong", record: semester }] }));
    await expect(broken.hasPaidAccess("candidate-a")).rejects.toThrow("key does not match");
  });

  it("uses a separate entitlement table and refuses a shared-table deployment", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof QueryCommand)) throw new Error("expected Query");
      expect(command.input.TableName).toBe("test-entitlements");
      expect(command.input.ConsistentRead).toBe(true);
      return { Items: [] };
    });
    await storeWith(send).loadEntitlements("candidate-a");
    expect(() => new DynamoBillingStore({ send } as unknown as Pick<DynamoDBDocumentClient,
      "send">, "same", "same", now)).toThrow("Separate");
  });

  it("replaces paid rows under a customer lock without touching free grants", async () => {
    let transaction: TransactWriteCommand | undefined;
    const store = storeWith(async command => {
      if (command instanceof QueryCommand) return { Items: [
        { sk: "ENTITLEMENT#free-grant#grant-a", record: grant },
        { sk: "ENTITLEMENT#semester#cs_test_1", record: semester },
      ] };
      if (command instanceof TransactWriteCommand) { transaction = command; return {}; }
      throw new Error("unexpected command");
    });
    await store.replacePaid("candidate-a", [{ ...semester, revokedAt: semester.startsAt }],
      { customerId: "cus_1", token: "lock-token" });
    const ops = transaction?.input.TransactItems ?? [];
    expect(ops).toHaveLength(2);
    expect(ops[0]?.ConditionCheck?.Key).toEqual({ pk: "CUSTOMER#cus_1",
      sk: "RECONCILE_LOCK" });
    expect(ops[0]?.ConditionCheck?.TableName).toBe("test-billing");
    expect(ops[1]?.Put?.TableName).toBe("test-entitlements");
    expect(ops[1]?.Put?.Item?.sk).toBe("ENTITLEMENT#semester#cs_test_1");
    expect(ops.some(op => op.Delete?.Key?.sk === "ENTITLEMENT#free-grant#grant-a"))
      .toBe(false);
  });
});
