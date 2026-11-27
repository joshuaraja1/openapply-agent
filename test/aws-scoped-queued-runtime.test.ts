import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { createAwsQueuedRunRuntime } from "../src/cloud/aws-queued-run-runtime.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const otherRunId = "00000000-0000-4000-8000-000000000003";
const config = { ledgerTable: "ledger", entitlementTable: "entitlements",
  artifactBucket: "openapply-private-test",
  artifactKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000004",
  applicationQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/openapply-staging-application.fifo" };

describe("scoped AWS queued runtime", () => {
  it("rejects a queue message for another run before touching AWS state", async () => {
    const send = vi.fn();
    const runtime = createAwsQueuedRunRuntime({
      dynamo: { send } as unknown as DynamoDBDocumentClient,
      sqs: { send } as unknown as SQSClient,
    }, config, { candidateId, runId, accessKeyId: "ASIATEST", secretAccessKey: "secret",
      sessionToken: "session", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
    { prepare: vi.fn() }, { verify: vi.fn() });
    const envelope = encodeCloudRunEnvelope({ version: 1, candidateId,
      runId: otherRunId, kind: "apply", scheduledAt: new Date().toISOString() });
    await expect(runtime.handle({ body: envelope.body, receiptHandle: "receipt" }))
      .rejects.toThrow("Artifact grant run mismatch");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects expired artifact credentials before constructing a worker", () => {
    const send = vi.fn();
    expect(() => createAwsQueuedRunRuntime({
      dynamo: { send } as unknown as DynamoDBDocumentClient,
      sqs: { send } as unknown as SQSClient,
    }, config, { candidateId, runId, accessKeyId: "ASIATEST", secretAccessKey: "secret",
      sessionToken: "session", expiresAt: new Date(Date.now() + 30_000).toISOString() },
    { prepare: vi.fn() }, { verify: vi.fn() })).toThrow("Scoped artifact credentials are unavailable");
  });
});
