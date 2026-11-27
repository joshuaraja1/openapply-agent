import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createAwsQueuedRunRuntime } from "../src/cloud/aws-queued-run-runtime.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const otherCandidateId = "00000000-0000-4000-8000-000000000003";
const otherRunId = "00000000-0000-4000-8000-000000000004";
const config = { ledgerTable: "openapply-staging-run-ledger", entitlementTable: "entitlements",
  artifactBucket: "openapply-private-test",
  artifactKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000004",
  artifactBrokerArn: "arn:aws:lambda:us-east-1:123456789012:function:openapply-staging-artifact-broker" };

describe("scoped AWS queued runtime", () => {
  it("uses an exact key despite another candidate's older queued run", async () => {
    const envelope = encodeCloudRunEnvelope({ version: 1, candidateId, runId,
      kind: "apply", scheduledAt: "2026-11-26T20:00:00.000Z" });
    const other = encodeCloudRunEnvelope({ version: 1, candidateId: otherCandidateId,
      runId: otherRunId, kind: "apply", scheduledAt: "2026-11-26T19:00:00.000Z" });
    const backlog = [
      { pk: `CANDIDATE#${otherCandidateId}`, sk: `DISPATCH#${otherRunId}`,
        candidateId: otherCandidateId, runId: otherRunId, state: "queued", ...other,
        createdAt: "2026-11-26T19:00:00.000Z" },
      { pk: `CANDIDATE#${candidateId}`, sk: `DISPATCH#${runId}`,
        candidateId, runId, state: "launched", ...envelope,
        createdAt: "2026-11-26T20:00:00.000Z" },
    ];
    const keys: unknown[] = [];
    const send = vi.fn(async (command: GetCommand) => {
      if (!(command instanceof GetCommand)) throw new Error("Stop after exact lookup");
      keys.push(command.input.Key);
      if (keys.length > 1) throw new Error("Stop after exact lookup");
      return { Item: backlog.find(item => item.pk === command.input.Key?.pk
        && item.sk === command.input.Key?.sk) };
    });
    const runtime = createAwsQueuedRunRuntime({
      dynamo: { send } as unknown as DynamoDBDocumentClient,
      lambda: { send: vi.fn() } as unknown as LambdaClient,
    }, config, { candidateId, runId, capability: "capability" },
    { prepare: vi.fn() }, { verify: vi.fn() });
    await expect(runtime.runExact()).rejects.toThrow("Stop after exact lookup");
    expect(keys[0]).toEqual({ pk: `CANDIDATE#${candidateId}`, sk: `DISPATCH#${runId}` });
    expect(keys).not.toContainEqual({ pk: `CANDIDATE#${otherCandidateId}`,
      sk: `DISPATCH#${otherRunId}` });
  });
  it("rejects a queue message for another run before touching AWS state", async () => {
    const send = vi.fn(async () => ({ Item: undefined }));
    const runtime = createAwsQueuedRunRuntime({
      dynamo: { send } as unknown as DynamoDBDocumentClient,
      lambda: { send } as unknown as LambdaClient,
    }, config, { candidateId, runId, capability: "capability" },
    { prepare: vi.fn() }, { verify: vi.fn() });
    await expect(runtime.runExact()).rejects.toThrow("Exact dispatch is not ready");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects missing capability before constructing a worker", () => {
    const send = vi.fn();
    expect(() => createAwsQueuedRunRuntime({
      dynamo: { send } as unknown as DynamoDBDocumentClient,
      lambda: { send } as unknown as LambdaClient,
    }, config, { candidateId, runId, capability: "" },
    { prepare: vi.fn() }, { verify: vi.fn() })).toThrow("Artifact run scope is unavailable");
  });
});
