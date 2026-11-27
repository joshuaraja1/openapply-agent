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
});
