import { describe, expect, it, vi } from "vitest";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoArtifactGrantFence } from "../src/cloud/aws-artifact-grant-fence.js";

const candidateId = "00000000-0000-4000-8000-000000000001";

describe("artifact grant deletion fence", () => {
  it("atomically blocks a deletion tombstone and reserves the 900-second grant plus margin", async () => {
    const send = vi.fn(async (_command: TransactWriteCommand) => ({}));
    const fence = new DynamoArtifactGrantFence({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    await fence.reserve(candidateId, 1000);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const items = command.input.TransactItems!;
    expect(items[0]?.ConditionCheck).toMatchObject({ TableName: "ledger",
      Key: { pk: `CANDIDATE#${candidateId}`, sk: "DELETED" },
      ConditionExpression: "attribute_not_exists(pk)" });
    expect(items[1]?.Put?.Item).toMatchObject({ pk: `CANDIDATE#${candidateId}`,
      expiresAt: 1960 });
    expect(items[1]?.Put?.Item?.sk).toMatch(/^GRANT#[0-9a-f-]{36}$/);
  });

  it("fails closed when tombstone conflicts and never reserves an invalid candidate", async () => {
    const send = vi.fn(async () => { throw new Error("transaction canceled"); });
    const fence = new DynamoArtifactGrantFence({ send } as unknown as
      Pick<DynamoDBDocumentClient, "send">, "ledger");
    await expect(fence.reserve(candidateId, 1000)).rejects.toThrow("transaction canceled");
    await expect(fence.reserve("../other", 1000)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
