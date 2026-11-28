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
  const launch = vi.fn(async (_candidateId: string, _runId: string) => launchResult);
  return { store, queue, launch, authorize: vi.fn(async () => true),
    hasAnotherActiveTask: vi.fn(async (_candidateId: string, _runId: string) => false),
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

  it("launches a second job seeker when an earlier run's seeker already has a task", async () => {
    const h = harness();
    const secondCandidate = "aa77d7c8-a697-4f49-932b-aa6ca45a4054";
    const secondRun = "cbc6b581-287c-42f5-b56c-a4ee75eb4196";
    const secondEnvelope = encodeCloudRunEnvelope({ version: 1,
      candidateId: secondCandidate, runId: secondRun,
      kind: "apply", scheduledAt: "2026-11-26T20:01:00.000Z" });
    const rows: DurableDispatchRecord[] = [
      { ...h.row, state: "queued" },
      { ...h.row, pk: `CANDIDATE#${secondCandidate}`, sk: `DISPATCH#${secondRun}`,
        candidateId: secondCandidate, runId: secondRun, body: secondEnvelope.body,
        groupId: secondEnvelope.groupId, deduplicationId: secondEnvelope.deduplicationId,
        createdAt: "2026-11-26T20:01:00.000Z", state: "queued" },
    ];
    h.store.listPending = vi.fn(async () => rows);
    h.hasAnotherActiveTask.mockImplementation(async candidate => candidate === candidateId);
    h.launch.mockResolvedValue("started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
    expect(h.launch).toHaveBeenCalledOnce();
    expect(h.launch).toHaveBeenCalledWith(secondCandidate, secondRun);
    expect(h.store.markLaunched).toHaveBeenCalledWith(secondCandidate, secondRun);
    expect(h.store.markLaunched).not.toHaveBeenCalledWith(candidateId, runId);
  });

  it("pages past more than 25 queued runs for one busy seeker", async () => {
    const h = harness();
    const secondCandidate = "aa77d7c8-a697-4f49-932b-aa6ca45a4054";
    const secondRun = "cbc6b581-287c-42f5-b56c-a4ee75eb4196";
    const rowFor = (seekId: string, id: string, minute: number): DurableDispatchRecord => {
      const createdAt = `2026-11-26T20:${String(minute).padStart(2, "0")}:00.000Z`;
      const envelope = encodeCloudRunEnvelope({ version: 1, candidateId: seekId,
        runId: id, kind: "apply", scheduledAt: createdAt });
      return { pk: `CANDIDATE#${seekId}`, sk: `DISPATCH#${id}`,
        candidateId: seekId, runId: id, state: "queued", body: envelope.body,
        groupId: envelope.groupId, deduplicationId: envelope.deduplicationId, createdAt };
    };
    const rows = Array.from({ length: 27 }, (_, index) => rowFor(candidateId,
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, index));
    rows.push(rowFor(secondCandidate, secondRun, 27));
    const send = vi.fn(async (command: QueryCommand) => {
      expect(command).toBeInstanceOf(QueryCommand);
      const offset = command.input.ExclusiveStartKey ? 25 : 0;
      return { Items: rows.slice(offset, offset + 25),
        ...(offset === 0 ? { LastEvaluatedKey: { pk: "cursor", sk: "page-1" } } : {}) };
    });
    const realStore = new DynamoApplicationDispatchStore(
      { send } as unknown as Pick<DynamoDBDocumentClient, "send">,
      "openapply-staging-run-ledger");
    h.store.listPending = vi.fn(limit => realStore.listPending(limit));
    h.hasAnotherActiveTask.mockImplementation(async candidate => candidate === candidateId);
    h.launch.mockResolvedValue("started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
    expect(h.store.listPending).toHaveBeenCalledWith(100);
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.launch).toHaveBeenCalledOnce();
    expect(h.launch).toHaveBeenCalledWith(secondCandidate, secondRun);
  });

  it("keeps scanning after a concurrent active-task reservation", async () => {
    const h = harness();
    const secondCandidate = "aa77d7c8-a697-4f49-932b-aa6ca45a4054";
    const secondRun = "cbc6b581-287c-42f5-b56c-a4ee75eb4196";
    const secondEnvelope = encodeCloudRunEnvelope({ version: 1,
      candidateId: secondCandidate, runId: secondRun,
      kind: "apply", scheduledAt: "2026-11-26T20:01:00.000Z" });
    h.store.listPending = vi.fn(async () => [h.row, {
      ...h.row, pk: `CANDIDATE#${secondCandidate}`, sk: `DISPATCH#${secondRun}`,
      candidateId: secondCandidate, runId: secondRun, body: secondEnvelope.body,
      groupId: secondEnvelope.groupId, deduplicationId: secondEnvelope.deduplicationId,
      createdAt: "2026-11-26T20:01:00.000Z",
    }]);
    let firstRead = true;
    h.hasAnotherActiveTask.mockImplementation(async candidate => {
      if (candidate !== candidateId) return false;
      if (firstRead) { firstRead = false; return false; }
      return true;
    });
    h.launch.mockImplementation(async candidate => candidate === candidateId ? "capacity_busy" : "started");
    expect(await dispatchOnePendingApplication(h)).toBe("started");
    expect(h.launch).toHaveBeenNthCalledWith(1, candidateId, runId);
    expect(h.launch).toHaveBeenNthCalledWith(2, secondCandidate, secondRun);
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
