import { describe, expect, it, vi } from "vitest";
import { DescribeTasksCommand, ListTasksCommand, RunTaskCommand, StopTaskCommand, type ECSClient } from "@aws-sdk/client-ecs";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoFargateLaunchStore, launchQueuedFargateRun, stopCandidateFargateTask,
  stopFargateRun, sweepFargateSlot,
  type FargateLaunchConfig } from "../src/cloud/fargate-launcher.js";

const candidateId = "19c886c7-3d13-4a16-92fa-7c84d862a9de";
const runId = "9d24cb92-32e1-4e84-9420-ef436f42abf8";
const taskArn = "arn:aws:ecs:us-east-1:123456789012:task/openapply-staging-browser/1234";
const config: FargateLaunchConfig = {
  enabled: true, environment: "staging",
  clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/openapply-staging-browser",
  taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/openapply-staging-queue:1",
  taskRoleArn: "arn:aws:iam::123456789012:role/openapply-staging-browser-task",
  subnets: ["subnet-a0123456"], securityGroupId: "sg-a0123456",
  containerName: "browser-worker",
  queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/openapply-staging-application.fifo",
  ledgerTable: "openapply-staging-run-ledger",
};

function harness() {
  let row: Record<string, unknown> | undefined;
  let slot = false;
  const store = {
    read: vi.fn(async () => row),
    readActiveSlot: vi.fn(async () => slot && row ? {
      candidateId, runId, clientToken: row.clientToken, reservedAt: row.reservedAt,
    } : undefined),
    listCandidateTasks: vi.fn(async () => row ? [row] : []),
    reserve: vi.fn(async (fresh: Record<string, unknown>) => {
      if (row) return "existing";
      if (slot) return "busy";
      row = { ...fresh };
      slot = true;
      return "created";
    }),
    markStarted: vi.fn(async (_row: unknown, arn: string) => {
      row = { ...row, taskArn: arn, state: "started" };
    }),
    markStopped: vi.fn(async () => {
      row = { ...row, state: "stopped" };
      delete row.capability;
      slot = false;
    }),
    markUnlaunched: vi.fn(async () => {
      row = { ...row, state: "stopped" };
      delete row.capability;
      slot = false;
    }),
  } as unknown as DynamoFargateLaunchStore;
  const sends: (RunTaskCommand | StopTaskCommand | DescribeTasksCommand | ListTasksCommand)[] = [];
  let fail = false;
  let stopped = false;
  let emptyDiscovery = false;
  const ecs = { send: vi.fn(async (command: RunTaskCommand | StopTaskCommand | DescribeTasksCommand | ListTasksCommand) => {
    sends.push(command);
    if (command instanceof RunTaskCommand) {
      if (fail) throw new Error("ambiguous timeout");
      return { tasks: [{ taskArn }] };
    }
    if (command instanceof DescribeTasksCommand) {
      return { tasks: [{ taskArn, lastStatus: stopped ? "STOPPED" : "RUNNING" }] };
    }
    if (command instanceof ListTasksCommand) return { taskArns: emptyDiscovery ? [] : [taskArn] };
    return { task: { taskArn } };
  }) } as unknown as Pick<ECSClient, "send">;
  return { store, ecs, sends, setFail(value: boolean) { fail = value; },
    setEmptyDiscovery(value: boolean) { emptyDiscovery = value; },
    setStopped(value: boolean) { stopped = value; },
    get row() { return row; } };
}

describe("bounded Fargate run launch", () => {
  it("reserves a fresh ECS token only after an observed stopped task", async () => {
    const oldToken = "a".repeat(64);
    let row: Record<string, unknown> = {
      pk: `CANDIDATE#${candidateId}`, sk: `TASK#${runId}`,
      candidateId, runId, state: "stopped", generation: 0,
      clientToken: oldToken, configHash: "b".repeat(64), reservedAt: 1_800_000_000,
    };
    const sent: unknown[] = [];
    const db = { send: vi.fn(async (command: GetCommand | TransactWriteCommand) => {
      sent.push(command);
      if (command instanceof GetCommand) return { Item: row };
      if (command instanceof TransactWriteCommand) {
        const entries = command.input.TransactItems ?? [];
        expect(entries[0]?.ConditionCheck?.Key).toEqual({ pk: row.pk, sk: "DELETED" });
        expect(entries[1]?.Update?.ConditionExpression).toContain("#state=:stopped");
        const values = entries[1]?.Update?.ExpressionAttributeValues as Record<string, unknown>;
        expect(values[":oldToken"]).toBe(oldToken);
        expect(values[":newToken"]).not.toBe(oldToken);
        row = { ...row, state: "reserved", capability: "new-capability",
          clientToken: values[":newToken"], generation: values[":generation"],
          reservedAt: values[":time"] };
        return {};
      }
      throw new Error("Unexpected Dynamo command");
    }) };
    const store = new DynamoFargateLaunchStore(
      db as unknown as Pick<DynamoDBDocumentClient, "send">,
      "openapply-staging-run-ledger");
    const result = await store.reserve({ ...row, state: "reserved", capability: "new-capability",
      reservedAt: 1_800_000_030 } as Parameters<DynamoFargateLaunchStore["reserve"]>[0]);
    expect(result).toBe("created");
    expect(row.generation).toBe(1);
    expect(row.clientToken).not.toBe(oldToken);
    expect(sent.some(command => command instanceof TransactWriteCommand)).toBe(true);
  });
  it("is disabled by default before touching any port", async () => {
    const h = harness();
    await expect(launchQueuedFargateRun(candidateId, runId,
      { ...config, enabled: false }, { ...h, signingKey: Buffer.alloc(32),
        authorize: vi.fn() })).rejects.toThrow("disabled");
    expect(h.sends).toHaveLength(0);
  });

  it("requires durable authorization before reserving a paid task", async () => {
    const h = harness();
    await expect(launchQueuedFargateRun(candidateId, runId, config,
      { ...h, signingKey: Buffer.alloc(32), authorize: async () => false }))
      .rejects.toThrow("unauthorized");
    expect(h.sends).toHaveLength(0);
    expect(h.row).toBeUndefined();
  });

  it("retries an ambiguous ECS response with identical parameters and token", async () => {
    const h = harness();
    const ports = { ...h, signingKey: Buffer.alloc(32, 7), authorize: async () => true };
    h.setFail(true);
    await expect(launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_000))
      .rejects.toThrow("ambiguous timeout");
    h.setFail(false);
    expect(await launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_020))
      .toBe("started");
    const [first, second] = h.sends as RunTaskCommand[];
    expect(first!.input).toEqual(second!.input);
    expect(first!.input.clientToken).toHaveLength(64);
    expect(first!.input.count).toBe(1);
    expect(first!.input.overrides?.containerOverrides?.[0]?.environment)
      .toContainEqual({ name: "OPENAPPLY_SUBMISSION_MODE", value: "disabled" });
  });

  it("fails closed after the reservation retry window", async () => {
    const h = harness();
    const ports = { ...h, signingKey: Buffer.alloc(32, 7), authorize: async () => true };
    h.setFail(true);
    await expect(launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_000))
      .rejects.toThrow();
    h.setFail(false);
    await expect(launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_001_201))
      .rejects.toThrow("needs reconciliation");
    expect(h.sends).toHaveLength(1);
  });

  it("keeps the slot until a task is observed STOPPED", async () => {
    const h = harness();
    const ports = { ...h, signingKey: Buffer.alloc(32, 7), authorize: async () => true };
    await launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_000);
    expect(await stopFargateRun(candidateId, runId, config, h)).toBe("stopping");
    expect(h.row?.state).toBe("started");
    expect(h.sends.some(command => command instanceof StopTaskCommand)).toBe(true);
    h.setStopped(true);
    expect(await stopFargateRun(candidateId, runId, config, h)).toBe("stopped");
    expect(h.row?.state).toBe("stopped");
    expect(await launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_030))
      .toBe("already_stopped");
  });

  it("candidate deletion waits for ECS STOPPED acknowledgement", async () => {
    const h = harness();
    const ports = { ...h, signingKey: Buffer.alloc(32, 7), authorize: async () => true };
    await launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_000);
    expect(await stopCandidateFargateTask(candidateId, config, h)).toBe("stopping");
    expect(h.row?.state).toBe("started");
    h.setStopped(true);
    expect(await stopCandidateFargateTask(candidateId, config, h)).toBe("stopped");
    expect(h.row?.state).toBe("stopped");
  });

  it("sweeper stops a task at 15 minutes and releases slot only after STOPPED", async () => {
    const h = harness();
    const ports = { ...h, signingKey: Buffer.alloc(32, 7), authorize: async () => true };
    await launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_000);
    expect(await sweepFargateSlot(config, h, 1_800_000_899)).toBe("waiting");
    expect(await sweepFargateSlot(config, h, 1_800_000_900)).toBe("stopping");
    h.setStopped(true);
    expect(await sweepFargateSlot(config, h, 1_800_000_910)).toBe("stopped");
    expect(await sweepFargateSlot(config, h, 1_800_000_920)).toBe("idle");
  });

  it("reconciles an old ambiguous launch only when the cluster has no active tasks", async () => {
    const h = harness();
    const ports = { ...h, signingKey: Buffer.alloc(32, 7), authorize: async () => true };
    h.setFail(true);
    await expect(launchQueuedFargateRun(candidateId, runId, config, ports, 1_800_000_000))
      .rejects.toThrow("ambiguous timeout");
    h.setEmptyDiscovery(true);
    expect(await sweepFargateSlot(config, h, 1_800_001_100)).toBe("waiting");
    expect(await sweepFargateSlot(config, h, 1_800_001_201)).toBe("stopped");
    expect(h.row?.state).toBe("stopped");
    expect(await stopCandidateFargateTask(candidateId, config, h)).toBe("stopped");
  });
});
