import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { createAwsQueuedRunRuntime } from "../src/cloud/aws-queued-run-runtime.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const config = { ledgerTable: "openapply-staging-run-ledger", entitlementTable: "entitlements",
  artifactBucket: "openapply-private-test",
  artifactKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000004",
  artifactBrokerArn: "arn:aws:lambda:us-east-1:123456789012:function:openapply-staging-artifact-broker" };

describe("scoped AWS queued runtime", () => {
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
