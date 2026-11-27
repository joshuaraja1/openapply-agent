import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dispatchOnePendingApplication,
  DynamoApplicationDispatchStore, type DurableDispatchRecord }
  from "../src/cloud/aws-durable-dispatch.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

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
    expect(h.queue.send).toHaveBeenCalledTimes(1);
    h.setLaunchResult("started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
    expect(h.row.state).toBe("launched");
    expect(h.queue.send).toHaveBeenCalledTimes(1);
    expect(await dispatchOnePendingApplication(h)).toBe("empty");
  });

  it("recovers a crash after SQS send by resending the same opaque envelope", async () => {
    const h = harness();
    h.setFailMarkQueued(true);
    await expect(dispatchOnePendingApplication(h)).rejects.toThrow("crash after SQS send");
    expect(h.row.state).toBe("pending_queue");
    h.setFailMarkQueued(false);
    h.setLaunchResult("started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
    expect(h.queue.send).toHaveBeenCalledTimes(2);
    expect(h.queue.send.mock.calls[0]).toEqual(h.queue.send.mock.calls[1]);
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
