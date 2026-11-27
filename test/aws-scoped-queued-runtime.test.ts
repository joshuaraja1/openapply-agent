import { describe, expect, it, vi } from "vitest";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { createAwsQueuedRunRuntime } from "../src/cloud/aws-queued-run-runtime.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const config = { artifactBucket: "openapply-private-test",
  artifactKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000004",
  artifactBrokerArn: "arn:aws:lambda:us-east-1:123456789012:function:openapply-staging-artifact-broker" };

describe("scoped AWS queued runtime", () => {
  it("fails closed when the trusted broker cannot load exact dispatch", async () => {
    const send = vi.fn(async (_command: InvokeCommand) =>
      ({ StatusCode: 200, Payload: Buffer.from("null") }));
    const runtime = createAwsQueuedRunRuntime({ lambda: { send } as unknown as LambdaClient },
      config, { candidateId, runId, capability: "capability" },
      { prepare: vi.fn() }, { verify: vi.fn() });
    await expect(runtime.runExact()).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(Buffer.from(send.mock.calls[0]![0].input.Payload as Uint8Array).toString());
    expect(payload).toEqual({ kind: "run-state", capability: "capability",
      request: { operation: "readDispatch" } });
  });

  it("rejects missing capability before constructing a worker", () => {
    const send = vi.fn();
    expect(() => createAwsQueuedRunRuntime({ lambda: { send } as unknown as LambdaClient },
      config, { candidateId, runId, capability: "" },
      { prepare: vi.fn() }, { verify: vi.fn() })).toThrow("Artifact run scope is unavailable");
  });
});
