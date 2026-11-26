import { describe, expect, it } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DurableApplicationJournal, officialJobKey } from "../src/cloud/durable-journal.js";

const candidateId = "4fd29cf4-edda-4e66-9440-172c167bb0aa";
const firstRun = "621e5016-1649-43b2-b97c-79219a9ac703";
const secondRun = "c7f715df-0f49-4be7-a529-40c8ca660f92";
const job = { provider: "Greenhouse", employerId: "acme", requisitionId: "12345" };
const receipt = { artifactId: "a987ca61-0192-42ae-8ae9-8a17caeff299", sha256: "a".repeat(64) };

function conflict(): never {
  const error = new Error("conditional write rejected");
  error.name = "TransactionCanceledException";
  Object.assign(error, { CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
  throw error;
}

/** Minimal atomic DynamoDB behavior for the lease and journal commands. */
class LedgerMemory {
  readonly items = new Map<string, Record<string, unknown>>();
  now = 1_800_000_000;
  key(pk: unknown, sk: unknown): string { return `${pk}|${sk}`; }
  async send(command: unknown): Promise<{ Item?: Record<string, unknown> }> {
    if (command instanceof GetCommand) {
      const input = command.input;
      const item = this.items.get(this.key(input.Key?.pk, input.Key?.sk));
      return item ? { Item: item } : {};
    }
    if (command instanceof PutCommand) {
      const input = command.input;
      const item = input.Item as Record<string, unknown>;
      const key = this.key(item.pk, item.sk);
      if (this.items.has(key)) conflict();
      this.items.set(key, item);
      return {};
    }
    if (command instanceof DeleteCommand) {
      const input = command.input;
      const key = this.key(input.Key?.pk, input.Key?.sk);
      const item = this.items.get(key);
      if (item?.ownerToken !== input.ExpressionAttributeValues?.[":token"]) conflict();
      this.items.delete(key);
      return {};
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("Unexpected command");
    const actions = command.input.TransactItems ?? [];
    // Check every condition before applying any write, as a transaction does.
    for (const action of actions) {
      if (action.ConditionCheck) {
        const { Key, ConditionExpression, ExpressionAttributeValues: values } = action.ConditionCheck;
        const item = this.items.get(this.key(Key?.pk, Key?.sk));
        if (ConditionExpression === "attribute_not_exists(pk)") {
          if (item) conflict();
        } else if (!item || item.ownerToken !== values?.[":token"] || Number(item.expiresAt) <= Number(values?.[":now"])) {
          conflict();
        }
      }
      if (action.Put) {
        const { Item, ExpressionAttributeValues: values } = action.Put;
        const item = Item as Record<string, unknown>;
        const existing = this.items.get(this.key(item.pk, item.sk));
        if (existing && (item.sk !== "LEASE" || Number(existing.expiresAt) > Number(values?.[":now"]))) conflict();
      }
      if (action.Update) {
        const { Key, ExpressionAttributeValues: values } = action.Update;
        const existing = this.items.get(this.key(Key?.pk, Key?.sk));
        if (!existing) conflict();
        if (Key?.sk === "LEASE") {
          if (existing.ownerToken !== values?.[":token"] || Number(existing.expiresAt) <= Number(values?.[":now"])) conflict();
        } else if (!action.Update.UpdateExpression?.includes(":confirmed")) {
          if (existing.state !== "submit_intent" || existing.ownerToken !== values?.[":token"]) conflict();
        } else if (!(["submit_intent", "uncertain"].includes(String(existing.state))) || existing.receiptSha256) conflict();
      }
    }
    for (const action of actions) {
      if (action.Put) {
        const item = action.Put.Item as Record<string, unknown>;
        this.items.set(this.key(item.pk, item.sk), item);
      }
      if (action.Update) {
        const { Key, ExpressionAttributeValues: values } = action.Update;
        const item = this.items.get(this.key(Key?.pk, Key?.sk))!;
        if (Key?.sk === "LEASE") item.expiresAt = values?.[":expiresAt"];
        else if (!action.Update.UpdateExpression?.includes(":confirmed")) item.state = "uncertain";
        else {
          item.state = "confirmed";
          item.receiptArtifactId = values?.[":artifact"];
          item.receiptSha256 = values?.[":digest"];
        }
      }
    }
    return {};
  }
  journal(): DurableApplicationJournal {
    return new DurableApplicationJournal(this as unknown as DynamoDBDocumentClient, "staging-ledger",
      () => this.now * 1000);
  }
}

describe("durable cloud application journal", () => {
  it("derives one exact-job key across run IDs and separates distinct requisitions", () => {
    expect(officialJobKey(job)).toBe(officialJobKey({ ...job, provider: "greenhouse" }));
    expect(officialJobKey(job)).not.toBe(officialJobKey({ ...job, requisitionId: "12346" }));
  });

  it("grants only one live lease and rejects an expired owner's renewal", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const [a, b] = await Promise.all([
      journal.acquireLease(candidateId, firstRun), journal.acquireLease(candidateId, secondRun),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    db.now += 121;
    const next = await journal.acquireLease(candidateId, secondRun);
    expect(next).toBeTruthy();
    expect(await journal.renewLease(candidateId, a!)).toBe(false);
    expect(await journal.renewLease(candidateId, next!)).toBe(true);
  });

  it("uses one candidate partition across UUID case for lease and submit intent", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const upper = candidateId.toUpperCase();
    const first = (await journal.acquireLease(candidateId, firstRun))!;
    expect(await journal.acquireLease(upper, secondRun)).toBeNull();
    expect(await journal.beginSubmission(upper, first, job)).toBe(true);
    expect(await journal.beginSubmission(candidateId, first, job)).toBe(false);
    expect(await journal.submissionStatus(upper, job)).toBe("needs_reconciliation");
    expect(db.items.has(db.key(`CANDIDATE#${upper}`, officialJobKey(job)))).toBe(false);
  });

  it("keeps intent after a crash, including a new run ID, and never grants another click", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const first = (await journal.acquireLease(candidateId, firstRun))!;
    expect(await journal.beginSubmission(candidateId, first, job)).toBe(true);
    expect(await journal.beginSubmission(candidateId, first, job)).toBe(false);
    expect(await journal.submissionStatus(candidateId, job)).toBe("needs_reconciliation");
    db.now += 121;
    const next = (await journal.acquireLease(candidateId, secondRun))!;
    expect(await journal.beginSubmission(candidateId, next, job)).toBe(false);
    const stored = db.items.get(db.key(`CANDIDATE#${candidateId}`, officialJobKey(job)));
    expect(stored?.expiresAt).toBeUndefined();
  });

  it("allows receipt confirmation after recovery but never overwrites a confirmed receipt", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const first = (await journal.acquireLease(candidateId, firstRun))!;
    await journal.beginSubmission(candidateId, first, job);
    db.now += 121;
    const next = (await journal.acquireLease(candidateId, secondRun))!;
    expect(await journal.confirmAfterVerification(candidateId, next, job, receipt)).toBe(true);
    expect(await journal.submissionStatus(candidateId, job)).toBe("confirmed");
    expect(await journal.confirmAfterVerification(candidateId, next, job, receipt)).toBe(false);
    expect(await journal.beginSubmission(candidateId, next, job)).toBe(false);
  });

  it("holds an ambiguous click for reconciliation and blocks old queued runs after deletion", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const token = (await journal.acquireLease(candidateId, firstRun))!;
    await journal.beginSubmission(candidateId, token, job);
    await journal.markUncertain(candidateId, token, job);
    expect(await journal.submissionStatus(candidateId, job)).toBe("needs_reconciliation");
    await journal.tombstoneCandidate(candidateId);
    db.now += 121;
    expect(await journal.acquireLease(candidateId, secondRun)).toBeNull();
    expect(await journal.beginSubmission(candidateId, token, { ...job, requisitionId: "other" })).toBe(false);
  });

  it("blocks a queued uppercase candidate ID after a lowercase deletion tombstone", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    await journal.tombstoneCandidate(candidateId);
    expect(await journal.acquireLease(candidateId.toUpperCase(), secondRun)).toBeNull();
    expect(db.items.has(db.key(`CANDIDATE#${candidateId.toUpperCase()}`, "DELETED"))).toBe(false);
  });

  it("does not disguise a DynamoDB transaction failure as a duplicate", async () => {
    const client = { send: async () => {
      const error = new Error("capacity failure");
      error.name = "TransactionCanceledException";
      Object.assign(error, { CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }] });
      throw error;
    } } as unknown as DynamoDBDocumentClient;
    const journal = new DurableApplicationJournal(client, "staging-ledger");
    await expect(journal.acquireLease(candidateId, firstRun)).rejects.toThrow("capacity failure");
  });
});
