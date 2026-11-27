import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoHostedRunAdmission, SqsApplicationQueueSender }
  from "../src/cloud/aws-enqueue-ports.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const pk = `CANDIDATE#${candidateId}`;
const run = { pk, sk: `RUN#${runId}`, subjectId: "subject-a",
  consentVersion: 2, profileArtifactId: "d1718848-6798-4464-b237-28aa7bd71ef9",
  job: { provider: "Greenhouse", employerId: "acme",
    requisitionId: "42" } };
const consent = { pk, sk: "CONSENT", runId, version: 2, state: "granted" };

function admission(rows: Record<string, unknown> = { [run.sk]: run,
  CONSENT: consent }) {
  const send = vi.fn(async (command: GetCommand) => {
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input.TableName).toBe("ledger");
    expect(command.input.ConsistentRead).toBe(true);
    return { Item: rows[String(command.input.Key?.sk)] };
  });
  return { port: new DynamoHostedRunAdmission({ send } as unknown as
    Pick<DynamoDBDocumentClient, "send">, "ledger"), send };
}

describe("durable hosted run admission", () => {
  it("accepts only a matching durable run, consent version and absence of deletion", async () => {
    const { port } = admission();
    expect(await port.ownsRun(candidateId, runId)).toBe(true);
    expect(await port.hasCurrentConsent(candidateId, runId)).toBe(true);
    expect(await port.loadIdentity(candidateId, runId)).toEqual({
      subjectId: "subject-a", consentVersion: 2, job: run.job,
    });
    expect(await port.loadProfileArtifactId(candidateId, runId)).toBe(run.profileArtifactId);
  });

  it("fails closed for missing, revoked, stale and deleted records", async () => {
    expect(await admission({}).port.ownsRun(candidateId, runId)).toBe(false);
    await expect(admission({}).port.loadIdentity(candidateId, runId))
      .rejects.toThrow("Run unavailable");
    await expect(admission({ [run.sk]: { ...run, profileArtifactId: undefined } })
      .port.ownsRun(candidateId, runId)).rejects.toThrow();
    expect(await admission({ [run.sk]: run, CONSENT: { ...consent,
      state: "revoked" } }).port.hasCurrentConsent(candidateId, runId)).toBe(false);
    expect(await admission({ [run.sk]: run, CONSENT: { ...consent,
      version: 1 } }).port.hasCurrentConsent(candidateId, runId)).toBe(false);
    expect(await admission({ [run.sk]: run, CONSENT: consent,
      DELETED: { pk, sk: "DELETED" } }).port.hasCurrentConsent(candidateId, runId)).toBe(false);
    await expect(admission({ [run.sk]: { ...run, subjectId: "" },
      CONSENT: consent }).port.ownsRun(candidateId, runId)).rejects.toThrow();
  });
});

describe("staging FIFO sender", () => {
  it("sends only bounded opaque application envelopes to the configured queue", async () => {
    const send = vi.fn(async (_command: SendMessageCommand) => ({}));
    const queue = new SqsApplicationQueueSender({ send } as unknown as
      Pick<SQSClient, "send">,
    "https://sqs.us-east-1.amazonaws.com/205064803661/openapply-staging-application.fifo");
    const message = encodeCloudRunEnvelope({ version: 1, candidateId, runId,
      kind: "apply", scheduledAt: "2026-11-26T00:00:00.000Z" });
    await queue.send(message);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command?.input.MessageBody).toBe(message.body);
    await expect(queue.send({ ...message, body: "x".repeat(1025) })).rejects.toThrow();
    await expect(queue.send({ ...message, groupId: runId })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary destinations before the first SQS call", () => {
    expect(() => new SqsApplicationQueueSender({} as Pick<SQSClient, "send">,
      "https://example.com/queue.fifo")).toThrow("Invalid application queue URL");
  });
});
