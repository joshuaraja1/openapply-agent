import { describe, expect, it, vi } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
  UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoOnboardingMarkers } from "../src/hosted/aws-onboarding-store.js";
import { DynamoCandidateDeletionStore } from "../src/hosted/aws-candidate-deletion-store.js";

const candidateId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const pk = `CANDIDATE#${candidateId}`;

describe("candidate deletion Dynamo boundary", () => {
  it("starts an upload only in a transaction that checks the tombstone", async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const markers = new DynamoOnboardingMarkers({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    const lease = await markers.beginUpload(candidateId, artifactId, "sub-1");
    expect(lease).toMatch(/^[a-f0-9-]{36}$/);
    const transaction = send.mock.calls[0]![0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems?.[0]?.ConditionCheck?.Key).toEqual({ pk, sk: "DELETED" });
    expect(transaction.input.TransactItems?.[1]?.Put?.Item).toMatchObject({
      pk, sk: `UPLOAD#${artifactId}`, subjectId: "sub-1", leaseId: lease });
    await markers.endUpload(candidateId, artifactId, lease);
    const release = send.mock.calls[1]![0] as DeleteCommand;
    expect(release.input.ConditionExpression).toContain("leaseId");
  });

  it("sets the application-ready marker only with the verified profile transaction", async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const markers = new DynamoOnboardingMarkers({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    await markers.markVerified(candidateId, artifactId, "sub-1", true);
    const transaction = send.mock.calls[0]![0] as TransactWriteCommand;
    expect(transaction.input.TransactItems?.[0]?.ConditionCheck?.Key).toEqual({ pk, sk: "DELETED" });
    const update = transaction.input.TransactItems?.[1]?.Update;
    expect(update?.UpdateExpression).toContain("applicationProfileReady = :ready");
    expect(update?.ExpressionAttributeValues?.[":ready"]).toBe(true);
    expect(update?.ConditionExpression).toContain("subjectId = :subjectId");
  });

  it("keeps one owner-bound tombstone and purges other ledger rows", async () => {
    const commands: unknown[] = [];
    let hasRows = true;
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      commands.push(command);
      if (command instanceof PutCommand) return {};
      if (command instanceof QueryCommand) {
        if (command.input.KeyConditionExpression?.includes("begins_with")) return { Items: [] };
        if (hasRows) {
          hasRows = false;
          return { Items: [{ pk, sk: "DELETED" }, { pk, sk: `PROFILE#${artifactId}` }] };
        }
        return { Items: [{ pk, sk: "DELETED" }] };
      }
      return {};
    });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    const marker = await store.begin(candidateId, "sub-1", 1000);
    expect(marker).toEqual({ state: "pending", subjectId: "sub-1", notBeforeEpoch: 1000 });
    const put = commands.find(command => command instanceof PutCommand) as PutCommand;
    expect(put.input.Item).toMatchObject({ deletionIndexPk: "PENDING", deletionDue: 1000 });
    expect(await store.hasActiveWriters(candidateId, 1001)).toBe(false);
    expect(await store.purgeMetadata(candidateId)).toBe(true);
    await store.markComplete(candidateId, "sub-1");
    const deleteCommands = commands.filter(command => command instanceof DeleteCommand) as DeleteCommand[];
    expect(deleteCommands).toHaveLength(1);
    expect(deleteCommands[0]?.input.Key).toEqual({ pk, sk: `PROFILE#${artifactId}` });
    const update = commands.find(command => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.ConditionExpression).toContain("subjectId");
  });

  it("fails closed on a conflicting or malformed existing tombstone", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutCommand) throw Object.assign(new Error("exists"), {
        name: "ConditionalCheckFailedException" });
      if (command instanceof GetCommand) return { Item: { pk, sk: "DELETED",
        candidateId, subjectId: "another-subject", state: "pending", notBeforeEpoch: 1000 } };
      return {};
    });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    await expect(store.begin(candidateId, "sub-1", 1000)).rejects.toThrow("Invalid deletion marker");
  });

  it("adopts a legacy journal tombstone without lifting the deletion barrier", async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof PutCommand) throw Object.assign(new Error("exists"), {
        name: "ConditionalCheckFailedException" });
      if (command instanceof GetCommand) return { Item: { pk, sk: "DELETED",
        deletedAt: "2026-11-25T00:00:00.000Z" } };
      return {};
    });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.begin(candidateId, "sub-1", 1000)).toEqual({
      state: "pending", subjectId: "sub-1", notBeforeEpoch: 1000 });
    const update = commands.find(command => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.Key).toEqual({ pk, sk: "DELETED" });
    expect(update.input.ConditionExpression).toContain("attribute_exists(deletedAt)");
    expect(update.input.ConditionExpression).toContain("attribute_not_exists(subjectId)");
  });

  it("returns the winning owner-bound marker after concurrent legacy adoption", async () => {
    let reads = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
        throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      }
      if (command instanceof GetCommand) return { Item: reads++ === 0
        ? { pk, sk: "DELETED", deletedAt: "2026-11-25T00:00:00.000Z" }
        : { pk, sk: "DELETED", candidateId, subjectId: "sub-1",
          state: "pending", notBeforeEpoch: 1000 } };
      return {};
    });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.begin(candidateId, "sub-1", 1200)).toEqual({
      state: "pending", subjectId: "sub-1", notBeforeEpoch: 1000 });
  });

  it("defers purge while a browser worker still has a live journal lease", async () => {
    const send = vi.fn(async (command: unknown) => command instanceof GetCommand
      ? { Item: { pk, sk: "LEASE", expiresAt: 2000 } }
      : { Items: [] });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.hasActiveWriters(candidateId, 1500)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits out a broker STS grant and fails closed on malformed grant expiry", async () => {
    let expiry: unknown = 2000;
    const send = vi.fn(async (command: unknown) => command instanceof GetCommand
      ? { Item: undefined } : command instanceof QueryCommand
        ? { Items: command.input.ExpressionAttributeValues?.[":prefix"] === "GRANT#"
          ? [{ pk, sk: "GRANT#one", expiresAt: expiry }] : [] } : {});
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.hasActiveWriters(candidateId, 1500)).toBe(true);
    expiry = "unknown";
    expect(await store.hasActiveWriters(candidateId, 3000)).toBe(true);
    expiry = 2000;
    expect(await store.hasActiveWriters(candidateId, 3000)).toBe(false);
  });

  it("requires every candidate task registry row to report stopped before purge", async () => {
    let taskState = "started";
    const send = vi.fn(async (command: unknown) => command instanceof QueryCommand
      ? { Items: [{ pk, sk: "TASK#run-one", state: taskState }] } : {});
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.hasUnstoppedTasks(candidateId)).toBe(true);
    taskState = "stopped";
    expect(await store.hasUnstoppedTasks(candidateId)).toBe(false);
    const query = send.mock.calls[0]![0] as QueryCommand;
    expect(query.input.ConsistentRead).toBe(true);
    expect(query.input.ExpressionAttributeValues?.[":prefix"]).toBe("TASK#");
  });

  it("serializes purge attempts with a bounded owner lease", async () => {
    const commands: UpdateCommand[] = [];
    let occupied = false;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateCommand) {
        commands.push(command);
        if (command.input.UpdateExpression?.startsWith("SET purgeOwner")) {
          if (occupied) throw Object.assign(new Error("claimed"), {
            name: "ConditionalCheckFailedException" });
          occupied = true;
        } else occupied = false;
      }
      return {};
    });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.claimPurge(candidateId, "sub-1", 1000, "owner-a")).toBe(true);
    expect(await store.claimPurge(candidateId, "sub-1", 1000, "owner-b")).toBe(false);
    await store.releasePurge(candidateId, "sub-1", "owner-a");
    expect(await store.claimPurge(candidateId, "sub-1", 1000, "owner-b")).toBe(true);
    expect(commands[0]?.input.ConditionExpression).toContain("purgeLeaseUntil < :now");
    expect(commands[2]?.input.ConditionExpression).toContain("purgeOwner = :owner");
  });

  it("queries only bounded due tombstones and removes them from the index on completion", async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof QueryCommand) return { Items: [
        { pk, sk: "DELETED", candidateId, subjectId: "sub-1", state: "pending" },
        { pk, sk: "PROFILE#other", candidateId, subjectId: "sub-1", state: "pending" },
      ] };
      return {};
    });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.due(1000, 1000)).toEqual({
      rows: [{ candidateId, subjectId: "sub-1" }], malformed: 1 });
    await store.defer(candidateId, "sub-1", 1060);
    await store.markComplete(candidateId, "sub-1");
    const query = commands[0] as QueryCommand;
    expect(query.input.IndexName).toBe("DeletionDueIndex");
    expect(query.input.Limit).toBe(25);
    const completed = commands.filter(command => command instanceof UpdateCommand)
      .at(-1) as UpdateCommand;
    expect(completed.input.UpdateExpression).toContain("REMOVE deletionIndexPk, deletionDue");
  });

  it("pages past 25 malformed due rows and defers them without losing a valid retry", async () => {
    const commands: unknown[] = [];
    let pages = 0;
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (!(command instanceof QueryCommand)) return {};
      if (pages++ === 0) return { Items: Array.from({ length: 25 }, (_, index) => ({
        pk: `CANDIDATE#bad-${index}`, sk: "DELETED", candidateId: "different",
        subjectId: "private-subject", state: "pending" })),
        LastEvaluatedKey: { pk: "CANDIDATE#bad-24", sk: "DELETED",
          deletionIndexPk: "PENDING", deletionDue: 1000 } };
      return { Items: [{ pk, sk: "DELETED", candidateId,
        subjectId: "sub-1", state: "pending" }] };
    });
    const store = new DynamoCandidateDeletionStore({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    expect(await store.due(1000, 25)).toEqual({
      rows: [{ candidateId, subjectId: "sub-1" }], malformed: 25 });
    const queries = commands.filter(command => command instanceof QueryCommand) as QueryCommand[];
    expect(queries).toHaveLength(2);
    expect(queries[1]?.input.ExclusiveStartKey).toEqual(queries[0]?.input.ExclusiveStartKey
      ?? { pk: "CANDIDATE#bad-24", sk: "DELETED", deletionIndexPk: "PENDING", deletionDue: 1000 });
    const updates = commands.filter(command => command instanceof UpdateCommand) as UpdateCommand[];
    expect(updates).toHaveLength(25);
    for (const update of updates) {
      expect(update.input.UpdateExpression).toContain("deletionDue = :later");
      expect(update.input.ExpressionAttributeValues).toMatchObject({
        ":later": 4600, ":reason": "invalid-marker" });
      expect(JSON.stringify(update.input.ExpressionAttributeValues)).not.toContain("private-subject");
    }
  });
});
