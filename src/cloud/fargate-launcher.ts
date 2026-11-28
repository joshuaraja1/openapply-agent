import { createHash } from "node:crypto";
import { DescribeTasksCommand, ListTasksCommand, RunTaskCommand, StopTaskCommand, type ECSClient } from "@aws-sdk/client-ecs";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { mintArtifactRunCapability } from "./artifact-credential-broker.js";
import { DynamoApplicationDispatchStore } from "./aws-durable-dispatch.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const arn = z.string().startsWith("arn:aws:");
const launchRow = z.object({ pk: z.string(), sk: z.string(),
  candidateId: uuid, runId: uuid, capability: z.string().min(1).optional(),
  clientToken: z.string().length(64), configHash: z.string().length(64),
  reservedAt: z.number().int().positive(), taskArn: arn.optional(),
  slotIndex: z.number().int().min(0).max(31).default(0),
  generation: z.number().int().nonnegative().max(2).default(0),
  state: z.enum(["reserved", "started", "stopped"]) });
type LaunchRow = z.infer<typeof launchRow>;

export interface FargateLaunchConfig {
  enabled: boolean;
  clusterArn: string;
  taskDefinitionArn: string;
  taskRoleArn: string;
  subnets: readonly string[];
  securityGroupId: string;
  containerName: string;
  queueUrl: string;
  ledgerTable: string;
  /** Durable browser-task ceiling. Increase only after task and cost validation. */
  maxConcurrentTasks?: number;
  environment: "staging";
}

export interface FargateStopConfig {
  clusterArn: string;
  ledgerTable: string;
}

function validatedStop(config: FargateStopConfig): void {
  if (!/^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:cluster\/[A-Za-z0-9_-]+$/.test(config.clusterArn)
    || config.ledgerTable !== "openapply-staging-run-ledger") {
    throw new Error("Invalid Fargate stop configuration");
  }
}

function validated(config: FargateLaunchConfig): FargateLaunchConfig {
  if (!config.enabled) throw new Error("Fargate launcher disabled");
  if (!/^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:cluster\/[A-Za-z0-9_-]+$/.test(config.clusterArn)
    || !/^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/.test(config.taskDefinitionArn)
    || !/^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(config.taskRoleArn)
    || !/^sg-[a-f0-9]+$/.test(config.securityGroupId)
    || config.subnets.length < 1 || config.subnets.length > 3
    || config.subnets.some(value => !/^subnet-[a-f0-9]+$/.test(value))
    || !/^[A-Za-z0-9_-]{1,128}$/.test(config.containerName)
    || !/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/openapply-staging-application\.fifo$/.test(config.queueUrl)
    || !/^openapply-staging-run-ledger$/.test(config.ledgerTable)
    || !Number.isInteger(config.maxConcurrentTasks ?? 1)
    || (config.maxConcurrentTasks ?? 1) < 1
    || (config.maxConcurrentTasks ?? 1) > 32) {
    throw new Error("Invalid Fargate launcher configuration");
  }
  return config;
}

function runKey(candidateId: string, runId: string) {
  return { pk: `CANDIDATE#${uuid.parse(candidateId)}`, sk: `TASK#${uuid.parse(runId)}` };
}
function candidateActiveKey(candidateId: string) {
  return { pk: `CANDIDATE#${uuid.parse(candidateId)}`, sk: "ACTIVE_TASK" };
}
function slotKey(index: number) {
  if (!Number.isInteger(index) || index < 0 || index > 31) throw new Error("Invalid Fargate slot");
  return { pk: "LAUNCHER#staging", sk: `SLOT#${index}` };
}

/** Non-expiring slots bound Fargate spend even after Lambda crashes. A
 * stopped task must be reconciled before another task can start. */
export class DynamoFargateLaunchStore {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string) {
    if (table !== "openapply-staging-run-ledger") throw new Error("Invalid launch ledger");
  }

  async read(candidateId: string, runId: string): Promise<LaunchRow | undefined> {
    const key = runKey(candidateId, runId);
    const item = (await this.db.send(new GetCommand({ TableName: this.table,
      Key: key, ConsistentRead: true }))).Item;
    if (!item) return undefined;
    const row = launchRow.parse(item);
    if (row.pk !== key.pk || row.sk !== key.sk) throw new Error("Launch row key mismatch");
    return row;
  }

  /** A candidate can have many queued runs but only one active browser task.
   * The scheduler skips their later runs so another candidate can use a free slot. */
  async hasAnotherActiveTask(candidateId: string, runId: string): Promise<boolean> {
    const item = (await this.db.send(new GetCommand({ TableName: this.table,
      Key: candidateActiveKey(candidateId), ConsistentRead: true }))).Item;
    if (!item) return false;
    const active = z.object({ pk: z.string(), sk: z.literal("ACTIVE_TASK"),
      runId: uuid, clientToken: z.string().length(64) }).parse(item);
    if (active.pk !== `CANDIDATE#${candidateId}`) throw new Error("Active task key mismatch");
    return active.runId !== uuid.parse(runId);
  }

  async readActiveSlot(index = 0): Promise<{ candidateId: string; runId: string;
    clientToken: string; reservedAt: number } | undefined> {
    const item = (await this.db.send(new GetCommand({ TableName: this.table,
      Key: slotKey(index), ConsistentRead: true }))).Item;
    if (!item) return undefined;
    return z.object({ candidateId: uuid, runId: uuid,
      clientToken: z.string().length(64), reservedAt: z.number().int().positive() }).parse(item);
  }

  async readActiveSlots(maxConcurrentTasks: number): Promise<Array<{ index: number;
    candidateId: string; runId: string; clientToken: string; reservedAt: number }>> {
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 32) {
      throw new Error("Invalid Fargate capacity");
    }
    const slots = await Promise.all(Array.from({ length: maxConcurrentTasks }, async (_, index) => {
      const slot = await this.readActiveSlot(index);
      return slot ? { index, ...slot } : undefined;
    }));
    return slots.filter((slot): slot is NonNullable<typeof slot> => slot !== undefined);
  }

  async listCandidateTasks(candidateId: string): Promise<LaunchRow[]> {
    const pk = `CANDIDATE#${uuid.parse(candidateId)}`;
    const rows: LaunchRow[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(new QueryCommand({ TableName: this.table,
        KeyConditionExpression: "pk=:pk AND begins_with(sk,:prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "TASK#" },
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      for (const item of result.Items ?? []) {
        const row = launchRow.parse(item);
        if (row.pk !== pk || row.sk !== `TASK#${row.runId}`) throw new Error("Task row key mismatch");
        rows.push(row);
      }
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return rows;
  }

  async reserve(row: LaunchRow, maxConcurrentTasks = 1): Promise<"created" | "existing" | "busy"> {
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 32) {
      throw new Error("Invalid Fargate capacity");
    }
    const existing = await this.read(row.candidateId, row.runId);
    if (existing?.state === "stopped") {
      if (existing.generation >= 2) return "existing";
      const generation = existing.generation + 1;
      const clientToken = createHash("sha256")
        .update(`${row.candidateId}:${row.runId}:${generation}`).digest("hex");
      for (let index = 0; index < maxConcurrentTasks; index++) {
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: this.table,
            Key: { pk: row.pk, sk: "DELETED" },
            ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: this.table, Key: runKey(row.candidateId, row.runId),
            UpdateExpression: "SET #state=:reserved, capability=:capability, clientToken=:newToken, reservedAt=:time, generation=:generation, slotIndex=:slotIndex REMOVE taskArn",
            ConditionExpression: "#state=:stopped AND clientToken=:oldToken AND configHash=:hash",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":reserved": "reserved", ":stopped": "stopped",
              ":capability": row.capability, ":newToken": clientToken,
              ":oldToken": existing.clientToken, ":time": row.reservedAt,
              ":generation": generation, ":slotIndex": index, ":hash": row.configHash } } },
          { Put: { TableName: this.table, Item: { ...slotKey(index),
            candidateId: row.candidateId, runId: row.runId,
            clientToken, reservedAt: row.reservedAt },
            ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: this.table, Item: { ...candidateActiveKey(row.candidateId),
            runId: row.runId, clientToken },
            ConditionExpression: "attribute_not_exists(pk)" } },
        ] }));
        return "created";
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name !== "TransactionCanceledException" && name !== "ConditionalCheckFailedException") throw error;
        const current = await this.read(row.candidateId, row.runId);
        if (current?.state !== "stopped") return current ? "existing" : "busy";
      }
      }
      return "busy";
    }
    if (existing) return "existing";
    for (let index = 0; index < maxConcurrentTasks; index++) {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.table,
          Key: { pk: row.pk, sk: "DELETED" },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.table, Item: { ...row, slotIndex: index },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.table,
          Item: { ...slotKey(index), candidateId: row.candidateId, runId: row.runId,
            clientToken: row.clientToken, reservedAt: row.reservedAt },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.table,
          Item: { ...candidateActiveKey(row.candidateId),
            runId: row.runId, clientToken: row.clientToken },
          ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
      return "created";
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name !== "TransactionCanceledException" && name !== "ConditionalCheckFailedException") throw error;
      if (await this.read(row.candidateId, row.runId)) return "existing";
    }
    }
    return "busy";
  }

  async markStarted(row: LaunchRow, taskArn: string): Promise<void> {
    await this.db.send(new UpdateCommand({ TableName: this.table,
      Key: runKey(row.candidateId, row.runId),
      UpdateExpression: "SET taskArn=:task, #state=:started",
      ConditionExpression: "clientToken=:token AND configHash=:hash AND #state IN (:reserved, :started) AND (attribute_not_exists(taskArn) OR taskArn=:task)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":task": taskArn, ":started": "started",
        ":reserved": "reserved", ":token": row.clientToken, ":hash": row.configHash } }));
  }

  private async retryDispatchUpdate(row: LaunchRow): Promise<NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number]> {
    const dispatch = await new DynamoApplicationDispatchStore(this.db, this.table)
      .read(row.candidateId, row.runId);
    if (!dispatch || (dispatch.state !== "launched" && dispatch.state !== "queued")) {
      throw new Error("Stopped dispatch is not retryable");
    }
    return { Update: { TableName: this.table,
      Key: { pk: dispatch.pk, sk: dispatch.sk },
      UpdateExpression: "SET #state=:queued, gsi1pk=:index, gsi1sk=:order",
      ConditionExpression: "#state IN (:launched, :queued)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":queued": "queued", ":launched": "launched",
        ":index": "APPLICATION_DISPATCH",
        ":order": `${dispatch.createdAt}#${row.candidateId}#${row.runId}` } } };
  }

  async markStopped(row: LaunchRow, retry = false): Promise<void> {
    const retryUpdate = retry ? await this.retryDispatchUpdate(row) : undefined;
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.table, Key: runKey(row.candidateId, row.runId),
        UpdateExpression: "SET #state=:stopped REMOVE capability",
        ConditionExpression: "clientToken=:token AND taskArn=:task AND #state=:started",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":stopped": "stopped", ":started": "started",
          ":token": row.clientToken, ":task": row.taskArn } } },
      { Delete: { TableName: this.table, Key: slotKey(row.slotIndex),
        ConditionExpression: "clientToken=:token AND candidateId=:candidate AND runId=:run",
        ExpressionAttributeValues: { ":token": row.clientToken,
          ":candidate": row.candidateId, ":run": row.runId } } },
      { Delete: { TableName: this.table, Key: candidateActiveKey(row.candidateId),
        ConditionExpression: "attribute_not_exists(pk) OR (clientToken=:token AND runId=:run)",
        ExpressionAttributeValues: { ":token": row.clientToken, ":run": row.runId } } },
      ...(retryUpdate ? [retryUpdate] : []),
    ] }));
  }

  async markUnlaunched(row: LaunchRow, retry = false): Promise<void> {
    const retryUpdate = retry ? await this.retryDispatchUpdate(row) : undefined;
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.table, Key: runKey(row.candidateId, row.runId),
        UpdateExpression: "SET #state=:stopped REMOVE capability",
        ConditionExpression: "clientToken=:token AND #state=:reserved AND attribute_not_exists(taskArn)",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":stopped": "stopped", ":reserved": "reserved",
          ":token": row.clientToken } } },
      { Delete: { TableName: this.table, Key: slotKey(row.slotIndex),
        ConditionExpression: "clientToken=:token AND candidateId=:candidate AND runId=:run",
        ExpressionAttributeValues: { ":token": row.clientToken,
          ":candidate": row.candidateId, ":run": row.runId } } },
      { Delete: { TableName: this.table, Key: candidateActiveKey(row.candidateId),
        ConditionExpression: "attribute_not_exists(pk) OR (clientToken=:token AND runId=:run)",
        ExpressionAttributeValues: { ":token": row.clientToken, ":run": row.runId } } },
      ...(retryUpdate ? [retryUpdate] : []),
    ] }));
  }
}

export type LaunchOutcome = "started" | "capacity_busy" | "already_stopped";

/** Call only after durable enqueue succeeds. A retry uses the exact same
 * RunTask parameters and ECS client token, including the stored capability.
 * Ambiguous AWS failures keep the slot; never pay for a speculative retry. */
export async function launchQueuedFargateRun(candidateId: string, runId: string,
  configValue: FargateLaunchConfig, ports: {
    store: DynamoFargateLaunchStore;
    ecs: Pick<ECSClient, "send">;
    authorize(candidateId: string, runId: string): Promise<boolean>;
    signingKey: Uint8Array;
  }, nowEpoch = Math.floor(Date.now() / 1000)): Promise<LaunchOutcome> {
  const config = validated(configValue);
  const key = runKey(candidateId, runId);
  if (!await ports.authorize(candidateId, runId)) throw new Error("Run launch unauthorized");
  const configHash = createHash("sha256").update(JSON.stringify({
    cluster: config.clusterArn, task: config.taskDefinitionArn,
    role: config.taskRoleArn, subnets: [...config.subnets].sort(),
    securityGroup: config.securityGroupId, container: config.containerName,
    queue: config.queueUrl,
  })).digest("hex");
  const clientToken = createHash("sha256").update(`${candidateId}:${runId}`).digest("hex");
  const fresh = launchRow.parse({ ...key, candidateId, runId,
    capability: mintArtifactRunCapability(candidateId, runId, ports.signingKey, nowEpoch),
    clientToken, configHash, reservedAt: nowEpoch, state: "reserved" });
  const result = await ports.store.reserve(fresh, config.maxConcurrentTasks ?? 1);
  if (result === "busy") return "capacity_busy";
  const row = await ports.store.read(candidateId, runId);
  const expectedToken = row?.generation
    ? createHash("sha256").update(`${candidateId}:${runId}:${row.generation}`).digest("hex")
    : clientToken;
  if (!row || row.configHash !== configHash || row.clientToken !== expectedToken) {
    throw new Error("Existing launch configuration differs");
  }
  if (row.state === "stopped") return "already_stopped";
  if (!row.capability) throw new Error("Launch capability unavailable");
  if (nowEpoch - row.reservedAt > 1200) {
    throw new Error("Launch reservation needs reconciliation");
  }
  if (!await ports.authorize(candidateId, runId)) throw new Error("Run launch unauthorized");
  const response = await ports.ecs.send(new RunTaskCommand({
    cluster: config.clusterArn, taskDefinition: config.taskDefinitionArn,
    launchType: "FARGATE", count: 1, clientToken: row.clientToken,
    startedBy: runId,
    enableExecuteCommand: false,
    networkConfiguration: { awsvpcConfiguration: {
      subnets: [...config.subnets].sort(), securityGroups: [config.securityGroupId],
      assignPublicIp: "DISABLED",
    } },
    overrides: { taskRoleArn: config.taskRoleArn,
      containerOverrides: [{ name: config.containerName, environment: [
        { name: "OPENAPPLY_RUN_CAPABILITY", value: row.capability },
        { name: "OPENAPPLY_CANDIDATE_ID", value: candidateId },
        { name: "OPENAPPLY_RUN_ID", value: runId },
        { name: "OPENAPPLY_SUBMISSION_MODE", value: "disabled" },
      ] }] },
    tags: [{ key: "openapply-environment", value: "staging" },
      { key: "openapply-run", value: runId }],
  }));
  if (response.failures?.length || response.tasks?.length !== 1 || !response.tasks[0]?.taskArn) {
    throw new Error("Fargate launch was not accepted; reservation retained for reconciliation");
  }
  await ports.store.markStarted(row, response.tasks[0].taskArn);
  return "started";
}

/** Deletion or consent withdrawal calls this before clearing candidate rows.
 * The caller must wait for a subsequent STOPPED observation before erasure. */
export async function stopFargateRun(candidateId: string, runId: string,
  config: FargateStopConfig, ports: { store: DynamoFargateLaunchStore;
    ecs: Pick<ECSClient, "send"> }): Promise<"stopping" | "stopped" | "unlaunched"> {
  validatedStop(config);
  const row = await ports.store.read(candidateId, runId);
  if (!row) return "unlaunched";
  if (row.state === "stopped") return "stopped";
  if (!row.taskArn) throw new Error("Launch outcome needs reconciliation before deletion");
  const result = await ports.ecs.send(new DescribeTasksCommand({
    cluster: config.clusterArn, tasks: [row.taskArn] }));
  const task = result.tasks?.find(task => task.taskArn === row.taskArn);
  if (task?.lastStatus === "STOPPED") {
    await ports.store.markStopped(row);
    return "stopped";
  }
  if (!task || result.failures?.length) throw new Error("Task stop state unavailable");
  await ports.ecs.send(new StopTaskCommand({ cluster: config.clusterArn,
    task: row.taskArn, reason: "OpenApply consent or data lifecycle stop" }));
  return "stopping";
}

/** A five-minute control-plane sweep resolves ambiguous RunTask responses,
 * stops tasks at the 15-minute staging cost cap, and frees the slot only
 * after ECS confirms STOPPED. Missing/ambiguous ECS state stays fenced. */
export async function sweepFargateSlot(config: FargateLaunchConfig,
  ports: { store: DynamoFargateLaunchStore; ecs: Pick<ECSClient, "send">;
    onStopped?(candidateId: string, runId: string, generation: number): Promise<boolean> },
  nowEpoch = Math.floor(Date.now() / 1000), slotIndex = 0): Promise<"idle" | "waiting" | "stopping" | "stopped"> {
  validated(config);
  // Inspect all historical slots even after a capacity reduction. Existing
  // tasks must be stopped and reclaimed before those slots can be forgotten.
  slotKey(slotIndex);
  const slot = await ports.store.readActiveSlot(slotIndex);
  if (!slot) return "idle";
  const row = await ports.store.read(slot.candidateId, slot.runId);
  if (!row || row.slotIndex !== slotIndex || row.clientToken !== slot.clientToken || row.state === "stopped") {
    throw new Error("Launch slot and run need operator reconciliation");
  }
  if (!row.taskArn) {
    const found = await ports.ecs.send(new ListTasksCommand({
      cluster: config.clusterArn, startedBy: row.runId }));
    if (found.taskArns?.length === 1 && found.taskArns[0]) {
      await ports.store.markStarted(row, found.taskArns[0]);
      row.taskArn = found.taskArns[0];
      row.state = "started";
    } else if (found.taskArns?.length) {
      throw new Error("Multiple tasks need operator reconciliation");
    } else if (nowEpoch - row.reservedAt <= 1200) {
      // Keep the original ECS client token retryable; API timing is ambiguous.
      return "waiting";
    } else {
      // The ECS startedBy index can omit short-lived stopped tasks. Verify
      // the whole single-purpose cluster has no active tasks before freeing
      // an ambiguous reservation. Any paginated result keeps the fence.
      for (const desiredStatus of ["RUNNING", "PENDING"] as const) {
        let cursor: string | undefined;
        do {
          const active = await ports.ecs.send(new ListTasksCommand({
            cluster: config.clusterArn, desiredStatus,
            ...(cursor ? { nextToken: cursor } : {}),
          }));
          if (active.taskArns?.length) return "waiting";
          cursor = active.nextToken;
        } while (cursor);
      }
      const retry = await ports.onStopped?.(row.candidateId, row.runId, row.generation);
      await ports.store.markUnlaunched(row, retry ?? false);
      return "stopped";
    }
  }
  const result = await ports.ecs.send(new DescribeTasksCommand({
    cluster: config.clusterArn, tasks: [row.taskArn] }));
  const task = result.tasks?.find(item => item.taskArn === row.taskArn);
  if (!task || result.failures?.length) throw new Error("Task state unavailable");
  if (task.lastStatus === "STOPPED") {
    const retry = await ports.onStopped?.(row.candidateId, row.runId, row.generation);
    await ports.store.markStopped(row, retry ?? false);
    return "stopped";
  }
  if (nowEpoch - row.reservedAt >= 900) {
    await ports.ecs.send(new StopTaskCommand({ cluster: config.clusterArn,
      task: row.taskArn, reason: "OpenApply staging task duration limit" }));
    return "stopping";
  }
  return "waiting";
}

/** Deletion gate for every staging slot. Call this before data
 * erasure and repeat until STOPPED. A missing ECS state cannot authorize erase. */
export async function stopCandidateFargateTask(candidateId: string,
  config: FargateStopConfig,
  ports: { store: DynamoFargateLaunchStore; ecs: Pick<ECSClient, "send"> }): Promise<"stopped" | "stopping"> {
  validatedStop(config);
  uuid.parse(candidateId);
  const rows = await ports.store.listCandidateTasks(candidateId);
  let stopping = false;
  for (const row of rows) {
    if (row.state === "stopped") continue;
    const outcome = await stopFargateRun(candidateId, row.runId, config, ports);
    if (outcome !== "stopped") stopping = true;
  }
  // An active slot with no task row is a damaged registry, never proof of stop.
  const slots = await ports.store.readActiveSlots(32);
  for (const slot of slots.filter(item => item.candidateId === candidateId)) {
    if (!rows.some(row => row.runId === slot.runId) || !stopping) {
      throw new Error("Candidate task registry needs reconciliation");
    }
  }
  return stopping ? "stopping" : "stopped";
}
