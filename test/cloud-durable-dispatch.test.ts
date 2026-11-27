import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dispatchOnePendingApplication,
  DynamoApplicationDispatchStore, type DurableDispatchRecord }
  from "../src/cloud/aws-durable-dispatch.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";
import { confirmedHostedAccess } from "../src/cloud/aws-fargate-launcher-lambda.js";

const candidateId = "19c886c7-3d13-4a16-92fa-7c84d862a9de";
const runId = "9d24cb92-32e1-4e84-9420-ef436f42abf8";
const encoded = encodeCloudRunEnvelope({ version: 1, candidateId, runId,
  kind: "apply", scheduledAt: "2026-11-26T20:00:00.000Z" });

function harness() {
  let row: DurableDispatchRecord = {
    pk: `CANDIDATE#${candidateId}`, sk: `DISPATCH#${runId}`,
    candidateId, runId, state: "pending_queue", body: encoded.body,
    groupId: encoded.groupId, deduplicationId: encoded.deduplicationId,
    createdAt: "2026-11-26T20:00:00.000Z",
  };
  let failMarkQueued = false;
  let launchResult: "started" | "capacity_busy" = "capacity_busy";
  const queue = { send: vi.fn(async () => {}) };
  const store = {
    listPending: vi.fn(async () => row.state === "pending_queue" || row.state === "queued"
      ? [row] : []),
    markQueued: vi.fn(async () => {
      if (failMarkQueued) throw new Error("crash after SQS send");
      row = { ...row, state: "queued" };
    }),
    markLaunched: vi.fn(async () => { row = { ...row, state: "launched" }; }),
    markBlocked: vi.fn(async () => { row = { ...row, state: "blocked" }; }),
    markNeedsReconciliation: vi.fn(async () => { row = { ...row, state: "needs_reconciliation" }; }),
  } as unknown as Pick<DynamoApplicationDispatchStore, "listPending" | "markQueued"
    | "markLaunched" | "markBlocked" | "markNeedsReconciliation">;
  const launch = vi.fn(async () => launchResult);
  return { store, queue, launch, authorize: vi.fn(async () => true),
    setFailMarkQueued(value: boolean) { failMarkQueued = value; },
    setLaunchResult(value: "started" | "capacity_busy") { launchResult = value; },
    get row() { return row; } };
}

describe("durable application outbox dispatch", () => {
  it("records only bounded pre-submit metadata and removes the pending index", async () => {
    const send = vi.fn(async (command: UpdateCommand) => {
      expect(command).toBeInstanceOf(UpdateCommand);
      expect(command.input.ConditionExpression).toBe("#state=:launched");
      expect(command.input.UpdateExpression).toContain("REMOVE gsi1pk, gsi1sk");
      expect(command.input.ExpressionAttributeValues).toMatchObject({
        ":preview": "preview_complete", ":status": "needs-human",
        ":count": 1, ":sha": "a".repeat(64), ":uploaded": true,
      });
      expect(JSON.stringify(command.input)).not.toContain("Security clearance");
      return {};
    });
    const store = new DynamoApplicationDispatchStore(
      { send } as unknown as Pick<DynamoDBDocumentClient, "send">,
      "openapply-staging-run-ledger");
    await store.markPreviewComplete(candidateId, runId, { status: "needs-human",
      blockerCount: 1, resumeSha256: "a".repeat(64), uploaded: true });
    expect(send).toHaveBeenCalledOnce();
    await expect(store.markPreviewComplete(candidateId, runId, { status: "needs-human",
      blockerCount: 101, resumeSha256: "a".repeat(64), uploaded: true }))
      .rejects.toThrow("Invalid preview outcome");
    expect(send).toHaveBeenCalledOnce();
  });
  it("retries entitlement read failures without blocking a queued run", async () => {
    const h = harness();
    h.authorize.mockImplementationOnce(() => confirmedHostedAccess("sub-a", async () => {
      throw new Error("DynamoDB unavailable");
    }));
    await expect(dispatchOnePendingApplication(h)).rejects.toThrow("DynamoDB unavailable");
    expect(h.store.markBlocked).not.toHaveBeenCalled();
    expect(h.row.state).toBe("pending_queue");
    h.setLaunchResult("started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
  });

  it("blocks only a confirmed lack of hosted access", async () => {
    expect(await confirmedHostedAccess("sub-a", async () => [])).toBe(false);
    await expect(confirmedHostedAccess("sub-a", async () => [{}]))
      .rejects.toThrow();
  });

  it("skips malformed index rows and paginates to a valid queued run", async () => {
    const valid: DurableDispatchRecord = {
      pk: `CANDIDATE#${candidateId}`, sk: `DISPATCH#${runId}`,
      candidateId, runId, state: "queued", body: encoded.body,
      groupId: encoded.groupId, deduplicationId: encoded.deduplicationId,
      createdAt: "2026-11-26T20:00:00.000Z",
    };
    let page = 0;
    const send = vi.fn(async (command: QueryCommand) => {
      expect(command).toBeInstanceOf(QueryCommand);
      page++;
      if (page === 1) return { Items: Array.from({ length: 25 }, () => ({
        ...valid, body: "private malformed content" })),
        LastEvaluatedKey: { pk: "cursor", sk: "one" } };
      expect(command.input.ExclusiveStartKey).toEqual({ pk: "cursor", sk: "one" });
      return { Items: [{ ...valid, state: "launched" }, valid] };
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new DynamoApplicationDispatchStore(
        { send } as unknown as Pick<DynamoDBDocumentClient, "send">,
        "openapply-staging-run-ledger");
      expect(await store.listPending()).toEqual([valid]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith("OpenApply dispatch skipped 25 malformed index row(s)");
      expect(warning.mock.calls.join(" ")).not.toContain("private malformed content");
    } finally { warning.mockRestore(); }
  });

  it("persists intent with a tombstone fence before permitting a queue send", async () => {
    let item: Record<string, unknown> | undefined;
    const send = vi.fn(async (command: GetCommand | TransactWriteCommand | UpdateCommand) => {
      if (command instanceof GetCommand) return { Item: item };
      if (command instanceof TransactWriteCommand) {
        const checks = command.input.TransactItems ?? [];
        expect(checks[0]?.ConditionCheck?.Key).toEqual({
          pk: `CANDIDATE#${candidateId}`, sk: "DELETED" });
        item = checks[1]?.Put?.Item as Record<string, unknown>;
        return {};
      }
      if (command instanceof UpdateCommand) {
        item = { ...item, state: "queued" };
        return {};
      }
      throw new Error("Unexpected Dynamo command");
    });
    const store = new DynamoApplicationDispatchStore(
      { send } as unknown as Pick<DynamoDBDocumentClient, "send">,
      "openapply-staging-run-ledger");
    const first = await store.ensurePending(candidateId, runId, encoded);
    expect(first.state).toBe("pending_queue");
    expect(item?.gsi1pk).toBe("APPLICATION_DISPATCH");
    expect((await store.ensurePending(candidateId, runId, encoded)).body).toBe(encoded.body);
    expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand))
      .toHaveLength(1);
    await store.markQueued(candidateId, runId);
    expect(item?.state).toBe("queued");
  });

  it("keeps a busy run indexed and launches it on the next scheduled tick", async () => {
    const h = harness();
    expect(await dispatchOnePendingApplication(h)).toBe("capacity_busy");
    expect(h.row.state).toBe("queued");
    expect(h.queue.send).not.toHaveBeenCalled();
    h.setLaunchResult("started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
    expect(h.row.state).toBe("launched");
    expect(h.queue.send).not.toHaveBeenCalled();
    expect(await dispatchOnePendingApplication(h)).toBe("empty");
  });

  it("recovers a crash before marking queued without SQS receive or send", async () => {
    const h = harness();
    h.setFailMarkQueued(true);
    await expect(dispatchOnePendingApplication(h)).rejects.toThrow("crash after SQS send");
    expect(h.row.state).toBe("pending_queue");
    h.setFailMarkQueued(false);
    h.setLaunchResult("started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
    expect(h.queue.send).not.toHaveBeenCalled();
  });

  it("rechecks consent and payment before replaying a pending message", async () => {
    const h = harness();
    h.authorize.mockResolvedValue(false);
    expect(await dispatchOnePendingApplication(h)).toBe("blocked");
    expect(h.row.state).toBe("blocked");
    expect(h.queue.send).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });
});
