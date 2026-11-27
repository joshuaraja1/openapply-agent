import { describe, expect, it } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DurableApplicationJournal, officialJobKey } from "../src/cloud/durable-journal.js";

const candidateId = "4fd29cf4-edda-4e66-9440-172c167bb0aa";
const firstRun = "621e5016-1649-43b2-b97c-79219a9ac703";
const secondRun = "c7f715df-0f49-4be7-a529-40c8ca660f92";
const job = { provider: "Greenhouse", employerId: "acme", requisitionId: "12345" };
const receiptDigest = "a".repeat(64);

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
        } else if (Key?.sk === "CONSENT") {
          if (!item || item.runId !== values?.[":runId"] || item.version !== values?.[":version"]
            || item.state !== values?.[":granted"]) conflict();
        } else if (!item || item.ownerToken !== values?.[":token"]
          || (values?.[":runId"] !== undefined && item.runId !== values?.[":runId"])
          || Number(item.expiresAt) <= Number(values?.[":now"])) {
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
        if (Key?.sk === "CONSENT") {
          if (values?.[":revoked"] !== undefined) {
            if (!existing || existing.version !== values?.[":version"] || existing.state !== "granted") conflict();
          } else if (existing && Number(existing.version) >= Number(values?.[":version"])) conflict();
        } else if (!existing) conflict();
        else if (Key?.sk === "LEASE") {
          if (existing.ownerToken !== values?.[":token"] || Number(existing.expiresAt) <= Number(values?.[":now"])) conflict();
        } else if (!action.Update.UpdateExpression?.includes(":confirmed")) {
          if (existing.state !== "submit_intent" || existing.ownerToken !== values?.[":token"]) conflict();
        } else if (!(["submit_intent", "uncertain"].includes(String(existing.state)))
          || existing.receiptSha256 || existing.receiptArtifactId !== values?.[":artifact"]) conflict();
      }
    }
    for (const action of actions) {
      if (action.Put) {
        const item = action.Put.Item as Record<string, unknown>;
        this.items.set(this.key(item.pk, item.sk), item);
      }
      if (action.Update) {
        const { Key, ExpressionAttributeValues: values } = action.Update;
        const item: Record<string, unknown> = this.items.get(this.key(Key?.pk, Key?.sk))
          ?? { pk: Key?.pk, sk: Key?.sk };
        if (Key?.sk === "CONSENT") {
          if (values?.[":revoked"] !== undefined) item.state = "revoked";
          else {
            item.runId = values?.[":runId"];
            item.version = values?.[":version"];
            item.state = "granted";
          }
        } else if (Key?.sk === "LEASE") item.expiresAt = values?.[":expiresAt"];
        else if (!action.Update.UpdateExpression?.includes(":confirmed")) item.state = "uncertain";
        else {
          item.state = "confirmed";
          item.receiptArtifactId = values?.[":artifact"];
          item.receiptSha256 = values?.[":digest"];
        }
        this.items.set(this.key(Key?.pk, Key?.sk), item);
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
    expect(await journal.grantConsent(upper, firstRun, 1)).toBe(true);
    expect(await journal.acquireLease(upper, secondRun)).toBeNull();
    expect(await journal.beginSubmission(upper, first, firstRun, 1, job)).toBeTruthy();
    expect(await journal.beginSubmission(candidateId, first, firstRun, 1, job)).toBeNull();
    expect(await journal.submissionStatus(upper, job)).toBe("needs_reconciliation");
    expect(db.items.has(db.key(`CANDIDATE#${upper}`, officialJobKey(job)))).toBe(false);
  });

  it("keeps intent after a crash, including a new run ID, and never grants another click", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const first = (await journal.acquireLease(candidateId, firstRun))!;
    expect(await journal.grantConsent(candidateId, firstRun, 1)).toBe(true);
    expect(await journal.beginSubmission(candidateId, first, firstRun, 1, job)).toBeTruthy();
    expect(await journal.beginSubmission(candidateId, first, firstRun, 1, job)).toBeNull();
    expect(await journal.submissionStatus(candidateId, job)).toBe("needs_reconciliation");
    expect((await journal.readSubmission(candidateId, job)).receiptArtifactId).toBeTruthy();
    db.now += 121;
    const next = (await journal.acquireLease(candidateId, secondRun))!;
    expect(await journal.grantConsent(candidateId, secondRun, 2)).toBe(true);
    expect(await journal.beginSubmission(candidateId, next, secondRun, 2, job)).toBeNull();
    const stored = db.items.get(db.key(`CANDIDATE#${candidateId}`, officialJobKey(job)));
    expect(stored?.expiresAt).toBeUndefined();
  });

  it("allows receipt confirmation after recovery but never overwrites a confirmed receipt", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const first = (await journal.acquireLease(candidateId, firstRun))!;
    await journal.grantConsent(candidateId, firstRun, 1);
    const artifactId = (await journal.beginSubmission(candidateId, first, firstRun, 1, job))!;
    db.now += 121;
    const next = (await journal.acquireLease(candidateId, secondRun))!;
    expect(await journal.confirmAfterVerification(candidateId, next, job,
      { artifactId, sha256: receiptDigest })).toBe(true);
    expect(await journal.submissionStatus(candidateId, job)).toBe("confirmed");
    expect(await journal.confirmAfterVerification(candidateId, next, job,
      { artifactId, sha256: receiptDigest })).toBe(false);
    expect(await journal.beginSubmission(candidateId, next, secondRun, 1, job)).toBeNull();
  });

  it("holds an ambiguous click for reconciliation and blocks old queued runs after deletion", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const token = (await journal.acquireLease(candidateId, firstRun))!;
    await journal.grantConsent(candidateId, firstRun, 1);
    await journal.beginSubmission(candidateId, token, firstRun, 1, job);
    await journal.markUncertain(candidateId, token, job);
    expect(await journal.submissionStatus(candidateId, job)).toBe("needs_reconciliation");
    await journal.tombstoneCandidate(candidateId);
    db.now += 121;
    expect(await journal.acquireLease(candidateId, secondRun)).toBeNull();
    expect(await journal.beginSubmission(candidateId, token, firstRun, 1,
      { ...job, requisitionId: "other" })).toBeNull();
  });

  it("blocks a queued uppercase candidate ID after a lowercase deletion tombstone", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    await journal.tombstoneCandidate(candidateId);
    expect(await journal.acquireLease(candidateId.toUpperCase(), secondRun)).toBeNull();
    expect(db.items.has(db.key(`CANDIDATE#${candidateId.toUpperCase()}`, "DELETED"))).toBe(false);
  });

  it("fences a revoked consent before intent and requires a new version and run", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const token = (await journal.acquireLease(candidateId, firstRun))!;
    expect(await journal.grantConsent(candidateId.toUpperCase(), firstRun.toUpperCase(), 1)).toBe(true);
    expect(await journal.revokeConsent(candidateId, 1)).toBe(true);
    expect(await journal.beginSubmission(candidateId, token, firstRun, 1, job)).toBeNull();
    expect(await journal.submissionStatus(candidateId, job)).toBe("not_started");
    expect(await journal.grantConsent(candidateId, firstRun, 1)).toBe(false);
    expect(await journal.grantConsent(candidateId, secondRun, 2)).toBe(true);
    expect(await journal.beginSubmission(candidateId, token, firstRun, 1, job)).toBeNull();
    await journal.releaseLease(candidateId, token);
    const newToken = (await journal.acquireLease(candidateId.toUpperCase(), secondRun))!;
    expect(await journal.beginSubmission(candidateId, newToken, secondRun, 2, job)).toBeTruthy();
    expect(await journal.beginSubmission(candidateId.toUpperCase(), newToken, secondRun.toUpperCase(), 2, job))
      .toBeNull();
  });

  it("does not let an old consent epoch start a different job after a new grant", async () => {
    const db = new LedgerMemory();
    const journal = db.journal();
    const token = (await journal.acquireLease(candidateId, firstRun))!;
    await journal.grantConsent(candidateId, firstRun, 1);
    await journal.grantConsent(candidateId, firstRun, 2);
    expect(await journal.beginSubmission(candidateId, token, firstRun, 1, job)).toBeNull();
    expect(await journal.beginSubmission(candidateId, token, firstRun, 2, job)).toBeTruthy();
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
